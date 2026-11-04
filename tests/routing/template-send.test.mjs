import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEndpoint, id } from './helpers/send-fixture.mjs';
const template=app=>({request_id:id(501),conversation_id:app.conversation,channel_id:id(201),kind:'template',template:{name:'appointment',language:'pt_BR',header:[],body:['Maria'],preview:'Olá Maria'}});

test('database window prevents free text before any provider call while accepted templates use exact approved payload',async()=>{
 const app=await setupEndpoint();try {
  await app.db.exec("update crm_messages set created_at=now()-interval '25 hours' where direction='inbound'");
  const blocked=await app.call();assert.equal(blocked.status,422);assert.equal(blocked.body.code,'outside_service_window');assert.equal(app.fetches,0);
  assert.equal(blocked.body.state,'failed');assert.equal((await app.db.query("select count(*)::int n from crm_outbound_requests where failure_code='outside_service_window'")).rows[0].n,1);
  const templateRequest={...template(app),request_id:id(502)};
  const result=await app.call(templateRequest);assert.equal(result.status,200);assert.equal(result.body.message.content,'Olá Maria');assert.equal(app.fetches,1);
  assert.equal(app.metadataCalls.length,2);
  assert.deepEqual(JSON.parse(app.sent[0].init.body),{messaging_product:'whatsapp',to:'5582991212108',type:'template',template:{name:'appointment',language:{code:'pt_BR'},components:[{type:'body',parameters:[{type:'text',text:'Maria'}]}]}});
  const stored=(await app.db.query('select message_kind,template_payload from crm_outbound_requests where request_id=\'00000000-0000-0000-0000-000000000502\'')).rows[0];assert.equal(stored.message_kind,'template');assert.equal(stored.template_payload.name,'appointment');
  assert.equal((await app.db.query("select message_type from crm_messages where direction='outbound'")).rows[0].message_type,'template');
  assert.equal((await app.call(templateRequest)).body.replayed,true);assert.equal(app.fetches,1);
 }finally{await app.close()}
});

test('template send rejects mismatched preview and variants before claiming and fails closed on metadata outage',async()=>{
 const app=await setupEndpoint();try {
  const request=template(app);
  for(const input of [{...request,text:'free text'},{...request,kind:'other'},{...request,template:{...request.template,preview:'Different'}},{...request,template:{...request.template,body:[]}}]) assert.ok((await app.call(input)).status>=400);
  assert.equal(app.fetches,0);assert.equal((await app.db.query('select count(*)::int n from crm_outbound_requests')).rows[0].n,0);
 }finally{await app.close()}
 const outage=await setupEndpoint({catalogTransport:async()=>Response.json({error:{code:403}},{status:403})});try {
  assert.equal((await outage.call(template(outage))).status,503);assert.equal(outage.fetches,0);assert.equal((await outage.db.query('select count(*)::int n from crm_outbound_requests')).rows[0].n,0);
 }finally{await outage.close()}
});

test('template accepted-but-unsaved recovery never fetches catalog or dispatches again and preserves template kind',async()=>{
 let metadataAvailable=true;
 const app=await setupEndpoint({catalogTransport:async url=>{if(!metadataAvailable)throw Error('offline');return Response.json({data:String(url).includes('/phone_numbers')?[{id:'one'}]:[{id:'123',name:'appointment',language:'pt_BR',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'Olá {{1}}'}]}]})}});try {
  await app.db.exec(`create function deny_template_save() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$;
  create trigger deny_template_save before insert on crm_messages for each row execute function deny_template_save();`);
  const sent=await app.call(template(app));assert.equal(sent.body.delivery_accepted,true);assert.equal(app.fetches,1);
  metadataAvailable=false;await app.db.exec('drop trigger deny_template_save on crm_messages');
  const recovered=await app.call({action:'reconcile',operation:'finalize',request_id:id(501),conversation_id:app.conversation,evidence:'Aceite persistido confirmado'});
  assert.equal(recovered.body.state,'sent');assert.equal(app.metadataCalls.length,2);assert.equal(app.fetches,1);
  assert.equal((await app.db.query("select message_type from crm_messages where direction='outbound'")).rows[0].message_type,'template');
 }finally{await app.close()}
});

test('simultaneous template calls claim once and changed variables cannot reuse a request UUID',async()=>{
 let started,release;const began=new Promise(r=>started=r);const gate=new Promise(r=>release=r);
 const app=await setupEndpoint({transport:async()=>{started();await gate;return Response.json({messages:[{id:'wamid.concurrent.template'}]})}});
 try {
  const request=template(app);const first=app.call(request);await began;
  const replay=await app.call(request);assert.equal(replay.body.state,'in_flight');assert.equal(app.fetches,1);
  const altered={...request,template:{...request.template,body:['Ana'],preview:'Olá Ana'}};
  assert.equal((await app.call(altered)).status,409);assert.equal(app.fetches,1);
  release();assert.equal((await first).body.state,'sent');
  assert.equal((await app.db.query("select count(*)::int n from crm_messages where direction='outbound'")).rows[0].n,1);
 }finally{release();await app.close()}
});

test('live template approval withdrawal rejects a new intent without claiming it',async()=>{
 const app=await setupEndpoint({catalogTransport:async url=>Response.json({data:String(url).includes('/phone_numbers')?[{id:'one'}]:[{id:'123',name:'appointment',language:'pt_BR',status:'PAUSED',category:'UTILITY',components:[{type:'BODY',text:'Olá {{1}}'}]}]})});
 try {const result=await app.call(template(app));assert.equal(result.status,409);assert.equal(result.body.code,'template_not_available');assert.equal(app.fetches,0);assert.equal((await app.db.query('select count(*)::int n from crm_outbound_requests')).rows[0].n,0)}finally{await app.close()}
});
