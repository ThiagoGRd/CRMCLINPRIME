// These checks keep the synthetic HTTP boundary strict enough to catch UI/API drift.
// They do not replace the browser checks or real database/edge-function tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import * as fixtureModule from './fixture-server.mjs';
import {fetchLegacyMessages} from '../../lib/legacy-history.ts';
import {classifySendResult, outboundRequestBody} from '../../lib/outbound.ts';
import {getConversationPatient, openConversation, searchConversationPatients} from '../../lib/start-conversation.ts';
import {renderTextTemplate, serviceWindow} from '../../supabase/functions/_shared/whatsapp-policy.ts';
import {fixtureIds as ids, fixtureId} from './fixture-identities.ts';

const requestId = '00000000-0000-4000-8000-000000000001';
const body = {request_id:requestId,conversation_id:ids.receptionConversation,channel_id:ids.reception,text:'Resposta sintética'};

async function setup(t) {
  assert.equal(typeof fixtureModule.createFixture, 'function', 'fixture must expose an isolated HTTP state');
  const fixture = fixtureModule.createFixture({sendDelayMs:0});
  const server = fixtureModule.createFixtureServer(fixture);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const client = createClient(`http://127.0.0.1:${server.address().port}`, 'synthetic-test-key', {
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  });
  return {fixture,client};
}

test('send fixture returns matching request identity and records a single transport', async t => {
  const {fixture,client} = await setup(t);
  const {data,error} = await client.functions.invoke('whatsapp-send',{body});
  assert.equal(error,null);
  assert.equal(data.request_id,requestId);
  assert.equal(data.state,'sent');
  assert.equal(data.message.conversation_id,ids.receptionConversation);
  assert.equal(data.message.channel_id,ids.reception);
  assert.equal(fixture.sends.length,1);
});

test('status-only and unknown identities never claim or transmit a message', async t => {
  const {fixture,client} = await setup(t);
  const {data,error} = await client.functions.invoke('whatsapp-send',{body:{request_id:requestId,action:'status'}});
  assert.equal(data,null);
  assert.equal(error?.name,'FunctionsHttpError');
  assert.equal(error.context.status,404);
  const detail=await error.context.json();
  assert.deepEqual(detail,{request_id:requestId,state:'not_found',retryable:false,replayed:true,error:'Tentativa não encontrada. Nenhuma mensagem foi enviada por esta consulta.'});
  assert.equal(classifySendResult(body,detail).state,'uncertain');
  assert.equal(fixture.sends.length,0);
  assert.equal(fixture.outbound.length,0);
  assert.equal(fixture.statusLookups.length,1);
});

test('old send payloads without UUID identity fail rather than hiding contract drift', async t => {
  const {fixture,client} = await setup(t);
  const {error} = await client.functions.invoke('whatsapp-send',{body:{conversation_id:ids.receptionConversation,channel_id:ids.reception,text:'old contract'}});
  assert.ok(error);
  assert.equal(fixture.sends.length,0);
});

test('lost response after claim is queryable without repeating transport', async t => {
  const {fixture,client} = await setup(t);
  fixture.nextSendMode = 'uncertain-after-claim';
  const first = await client.functions.invoke('whatsapp-send',{body});
  assert.ok(first.error);
  assert.equal(fixture.sends.length,1);
  const query = await client.from('crm_outbound_requests')
    .select('request_id,conversation_id,channel_id,content,state,failure_code')
    .eq('org_id',ids.org).eq('conversation_id',ids.receptionConversation)
    .in('state',['pending','in_flight','uncertain']).order('created_at').order('request_id').range(0,499);
  assert.equal(query.error,null);
  assert.equal(query.data.length,1);
  assert.equal(query.data[0].request_id,requestId);
  assert.equal(query.data[0].content,'Resposta sintética');
  const status = await client.functions.invoke('whatsapp-send',{body:{request_id:requestId,action:'status'}});
  assert.equal(status.data,null);
  assert.equal(status.error?.name,'FunctionsHttpError');
  assert.equal(status.error.context.status,409);
  const detail=await status.error.context.json();
  assert.equal(detail.state,'uncertain');
  assert.equal(classifySendResult(body,detail).state,'uncertain');
  assert.equal(fixture.sends.length,1);
  assert.equal(fixture.outbound.length,1);
});

test('request lost before claim has no remote row and status does not create one', async t => {
  const {fixture,client} = await setup(t);
  fixture.nextSendMode = 'drop-before-claim';
  assert.ok((await client.functions.invoke('whatsapp-send',{body})).error);
  const result = await client.functions.invoke('whatsapp-send',{body:{request_id:requestId,action:'status'}});
  assert.equal(result.error?.context.status,404);
  assert.equal((await result.error.context.json()).state,'not_found');
  assert.equal(fixture.sends.length,0);
  assert.equal(fixture.outbound.length,0);
});

test('failed status uses the real 422 response and never transmits again', async t => {
  const {fixture,client}=await setup(t);
  fixture.outbound.push({...body,state:'failed',failure_code:'provider_rejected_131047'});
  const {data,error}=await client.functions.invoke('whatsapp-send',{body:{request_id:requestId,action:'status'}});
  assert.equal(data,null);
  assert.equal(error?.name,'FunctionsHttpError');
  assert.equal(error.context.status,422);
  const detail=await error.context.json();
  assert.equal(detail.state,'failed');
  assert.equal(detail.retryable,false);
  assert.equal(detail.replayed,true);
  assert.equal(classifySendResult(body,detail).state,'failed');
  assert.equal(fixture.sends.length,0);
});

test('legacy null predicates and range exclude routed records from history', async t => {
  const {fixture,client} = await setup(t);
  const result = await client.from('crm_messages').select('*',{count:'exact'})
    .eq('org_id',ids.org).eq('patient_id',ids.patient)
    .is('channel_id',null).is('conversation_id',null).order('created_at').order('id').range(0,39);
  assert.equal(result.error,null);
  assert.equal(result.count,41);
  assert.equal(result.data.length,40);
  assert.ok(result.data.every(row => row.channel_id === null && row.conversation_id === null));
  assert.equal(fixture.sends.length,0);
});

test('outbound query requires organization and conversation filters', async t => {
  const {client} = await setup(t);
  assert.ok((await client.from('crm_outbound_requests').select('*')).error);
  assert.ok((await client.from('crm_outbound_requests').select('*').eq('org_id',ids.org)).error);
});

test('exact-count range beyond remaining rows returns PostgREST 416, not an empty success', async t => {
  const {fixture,client}=await setup(t);
  const result=await client.from('crm_messages').select('*',{count:'exact'})
    .eq('org_id',ids.org).eq('patient_id',ids.patient)
    .is('channel_id',null).is('conversation_id',null).range(80,119);
  assert.equal(result.status,416);
  assert.equal(result.error?.code,'PGRST103');
  assert.equal(result.data,null);
  assert.equal(fixture.requests.length,1);
  const withoutExact=await client.from('crm_messages').select('*')
    .eq('org_id',ids.org).eq('patient_id',ids.patient)
    .is('channel_id',null).is('conversation_id',null).range(80,119);
  assert.equal(withoutExact.error,null);
  assert.deepEqual(withoutExact.data,[]);
});

test('real legacy reader recovers once from an HTTP 416 range without losing its scope', async t => {
  const {fixture,client}=await setup(t);
  const page=await fetchLegacyMessages(client,{orgId:ids.org,patientId:ids.patient,page:2});
  assert.equal(page.page,0);
  assert.equal(page.total,41);
  assert.equal(page.rows.length,40);
  assert.equal(page.rows[0].id,fixtureId(1001));
  assert.deepEqual(fixture.requests.map(row=>row.params.offset),['80','0']);
  assert.ok(fixture.requests.every(row=>row.method==='GET' && row.params.org_id===`eq.${ids.org}` && row.params.patient_id===`eq.${ids.patient}` && row.params.channel_id==='is.null' && row.params.conversation_id==='is.null'));
  assert.equal(fixture.sends.length,0);
});


test('fixture identities are UUIDs and default inbound keeps the free-text window open', async t => {
  const {fixture}=await setup(t);
  for (const value of [fixture.org,...fixture.channels.map(row=>row.id),...fixture.conversations.map(row=>row.id),...fixture.messages.map(row=>row.id)]) {
    assert.match(value,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
  assert.equal(serviceWindow(fixture.messages[0].created_at).open,true);
});

test('real patient lookup handles ilike name, phone, literal wildcards and maybeSingle cardinality', async t => {
  const {fixture,client}=await setup(t);
  assert.equal((await searchConversationPatients(client,ids.org,'mArIa'))[0].id,ids.patient);
  assert.equal((await searchConversationPatients(client,ids.org,'11911112222'))[0].id,ids.patient);
  assert.deepEqual(await searchConversationPatients(client,ids.org,'%_'),[]);
  assert.equal((await getConversationPatient(client,ids.org,ids.patient)).id,ids.patient);
  assert.equal(await getConversationPatient(client,ids.org,fixtureId(999)),null);
  const multi=await client.from('crm_patients').select('id').eq('org_id',ids.org).maybeSingle();
  assert.equal(multi.error?.code,'PGRST116');
  assert.equal(fixture.sends.length,0);
});

test('real openConversation reuses exact route without changing status or sending', async t => {
  const {fixture,client}=await setup(t);
  fixture.conversations[0].status='closed';
  const original=structuredClone(fixture.conversations[0]);
  const result=await openConversation(client,{orgId:ids.org,patientId:ids.patient,channelId:ids.reception});
  assert.deepEqual(result,{id:ids.receptionConversation,channel_id:ids.reception,inbox_key:'reception'});
  assert.deepEqual(fixture.conversations[0],original);
  assert.equal(fixture.requests.some(row=>row.method!=='GET'),false);
  assert.equal(fixture.sends.length,0);
});

test('real openConversation inserts once then reuses a synthetic patient/channel route', async t => {
  const {fixture,client}=await setup(t);
  const input={orgId:ids.org,patientId:ids.newPatient,channelId:ids.reception};
  const first=await openConversation(client,input);
  assert.match(first.id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(await openConversation(client,input),first);
  assert.equal(fixture.conversations.filter(row=>row.patient_id===ids.newPatient&&row.channel_id===ids.reception).length,1);
  const writes=fixture.requests.filter(row=>row.method==='POST');
  assert.equal(writes.length,1);
  assert.equal(writes[0].path,'/rest/v1/crm_conversations');
  assert.deepEqual(writes[0].payload,{org_id:ids.org,patient_id:ids.newPatient,channel_id:ids.reception});
  assert.equal(fixture.sends.length,0);
});

test('conversation insert returns projected array for maybeSingle and explicit unique conflict', async t => {
  const {fixture,client}=await setup(t);
  const input={org_id:ids.org,patient_id:ids.newPatient,channel_id:ids.crc};
  const result=await client.from('crm_conversations').insert(input).select('id,org_id,patient_id,channel_id').maybeSingle();
  assert.equal(result.error,null);
  assert.deepEqual(Object.keys(result.data).sort(),['channel_id','id','org_id','patient_id']);
  const duplicate=await client.from('crm_conversations').insert(input).select('id').maybeSingle();
  assert.equal(duplicate.error?.code,'23505');
  assert.equal(duplicate.status,409);
  assert.equal(fixture.sends.length,0);
});

test('catalog and window read-only contracts are scoped to the exact connected route', async t => {
  const {fixture,client}=await setup(t);
  const route={conversation_id:ids.receptionConversation,channel_id:ids.reception};
  const result=await client.functions.invoke('whatsapp-templates',{body:route});
  assert.equal(result.error,null);
  assert.equal(result.data.templates.length,1);
  assert.equal(result.data.window.open,true);
  assert.ok(Number.isFinite(Date.parse(result.data.checked_at)));
  const window=await client.functions.invoke('whatsapp-templates',{body:{...route,action:'window'}});
  assert.equal(window.error,null);
  assert.equal(window.data.window.open,true);
  assert.equal(window.data.templates,undefined);
  assert.equal((await client.functions.invoke('whatsapp-templates',{body:{...route,channel_id:ids.commercial}})).error.context.status,409);
  assert.equal(fixture.sends.length,0);
  assert.equal(fixture.outbound.length,0);
});

test('expired window rejects free text while an explicit matching template is accepted', async t => {
  const {fixture,client}=await setup(t);
  fixture.messages[0].created_at=new Date(Date.now()-25*60*60*1000).toISOString();
  const blocked=await client.functions.invoke('whatsapp-send',{body});
  assert.equal(blocked.error?.context.status,422);
  assert.equal((await blocked.error.context.json()).code,'outside_service_window');
  assert.equal(fixture.sends.length,0);
  assert.equal(fixture.outbound.length,0);
  const catalog=await client.functions.invoke('whatsapp-templates',{body:{conversation_id:body.conversation_id,channel_id:body.channel_id}});
  const selected=catalog.data.templates[0];
  const template={name:selected.name,language:selected.language,header:[],body:['Maria'],preview:renderTextTemplate(selected,{header:[],body:['Maria']})};
  const sent=await client.functions.invoke('whatsapp-send',{body:outboundRequestBody({...body,text:template.preview,kind:'template',template})});
  assert.equal(sent.error,null);
  assert.equal(sent.data.message.content,template.preview);
  assert.equal(fixture.sends[0].kind,'template');
  assert.equal(fixture.sends[0].text,undefined);
  assert.equal(fixture.outbound[0].message_kind,'template');
  assert.ok(fixture.outbound[0].provider_message_id);
  const ledger=await client.from('crm_outbound_requests')
    .select('request_id,conversation_id,channel_id,content,state,failure_code,provider_message_id,message_kind')
    .eq('org_id',ids.org).eq('conversation_id',ids.receptionConversation).order('created_at').order('request_id').range(0,499);
  assert.equal(ledger.error,null);
  assert.equal(ledger.data[0].message_kind,'template');
  assert.equal(ledger.data[0].provider_message_id,fixture.outbound[0].provider_message_id);
  assert.equal(ledger.data[0].content,template.preview);
});

test('changed template previews and mixed text/template payloads never dispatch', async t => {
  const {fixture,client}=await setup(t);
  const template={name:'retorno_sintetico',language:'pt_BR',header:[],body:['Maria'],preview:'Alterado'};
  const request={request_id:requestId,conversation_id:body.conversation_id,channel_id:body.channel_id,kind:'template',template};
  const changed=await client.functions.invoke('whatsapp-send',{body:request});
  assert.equal(changed.error?.context.status,409);
  assert.equal((await changed.error.context.json()).code,'template_preview_changed');
  assert.equal((await client.functions.invoke('whatsapp-send',{body:{...request,text:'Não permitido'}})).error?.context.status,400);
  assert.equal(fixture.sends.length,0);
});

test('audit reads preserve tenant and conversation scope without allowing fixture writes', async t => {
  const {fixture,client}=await setup(t);
  const audit=await client.from('crm_outbound_reconciliations').select('id,request_id,actor_id,operation,evidence,resulting_state,created_at')
    .eq('org_id',ids.org).eq('conversation_id',ids.receptionConversation).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(21);
  assert.equal(audit.error,null);
  assert.deepEqual(audit.data,[]);
  assert.ok((await client.from('crm_outbound_reconciliations').select('*')).error);
  assert.ok((await client.from('crm_outbound_reconciliations').insert({evidence:'not an RPC'})).error);
  assert.equal(fixture.sends.length,0);
});

test('concurrent real openConversation submissions recover the unique route without duplicate records', async t => {
  const {fixture,client}=await setup(t);
  const input={orgId:ids.org,patientId:ids.newPatient,channelId:ids.reception};
  const results=await Promise.all([openConversation(client,input),openConversation(client,input)]);
  assert.equal(results[0].id,results[1].id);
  assert.equal(fixture.conversations.filter(row=>row.patient_id===ids.newPatient&&row.channel_id===ids.reception).length,1);
  assert.equal(fixture.sends.length,0);
});

test('real openConversation recovers a lost insert response by exact scoped lookup', async t => {
  const {fixture,client}=await setup(t);
  fixture.nextConversationMode='drop-after-insert';
  const result=await openConversation(client,{orgId:ids.org,patientId:ids.newPatient,channelId:ids.reception});
  assert.equal(fixture.conversations.filter(row=>row.id===result.id).length,1);
  const writes=fixture.requests.filter(row=>row.path==='/rest/v1/crm_conversations'&&row.method==='POST');
  assert.equal(writes.length,1);
  const afterInsert=fixture.requests.slice(fixture.requests.indexOf(writes[0])+1);
  assert.ok(afterInsert.some(row=>row.method==='GET'&&row.path==='/rest/v1/crm_conversations'&&row.params.org_id===`eq.${ids.org}`&&row.params.patient_id===`eq.${ids.newPatient}`&&row.params.channel_id===`eq.${ids.reception}`));
  assert.equal(fixture.sends.length,0);
});

test('single-object reads use PostgREST cardinality errors while maybeSingle absence is null', async t => {
  const {client}=await setup(t);
  const found=await client.from('crm_patients').select('id,name').eq('id',ids.patient).single();
  assert.equal(found.error,null);
  assert.deepEqual(found.data,{id:ids.patient,name:'Maria Teste'});
  const absent=await client.from('crm_patients').select('id').eq('id',fixtureId(999)).single();
  assert.equal(absent.status,406);
  assert.equal(absent.error?.code,'PGRST116');
});

test('send replay retains one transport and rejects changed message identity', async t => {
  const {fixture,client}=await setup(t);
  const first=await client.functions.invoke('whatsapp-send',{body});
  const replay=await client.functions.invoke('whatsapp-send',{body});
  assert.equal(replay.error,null);
  assert.equal(replay.data.replayed,true);
  assert.equal(replay.data.message.id,first.data.message.id);
  const conflict=await client.functions.invoke('whatsapp-send',{body:{...body,text:'Texto diferente'}});
  assert.equal(conflict.error?.context.status,409);
  assert.equal(fixture.sends.length,1);
});

const reviewBody=(operation,extra={})=>({request_id:requestId,conversation_id:ids.receptionConversation,action:'reconcile',operation,evidence:'Conferência estritamente sintética',...extra});

test('observed uncertain outcome returns successful audit acknowledgement without claiming delivery', async t => {
  const {fixture,client}=await setup(t);
  fixture.nextSendMode='uncertain-after-claim';
  assert.ok((await client.functions.invoke('whatsapp-send',{body})).error);
  const result=await client.functions.invoke('whatsapp-send',{body:reviewBody('observe')});
  assert.equal(result.error,null);
  assert.equal(result.data.state,'uncertain');
  assert.equal(result.data.delivery_accepted,false);
  assert.equal(result.data.reconciliation.operation,'observe');
  assert.equal(result.data.reconciliation.actor_id,ids.user);
  assert.equal(classifySendResult(body,result.data).state,'uncertain');
  const audit=await client.from('crm_outbound_reconciliations').select('request_id,operation,evidence,resulting_state')
    .eq('org_id',ids.org).eq('conversation_id',ids.receptionConversation);
  assert.equal(audit.error,null);
  assert.deepEqual(audit.data,[{request_id:requestId,operation:'observe',evidence:'Conferência estritamente sintética',resulting_state:'uncertain'}]);
  assert.equal(fixture.sends.length,1);
  assert.equal((await client.functions.invoke('whatsapp-send',{body:reviewBody('cancel')})).error?.context.status,409);
  assert.equal((await client.functions.invoke('whatsapp-send',{body:reviewBody('finalize')})).error?.context.status,409);
  assert.equal(fixture.audit.length,1);
  assert.equal(fixture.sends.length,1);
});

test('accepted-but-unsaved fixture finalizes locally and returns the original message on repeat', async t => {
  const {fixture,client}=await setup(t);
  fixture.nextSendMode='accepted-before-storage';
  const first=await client.functions.invoke('whatsapp-send',{body});
  assert.equal(first.error?.context.status,409);
  assert.equal((await first.error.context.json()).delivery_accepted,true);
  fixture.channels[0].status='disconnected';
  const result=await client.functions.invoke('whatsapp-send',{body:reviewBody('finalize')});
  assert.equal(result.error,null);
  assert.equal(result.data.state,'sent');
  assert.equal(result.data.message.content,body.text);
  assert.equal(result.data.reconciliation.operation,'finalize');
  const repeated=await client.functions.invoke('whatsapp-send',{body:reviewBody('finalize')});
  assert.equal(repeated.data.message.id,result.data.message.id);
  assert.equal(fixture.messages.filter(row=>row.id===result.data.message.id).length,1);
  assert.equal(fixture.sends.length,1);
});

test('cancelled unclaimed identity remains terminal in status and delayed-send responses', async t => {
  const {fixture,client}=await setup(t);
  const cancel=await client.functions.invoke('whatsapp-send',{body:reviewBody('cancel')});
  assert.equal(cancel.error,null);
  assert.equal(cancel.data.state,'cancelled');
  assert.equal(cancel.data.reconciliation.operation,'cancel');
  const status=await client.functions.invoke('whatsapp-send',{body:{request_id:requestId,action:'status'}});
  assert.equal(status.data.state,'cancelled');
  assert.equal((await client.functions.invoke('whatsapp-send',{body})).data.state,'cancelled');
  assert.equal(fixture.sends.length,0);
  assert.equal(fixture.outbound.length,0);
});

test('review evidence and conversation mismatches fail without audit writes or dispatch', async t => {
  const {fixture,client}=await setup(t);
  fixture.nextSendMode='uncertain-after-claim';
  await client.functions.invoke('whatsapp-send',{body});
  assert.equal((await client.functions.invoke('whatsapp-send',{body:reviewBody('observe',{evidence:' '})})).error?.context.status,400);
  assert.equal((await client.functions.invoke('whatsapp-send',{body:reviewBody('observe',{conversation_id:ids.commercialConversation})})).error?.context.status,409);
  assert.equal(fixture.audit.length,0);
  assert.equal(fixture.sends.length,1);
});
