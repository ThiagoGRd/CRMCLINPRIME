import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import * as start from '../../lib/start-conversation.ts';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const load = path => readFile(new URL(path,import.meta.url),'utf8');

// Actual Supabase query builder -> in-process SQL bridge -> actual migrations/RLS.
// No Supabase project, network requests, provider credentials or WhatsApp sends.
async function setup() {
  const db = new PGlite();
  await db.exec(await load('./fixture.sql'));
  await db.exec(await load('../../supabase/migrations/20261103030000_crm_foundation.sql'));
  await db.exec(`update channels set inbox_key='reception';
    alter table channels add column display_name text default 'Recepção', add column config jsonb;
    update crm_patients set name=case when org_id='${id(1)}' then 'Maria Sem Conversa' else 'Outro Tenant' end,phone='558299991234';
    grant select on crm_patients,channels to authenticated;
    alter table crm_patients enable row level security;
    alter table channels enable row level security;
    create policy synthetic_patient_read on crm_patients for select to authenticated using (crm_is_org_member(org_id));
    create policy synthetic_channel_read on channels for select to authenticated using (crm_is_org_member(org_id));
    select set_config('request.jwt.claim.sub','${id(11)}',false);
    set role authenticated;`);
  const writes=[]; const reads=[]; let loseInsertResponse=false;
  const client=createClient('http://synthetic.invalid','synthetic-anon-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
    const url=new URL(String(input)); const table=url.pathname.split('/').at(-1);
    assert.ok(['crm_patients','channels','crm_conversations'].includes(table),'opening never calls a provider or message endpoint');
    try {
      let rows;
      if(init.method==='POST') {
        assert.equal(table,'crm_conversations');
        const body=JSON.parse(init.body); writes.push(body);
        assert.deepEqual(Object.keys(body).sort(),['channel_id','org_id','patient_id']);
        rows=(await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning *',[body.org_id,body.patient_id,body.channel_id])).rows;
        if(loseInsertResponse){loseInsertResponse=false;throw new Error('Synthetic lost response after commit');}
      } else {
        assert.equal(init.method,'GET');
        reads.push({table,filters:Object.fromEntries(url.searchParams)});
        const values=[];const clauses=[];
        for(const [column,filter] of url.searchParams) {
          if(['select','order','limit'].includes(column))continue;
          assert.ok(['org_id','id','patient_id','channel_id','name','phone'].includes(column));
          const separator=filter.indexOf('.');const operator=filter.slice(0,separator);const value=filter.slice(separator+1);
          assert.ok(['eq','ilike'].includes(operator));values.push(value);clauses.push(`${column} ${operator==='eq'?'=':'ilike'} $${values.length}`);
        }
        assert.ok(url.searchParams.has('org_id'),'every read must constrain tenant explicitly');
        const order=(url.searchParams.get('order')??'').split(',').filter(Boolean).map(value=>{assert.match(value,/^(name|id|created_at)\.(asc|desc)$/);return value.replace('.',' ');});
        const limit=Number(url.searchParams.get('limit')??1000);assert.ok(Number.isInteger(limit)&&limit>0&&limit<=1000);
        rows=(await db.query(`select * from ${table} where ${clauses.join(' and ')}${order.length?' order by '+order.join(','):''} limit ${limit}`,values)).rows;
      }
      const single=new Headers(init.headers).get('accept')?.includes('vnd.pgrst.object');
      return Response.json(single?(rows[0]??null):rows);
    }catch(error){
      return Response.json({code:error.code??'FETCH_ERROR',message:error.message,details:'',hint:''},{status:error.code==='23505'?409:400});
    }
  }}});
  return {db,client,writes,reads,loseResponse:()=>{loseInsertResponse=true;}};
}

// Omitting explicit choice or allowing an invalid route must fail before writing.
test('opening requires explicit patient/channel and rejects invalid, unavailable and unclassified routes',async()=>{
  assert.equal(typeof start.openConversation,'function');
  const f=await setup();try{
    for(const input of [
      {orgId:id(1),patientId:'',channelId:id(201)},
      {orgId:id(1),patientId:id(101),channelId:''},
      {orgId:id(1),patientId:'not-a-uuid',channelId:id(201)},
      {orgId:id(1),patientId:id(101),channelId:id(999)},
    ])await assert.rejects(start.openConversation(f.client,input));
    for(const update of ["inbox_key=null","inbox_key='reception',type='sms'","type='whatsapp_cloud',phone_number_id=null"]){
      await f.db.exec(`reset role; update channels set ${update} where id='${id(201)}'; set role authenticated;`);
      await assert.rejects(start.openConversation(f.client,{orgId:id(1),patientId:id(101),channelId:id(201)}));
    }
    assert.deepEqual(f.writes,[]);
  }finally{await f.db.close();}
});

test('explicit known disconnected number can open a conversation but never sends',async()=>{
  assert.equal(typeof start.openConversation,'function');
  const f=await setup();try{
    await f.db.exec(`reset role; update channels set status='disconnected',inbox_key='crc' where id='${id(202)}'; set role authenticated;`);
    const result=await start.openConversation(f.client,{orgId:id(1),patientId:id(101),channelId:id(202)});
    assert.equal(result.channel_id,id(202));assert.equal(result.inbox_key,'crc');assert.ok(result.id);
    assert.equal(f.writes.length,1);
    await f.db.exec('reset role');
    assert.equal((await f.db.query('select count(*)::int n from crm_messages')).rows[0].n,1);
  }finally{await f.db.close();}
});

test('repeated and simultaneous opening returns one unique conversation without changing existing metadata',async()=>{
  assert.equal(typeof start.openConversation,'function');
  const f=await setup();try{
    const input={orgId:id(1),patientId:id(101),channelId:id(201)};
    const [first,second]=await Promise.all([start.openConversation(f.client,input),start.openConversation(f.client,input)]);
    assert.equal(first.id,second.id);assert.equal((await f.db.query('select count(*)::int n from crm_conversations')).rows[0].n,1);
    await f.db.query("update crm_conversations set status='closed',assigned_to=$1 where id=$2",[id(11),first.id]);
    const before=(await f.db.query('select * from crm_conversations')).rows[0];
    assert.equal((await start.openConversation(f.client,input)).id,first.id);
    assert.deepEqual((await f.db.query('select * from crm_conversations')).rows[0],before);
    const another=await start.openConversation(f.client,{...input,channelId:id(202)});
    assert.notEqual(another.id,first.id);assert.equal(another.channel_id,id(202));
  }finally{await f.db.close();}
});

test('lost insert response recovers by exact tenant/patient/channel lookup without another write',async()=>{
  assert.equal(typeof start.openConversation,'function');
  const f=await setup();try{
    f.loseResponse();const result=await start.openConversation(f.client,{orgId:id(1),patientId:id(101),channelId:id(201)});
    assert.ok(result.id);assert.equal(f.writes.length,1);
    assert.equal((await f.db.query('select count(*)::int n from crm_conversations')).rows[0].n,1);
  }finally{await f.db.close();}
});

test('tenant boundaries reject foreign patient/channel and revoked membership with no false success',async()=>{
  assert.equal(typeof start.openConversation,'function');
  const f=await setup();try{
    for(const input of [
      {orgId:id(1),patientId:id(102),channelId:id(201)},
      {orgId:id(1),patientId:id(101),channelId:id(203)},
      {orgId:id(2),patientId:id(102),channelId:id(203)},
    ])await assert.rejects(start.openConversation(f.client,input));
    assert.deepEqual(f.writes,[]);
    await f.db.exec(`reset role; delete from org_members where user_id='${id(11)}'; set role authenticated;`);
    await assert.rejects(start.openConversation(f.client,{orgId:id(1),patientId:id(101),channelId:id(201)}));
    assert.deepEqual(f.writes,[]);
  }finally{await f.db.close();}
});

test('patient lookup and name/phone search include patients without conversations and exclude other tenants',async()=>{
  assert.equal(typeof start.searchConversationPatients,'function');assert.equal(typeof start.getConversationPatient,'function');
  const f=await setup();try{
    assert.equal((await start.getConversationPatient(f.client,id(1),id(101))).name,'Maria Sem Conversa');
    assert.equal(await start.getConversationPatient(f.client,id(1),id(102)),null);
    for(const query of ['Maria','9991234',''])assert.deepEqual((await start.searchConversationPatients(f.client,id(1),query)).map(row=>row.id),[id(101)]);
    assert.deepEqual(await start.searchConversationPatients(f.client,id(1),'Outro'),[]);
    assert.deepEqual(await start.searchConversationPatients(f.client,id(1),'%'),[]);
    assert.deepEqual(await start.searchConversationPatients(f.client,id(1),'_'),[]);
    assert.equal((await f.db.query('select count(*)::int n from crm_conversations')).rows[0].n,0);
  }finally{await f.db.close();}
});
