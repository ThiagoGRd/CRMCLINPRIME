import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceptionGatewayClient, receptionGatewayIntentId} from '../lib/server/reception-gateway-client';
const scope={orgId:'00000000-0000-4000-8000-000000000001',channelId:'00000000-0000-4000-8000-000000000002',actorId:'00000000-0000-4000-8000-000000000003'};
const intent='00000000-0000-4000-8000-000000000004', binding='00000000-0000-4000-8000-000000000005';
const config={origin:'https://gateway.example.invalid',principal:'fixture',token:'synthetic_'+ 'a'.repeat(32),recipientBindingId:binding,...scope};
const body=(id:string,state='api_accepted')=>({intent_id:id,state,provider_message_ids:state==='api_accepted'?['fixture_msg']:[],delivery_state:'unverified'});
test('scoped identity deterministic and distinct across operators and channels',()=>{
 const id=receptionGatewayIntentId(scope,intent);assert.equal(id,'66a34b61-c9c3-86c0-821a-a8681c0fd231');assert.equal(id,receptionGatewayIntentId(scope,intent));
 assert.match(id,/^[0-9a-f-]{36}$/);assert.notEqual(id,receptionGatewayIntentId({...scope,actorId:binding},intent));
 assert.notEqual(id,receptionGatewayIntentId({...scope,channelId:binding},intent));
});
test('off by default, trusted scope, fixed HTTPS route, one request',async()=>{
 let calls=0;
 const fetcher:typeof fetch=async(url,options)=>{calls++;assert.equal(url,config.origin+'/crm-recepcao/v1/text-intents');assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');const request=JSON.parse(String(options?.body));assert.deepEqual(Object.keys(request).sort(),['intent_id','recipient_binding_id','text']);return Response.json(body(request.intent_id));};
 const off=createReceptionGatewayClient(config,{fetcher});await assert.rejects(off.submit(scope,intent,'fixture'));assert.equal(calls,0);
 const client=createReceptionGatewayClient(config,{enabled:true,fetcher});
 await assert.rejects(client.submit({...scope,actorId:binding},intent,'fixture'));assert.equal(calls,0);
 assert.equal((await client.submit(scope,intent,'fixture')).state,'api_accepted');assert.equal(calls,1);
});
test('rejects unsafe configuration and absent credential',()=>{
 for(const origin of ['http://gateway.example.invalid','https://user@gateway.example.invalid','https://gateway.example.invalid/path','https://gateway.example.invalid?x=1','https://gateway.example.invalid/'])assert.throws(()=>createReceptionGatewayClient({...config,origin}));
 assert.throws(()=>createReceptionGatewayClient({...config,token:''}));
});
test('rejects malformed, mismatched, oversized, redirect and ambiguous results without retry',async()=>{
 for(const result of [body(intent), {...body(receptionGatewayIntentId(scope,intent)),delivery_state:'delivered'}, {...body(receptionGatewayIntentId(scope,intent)),provider_message_ids:['a','b']},body(receptionGatewayIntentId(scope,intent),'bogus')]){
  let calls=0;const client=createReceptionGatewayClient(config,{enabled:true,fetcher:async()=>{calls++;return Response.json(result)}});
  await assert.rejects(client.submit(scope,intent,'fixture'),/Reception gateway unavailable/);assert.equal(calls,1);
 }
 for(const response of [new Response('x'.repeat(4097)),new Response('',{status:302,headers:{location:'https://example.invalid'}})]){
  let calls=0;const client=createReceptionGatewayClient(config,{enabled:true,fetcher:async()=>{calls++;return response}});await assert.rejects(client.submit(scope,intent,'fixture'));assert.equal(calls,1);
 }
});
test('status is one GET and preserves unverified pending state',async()=>{
 let calls=0;const client=createReceptionGatewayClient(config,{enabled:true,fetcher:async(url,options)=>{calls++;assert.equal(options?.method,'GET');assert.equal(options?.body,undefined);assert.equal(url,config.origin+'/crm-recepcao/v1/text-intents/'+receptionGatewayIntentId(scope,intent));return Response.json(body(receptionGatewayIntentId(scope,intent),'recorded'));}});
 assert.equal((await client.status(scope,intent)).state,'recorded');assert.equal(calls,1);
});
test('bounded deadline handles stalled fetch/body and never retries',async()=>{
 for(const fetcher of [async()=>new Promise<Response>(()=>{}),async()=>new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}})]){
  let calls=0;const client=createReceptionGatewayClient(config,{enabled:true,timeoutMs:20,fetcher:async()=>{calls++;return fetcher()}});
  await assert.rejects(client.submit(scope,intent,'fixture'));assert.equal(calls,1);
 }
});
test('rejects duplicate response keys including escaped equivalents without accepting or retrying',async(t)=>{
 const id=receptionGatewayIntentId(scope,intent);
 const responses=[
  `{"intent_id":"${id}","state":"uncertain","state":"api_accepted","provider_message_ids":["fixture_msg"],"delivery_state":"unverified"}`,
  `{"intent_id":"${id}","state":"uncertain","st\\u0061te":"api_accepted","provider_message_ids":["fixture_msg"],"delivery_state":"unverified"}`,
  `{"intent_id":"${id}","state":"api_accepted","provider_message_ids":[],"provider_message_ids":["fixture_msg"],"delivery_state":"unverified"}`,
  `{"intent_id":"${intent}","intent_id":"${id}","state":"api_accepted","provider_message_ids":["fixture_msg"],"delivery_state":"unverified"}`,
 ];
 for(const [index,raw] of responses.entries())await t.test(`duplicate response vector ${index}`,async()=>{
  let calls=0;
  const client=createReceptionGatewayClient(config,{enabled:true,fetcher:async()=>{calls++;return new Response(raw,{headers:{'Content-Type':'application/json'}})}});
  await assert.rejects(client.submit(scope,intent,'fixture'),/Reception gateway unavailable/);
  assert.equal(calls,1);
 });
});
test('structural JSON preflight accepts escaped unique keys and normal whitespace',async()=>{
 const id=receptionGatewayIntentId(scope,intent);
 const raw=` { "intent_id" : "${id}", "st\\u0061te" : "api_accepted", "provider_message_ids" : ["fixture_msg"], "delivery_state" : "unverified" }\n`;
 const client=createReceptionGatewayClient(config,{enabled:true,fetcher:async()=>new Response(raw,{headers:{'Content-Type':'application/json'}})});
 assert.equal((await client.status(scope,intent)).state,'api_accepted');
});
test('structural JSON preflight rejects malformed grammar and excessive nesting on status',async()=>{
 const valid=JSON.stringify(body(receptionGatewayIntentId(scope,intent)));
 for(const raw of [valid+'{}',valid.slice(0,-1)+',}',valid.replace('"api_accepted"','"api_accepted\\"'),valid.replace('["fixture_msg"]','["fixture_msg",]'),valid.replace('"state":','"state" '),'['.repeat(40)+'0'+']'.repeat(40)]){
  let calls=0;const client=createReceptionGatewayClient(config,{enabled:true,fetcher:async()=>{calls++;return new Response(raw,{headers:{'Content-Type':'application/json'}})}});
  await assert.rejects(client.status(scope,intent),/Reception gateway unavailable/);assert.equal(calls,1);
 }
});
