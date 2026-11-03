import test from 'node:test';
import assert from 'node:assert/strict';
import * as outbound from '../lib/outbound.ts';
const intent={request_id:'request-a',conversation_id:'conversation-a',channel_id:'channel-a',text:'Olá'};
test('only confirmed matching send responses can clear a draft',()=>{
  assert.equal(typeof outbound.classifySendResult,'function');
  assert.equal(outbound.classifySendResult(intent,{state:'sent',request_id:'request-a',message:{id:'m1',conversation_id:'conversation-a',channel_id:'channel-a'}}).state,'sent');
  assert.equal(outbound.classifySendResult(intent,{state:'sent',request_id:'other',message:{id:'m1',conversation_id:'conversation-a',channel_id:'channel-a'}}).state,'uncertain');
  assert.equal(outbound.classifySendResult(intent,{state:'sent',request_id:'request-a',message:{id:'m1',conversation_id:'conversation-b',channel_id:'channel-a'}}).state,'uncertain');
  assert.equal(outbound.classifySendResult(intent,null).state,'uncertain');
});
test('pending and uncertain sends never become retryable failures',()=>{
  for(const state of ['pending','in_flight','uncertain','not_found'])assert.notEqual(outbound.classifySendResult(intent,{request_id:'request-a',state}).state,'failed');
  assert.equal(outbound.classifySendResult(intent,{request_id:'request-a',state:'failed',error:'Provider rejected'}).state,'failed');
});
test('unresolved request protection is scoped to exact conversation, channel and trimmed text',()=>{
  assert.equal(typeof outbound.hasUnresolvedDuplicate,'function');
  const rows=[{...intent,state:'uncertain' as const,error:'Timeout'}];
  assert.equal(outbound.hasUnresolvedDuplicate(rows,{...intent,text:' Olá '}),true);
  assert.equal(outbound.hasUnresolvedDuplicate(rows,{...intent,conversation_id:'conversation-b'}),false);
  assert.equal(outbound.hasUnresolvedDuplicate(rows,{...intent,text:'Outra mensagem'}),false);
  assert.equal(outbound.hasUnresolvedDuplicate([{...intent,state:'failed'}],intent),false);
});
test('remote refresh does not erase a locally uncertain request and settled state wins',()=>{
  assert.equal(typeof outbound.mergeOutboundAttempts,'function');
  const pending={...intent,state:'uncertain' as const,error:'Timeout'};
  assert.deepEqual(outbound.mergeOutboundAttempts([pending],[]),[pending]);
  assert.equal(outbound.mergeOutboundAttempts([pending],[{...intent,state:'sent'}])[0].state,'sent');
});

test('send marker survives remount without persisting message content and is isolated by user/org',()=>{
  assert.equal(typeof outbound.persistOutboundMarker,'function');
  const values=new Map<string,string>();
  const storage={get length(){return values.size},key:(index:number)=>[...values.keys()][index]??null,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}};
  const scope={orgId:'org-a',userId:'user-a'};
  outbound.persistOutboundMarker(storage,scope,intent);
  const encoded=[...values.values()].join('');
  assert.ok(!encoded.includes('Olá'));
  assert.deepEqual(outbound.readOutboundMarkers(storage,scope).map(row=>row.request_id),['request-a']);
  assert.deepEqual(outbound.readOutboundMarkers(storage,{...scope,userId:'other'}),[]);
  assert.deepEqual(outbound.readOutboundMarkers(storage,{...scope,orgId:'other'}),[]);
  outbound.removeOutboundMarker(storage,scope,intent.request_id);
  assert.deepEqual(outbound.readOutboundMarkers(storage,scope),[]);
});
test('failed or corrupt local durability blocks transport preparation instead of dropping identity',()=>{
  const unavailable={length:0,key:()=>null,getItem:()=>null,setItem:()=>{throw new Error('Quota')},removeItem:()=>{}};
  assert.throws(()=>outbound.persistOutboundMarker(unavailable,{orgId:'org',userId:'user'},intent),/Quota/);
  assert.throws(()=>outbound.readOutboundMarkers({length:1,key:()=> 'clinprime-outbound-v2:org:user:request',getItem:()=>'{broken',setItem:()=>{},removeItem:()=>{}},{orgId:'org',userId:'user'}));
});
test('stale remote polls never regress a terminal local confirmation',()=>{
  assert.equal(outbound.mergeOutboundAttempts([{...intent,state:'sent'}],[{...intent,state:'in_flight'}])[0].state,'sent');
});
test('fresh marker read blocks a new send when SPA query caches are empty or content unknown',()=>{
  assert.equal(typeof outbound.hasUnknownOutboundMarker,'function');
  const marker={request_id:intent.request_id,conversation_id:intent.conversation_id,channel_id:intent.channel_id,created_at:'2026-11-03'};
  assert.equal(outbound.hasUnknownOutboundMarker([marker],[],intent.conversation_id),true);
  assert.equal(outbound.hasUnknownOutboundMarker([marker],[{...intent,text:'',state:'uncertain'}],intent.conversation_id),true);
  assert.equal(outbound.hasUnknownOutboundMarker([marker],[{...intent,state:'uncertain'}],intent.conversation_id),false);
  assert.equal(outbound.hasUnknownOutboundMarker([marker],[],'different-conversation'),false);
});

test('concurrent tab markers cannot overwrite each other or be lost when another settles',()=>{
  const values=new Map<string,string>(); const scope={orgId:'org',userId:'user'}; let interleave=true;
  const storage={get length(){return values.size},key:(index:number)=>[...values.keys()][index]??null,getItem:(key:string)=>values.get(key)??null,
    setItem:(key:string,value:string)=>{if(interleave){interleave=false;outbound.persistOutboundMarker(storage,scope,{...intent,request_id:'request-b',conversation_id:'other'});}values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}};
  outbound.persistOutboundMarker(storage,scope,intent);
  assert.deepEqual(outbound.readOutboundMarkers(storage,scope).map(row=>row.request_id).sort(),['request-a','request-b']);
  outbound.removeOutboundMarker(storage,scope,'request-a');
  assert.deepEqual(outbound.readOutboundMarkers(storage,scope).map(row=>row.request_id),['request-b']);
});
