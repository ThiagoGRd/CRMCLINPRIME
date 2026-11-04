import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
async function setup(){const db=new PGlite();await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));await db.exec(`alter table org_members add column role text default 'admin'; alter table crm_messages add column direction text, add column content text, add column message_type text, add column status text, add column sent_by uuid;update channels set inbox_key='reception';`);for(const name of ['50000_crm_outbound_requests','60000_crm_outbound_reconciliation','70000_whatsapp_window_templates']){const sql=await readFile(new URL(`../../supabase/migrations/202611030${name}.sql`,import.meta.url),'utf8').catch(()=>'');if(sql)await db.exec(sql)}const conversation=(await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values($1,$2,$3) returning id',[id(1),id(101),id(201)])).rows[0].id;return{db,conversation}}
const claim=async(db,c,n=501,kind='text',payload=null,content='Olá')=>(await db.query('select claim_crm_outbound_request($1,$2,$3,$4,$5,$6,$7) result',[id(n),id(11),c,id(201),content,kind,payload])).rows[0].result;
const inbound=(db,channel=id(201),age='1 hour',direction='inbound')=>db.query(`insert into crm_messages(org_id,patient_id,channel_id,direction,created_at) values($1,$2,$3,$4,clock_timestamp()-$5::interval)`,[id(1),id(101),channel,direction,age]);
const payload={id:'123',name:'appointment',language:'pt_BR',header:[],body:['Ana']};
test('claim records terminal local rejection without dispatch; only exact-route recent inbound opens a new intent',async()=>{const{db,conversation}=await setup();try{
 const blocked=await claim(db,conversation);assert.equal(blocked.state,'failed');assert.equal(blocked.claimed,false);assert.equal(blocked.claim_token,null);assert.equal(blocked.failure_code,'outside_service_window');
 await inbound(db,id(202));await inbound(db,id(201),'1 minute','outbound');assert.equal((await claim(db,conversation,502)).failure_code,'outside_service_window');
 await inbound(db,id(201),'24 hours');assert.equal((await claim(db,conversation,503)).state,'failed');await inbound(db);assert.equal((await claim(db,conversation,504)).claimed,true);
 assert.equal((await claim(db,conversation)).state,'failed');
 await inbound(db,id(201),'-1 hour');assert.equal((await claim(db,conversation,505)).state,'failed');assert.equal((await claim(db,conversation,504)).claimed,false);
}finally{await db.close()}});
test('approved server template payload bypasses closed window but request identity binds kind, exact template and values',async()=>{const{db,conversation}=await setup();try{
 const first=await claim(db,conversation,501,'template',payload);assert.equal(first.claimed,true);assert.equal((await claim(db,conversation,501,'template',payload)).claimed,false);
 for(const changed of [{...payload,name:'other'},{...payload,language:'en_US'},{...payload,body:['Other']}])await assert.rejects(claim(db,conversation,501,'template',changed),/outbound_request_conflict/);
 await assert.rejects(claim(db,conversation),/outbound_request_conflict/);await assert.rejects(claim(db,conversation,502,'template',null),/outbound_input_invalid/);await assert.rejects(claim(db,conversation,502,'text',payload),/outbound_input_invalid/);
 await assert.rejects(db.query('update crm_outbound_requests set template_payload=$1 where request_id=$2',[{...payload,name:'other'},id(501)]),/outbound_identity_immutable/);
 await db.query('select finish_crm_outbound_request($1,$2,$3,$4,$5)',[id(501),first.claim_token,'uncertain','storage_failed','wamid.template']);
 const result=(await db.query('select reconcile_crm_outbound_request($1,$2,$3,$4,$5) result',[id(501),id(11),conversation,'finalize','Synthetic provider evidence'])).rows[0].result;
 assert.equal(result.state,'sent');assert.equal((await db.query('select message_type,content from crm_messages where id=$1',[result.message.id])).rows[0].message_type,'template');
}finally{await db.close()}});
test('window RPC isolates auth and reads exact route while cancelled tombstone still prevents delayed template/text claims',async()=>{const{db,conversation}=await setup();try{
 await inbound(db);const win=(await db.query('select get_crm_whatsapp_window($1,$2,$3) result',[conversation,id(201),id(11)])).rows[0].result;assert.equal(win.open,true);assert.equal(win.reason,'open');
 await assert.rejects(db.query('select get_crm_whatsapp_window($1,$2,$3)',[conversation,id(202),id(11)]),/outbound_route_unavailable/);
 await assert.rejects(db.query('select get_crm_whatsapp_window($1,$2,$3)',[conversation,id(201),id(22)]),/outbound_access_denied/);
 await db.query('select reconcile_crm_outbound_request($1,$2,$3,$4,$5)',[id(501),id(11),conversation,'cancel','Synthetic cancellation']);
 assert.equal((await claim(db,conversation,501,'template',payload)).state,'cancelled');assert.equal((await claim(db,conversation)).state,'cancelled');
 await db.exec('set role authenticated');await assert.rejects(db.query('select get_crm_whatsapp_window($1,$2,$3)',[conversation,id(201),id(11)]),/permission denied/);await assert.rejects(claim(db,conversation,502,'template',payload),/permission denied/);
}finally{await db.close()}});
