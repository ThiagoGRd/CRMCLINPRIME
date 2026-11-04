import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEndpoint, id } from './helpers/send-fixture.mjs';

test('send intent requires UUID, correct member, classified connected WhatsApp channel and immutable route',async()=>{
 const app=await setupEndpoint();try {
  for(const body of [{...app.body,request_id:undefined},{...app.body,request_id:'invalid'},{...app.body,conversation_id:id(999)},{...app.body,channel_id:id(202)}]) assert.ok((await app.call(body)).status>=400);
  assert.equal((await app.call(app.body,'invalid')).status,401);
  assert.equal((await app.call(app.body,'foreign')).status,403);
  for(const [column,value] of [['status','disconnected'],['type','sms'],['inbox_key',null],['inbox_key','unrecognized']]) {
   if(value==='unrecognized') continue; // Database CHECK already rejects this value.
   await app.db.query(`update channels set ${column}=$1 where id=$2`,[value,id(201)]);
   assert.equal((await app.call()).status,409);
   await app.db.query("update channels set status='connected',type='whatsapp_cloud',inbox_key='reception' where id=$1",[id(201)]);
  }
  assert.equal(app.fetches,0);
 }finally{await app.close()}
});

test('simultaneous and repeated send calls dispatch exactly once and return the stored confirmed message',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);
 let started;const began=new Promise(resolve=>started=resolve);
 const app=await setupEndpoint({transport:async()=>{started();await gate;return Response.json({messages:[{id:'wamid.concurrent'}]})}});
 try {
  const first=app.call();await began;
  const concurrent=await app.call();assert.equal(concurrent.status,202);assert.equal(concurrent.body.state,'in_flight');
  release();const sent=await first;
  assert.equal(sent.status,200);assert.equal(sent.body.state,'sent');assert.equal(sent.body.request_id,id(501));
  const replay=await app.call();assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.message.id,sent.body.message.id);
  assert.equal(app.fetches,1);assert.equal(sent.body.message.conversation_id,app.conversation);assert.equal(sent.body.message.channel_id,id(201));
  assert.equal(app.sent[0].url,'https://graph.facebook.com/v25.0/one/messages');
  assert.equal(app.sent[0].init.redirect,'error');
  assert.deepEqual(JSON.parse(app.sent[0].init.body),{messaging_product:'whatsapp',to:'5582991212108',type:'text',text:{body:'Olá'}});
  assert.equal((await app.db.query("select count(*)::int as n from crm_messages where direction='outbound'")).rows[0].n,1);
  assert.equal((await app.call({...app.body,text:'Changed'})).status,409);assert.equal(app.fetches,1);
 }finally{release();await app.close()}
});

test('status-only authenticates and reads without creating a request, claiming or calling transport',async()=>{
 const app=await setupEndpoint();try {
  const absent=await app.call({request_id:id(501),action:'status'});assert.equal(absent.status,404);assert.equal(absent.body.state,'not_found');
  assert.equal((await app.db.query('select count(*)::int as n from crm_outbound_requests')).rows[0].n,0);
  const sent=await app.call();
  const status=await app.call({request_id:id(501),action:'status'});assert.equal(status.body.message.id,sent.body.message.id);
  assert.equal((await app.call({request_id:id(501),action:'status'},'foreign')).body.state,'not_found');
  assert.equal((await app.call({request_id:id(501),action:'status'},'invalid')).status,401);
  assert.equal(app.fetches,1);
  assert.equal(app.rpcCalls.filter(c=>c.name==='claim_crm_outbound_request').length,1);
 }finally{await app.close()}
});

for(const [label,transport,code] of [
 ['timeout',async()=>{throw new DOMException('Timed out','TimeoutError')},'transport_unknown'],
 ['network failure',async()=>{throw new TypeError('connection closed')},'transport_unknown'],
 ['missing provider ID',async()=>Response.json({messages:[]}), 'provider_id_missing'],
 ['malformed provider reply',async()=>new Response('not json'), 'provider_response_invalid'],
 ['provider server error',async()=>Response.json({error:{code:1,message:'upstream error'}},{status:503}), 'provider_outcome_unknown'],
]) test(`${label} is durable uncertainty and never automatically resends`,async()=>{
 const app=await setupEndpoint({transport});try {
  const first=await app.call();assert.equal(first.status,409);assert.equal(first.body.state,'uncertain');assert.equal(first.body.retryable,false);
  const replay=await app.call();assert.equal(replay.body.state,'uncertain');assert.equal(app.fetches,1);
  const row=(await app.db.query('select state,failure_code from crm_outbound_requests')).rows[0];assert.equal(row.state,'uncertain');assert.equal(row.failure_code,code);
  assert.ok(app.sent[0].init.signal); // A bounded transport wait is always attached.
 }finally{await app.close()}
});

test('structured provider rejection is terminal, stores no message, and requires a new deliberate intent',async()=>{
 const app=await setupEndpoint({transport:async()=>Response.json({error:{code:131047,message:'outside window'}},{status:400})});try {
  const first=await app.call();assert.equal(first.status,422);assert.equal(first.body.state,'failed');assert.equal(first.body.retryable,false);
  assert.match(first.body.error,/24h/);
  const replay=await app.call();assert.equal(replay.status,422);assert.equal(replay.body.state,'failed');assert.equal(app.fetches,1);
  assert.equal((await app.db.query("select count(*)::int as n from crm_messages where direction='outbound'")).rows[0].n,0);
 }finally{await app.close()}
});

test('accepted send plus storage failure records provider ID as uncertain and never sends again',async()=>{
 const app=await setupEndpoint();try {
  await app.db.exec(`create function fail_synthetic_message() returns trigger language plpgsql as $$ begin raise exception 'synthetic save failure'; end $$;
  create trigger fail_synthetic_message before insert on crm_messages for each row execute function fail_synthetic_message();`);
  const first=await app.call();assert.equal(first.status,409);assert.equal(first.body.state,'uncertain');assert.equal(first.body.delivery_accepted,true);
  const replay=await app.call();assert.equal(replay.body.state,'uncertain');assert.equal(replay.body.delivery_accepted,true);assert.equal(app.fetches,1);
  const row=(await app.db.query('select state,provider_message_id from crm_outbound_requests')).rows[0];assert.equal(row.state,'uncertain');assert.equal(row.provider_message_id,'wamid.synthetic');
 }finally{await app.close()}
});

test('lost completion response returns the transactionally saved message without downgrading or resending',async()=>{
 const app=await setupEndpoint({loseCompleteResponse:true});try {
  const first=await app.call();assert.equal(first.status,200);assert.equal(first.body.state,'sent');
  const replay=await app.call();assert.equal(replay.body.message.id,first.body.message.id);assert.equal(app.fetches,1);
 }finally{await app.close()}
});

test('failure to persist an uncertain outcome leaves the claim occupied and fails closed on repeat',async()=>{
 const app=await setupEndpoint({failRpc:'finish_crm_outbound_request',transport:async()=>{throw new TypeError('lost connection')}});try {
  const first=await app.call();assert.equal(first.body.state,'uncertain');
  const replay=await app.call();assert.equal(replay.status,202);assert.equal(replay.body.state,'in_flight');assert.equal(app.fetches,1);
 }finally{await app.close()}
});

test('aged replay followed by accepted-but-unsaved provider response preserves acceptance evidence',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);
 let started;const began=new Promise(resolve=>started=resolve);
 const app=await setupEndpoint({transport:async()=>{started();await gate;return Response.json({messages:[{id:'wamid.late.accepted'}]})}});
 try {
  await app.db.exec(`create function fail_late_message() returns trigger language plpgsql as $$ begin raise exception 'synthetic late save failure'; end $$;
  create trigger fail_late_message before insert on crm_messages for each row execute function fail_late_message();`);
  const original=app.call();await began;
  await app.db.query("update crm_outbound_requests set claimed_at=now()-interval '10 minutes' where request_id=$1",[id(501)]);
  assert.equal((await app.call()).body.state,'uncertain');
  release();const first=await original;assert.equal(first.body.state,'uncertain');assert.equal(first.body.delivery_accepted,true);
  const status=await app.call({request_id:id(501),action:'status'});assert.equal(status.body.delivery_accepted,true);
  assert.equal((await app.db.query('select provider_message_id from crm_outbound_requests')).rows[0].provider_message_id,'wamid.late.accepted');
  assert.equal(app.fetches,1);
 }finally{release();await app.close()}
});

test('durable claim failure never falls through to provider transport',async()=>{
 const app=await setupEndpoint({failRpc:'claim_crm_outbound_request'});try {
  const first=await app.call();assert.equal(first.status,503);assert.equal(first.body.retryable,false);assert.equal(app.fetches,0);
  assert.equal((await app.db.query('select count(*)::int as n from crm_outbound_requests')).rows[0].n,0);
 }finally{await app.close()}
});
