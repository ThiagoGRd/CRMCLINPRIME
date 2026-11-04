import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createHmac, webcrypto } from 'node:crypto';
import vm from 'node:vm';
const source=stripTypeScriptTypes((await readFile(new URL('../../supabase/functions/whatsapp-webhook/index.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,''));
test('webhook returns retryable failure when its exact channel lookup fails',async()=>{
 let handler;
 const admin={from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:null,error:{message:'synthetic temporary failure'}})})};
 vm.runInNewContext(source,{Deno:{env:{get:key=>key==='WA_APP_SECRET'?'synthetic-secret':''},serve:h=>handler=h},createClient:()=>admin,crypto:webcrypto,TextEncoder,Uint8Array,Response,URL,console:{warn(){},error(){}}});
 const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'exact'}}}]}]});
 const signature=createHmac('sha256','synthetic-secret').update(body).digest('hex');
 const response=await handler(new Request('http://synthetic.local',{method:'POST',body,headers:{'x-hub-signature-256':`sha256=${signature}`}}));
 assert.equal(response.status,503);
});

test('missing, malformed and future inbound timestamps cannot create a patient or falsely open the service window',async()=>{
 let handler;const mutations=[];
 const admin={rpc:async(...args)=>{mutations.push(args);return {data:'synthetic-patient',error:null}},from:table=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{id:'channel',org_id:'org'},error:null}),upsert:async row=>{mutations.push({table,row});return {error:null}}})};
 vm.runInNewContext(source,{Deno:{env:{get:key=>key==='WA_APP_SECRET'?'synthetic-secret':''},serve:h=>handler=h},createClient:()=>admin,crypto:webcrypto,TextEncoder,Uint8Array,Response,URL,waIdToLocal:value=>value,parseMessage:()=>({content:'Synthetic',type:'text'}),console:{warn(){},error(){}}});
 for(const timestamp of [undefined,null,'',0,-1,'broken',' 123 ','1e9',true,Infinity,Math.floor(Date.now()/1000)+3600]){
  const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'exact'},messages:[{id:'wamid.invalid',from:'synthetic',timestamp}]}}]}]});
  const signature=createHmac('sha256','synthetic-secret').update(body).digest('hex');
  const response=await handler(new Request('http://synthetic.local',{method:'POST',body,headers:{'x-hub-signature-256':`sha256=${signature}`}}));
  assert.equal(response.status,503,`invalid timestamp ${timestamp} must be rejected`);assert.equal(mutations.length,0);
 }
 const timestamp=String(Math.floor(Date.now()/1000)-60);
 const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'exact'},messages:[{id:'wamid.valid',from:'synthetic',timestamp}]}}]}]});
 const signature=createHmac('sha256','synthetic-secret').update(body).digest('hex');
 const response=await handler(new Request('http://synthetic.local',{method:'POST',body,headers:{'x-hub-signature-256':`sha256=${signature}`}}));
 assert.equal(response.status,200);assert.equal(mutations.length,2);assert.equal(mutations[1].row.created_at,new Date(Number(timestamp)*1000).toISOString());assert.equal(mutations[1].row.direction,'inbound');
});
