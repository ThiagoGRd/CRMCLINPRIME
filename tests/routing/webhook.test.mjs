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
