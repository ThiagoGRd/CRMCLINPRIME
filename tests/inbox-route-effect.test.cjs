/* eslint-disable @typescript-eslint/no-require-imports -- Executes actual Inbox route effect with in-memory hook dependencies. */
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');const React=require('react');
test('actual Inbox routed patient effect opens mobile chat for initial and later Atender links',()=>{
 const state=[];let cursor=0;let effects=[];let params=new URLSearchParams('p=fictional-patient-one');const originalLoad=Module._load;
 const ui=new Proxy({},{get:(_,key)=>String(key)});
 Module._load=function(name,...rest){
  if(name==='react')return {...React,useState:initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value}]},useRef:initial=>{const i=cursor++;if(!(i in state))state[i]={current:initial};return state[i]},useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:(fn,deps)=>effects.push({fn,deps})};
  if(name==='next/navigation')return {useSearchParams:()=>params};
  if(name==='@tanstack/react-query')return {useQuery:()=>({data:[]}),useQueryClient:()=>({})};
  if(name==='@/lib/supabase/client')return {createClient:()=>({})};
  if(name==='@/components/org-context')return {useOrg:()=>({id:'fictional-org'})};
  if(name==='@/lib/funil')return {CC_BADGE:{}};
  if(name==='@/lib/format')return {formatPhoneDisplay:()=>'',formatCurrency:()=>'',formatDateBR:()=>''};
  if(name.startsWith('@/components/ui/')||name==='lucide-react')return ui;
  if(name==='sonner')return {toast:{}};
  if(name==='./reception-pilot-panel')return {ReceptionPilotPanel:'Pilot'};
  return originalLoad.call(this,name,...rest);
 };
 const path=require.resolve('../components/inbox/inbox-client');delete require.cache[path];
 try{
  const {InboxClient}=require(path);const {InboxMobileNavigation}=require('../components/inbox/inbox-mobile-navigation');
  function find(node,type){if(!React.isValidElement(node))return; if(node.type===type)return node;for(const child of React.Children.toArray(node.props.children)){const found=find(child,type);if(found)return found}}
  const render=()=>{cursor=0;effects=[];return InboxClient()};
  assert.equal(find(render(),InboxMobileNavigation).props.view,'list');
  effects.find(effect=>effect.deps?.[0]===params).fn();assert.equal(find(render(),InboxMobileNavigation).props.view,'chat');
  // A user can return to the list; a later routed selection must reopen chat.
  find(render(),InboxMobileNavigation).props.onChange('list');params=new URLSearchParams('p=fictional-patient-two');render();effects.find(effect=>effect.deps?.[0]===params).fn();assert.equal(find(render(),InboxMobileNavigation).props.view,'chat');
  find(render(),InboxMobileNavigation).props.onChange('list');params=new URLSearchParams();render();effects.find(effect=>effect.deps?.[0]===params).fn();assert.equal(find(render(),InboxMobileNavigation).props.view,'list');
 }finally{Module._load=originalLoad;delete require.cache[path]}
});
