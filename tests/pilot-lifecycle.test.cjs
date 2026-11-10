/* eslint-disable @typescript-eslint/no-require-imports -- Actual component lifecycle fixture, no network. */
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const React=require('react');const controller=require('../lib/reception-pilot-controller');
const id='00000000-0000-4000-8000-000000000001';
const context={contextKey:'a'.repeat(64),orgId:id,actorId:id,recipientLabel:'Fictício',latest:null};
async function harness(){
 const state=[];let cursor=0,effect,cleanup,authCallback,subscribed=false,requests=0,posts=0;
 const api={...controller.browserPilotAPI};const originalLoad=Module._load;const originalWindow=global.window;
 const values=new Map();global.window={localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},addEventListener:()=>{},removeEventListener:()=>{}};
 controller.browserPilotAPI.context=async()=>{requests++;return context};controller.browserPilotAPI.status=async()=>{throw Error('fixture')};controller.browserPilotAPI.submit=async()=>{posts++;throw Error('fixture')};
 Module._load=function(name,...rest){
  if(name==='react')return {...React,useState:initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=v}]},useRef:initial=>{const i=cursor++;if(!(i in state))state[i]={current:initial};return state[i]},useEffect:fn=>{if(!subscribed){effect=fn;subscribed=true}}};
  if(name==='../../lib/supabase/client')return {createClient:()=>({auth:{onAuthStateChange:callback=>{authCallback=callback;return {data:{subscription:{unsubscribe:()=>{}}}}}}})};
  return originalLoad.call(this,name,...rest);
 };
 const path=require.resolve('../components/inbox/reception-pilot-panel');delete require.cache[path];
 const {ReceptionPilotPanel}=require(path);
 const render=()=>{cursor=0;return ReceptionPilotPanel({orgId:id})};render();cleanup=effect();await new Promise(resolve=>setImmediate(resolve));
 return {render,event:(name,actor)=>authCallback(name,actor?{user:{id:actor}}:null),counts:()=>({requests,posts}),close:()=>{cleanup?.();Module._load=originalLoad;global.window=originalWindow;Object.assign(controller.browserPilotAPI,api);delete require.cache[path]}};
}
test('actual panel preserves same-account focus/SIGNED_IN draft and explicit GET recovery; real account changes hide it',async()=>{
 const h=await harness();try{
  let panel=h.render();assert.ok(panel);panel.props.setText('draft to preserve');
  h.event('SIGNED_IN',id);panel=h.render();assert.ok(panel,'same-user SIGNED_IN must not hide the panel');assert.equal(panel.props.text,'draft to preserve');
  const before=h.counts().requests;panel.props.recover();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.counts().requests,before+1);assert.equal(h.counts().posts,0);
  h.event('SIGNED_IN','00000000-0000-4000-8000-000000000002');assert.equal(h.render(),null);assert.equal(h.counts().posts,0);
 }finally{h.close()}
});
test('actual panel sign-out hides and invalidates without sending',async()=>{
 const h=await harness();try{assert.ok(h.render());h.event('SIGNED_OUT',null);assert.equal(h.render(),null);assert.equal(h.counts().posts,0)}finally{h.close()}
});
