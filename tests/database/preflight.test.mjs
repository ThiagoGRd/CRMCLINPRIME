import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const load = name => readFile(new URL(name,import.meta.url),'utf8');
async function audit(db) {
  let sql='';
  try { sql=await load('../../docs/schema/crm-preflight.sql'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const notices=[];
  const results=await db.exec(sql,{onNotice: notice => {
    if (notice.message.startsWith('CRM_PREFLIGHT ')) notices.push(JSON.parse(notice.message.slice('CRM_PREFLIGHT '.length)));
  }});
  return {rows:results.flatMap(result=>result.rows),notices};
}
const find=(rows,check)=>rows.find(row=>row.check_id === check);

test('preflight reports missing predecessor schema without creating objects or aborting',async()=>{
  const db=new PGlite();
  try {
    const before=(await db.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace")).rows[0].n;
    const result=await audit(db);
    assert.equal(find(result.rows,'crm_patients.org_id')?.status,'missing');
    assert.equal(find(result.rows,'auth.uid()')?.status,'missing');
    assert.equal(find(result.rows,'audit_context')?.details.transaction_read_only,'on');
    assert.equal(find(result.rows,'supabase_realtime')?.status,'missing');
    assert.equal(find(result.notices,'duplicate_org_memberships')?.status,'skipped_missing_columns');
    const after=(await db.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace")).rows[0].n;
    assert.equal(after,before);
  } finally {await db.close();}
});

test('preflight counts duplicate memberships and cross-org legacy links without returning records',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await load('./fixture.sql'));
    await db.exec(`alter table org_members drop constraint org_members_pkey;
      insert into org_members select * from org_members where user_id='00000000-0000-0000-0000-000000000011';
      insert into crm_messages(org_id,patient_id,channel_id,whatsapp_message_id)
      values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000203','synthetic-private-message');`);
    const result=await audit(db);
    assert.equal(find(result.notices,'duplicate_org_memberships')?.count,1);
    assert.equal(find(result.notices,'messages_patient_outside_org')?.count,1);
    assert.equal(find(result.notices,'messages_channel_outside_org')?.count,1);
    assert.equal(find(result.notices,'legacy_messages_without_channel')?.count,1);
    assert.equal(find(result.rows,'crm_messages.rls')?.status,'disabled');
    assert.equal(JSON.stringify(result).includes('synthetic-private-message'),false);
    assert.equal(JSON.stringify(result).includes('00000000-0000-0000-0000-000000000011'),false);
    assert.equal((await db.query('select count(*)::int as n from org_members')).rows[0].n,3);
    assert.equal((await db.query('select count(*)::int as n from crm_messages')).rows[0].n,2);
  } finally {await db.close();}
});

test('preflight inventories actual policies, privileges and three-table publication after hardening',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await load('./fixture.sql'));
    await db.exec(await load('../../supabase/migrations/20261103030000_crm_foundation.sql'));
    await db.exec(`alter table crm_messages enable row level security;
      create policy synthetic_message_read on crm_messages for select to authenticated using (public.crm_is_org_member(org_id));
      create publication supabase_realtime;`);
    await db.exec(await load('../../supabase/migrations/20261103040000_crm_security_realtime.sql'));
    const result=await audit(db);
    for (const table of ['crm_conversations','crm_messages','crm_pending_items']) {
      assert.equal(find(result.rows,`${table}.rls`)?.status,'enabled');
      assert.equal(find(result.rows,`${table}.realtime`)?.status,'member');
    }
    assert.ok(result.rows.some(row=>row.section === 'policies' && row.details.policy === 'synthetic_message_read'));
    const authPrivileges=find(result.rows,'crm_pending_items.authenticated');
    assert.equal(authPrivileges?.details.truncate,false);
    assert.equal(authPrivileges?.details.update,true);
    assert.equal(find(result.notices,'duplicate_org_memberships')?.count,0);
    assert.equal(find(result.rows,'crm_pending_work_queue')?.status,'valid');
    assert.equal(find(result.rows,'resolve_pending_item(uuid, text).anon')?.details.execute,false);
  } finally {await db.close();}
});

test('preflight never reports RLS-filtered data as a clean complete audit',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await load('./fixture.sql'));
    await db.exec('grant select on all tables in schema public to authenticated; alter table crm_messages enable row level security;');
    await db.exec('set role authenticated');
    const result=await audit(db);
    assert.equal(find(result.notices,'messages_patient_outside_org')?.status,'blocked');
    assert.equal(find(result.notices,'messages_patient_outside_org')?.count,null);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as n from crm_messages')).rows[0].n,1);
  } finally {await db.close();}
});

test('preflight exposes unsafe outbox grants and RLS plus missing message write columns after the full migration chain',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await load('./fixture.sql'));
    await db.exec(await load('../../supabase/migrations/20261103030000_crm_foundation.sql'));
    await db.exec(`alter table crm_messages enable row level security;
      create publication supabase_realtime;
      alter table crm_messages add column direction text, add column content text,
        add column message_type text, add column status text, add column sent_by uuid;`);
    await db.exec(await load('../../supabase/migrations/20261103040000_crm_security_realtime.sql'));
    await db.exec(await load('../../supabase/migrations/20261103050000_crm_outbound_requests.sql'));
    const safe=await audit(db);
    assert.equal(find(safe.rows,'crm_outbound_requests.rls')?.status,'enabled');
    assert.equal(find(safe.rows,'crm_outbound_requests.claim_token.authenticated')?.details.select,false);
    assert.equal(find(safe.rows,'claim_crm_outbound_request(uuid, uuid, uuid, uuid, text).authenticated')?.details.execute,false);
    for(const name of ['direction','content','message_type','status','sent_by']) {
      assert.equal(find(safe.rows,`crm_messages.${name}`)?.status,'present');
    }
    await db.exec(`alter table crm_outbound_requests disable row level security;
      grant select(claim_token) on crm_outbound_requests to authenticated;
      grant execute on function claim_crm_outbound_request(uuid,uuid,uuid,uuid,text) to authenticated;
      alter table crm_messages drop column sent_by;`);
    const unsafe=await audit(db);
    assert.equal(find(unsafe.rows,'crm_outbound_requests.rls')?.status,'disabled');
    assert.equal(find(unsafe.rows,'crm_outbound_requests.claim_token.authenticated')?.details.select,true);
    assert.equal(find(unsafe.rows,'claim_crm_outbound_request(uuid, uuid, uuid, uuid, text).authenticated')?.details.execute,true);
    assert.equal(find(unsafe.rows,'crm_messages.sent_by')?.status,'missing');
    for(const name of ['complete_crm_outbound_request','finish_crm_outbound_request','get_crm_outbound_request']) {
      assert.ok(unsafe.rows.some(row=>row.section==='function_privileges' && row.check_id.startsWith(name+'(') && row.check_id.endsWith('.authenticated') && row.details.execute===false));
    }
  } finally {await db.close();}
});
