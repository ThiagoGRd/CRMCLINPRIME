import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const load = name => readFile(new URL(name, import.meta.url), 'utf8');
const hardening = async () => {
  try { return await load('../../supabase/migrations/20261103040000_crm_security_realtime.sql'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
};
async function setup({ publication = true, messageRls = true } = {}) {
  const db = new PGlite();
  await db.exec(await load('./fixture.sql'));
  // Reproduce permissive Supabase-style defaults; the new migration must narrow them.
  await db.exec(`grant usage on schema public, auth to anon;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  await db.exec(await load('../../supabase/migrations/20261103030000_crm_foundation.sql'));
  if (messageRls) await db.exec(`alter table crm_messages enable row level security;
    create policy synthetic_message_read on crm_messages for select to authenticated
    using (public.crm_is_org_member(org_id));`);
  if (publication) await db.exec('create publication supabase_realtime for table public.channels, public.crm_messages');
  return db;
}
async function login(db, actor, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor ? id(actor) : '']);
  await db.exec(`set role ${role}`);
}
async function seed(db, org = 1, patient = 101, channel = 201, assignee = 11) {
  const conversation = (await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning id', [id(org), id(patient), id(channel)])).rows[0].id;
  const pending = (await db.query("insert into crm_pending_items(org_id,patient_id,conversation_id,title,assigned_to,due_at) values ($1,$2,$3,'Confirmar atendimento',$4,'2026-12-01') returning id", [id(org),id(patient),conversation,id(assignee)])).rows[0].id;
  return {conversation,pending};
}

test('permissive defaults cannot give anon or authenticated destructive access to new CRM tables', async () => {
  const db = await setup();
  try {
    await db.exec(await hardening());
    const {pending} = await seed(db);
    for (const role of ['anon', 'authenticated']) {
      await login(db, role === 'authenticated' ? 11 : null, role);
      for (const table of ['crm_pending_items', 'crm_conversations']) {
        const privileges = (await db.query(`select has_table_privilege(current_user,$1,'DELETE') as delete,
          has_table_privilege(current_user,$1,'TRUNCATE') as truncate,
          has_table_privilege(current_user,$1,'TRIGGER') as trigger`, [table])).rows[0];
        assert.deepEqual(privileges, {delete:false,truncate:false,trigger:false});
      }
      await assert.rejects(db.exec('truncate crm_pending_items'), /permission denied/);
      await assert.rejects(db.query('delete from crm_pending_items where id=$1',[pending]), /permission denied/);
      if (role === 'anon') {
        await assert.rejects(db.query('select * from crm_pending_items'), /permission denied/);
        await assert.rejects(db.query('select * from crm_conversations'), /permission denied/);
        await assert.rejects(db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3)',[id(1),id(101),id(202)]), /permission denied/);
        await assert.rejects(db.query("update crm_pending_items set title='anonymous' where id=$1",[pending]), /permission denied/);
        await assert.rejects(db.query('select resolve_pending_item($1,$2)',[pending,'confirmed']), /permission denied/);
        await assert.rejects(db.query('select crm_is_org_member($1)',[id(1)]), /permission denied/);
      }
    }
    assert.equal((await db.query("update crm_pending_items set status='in_progress' where id=$1 returning status",[pending])).rows[0].status,'in_progress');
  } finally { await db.close(); }
});

test('pending primary identity cannot be rewritten by its own organization', async () => {
  const db = await setup();
  try {
    await db.exec(await hardening());
    const {pending} = await seed(db);
    await login(db,11);
    await assert.rejects(db.query('update crm_pending_items set id=$1 where id=$2',[id(901),pending]), /identidade/);
    assert.equal((await db.query('select id from crm_pending_items')).rows[0].id,pending);
  } finally { await db.close(); }
});

test('RLS rejects missing identity, nonmembers and cross-tenant reads, writes and resolution', async () => {
  const db = await setup();
  try {
    await db.exec(await hardening());
    const own = await seed(db);
    const other = await seed(db,2,102,203,22);
    for (const actor of [null,33,22]) {
      await login(db,actor);
      assert.equal((await db.query('select id from crm_pending_items where id=$1',[own.pending])).rows.length,0);
      assert.equal((await db.query('select id from crm_conversations where id=$1',[own.conversation])).rows.length,0);
      assert.equal((await db.query("update crm_pending_items set title='tampered' where id=$1 returning id",[own.pending])).rows.length,0);
      assert.equal((await db.query("update crm_conversations set status='closed' where id=$1 returning id",[own.conversation])).rows.length,0);
      await assert.rejects(db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3)',[id(1),id(101),id(202)]),/row-level security/);
      await assert.rejects(db.query("insert into crm_pending_items(org_id,patient_id,conversation_id,title,assigned_to,due_at) values ($1,$2,$3,'forbidden',$4,now())",[id(1),id(101),own.conversation,id(11)]),/row-level security/);
      await assert.rejects(db.query('select resolve_pending_item($1,$2)',[own.pending,'not mine']),/acesso/);
    }
    await login(db,11);
    await assert.rejects(db.query('update crm_pending_items set assigned_to=$1 where id=$2',[id(22),own.pending]),/foreign key/);
    await assert.rejects(db.query('update crm_conversations set assigned_to=$1 where id=$2',[id(22),own.conversation]),/foreign key/);
    await assert.rejects(db.query('update crm_pending_items set conversation_id=$1 where id=$2',[other.conversation,own.pending]),/identidade/);
    await assert.rejects(db.query('update crm_pending_items set org_id=$1 where id=$2',[id(2),own.pending]),/identidade|row-level security/);
    const resolved=(await db.query('select * from resolve_pending_item($1,$2)',[own.pending,'Paciente confirmou'])).rows[0];
    assert.equal(resolved.resolved_by,id(11));
    await assert.rejects(db.query("update crm_pending_items set title='changed evidence' where id=$1",[own.pending]),/resolvida/);
  } finally { await db.close(); }
});

test('service role retains ingestion but cannot impersonate a human pending resolution', async () => {
  const db = await setup();
  try {
    await db.exec(await hardening());
    const {pending} = await seed(db);
    await login(db,null,'service_role');
    assert.equal((await db.query('select id from crm_conversations')).rows.length,1);
    await assert.rejects(db.query('select resolve_pending_item($1,$2)',[pending,'service claimed']),/permission denied/);
    await assert.rejects(db.query("update crm_pending_items set status='resolved',resolution_evidence='service claimed',resolved_by=$1,resolved_at=now() where id=$2",[id(11),pending]),/resolve_pending_item/);
    await assert.rejects(db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3)',[id(1),id(102),id(201)]),/foreign key/);
    assert.ok((await db.query('select ensure_whatsapp_patient($1,$2,$3) as id',[id(1),'82991212108','Synthetic'])).rows[0].id);
    for (const role of ['anon','authenticated']) {
      await login(db,role === 'authenticated' ? 11 : null,role);
      await assert.rejects(db.query('select ensure_whatsapp_patient($1,$2,$3)',[id(1),'82991212108','Synthetic']),/permission denied/);
    }
  } finally { await db.close(); }
});

test('Realtime registration is idempotent and preserves unrelated existing membership', async () => {
  const db = await setup();
  try {
    await db.exec(await hardening());
    await db.exec(await hardening());
    assert.deepEqual((await db.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(row=>row.tablename),['channels','crm_conversations','crm_messages','crm_pending_items']);
  } finally { await db.close(); }
});

for (const [options,reason] of [[{messageRls:false},/crm_messages.*RLS/],[{publication:false},/supabase_realtime/]]) {
  test(`Realtime registration fails closed for ${options.messageRls === false ? 'unprotected messages' : 'missing publication'}`, async () => {
    const db = await setup(options);
    try {
      await assert.rejects(db.exec(await hardening()),reason);
      await db.exec('rollback');
      assert.equal((await db.query("select has_table_privilege('authenticated','crm_pending_items','TRUNCATE') as allowed")).rows[0].allowed,true);
    } finally { await db.close(); }
  });
}

test('all-table publication coverage is retained without trying to register duplicate tables', async () => {
  const db=await setup();
  try {
    await db.exec('drop publication supabase_realtime; create publication supabase_realtime for all tables');
    await db.exec(await hardening());
    await db.exec(await hardening());
    assert.equal((await db.query("select puballtables from pg_publication where pubname='supabase_realtime'")).rows[0].puballtables,true);
    assert.equal((await db.query("select count(*)::int as n from pg_publication_tables where pubname='supabase_realtime' and tablename in ('crm_conversations','crm_messages','crm_pending_items')")).rows[0].n,3);
  } finally {await db.close();}
});

test('ordered 300, 400 and 500 migrations preserve service ingestion and deny browser outbox tokens', async () => {
  const db=await setup();
  try {
    await db.exec(await hardening());
    await db.exec(`alter table crm_messages add column direction text, add column content text,
      add column message_type text, add column status text, add column sent_by uuid;
      update channels set inbox_key='reception';`);
    await db.exec(await load('../../supabase/migrations/20261103050000_crm_outbound_requests.sql'));
    const {conversation}=await seed(db);
    await login(db,null,'service_role');
    const claim=(await db.query('select claim_crm_outbound_request($1,$2,$3,$4,$5) as result',
      [id(501),id(11),conversation,id(201),'Mensagem sintética'])).rows[0].result;
    assert.equal(claim.claimed,true);
    assert.equal(claim.state,'in_flight');
    const completed=(await db.query('select complete_crm_outbound_request($1,$2,$3) as result',
      [id(501),claim.claim_token,'synthetic-hardening-wamid'])).rows[0].result;
    assert.equal(completed.state,'sent');
    await login(db,11);
    assert.equal((await db.query('select state from crm_outbound_requests')).rows[0].state,'sent');
    await assert.rejects(db.query('select claim_token from crm_outbound_requests'),/permission denied/);
    await assert.rejects(db.exec('truncate crm_outbound_requests'),/permission denied/);
    await login(db,22);
    assert.equal((await db.query('select request_id from crm_outbound_requests')).rows.length,0);
    await login(db,null,'anon');
    await assert.rejects(db.query('select request_id from crm_outbound_requests'),/permission denied/);
  } finally {await db.close();}
});
