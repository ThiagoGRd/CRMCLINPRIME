import test from 'node:test';import assert from 'node:assert/strict';
import {PilotController} from '../lib/reception-pilot-controller';
const id='00000000-0000-4000-8000-000000000001';
const context={contextKey:'a'.repeat(64),orgId:id,actorId:id,recipientLabel:'Fictício',latest:null};
const storage=()=>{const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)},removeItem:(k:string)=>{data.delete(k)}}};
test('persist before POST, synchronous guard, lost response never sends again or clears marker',async()=>{
 const store=storage();let sends=0;const api={context:async()=>context,status:async()=>{throw Error()},submit:async()=>{sends++;assert.equal(store.getItem('reception-pilot:'+context.contextKey),id);throw Error('lost')}};
 const controller=new PilotController(id,store,api,()=>id);await controller.recover();
 await Promise.all([controller.send('fixture'),controller.send('fixture')]);assert.equal(sends,1);assert.equal(controller.view.canSend,false);
 await controller.recover();assert.equal(controller.view.canSend,false);assert.equal(controller.newMessage(),false);assert.equal(sends,1);
});
test('storage failure prevents network and new tab pending is read only',async()=>{
 let sends=0;const api={context:async()=>context,status:async()=>{throw Error()},submit:async()=>{sends++;throw Error()}};
 const bad={getItem:()=>null,setItem:()=>{throw Error()},removeItem:()=>{}};
 const c=new PilotController(id,bad,api,()=>id);await c.recover();await c.send('fixture');assert.equal(sends,0);assert.equal(c.view.canSend,false);
 const pending={intent_id:id,state:'uncertain',provider_message_ids:[],delivery_state:'unverified'};
 const tab=new PilotController(id,storage(),{...api,context:async()=>({...context,latest:pending})} as never,()=>id);await tab.recover();assert.equal(tab.view.canSend,false);assert.equal(tab.newMessage(),false);
});
test('reload recovers existing marker by GET only; safe terminal needs explicit new action; context change invalidates',async()=>{
 const store=storage();store.setItem('reception-pilot:'+context.contextKey,id);let posts=0;let changed=false;
 const result={intent_id:id,state:'api_accepted' as const,provider_message_ids:['fixture'],delivery_state:'unverified' as const};
 const api={context:async()=>({...context,contextKey:changed?'b'.repeat(64):context.contextKey,latest:result}),status:async()=>result,submit:async()=>{posts++;return result}};
 const c=new PilotController(id,store,api,()=>id);await c.recover();assert.equal(c.view.canSend,false);assert.equal(c.view.canNew,true);assert.equal(posts,0);assert.equal(c.newMessage(),true);assert.equal(c.view.canSend,true);
 changed=true;await c.recover();assert.equal(c.view.canSend,false);assert.equal(c.newMessage(),false);await c.send('fixture');assert.equal(posts,0);
});
test('navigation invalidation during context fetch prevents POST',async()=>{
 let release:()=>void=()=>{};let block=false;let posts=0;
 const api={context:async()=>{if(block)await new Promise<void>(r=>release=r);return context},status:async()=>{throw Error()},submit:async()=>{posts++;throw Error()}};
 const c=new PilotController(id,storage(),api,()=>id);await c.recover();block=true;const pending=c.send('fixture');c.invalidate();release();await pending;assert.equal(posts,0);assert.equal(c.view.canSend,false);
});
test('new draft and pending second POST never retain the first accepted result',async()=>{
 const result={intent_id:id,state:'api_accepted' as const,provider_message_ids:['fixture'],delivery_state:'unverified' as const};
 let finish:(value:typeof result)=>void=()=>{};
 const api={context:async()=>({...context,latest:result}),status:async()=>result,submit:async()=>new Promise<typeof result>(resolve=>finish=resolve)};
 const c=new PilotController(id,storage(),api,()=>id);await c.recover();assert.equal(c.view.result?.state,'api_accepted');assert.equal(c.newMessage(),true);assert.equal(c.view.result,null);
 const send=c.send('second');await new Promise(resolve=>setImmediate(resolve));assert.equal(c.view.busy,true);assert.equal(c.view.result,null);finish(result);await send;
});
test('short foreground wait preserves dispatching until explicit GET recovers late acceptance without another POST',async()=>{
 const pending={intent_id:id,state:'dispatching' as const,provider_message_ids:[],delivery_state:'unverified' as const};
 const accepted={...pending,state:'api_accepted' as const,provider_message_ids:['fictional_late_ack']};
 let latest:typeof pending|typeof accepted|null=null;let posts=0;let reads=0;
 const api={context:async()=>{reads++;return {...context,latest}},status:async()=>{reads++;return latest!},submit:async()=>{posts++;latest=pending;throw Error('foreground deadline')}};
 const store=storage();const c=new PilotController(id,store,api,()=>id);await c.recover();await c.send('fixture');
 assert.equal(c.view.canSend,false);assert.equal(c.newMessage(),false);assert.equal(posts,1);
 await c.recover();assert.equal(c.view.result?.state,'dispatching');assert.equal(c.view.canNew,false);
 await c.send('same fixture');assert.equal(posts,1);latest=accepted;
 await c.recover();assert.equal(c.view.result?.state,'api_accepted');assert.equal(c.view.canSend,false);assert.equal(c.view.canNew,true);assert.equal(posts,1);assert.ok(reads>=6);
 assert.equal(store.getItem('reception-pilot:'+context.contextKey),id);
});
