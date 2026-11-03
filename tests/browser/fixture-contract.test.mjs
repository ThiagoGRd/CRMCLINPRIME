// These checks keep the synthetic HTTP boundary strict enough to catch UI/API drift.
// They do not replace the browser checks or real database/edge-function tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import * as fixtureModule from './fixture-server.mjs';
import {fetchLegacyMessages} from '../../lib/legacy-history.ts';
import {classifySendResult} from '../../lib/outbound.ts';

const requestId = '00000000-0000-4000-8000-000000000001';
const body = {request_id:requestId,conversation_id:'conversation-r',channel_id:'number-r',text:'Resposta sintética'};

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
  assert.equal(data.message.conversation_id,'conversation-r');
  assert.equal(data.message.channel_id,'number-r');
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
  const {error} = await client.functions.invoke('whatsapp-send',{body:{conversation_id:'conversation-r',channel_id:'number-r',text:'old contract'}});
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
    .eq('org_id','org-a').eq('conversation_id','conversation-r')
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
    .eq('org_id','org-a').eq('patient_id','patient-a')
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
  assert.ok((await client.from('crm_outbound_requests').select('*').eq('org_id','org-a')).error);
});

test('exact-count range beyond remaining rows returns PostgREST 416, not an empty success', async t => {
  const {fixture,client}=await setup(t);
  const result=await client.from('crm_messages').select('*',{count:'exact'})
    .eq('org_id','org-a').eq('patient_id','patient-a')
    .is('channel_id',null).is('conversation_id',null).range(80,119);
  assert.equal(result.status,416);
  assert.equal(result.error?.code,'PGRST103');
  assert.equal(result.data,null);
  assert.equal(fixture.requests.length,1);
  const withoutExact=await client.from('crm_messages').select('*')
    .eq('org_id','org-a').eq('patient_id','patient-a')
    .is('channel_id',null).is('conversation_id',null).range(80,119);
  assert.equal(withoutExact.error,null);
  assert.deepEqual(withoutExact.data,[]);
});

test('real legacy reader recovers once from an HTTP 416 range without losing its scope', async t => {
  const {fixture,client}=await setup(t);
  const page=await fetchLegacyMessages(client,{orgId:'org-a',patientId:'patient-a',page:2});
  assert.equal(page.page,0);
  assert.equal(page.total,41);
  assert.equal(page.rows.length,40);
  assert.equal(page.rows[0].id,'legacy-001');
  assert.deepEqual(fixture.requests.map(row=>row.params.offset),['80','0']);
  assert.ok(fixture.requests.every(row=>row.method==='GET' && row.params.org_id==='eq.org-a' && row.params.patient_id==='eq.patient-a' && row.params.channel_id==='is.null' && row.params.conversation_id==='is.null'));
  assert.equal(fixture.sends.length,0);
});
