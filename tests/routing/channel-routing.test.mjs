import { test } from 'node:test';
import assert from 'node:assert/strict';
const helper = await import('../../supabase/functions/_shared/routing.ts').catch(()=>({}));
test('delivery is explicit and fails closed for missing, wrong, disconnected or foreign channels',()=>{
 assert.equal(typeof helper.validateSendRoute,'function');
 const conversation={id:'conv',org_id:'org',patient_id:'pat',channel_id:'ch'};
 const channel={id:'ch',org_id:'org',type:'whatsapp_cloud',status:'connected',phone_number_id:'123'};
 assert.equal(helper.validateSendRoute({conversation_id:'conv',channel_id:'ch'},conversation,channel),null);
 for(const [input,c,ch] of [ [{},conversation,channel],[{conversation_id:'conv',channel_id:'other'},conversation,channel],[{conversation_id:'conv',channel_id:'ch'},conversation,{...channel,status:'disconnected'}],[{conversation_id:'conv',channel_id:'ch'},conversation,{...channel,org_id:'foreign'}],[{conversation_id:'conv',channel_id:'ch'},null,channel] ]) assert.ok(helper.validateSendRoute(input,c,ch));
});

// Execute the actual Edge Function with synthetic connector/transport boundaries.
// No request leaves this process and no Supabase keys are read.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { localToWa } from '../../supabase/functions/_shared/wa.ts';
const source = stripTypeScriptTypes((await readFile(new URL('../../supabase/functions/whatsapp-send/index.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,''));
async function runEndpoint({body={conversation_id:'conv',channel_id:'ch',text:'Oi'},member=true,status='connected',channelOrg='org',conversationOrg='org'}={}) {
 let handler,fetches=0,inserted;
 const data={crm_conversations:{id:'conv',org_id:conversationOrg,patient_id:'pat',channel_id:'ch'},org_members:member?{org_id:'org'}:null,channels:{id:'ch',org_id:channelOrg,type:'whatsapp_cloud',status,phone_number_id:'123'},crm_patients:{id:'pat',org_id:'org',phone:'82991212108'},channel_secrets:{access_token:'synthetic'}};
 const admin={auth:{getUser:async()=>({data:{user:{id:'user'}}})},from(table){const filters=[];let write; const q={select(){return q},eq(key,value){filters.push([key,value]);return q},insert(value){write=value;inserted=value;return q},async maybeSingle(){const row=data[table];return {data:row && filters.every(([k,v])=>row[k]===undefined || row[k]===v)?row:null}},async single(){return {data:{id:'message',...write}}}};return q}};
 vm.runInNewContext(source,{Deno:{env:{get:()=>''},serve:h=>handler=h},createClient:()=>admin,validateSendRoute:helper.validateSendRoute,localToWa,Response,fetch:async()=>{fetches++;return Response.json({messages:[{id:'wamid'}]})}});
 const response=await handler(new Request('http://synthetic.local',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify(body)}));
 return {status:response.status,body:await response.json(),fetches,inserted};
}
test('actual send endpoint never reaches transport for missing, mismatched, disconnected or unauthorized route',async()=>{
 for(const options of [{body:{patient_id:'pat',text:'Oi'}},{body:{conversation_id:'conv',channel_id:'wrong',text:'Oi'}},{status:'disconnected'},{channelOrg:'other'},{member:false}]) {
  const result=await runEndpoint(options);assert.ok(result.status>=400);assert.equal(result.fetches,0);
 }
});
test('actual send endpoint persists and returns the exact selected conversation/channel',async()=>{
 const result=await runEndpoint();assert.equal(result.status,200);assert.equal(result.fetches,1);
 assert.equal(result.inserted.conversation_id,'conv');assert.equal(result.body.message.conversation_id,'conv');assert.equal(result.body.message.channel_id,'ch');
});
