import test from 'node:test';
import assert from 'node:assert/strict';
import * as pilot from '../lib/server/reception-pilot';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const config={orgId:id(1),actorId:id(2),channelId:id(3),recipientBindingId:id(4),origin:'https://gateway.invalid',principal:'fixture',token:'a'.repeat(32),appOrigin:'https://crm.invalid',recipientLabel:'Destino fictício aprovado',revision:'fixture-1'};
function session(actor=config.actorId,member=true){return {auth:{getUser:async()=>({data:{user:{id:actor}},error:null})},from:(table:string)=>{assert.equal(table,'org_members');const filters:Record<string,string>={};return {select:()=>({eq:(k:string,v:string)=>{filters[k]=v;return {eq:(k:string,v:string)=>{filters[k]=v;return {maybeSingle:async()=>({data:member?{user_id:filters.user_id,org_id:filters.org_id}:null,error:null})}}}}})}}};}
const request=(path='context',body?:unknown)=>new Request('https://crm.invalid/api/reception-pilot/'+path,{method:body?'POST':'GET',headers:{Origin:'https://crm.invalid','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
test('factory exists and disabled wrapper denies without session/network',async()=>{
 assert.equal(typeof pilot.createReceptionPilotHandlers,'function');
 const off=pilot.createReceptionPilotHandlers();assert.equal((await off.context(request())).status,503);
});
test('exact verified operator membership, strict payload, scope and CSRF',async()=>{
 let sends=0;let member=true;let actor=config.actorId;
 const gateway={context:async()=>null,submitPilot:async()=>{sends++;return {intent_id:id(5),state:'api_accepted',provider_message_ids:['fixture'],delivery_state:'unverified'}},status:async()=>{throw Error()}};
 const h=pilot.createReceptionPilotHandlers({config,session:async()=>session(actor,member),gateway} as never);
 const response=await h.context(request());assert.equal(response.status,200);const c=await response.json();
 const body={intentId:id(6),contextKey:c.contextKey,previousIntentId:null,text:'fixture'};
 assert.equal((await h.submit(request('submit',{...body,principal:'forged'}))).status,400);
 assert.equal((await h.submit(new Request('https://crm.invalid/api/reception-pilot/submit',{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/json'},body:JSON.stringify(body)}))).status,403);
 assert.equal((await h.submit(request('submit',{...body,contextKey:'stale'}))).status,409);
 member=false;assert.equal((await h.submit(request('submit',body))).status,403);
 member=true;actor=id(9);assert.equal((await h.context(request())).status,403);assert.equal(sends,0);
 actor=config.actorId;assert.equal((await h.submit(request('submit',body))).status,200);assert.equal(sends,1);
});
test('invalid trusted configuration fails closed before session lookup',async()=>{
 let sessions=0;
 for(const invalid of [{recipientLabel:42},{revision:123},{appOrigin:'http://crm.invalid'},{actorId:'invalid'},{token:''}]){
  const h=pilot.createReceptionPilotHandlers({config:{...config,...invalid},session:async()=>{sessions++;return session()},gateway:{context:async()=>null,status:async()=>{throw Error('fixture only')},submitPilot:async()=>{throw Error('fixture only')}}} as never);
  assert.equal((await h.context(request())).status,503);
 }
 assert.equal(sessions,0);
});
