import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEndpoint, id } from './helpers/send-fixture.mjs';
const recovery=(app,operation='cancel',extra={})=>({action:'reconcile',request_id:id(501),conversation_id:app.conversation,operation,evidence:'Conferido pelo administrador',...extra});

test('absent cancellation responds with audited terminal state and delayed send never reaches provider',async()=>{
 const app=await setupEndpoint();try {
  const cancel=await app.call(recovery(app));assert.equal(cancel.status,200);assert.equal(cancel.body.state,'cancelled');assert.equal(cancel.body.retryable,false);
  assert.equal(cancel.body.reconciliation.operation,'cancel');assert.equal(cancel.body.reconciliation.actor_id,id(11));assert.ok(cancel.body.reconciliation.id);
  const delayed=await app.call();assert.equal(delayed.status,200);assert.equal(delayed.body.state,'cancelled');
  assert.equal((await app.call({action:'status',request_id:id(501)})).body.state,'cancelled');assert.equal(app.fetches,0);
 }finally{await app.close()}
});

test('accepted-but-unsaved finalize works without channel credentials or transport and returns original immutable message',async()=>{
 const app=await setupEndpoint();try {
  await app.db.exec(`create function deny_message() returns trigger language plpgsql as $$ begin raise exception 'synthetic storage failure'; end $$;
  create trigger deny_message before insert on crm_messages for each row execute function deny_message();`);
  const first=await app.call();assert.equal(first.body.delivery_accepted,true);
  await app.db.exec("drop trigger deny_message on crm_messages;delete from channel_secrets;update channels set status='disconnected'");
  const result=await app.call(recovery(app,'finalize'));assert.equal(result.status,200);assert.equal(result.body.state,'sent');assert.equal(result.body.message.content,'Olá');
  assert.equal(result.body.reconciliation.operation,'finalize');assert.equal(app.fetches,1);
  assert.equal((await app.call(recovery(app,'finalize'))).body.message.id,result.body.message.id);assert.equal(app.fetches,1);
 }finally{await app.close()}
});

test('unknown outcome accepts an observation but not cancellation, fabricated acceptance or another dispatch',async()=>{
 const app=await setupEndpoint({transport:async()=>{throw new TypeError('synthetic disconnected')}});try {
  await app.call();
  const note=await app.call(recovery(app,'observe',{provider_message_id:'wamid.forged',actor_id:id(22)}));assert.equal(note.status,200);assert.equal(note.body.state,'uncertain');
  assert.equal(note.body.reconciliation.actor_id,id(11));assert.equal(note.body.delivery_accepted,false);
  assert.equal((await app.call(recovery(app,'finalize',{provider_message_id:'wamid.forged'}))).status,409);
  assert.equal((await app.call(recovery(app,'cancel'))).status,409);
  assert.equal((await app.call()).body.state,'uncertain');assert.equal(app.fetches,1);
  const row=(await app.db.query('select provider_message_id,state from crm_outbound_requests')).rows[0];assert.equal(row.provider_message_id,null);assert.equal(row.state,'uncertain');
 }finally{await app.close()}
});

test('recovery authenticates the caller, requires admin and evidence, and rejects unrelated conversation IDs',async()=>{
 const app=await setupEndpoint();try {
  assert.equal((await app.call(recovery(app),'invalid')).status,401);
  assert.equal((await app.call(recovery(app),'foreign')).status,403);
  for(const invalid of [{evidence:''},{evidence:' '},{evidence:'x'.repeat(2001)},{operation:'resend'},{conversation_id:'bad'}]) assert.equal((await app.call(recovery(app,'cancel',invalid))).status,400);
  await app.db.exec("update org_members set role='receptionist'");
  assert.equal((await app.call(recovery(app,'cancel',{role:'admin',user_id:id(11)}))).status,403);
  assert.equal(app.fetches,0);assert.equal((await app.db.query('select count(*)::int n from crm_outbound_cancellations')).rows[0].n,0);
 }finally{await app.close()}
});

test('lost recovery response fails closed and status can recover the durable cancellation',async()=>{
 const app=await setupEndpoint({loseReconcileResponse:true});try {
  const result=await app.call(recovery(app));assert.equal(result.status,503);assert.equal(result.body.retryable,false);
  assert.equal((await app.call({action:'status',request_id:id(501)})).body.state,'cancelled');assert.equal(app.fetches,0);
 }finally{await app.close()}
});
