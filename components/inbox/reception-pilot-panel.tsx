"use client";
import {useEffect,useRef,useState} from 'react';
import {createClient} from '../../lib/supabase/client';
import {PilotController,browserPilotAPI} from '../../lib/reception-pilot-controller';
import {ReceptionPilotControls} from './reception-pilot-controls';
export function ReceptionPilotPanel({orgId}:{orgId:string}){
 const controller=useRef<PilotController|null>(null);
 const [view,setView]=useState<PilotController['view']|null>(null);
 const [text,setText]=useState('');
 useEffect(()=>{
  let active=true;let sessionActor:string|null=null;let invalidated=false;
  // Accessing localStorage itself may throw. Do not enable a memory-only fallback.
  try{
   const c=new PilotController(orgId,window.localStorage,browserPilotAPI,()=>crypto.randomUUID(),()=>{if(!active)return;if(!invalidated&&sessionActor&&c.view.context&&sessionActor!==c.view.context.actorId){invalidated=true;c.invalidate();setText('');setView(null);return}if(!invalidated)setView({...c.view})});controller.current=c;
   const subscription=createClient().auth.onAuthStateChange((event,session)=>{
    const actor=session?.user?.id??null;
    const expected=c.view.context?.actorId??sessionActor;
    if(event==='SIGNED_OUT'||!actor||(expected!==null&&actor!==expected)){
     invalidated=true;c.invalidate();setText('');setView(null);return;
    }
    // Supabase emits same-user SIGNED_IN on focus/session recovery too.
    // Preserve drafts and recovery state; never send or recreate intents here.
    sessionActor=actor;
   });
   const changed=(event:StorageEvent)=>{if(event.key===null||event.key.startsWith('reception-pilot:')){c.invalidate();setText('')}};
   const leave=()=>{c.invalidate();setText('')};
   window.addEventListener('storage',changed);window.addEventListener('pagehide',leave);
   void c.recover();
   return ()=>{active=false;c.invalidate();subscription.data.subscription.unsubscribe();window.removeEventListener('storage',changed);window.removeEventListener('pagehide',leave)};
  }catch{return ()=>{active=false}}
 },[orgId]);
 if(!view?.context||view.context.orgId!==orgId)return null;
 return <ReceptionPilotControls view={view} text={text} setText={setText} send={()=>{void controller.current?.send(text);setText('')}} recover={()=>{void controller.current?.recover()}} newMessage={()=>{if(controller.current?.newMessage())setText('')}}/>;
}
