import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
async function setup() {
 const db = new PGlite();
 await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));
 await db.exec(`alter table crm_messages add column direction text, add column content text, add column message_type text, add column status text, add column sent_by uuid;
 update channels set inbox_key='reception';`);
 let sql=''; try {sql=await readFile(new URL('../../supabase/migrations/20261103050000_crm_outbound_requests.sql',import.meta.url),'utf8')} catch {}
 await db.exec(sql);
 const conversation=(await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning id',[id(1),id(101),id(201)])).rows[0].id;
 return {db,conversation};
}
async function claim(db,conversation,request=id(501),user=id(11),channel=id(201),content='Olá') {
 return (await db.query('select claim_crm_outbound_request($1,$2,$3,$4,$5) as result',[request,user,conversation,channel,content])).rows[0].result;
}

test('durable outbound claim serializes duplicate intents and binds actor, tenant, route and text',async()=>{
 const {db,conversation}=await setup();
 try {
  assert.equal((await db.query("select to_regclass('public.crm_outbound_requests') as name")).rows[0].name,'crm_outbound_requests');
  await db.exec('set role service_role');
  const results=await Promise.all([claim(db,conversation),claim(db,conversation)]);
  assert.equal(results.filter(r=>r.claimed).length,1);
  assert.equal(results[0].state,'in_flight');assert.equal(results[1].state,'in_flight');
  assert.equal((await claim(db,conversation)).claimed,false);
  await assert.rejects(claim(db,conversation,id(501),id(11),id(201),'Outro texto'),/outbound_request_conflict/);
  await assert.rejects(claim(db,conversation,id(502),id(22)),/outbound_access_denied/);
  await assert.rejects(claim(db,conversation,id(502),id(11),id(202)),/outbound_route_unavailable/);
  await db.exec('reset role');
  await db.query('insert into org_members(org_id,user_id) values ($1,$2)',[id(1),id(12)]);
  await db.exec('set role service_role');
  await assert.rejects(claim(db,conversation,id(501),id(12)),/outbound_request_conflict/);
  await db.exec('reset role');
  await db.query("update channels set inbox_key=null where id=$1",[id(201)]);
  await db.exec('set role service_role');
  await assert.rejects(claim(db,conversation,id(503)),/outbound_route_unavailable/);
 } finally {await db.close()}
});

test('only the claim owner may atomically persist accepted messages and replays return that exact message',async()=>{
 const {db,conversation}=await setup();
 try {
  assert.equal((await db.query("select to_regclass('public.crm_outbound_requests') as name")).rows[0].name,'crm_outbound_requests');
  await db.exec('set role service_role');
  const first=await claim(db,conversation);
  await assert.rejects(db.query('select complete_crm_outbound_request($1,$2,$3)',[id(501),id(999),'wamid.one']),/outbound_claim_invalid/);
  const completed=(await db.query('select complete_crm_outbound_request($1,$2,$3) as result',[id(501),first.claim_token,'wamid.one'])).rows[0].result;
  assert.equal(completed.state,'sent');assert.equal(completed.message.content,'Olá');
  const replay=await claim(db,conversation);
  assert.equal(replay.claimed,false);assert.equal(replay.state,'sent');
  assert.equal(replay.message.id,completed.message.id);
  await db.exec('reset role');
  assert.equal((await db.query("select count(*)::int as n from crm_messages where whatsapp_message_id='wamid.one'")).rows[0].n,1);
  await assert.rejects(db.query('update crm_outbound_requests set content=$1 where request_id=$2',['Changed',id(501)]),/outbound_identity_immutable/);
  await db.exec('set role service_role');
  await assert.rejects(db.query("update crm_outbound_requests set state='pending' where request_id=$1",[id(501)]),/permission denied/);
 } finally {await db.close()}
});

test('unknown, rejected and storage-failed outcomes are terminal and cannot obtain a new send claim',async()=>{
 const {db,conversation}=await setup();
 try {
  assert.equal((await db.query("select to_regclass('public.crm_outbound_requests') as name")).rows[0].name,'crm_outbound_requests');
  await db.exec('set role service_role');
  for(const [n,state,reason] of [[501,'uncertain','transport_timeout'],[502,'failed','provider_rejected']]) {
   const first=await claim(db,conversation,id(n));
   await db.query('select finish_crm_outbound_request($1,$2,$3,$4,$5)',[id(n),first.claim_token,state,reason,null]);
   const replay=await claim(db,conversation,id(n));assert.equal(replay.claimed,false);assert.equal(replay.state,state);
   if(state==='failed') await assert.rejects(db.query('select complete_crm_outbound_request($1,$2,$3)',[id(n),first.claim_token,'wamid.late']),/outbound_claim_invalid/);
  }
  const first=await claim(db,conversation,id(503));
  await assert.rejects(db.query('select complete_crm_outbound_request($1,$2,$3)',[id(503),first.claim_token,'']),/outbound_provider_id_required/);
  await db.exec('reset role');
  await db.exec(`create function fail_synthetic_message() returns trigger language plpgsql as $$ begin raise exception 'synthetic storage failure'; end $$;
  create trigger fail_synthetic_message before insert on crm_messages for each row execute function fail_synthetic_message();`);
  await db.exec('set role service_role');
  await assert.rejects(db.query('select complete_crm_outbound_request($1,$2,$3)',[id(503),first.claim_token,'wamid.accepted']),/synthetic storage failure/);
  assert.equal((await claim(db,conversation,id(503))).state,'in_flight');
  await db.query('select finish_crm_outbound_request($1,$2,$3,$4,$5)',[id(503),first.claim_token,'uncertain','storage_failed','wamid.accepted']);
  const replay=await claim(db,conversation,id(503));assert.equal(replay.claimed,false);assert.equal(replay.state,'uncertain');assert.equal(replay.provider_message_id,'wamid.accepted');
 } finally {await db.close()}
});

test('abandoned claims become uncertain without lease reclamation; authenticated clients cannot write or invoke service RPCs',async()=>{
 const {db,conversation}=await setup();
 try {
  assert.equal((await db.query("select to_regclass('public.crm_outbound_requests') as name")).rows[0].name,'crm_outbound_requests');
  await db.exec('set role service_role');await claim(db,conversation);
  await db.exec('reset role');
  await db.query("update crm_outbound_requests set claimed_at=now()-interval '10 minutes' where request_id=$1",[id(501)]);
  await db.exec('set role service_role');
  const replay=await claim(db,conversation);assert.equal(replay.claimed,false);assert.equal(replay.state,'uncertain');
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(11)]);
  await db.exec('set role authenticated');
  await assert.rejects(claim(db,conversation),/permission denied/);
  await assert.rejects(db.query('select complete_crm_outbound_request($1,$2,$3)',[id(501),id(999),'wamid']),/permission denied/);
  await assert.rejects(db.query('select * from crm_outbound_requests'),/permission denied/);
  await assert.rejects(db.query('delete from crm_outbound_requests'),/permission denied/);
 } finally {await db.close()}
});

test('late confirmation completes the original uncertain claim without allowing another dispatch',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');const first=await claim(db,conversation);
  await db.exec('reset role');await db.query("update crm_outbound_requests set claimed_at=now()-interval '10 minutes' where request_id=$1",[id(501)]);
  await db.exec('set role service_role');assert.equal((await claim(db,conversation)).state,'uncertain');
  const complete=(await db.query('select complete_crm_outbound_request($1,$2,$3) as result',[id(501),first.claim_token,'wamid.late.confirmed'])).rows[0].result;
  assert.equal(complete.state,'sent');assert.equal((await claim(db,conversation)).claimed,false);
 }finally{await db.close()}
});

test('member ledger reads exclude claim tokens, tenant access is isolated, and access revocation does not erase audit history',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');await claim(db,conversation);
  await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(11)]);await db.exec('set role authenticated');
  const own=(await db.query('select request_id,content,state from crm_outbound_requests')).rows;assert.equal(own.length,1);assert.equal(own[0].content,'Olá');
  await assert.rejects(db.query('select claim_token from crm_outbound_requests'),/permission denied/);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(22)]);
  assert.equal((await db.query('select request_id,content,state from crm_outbound_requests')).rows.length,0);
  await db.exec('reset role');await db.query('delete from org_members where user_id=$1',[id(11)]);
  await db.exec('set role service_role');
  await assert.rejects(claim(db,conversation),/outbound_access_denied/);
  const hidden=(await db.query('select get_crm_outbound_request($1,$2) as result',[id(501),id(11)])).rows[0].result;assert.equal(hidden.state,'not_found');
 }finally{await db.close()}
});

test('late accepted-but-unsaved evidence enriches uncertainty without replacing a known provider ID',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');const first=await claim(db,conversation);
  await db.exec('reset role');await db.query("update crm_outbound_requests set claimed_at=now()-interval '10 minutes' where request_id=$1",[id(501)]);
  await db.exec('set role service_role');assert.equal((await claim(db,conversation)).state,'uncertain');
  const update=(await db.query('select finish_crm_outbound_request($1,$2,$3,$4,$5) as result',[id(501),first.claim_token,'uncertain','storage_failed','wamid.known'])).rows[0].result;
  assert.equal(update.provider_message_id,'wamid.known');assert.equal(update.state,'uncertain');
  await assert.rejects(db.query('select finish_crm_outbound_request($1,$2,$3,$4,$5)',[id(501),first.claim_token,'uncertain','storage_failed','wamid.different']),/outbound_provider_id_conflict/);
  assert.equal((await claim(db,conversation)).claimed,false);
 }finally{await db.close()}
});

test('status lookup of an abandoned claim reports uncertainty without changing stored state',async()=>{
 const {db,conversation}=await setup();try {
  await db.exec('set role service_role');await claim(db,conversation);
  await db.exec('reset role');await db.query("update crm_outbound_requests set claimed_at=now()-interval '10 minutes' where request_id=$1",[id(501)]);
  await db.exec('set role service_role');const result=(await db.query('select get_crm_outbound_request($1,$2) as result',[id(501),id(11)])).rows[0].result;
  assert.equal(result.state,'uncertain');assert.equal(result.claim_token,undefined);
  await db.exec('reset role');assert.equal((await db.query('select state from crm_outbound_requests')).rows[0].state,'in_flight');
 }finally{await db.close()}
});
