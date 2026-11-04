import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
async function setup() {
 const db = new PGlite();
 await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));
 await db.exec(`alter table org_members add column role text default 'receptionist';
 update org_members set role='admin' where user_id='${id(11)}';
 insert into org_members(org_id,user_id,role) values ('${id(1)}','${id(12)}','receptionist');
 alter table crm_messages add column direction text, add column content text, add column message_type text, add column status text, add column sent_by uuid;
 update channels set inbox_key='reception';`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261103050000_crm_outbound_requests.sql',import.meta.url),'utf8'));
 const migration=await readFile(new URL('../../supabase/migrations/20261103060000_crm_outbound_reconciliation.sql',import.meta.url),'utf8').catch(()=> '');
 if(migration) await db.exec(migration);
 const conversation=(await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning id',[id(1),id(101),id(201)])).rows[0].id;
 return {db,conversation};
}
async function rpc(db,name,args) { return (await db.query(`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args)).rows[0].result; }
const claim=(db,conversation,request=id(501),user=id(11))=>rpc(db,'claim_crm_outbound_request',[request,user,conversation,id(201),'Olá']);
const recover=(db,conversation,operation,request=id(501),user=id(11),evidence='Verificado pelo operador')=>rpc(db,'reconcile_crm_outbound_request',[request,user,conversation,operation,evidence]);
const status=(db,request=id(501),user=id(11))=>rpc(db,'get_crm_outbound_request',[request,user]);

test('cancelling an absent ID durably prevents its delayed claim, records actor and is tenant isolated',async()=>{
 const {db,conversation}=await setup();try {
  assert.equal((await db.query("select to_regprocedure('reconcile_crm_outbound_request(uuid,uuid,uuid,text,text)') is not null as available")).rows[0].available,true);
  await db.exec('set role service_role');
  const cancelled=await recover(db,conversation,'cancel');assert.equal(cancelled.state,'cancelled');
  assert.equal(cancelled.reconciliation.actor_id,id(11));assert.equal(cancelled.reconciliation.previous_state,'not_found');
  assert.equal((await status(db)).state,'cancelled');assert.equal((await status(db,id(501),id(22))).state,'not_found');
  const delayed=await claim(db,conversation);assert.equal(delayed.state,'cancelled');assert.equal(delayed.claimed,false);assert.equal(delayed.claim_token,null);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from crm_outbound_requests')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from crm_outbound_cancellations')).rows[0].n,1);
 }finally{await db.close()}
});

test('unclaimed pending requests can cancel, but any claimed or uncertain request cannot be safely cancelled',async()=>{
 const {db,conversation}=await setup();try {
  await db.query('insert into crm_outbound_requests(request_id,org_id,requested_by,conversation_id,channel_id,patient_id,content) values($1,$2,$3,$4,$5,$6,$7)',[id(501),id(1),id(12),conversation,id(201),id(101),'Olá']);
  await db.exec('set role service_role');
  assert.equal((await recover(db,conversation,'cancel')).state,'cancelled');assert.equal((await claim(db,conversation,id(501),id(12))).claimed,false);
  const claimed=await claim(db,conversation,id(502));
  await assert.rejects(recover(db,conversation,'cancel',id(502)),/outbound_cancel_unsafe/);
  await rpc(db,'finish_crm_outbound_request',[id(502),claimed.claim_token,'uncertain','transport_unknown',null]);
  await assert.rejects(recover(db,conversation,'cancel',id(502)),/outbound_cancel_unsafe/);
  assert.equal((await status(db,id(502))).state,'uncertain');
  await db.exec('reset role');assert.equal((await db.query('select state from crm_outbound_requests where request_id=$1',[id(501)])).rows[0].state,'cancelled');
 }finally{await db.close()}
});

test('accepted-but-unsaved recovery atomically uses immutable request and existing provider ID without another claim',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');const first=await claim(db,conversation,id(501),id(12));
  await rpc(db,'finish_crm_outbound_request',[id(501),first.claim_token,'uncertain','storage_failed','wamid.accepted']);
  const recovered=await recover(db,conversation,'finalize');assert.equal(recovered.state,'sent');assert.equal(recovered.message.content,'Olá');
  assert.equal(recovered.reconciliation.provider_message_id,'wamid.accepted');assert.equal(recovered.reconciliation.message_id,recovered.message.id);
  assert.equal((await claim(db,conversation,id(501),id(12))).claimed,false);
  const again=await recover(db,conversation,'finalize');assert.equal(again.message.id,recovered.message.id);
  await db.exec('reset role');
  const message=(await db.query('select * from crm_messages where id=$1',[recovered.message.id])).rows[0];assert.equal(message.sent_by,id(12));assert.equal(message.status,'sent');
  assert.equal((await db.query("select count(*)::int n from crm_messages where whatsapp_message_id='wamid.accepted'")).rows[0].n,1);
 }finally{await db.close()}
});

test('manual evidence cannot manufacture acceptance, erase uncertainty or block a later proven acceptance',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');const first=await claim(db,conversation);
  await rpc(db,'finish_crm_outbound_request',[id(501),first.claim_token,'uncertain','transport_unknown',null]);
  await assert.rejects(recover(db,conversation,'finalize'),/outbound_acceptance_required/);
  const note=await recover(db,conversation,'observe',id(501),id(11),'Operador acredita que chegou; não confirmado');
  assert.equal(note.state,'uncertain');assert.equal(note.provider_message_id,null);assert.equal(note.reconciliation.operation,'observe');
  assert.equal((await claim(db,conversation)).claimed,false);
  await rpc(db,'finish_crm_outbound_request',[id(501),first.claim_token,'uncertain','storage_failed','wamid.late']);
  const recovered=await recover(db,conversation,'finalize');assert.equal(recovered.state,'sent');
  await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from crm_outbound_reconciliations')).rows[0].n,2);
 }finally{await db.close()}
});

test('audit and tombstone writes fail atomically and append-only history cannot be mutated',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec(`create function deny_reconciliation() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure'; end $$;
  create trigger deny_reconciliation before insert on crm_outbound_reconciliations for each row execute function deny_reconciliation();`);
  await db.exec('set role service_role');await assert.rejects(recover(db,conversation,'cancel'),/synthetic audit failure/);
  await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from crm_outbound_cancellations')).rows[0].n,0);
  await db.exec('drop trigger deny_reconciliation on crm_outbound_reconciliations');
  await db.exec('set role service_role');await recover(db,conversation,'cancel');await db.exec('reset role');
  await assert.rejects(db.exec("update crm_outbound_reconciliations set evidence='changed'"),/outbound_history_immutable/);
  await assert.rejects(db.exec('delete from crm_outbound_reconciliations'),/outbound_history_immutable/);
  await assert.rejects(db.exec('delete from crm_outbound_cancellations'),/outbound_history_immutable/);
 }finally{await db.close()}
});

test('failed finalization audit insert rolls back message persistence and keeps the occupied claim',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');const first=await claim(db,conversation);
  await rpc(db,'finish_crm_outbound_request',[id(501),first.claim_token,'uncertain','storage_failed','wamid.atomic']);
  await db.exec('reset role');await db.exec(`create function deny_reconciliation() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure'; end $$;
  create trigger deny_reconciliation before insert on crm_outbound_reconciliations for each row execute function deny_reconciliation();`);
  await db.exec('set role service_role');await assert.rejects(recover(db,conversation,'finalize'),/synthetic audit failure/);
  assert.equal((await status(db)).state,'uncertain');assert.equal((await claim(db,conversation)).claimed,false);
  await db.exec('reset role');assert.equal((await db.query("select count(*)::int n from crm_messages where whatsapp_message_id='wamid.atomic'")).rows[0].n,0);
 }finally{await db.close()}
});

test('admin-only recovery and member-only audit reads resist spoofing, cross-tenant and direct writes',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');
  for(const user of [id(12),id(22),null]) await assert.rejects(recover(db,conversation,'cancel',id(501),user),/outbound_access_denied/);
  for(const evidence of ['', '   ', 'x'.repeat(2001),null]) await assert.rejects(recover(db,conversation,'cancel',id(501),id(11),evidence),/outbound_evidence_required/);
  await assert.rejects(recover(db,conversation,'observe'),/outbound_request_not_found/);
  await recover(db,conversation,'cancel');await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(12)]);await db.exec('set role authenticated');
  assert.equal((await db.query('select actor_id,evidence from crm_outbound_reconciliations')).rows.length,1);
  await assert.rejects(recover(db,conversation,'cancel'),/permission denied/);
  for(const table of ['crm_outbound_reconciliations','crm_outbound_cancellations']) for(const op of ['delete from','truncate']) await assert.rejects(db.exec(`${op} ${table}`),/permission denied/);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(22)]);
  assert.equal((await db.query('select * from crm_outbound_reconciliations')).rows.length,0);
  assert.equal((await db.query('select * from crm_outbound_cancellations')).rows.length,0);
  await db.exec('reset role;set role anon');await assert.rejects(db.exec('select * from crm_outbound_reconciliations'),/permission denied/);
 }finally{await db.close()}
});
