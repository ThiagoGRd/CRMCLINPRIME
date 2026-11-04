// Real SQL functions with a synthetic Supabase boundary and a mocked transport.
// No credentials, real patient data, or external network are used.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { localToWa } from '../../../supabase/functions/_shared/wa.ts';
import { validateSendRoute } from '../../../supabase/functions/_shared/routing.ts';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
export const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
export async function setupEndpoint(options={}) {
 const db=new PGlite();
 await db.exec(await readFile(new URL('../../database/fixture.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../../supabase/migrations/20261103030000_crm_foundation.sql',import.meta.url),'utf8'));
 await db.exec(`alter table org_members add column role text default 'admin';
 alter table channels add column waba_id text default '9001';
 alter table crm_messages add column direction text, add column content text, add column message_type text, add column status text, add column sent_by uuid;
 create table channel_secrets(channel_id uuid,access_token text);
 insert into channel_secrets values ('${id(201)}','synthetic');
 update channels set inbox_key='reception';
 update crm_patients set phone='82991212108';`);
 await db.exec(await readFile(new URL('../../../supabase/migrations/20261103050000_crm_outbound_requests.sql',import.meta.url),'utf8'));
 const recoveryMigration=await readFile(new URL('../../../supabase/migrations/20261103060000_crm_outbound_reconciliation.sql',import.meta.url),'utf8').catch(()=> '');
 if(recoveryMigration) await db.exec(recoveryMigration);
 const policyMigration=await readFile(new URL('../../../supabase/migrations/20261103070000_whatsapp_window_templates.sql',import.meta.url),'utf8').catch(()=> '');
 if(policyMigration) await db.exec(policyMigration);
 const conversation=(await db.query('insert into crm_conversations(org_id,patient_id,channel_id) values ($1,$2,$3) returning id',[id(1),id(101),id(201)])).rows[0].id;
 await db.query("insert into crm_messages(org_id,patient_id,channel_id,conversation_id,direction,content,created_at) values ($1,$2,$3,$4,'inbound','Olá',now()-interval '1 hour')",[id(1),id(101),id(201),conversation]);
 let handler,fetches=0;const sent=[];const rpcCalls=[];const metadataCalls=[];
 const admin={
  auth:{getUser:async jwt=>({data:{user:jwt==='synthetic'?{id:id(11)}:jwt==='foreign'?{id:id(22)}:null}})},
  from(table) {
   const filters=[];let columns='*',write;
   const q={select(value){columns=value;return q},eq(key,value){filters.push([key,value]);return q},insert(value){write=value;return q},async maybeSingle(){
    try {const result=await db.query(`select ${columns} from ${table} where ${filters.map(([key],i)=>`${key}=$${i+1}`).join(' and ')}`,filters.map(([,value])=>value));return {data:result.rows[0]??null,error:null}}
    catch(error){return {data:null,error}}
   },async single(){
    const keys=Object.keys(write);try {const result=await db.query(`insert into ${table} (${keys.join(',')}) values (${keys.map((_,i)=>`$${i+1}`).join(',')}) returning ${columns}`,Object.values(write));return {data:result.rows[0],error:null}}catch(error){return {data:null,error}}
   }};return q;
  },
  async rpc(name,args) {
   rpcCalls.push({name,args});
   if(options.failRpc===name) return {data:null,error:{message:'synthetic RPC failure'}};
   try {const result=await db.query(`select ${name}(${Object.keys(args).map((key,i)=>`${key} => $${i+1}`).join(',')}) as data`,Object.values(args));
    if((options.loseReconcileResponse&&name==='reconcile_crm_outbound_request')||(options.loseCompleteResponse&&name==='complete_crm_outbound_request')) return {data:null,error:{message:'synthetic response lost'}};
    return {data:result.rows[0].data,error:null};
   }catch(error){return {data:null,error}}
  }
 };
 const helpers=await import('../../../supabase/functions/_shared/outbound.ts').catch(()=>({}));
 const policyHelpers=await import('../../../supabase/functions/_shared/whatsapp-policy.ts');
 const catalogHelpers=await import('../../../supabase/functions/_shared/whatsapp-catalog.ts');
 const source=stripTypeScriptTypes((await readFile(new URL('../../../supabase/functions/whatsapp-send/index.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,''));
 const transport=async(url,init)=>{if(init?.method==='GET'){metadataCalls.push({url,init});return options.catalogTransport?options.catalogTransport(url,init):Response.json({data:String(url).includes('/phone_numbers')?[{id:'one'}]:[{id:'123',name:'appointment',language:'pt_BR',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'Olá {{1}}'}]}]})}fetches++;sent.push({url,init});return options.transport?options.transport(url,init):Response.json({messages:[{id:'wamid.synthetic'}]})};
 vm.runInNewContext(source,{Deno:{env:{get:()=>''},serve:h=>handler=h},createClient:()=>admin,localToWa,validateSendRoute,...helpers,...policyHelpers,loadTextTemplateCatalog:config=>catalogHelpers.loadTextTemplateCatalog(config,transport),Response,AbortSignal,setTimeout,clearTimeout,fetch:transport,console});
 const body={request_id:id(501),conversation_id:conversation,channel_id:id(201),text:'Olá'};
 const call=async(payload=body,jwt='synthetic')=>{
  const response=await handler(new Request('http://synthetic.local',{method:'POST',headers:{Authorization:`Bearer ${jwt}`},body:JSON.stringify(payload)}));
  return {status:response.status,body:await response.json()};
 };
 return {db,conversation,body,call,sent,rpcCalls,metadataCalls,get fetches(){return fetches},close:()=>db.close()};
}
