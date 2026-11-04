import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
test('synthetic migration enforces tenant identity, durable work, explicit audited resolution and monotonic activity', async () => {
 const db = new PGlite();
 try {
 await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
 const migration = new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url);
 let sql=''; try { sql=await readFile(migration,'utf8'); } catch {}
 await db.exec(sql);
 assert.equal((await db.query("select to_regclass('public.crm_conversations') as name")).rows[0].name,'crm_conversations');
 const insertConversation = async (patient,channel) => (await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning id',[id(1),id(patient),id(channel)])).rows[0].id;
 const a=await insertConversation(101,201), b=await insertConversation(101,202);
 assert.notEqual(a,b);
 await db.query('insert into crm_patients(id,org_id) values ($1,$2)',[id(103),id(1)]);
 await assert.rejects(db.query('update crm_conversations set patient_id=$1 where id=$2',[id(103),a]),/identidade/);
 await assert.rejects(insertConversation(101,201),/unique/);
 await assert.rejects(insertConversation(102,201),/foreign key/);
 await assert.rejects(insertConversation(101,203),/foreign key/);
 assert.equal((await db.query("select conversation_id from crm_messages where whatsapp_message_id='legacy'")).rows[0].conversation_id,null);
 const pending = (assignee,due,conversation=a) => db.query("insert into crm_pending_items(org_id,patient_id,conversation_id,title,assigned_to,due_at) values ($1,$2,$3,'Retornar ao paciente',$4,$5) returning id",[id(1),id(101),conversation,assignee,due]);
 await assert.rejects(pending(null,'2026-12-01'),/not-null/);
 await assert.rejects(pending(id(11),null),/not-null/);
 await assert.rejects(pending(id(22),'2026-12-01'),/foreign key/);
 const p=(await pending(id(11),'2026-12-01')).rows[0].id;
 await db.query("insert into crm_messages(org_id,patient_id,channel_id,whatsapp_message_id,created_at) values ($1,$2,$3,'new','2026-11-03'),($1,$2,$3,'old','2026-11-01')",[id(1),id(101),id(201)]);
 await db.query("insert into crm_messages(org_id,patient_id,channel_id,whatsapp_message_id,created_at) values ($1,$2,$3,'new','2026-11-03') on conflict(whatsapp_message_id) do nothing",[id(1),id(101),id(201)]);
 assert.equal((await db.query('select status from crm_pending_items where id=$1',[p])).rows[0].status,'open');
 assert.equal((await db.query('select last_message_at::text as at from crm_conversations where id=$1',[a])).rows[0].at,'2026-11-03 00:00:00+00');
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(11)]);
 await db.exec('set role authenticated');
 await assert.rejects(db.query("update crm_pending_items set status='resolved',resolution_evidence='done',resolved_by=$2,resolved_at=now() where id=$1",[p,id(11)]),/resolve_pending_item/);
 await assert.rejects(db.query('select resolve_pending_item($1,$2)',[p,'   ']),/evid/);
 await db.query('select resolve_pending_item($1,$2)',[p,'Paciente confirmou atendimento']);
 const resolved=(await db.query('select * from crm_pending_items where id=$1',[p])).rows[0];
 assert.equal(resolved.status,'resolved'); assert.equal(resolved.resolved_by,id(11)); assert.ok(resolved.resolved_at);
 await assert.rejects(db.query("update crm_pending_items set status='open' where id=$1",[p]),/resol/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(22)]);
 assert.equal((await db.query('select * from crm_pending_items')).rows.length,0);
 assert.equal((await db.query('select * from crm_conversations')).rows.length,0);
 await assert.rejects(pending(id(11),'2026-12-01'),/row-level security/);
 await assert.rejects(insertConversation(101,201),/row-level security/);
 await assert.rejects(db.query('select resolve_pending_item($1,$2)',[p,'not mine']),/acesso/);
 } finally { await db.close(); }
});

test('known legacy messages backfill exactly and invalid legacy tenant references abort migration',async()=>{
 const fixture=await readFile(new URL('./fixture.sql',import.meta.url),'utf8');
 const migration=await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8');
 const db=new PGlite();
 try {
  await db.exec(fixture);
  await db.query("insert into crm_messages(org_id,patient_id,channel_id,whatsapp_message_id,created_at) values ($1,$2,$3,'known','2026-10-01')",[id(1),id(101),id(201)]);
  await db.exec(migration);
  const rows=(await db.query('select m.conversation_id,c.channel_id from crm_messages m join crm_conversations c on c.id=m.conversation_id')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].channel_id,id(201));
 } finally {await db.close()}
 const invalid=new PGlite();
 try {
  await invalid.exec(fixture);
  await invalid.query("insert into crm_messages(org_id,patient_id,channel_id) values ($1,$2,$3)",[id(1),id(101),id(203)]);
  await assert.rejects(invalid.exec(migration),/foreign key/);
  await invalid.exec('rollback');
  assert.equal((await invalid.query("select to_regclass('public.crm_conversations') as name")).rows[0].name,null);
 } finally {await invalid.close()}
});

test('service-only patient creation reuses canonical identity and creates one initial deal',async()=>{
 const db=new PGlite();
 try {
 await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));
 assert.ok((await db.query("select to_regprocedure('public.ensure_whatsapp_patient(uuid,text,text)') as name")).rows[0].name);
 await db.exec('set role service_role');
 const create=async()=> (await db.query('select ensure_whatsapp_patient($1,$2,$3) as id',[id(1),'82991212108','Synthetic Patient'])).rows[0].id;
 const first=await create();assert.equal(await create(),first);
 await db.exec('reset role');
 assert.equal((await db.query('select count(*)::int as n from crm_patients where phone=$1',['82991212108'])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int as n from crm_deals where patient_id=$1',[first])).rows[0].n,1);
 await db.exec('set role authenticated');
 await assert.rejects(create(),/permission denied/);
 } finally {await db.close()}
});

test('UI-created pending item accepts an optional empty description', async () => {
 const {buildPendingCreate} = await import('../../lib/pending-items.ts');
 const db = new PGlite();
 try {
  await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));
  const c=(await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning id',[id(1),id(101),id(201)])).rows[0].id;
  const payload=buildPendingCreate(id(1),id(101),c,{title:'Retornar',description:'  ',assigned_to:id(11),due_at:'2026-12-01T09:00:00Z',status:'open'},[id(11)]);
  const columns=Object.keys(payload);
  const row=(await db.query(`insert into crm_pending_items (${columns.join(',')}) values (${columns.map((_,i)=>'$'+(i+1)).join(',')}) returning description`,Object.values(payload))).rows[0];
  assert.equal(row.description,'');
 } finally {await db.close()}
});

test('messages without a known channel still enforce patient tenant identity', async () => {
 const db=new PGlite();
 try {
  await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));
  await assert.rejects(db.query('insert into crm_messages(org_id,patient_id,channel_id) values ($1,$2,NULL)',[id(1),id(102)]),/foreign key/);
 } finally {await db.close()}
});

test('resolution rejects all-whitespace evidence at the RPC boundary', async () => {
 const db=new PGlite();
 try {
  await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));
  const c=(await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning id',[id(1),id(101),id(201)])).rows[0].id;
  const p=(await db.query("insert into crm_pending_items(org_id,patient_id,conversation_id,title,assigned_to,due_at) values ($1,$2,$3,'Confirmar',$4,'2026-12-01') returning id",[id(1),id(101),c,id(11)])).rows[0].id;
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(11)]);await db.exec('set role authenticated');
  for(const evidence of ['\n','\t',' \n\t ']) await assert.rejects(db.query('select resolve_pending_item($1,$2)',[p,evidence]),/evid/);
 } finally {await db.close()}
});
