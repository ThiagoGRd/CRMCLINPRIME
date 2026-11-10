import {baileysTextUUID as UUID,validBaileysText} from './baileys-text-contract';
import type {ReceptionResult} from './server/reception-gateway-client';
export type PilotContext={contextKey:string;orgId:string;actorId:string;recipientLabel:string;latest:ReceptionResult|null};
export type PilotAPI={context:()=>Promise<PilotContext>;status:(intent:string,key:string)=>Promise<ReceptionResult>;submit:(body:{intentId:string;contextKey:string;previousIntentId:string|null;text:string})=>Promise<ReceptionResult>};
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const terminal=(r:ReceptionResult|null)=>r!==null&&['api_accepted','rejected_before_dispatch'].includes(r.state);
export function validPilotResult(v:unknown):v is ReceptionResult{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const r=v as ReceptionResult;
 return Object.keys(r).sort().join(',')==='delivery_state,intent_id,provider_message_ids,state'&&UUID.test(r.intent_id)&&r.delivery_state==='unverified'&&['recorded','dispatching','api_accepted','uncertain','rejected_before_dispatch'].includes(r.state)&&Array.isArray(r.provider_message_ids)&&(r.state==='api_accepted'?r.provider_message_ids.length===1&&/^[A-Za-z0-9_-]{1,128}$/.test(r.provider_message_ids[0]):r.provider_message_ids.length===0);
}
export class PilotController{
 view:{context:PilotContext|null;result:ReceptionResult|null;canSend:boolean;canNew:boolean;busy:boolean;error:string|null}={context:null,result:null,canSend:false,canNew:false,busy:false,error:null};
 private marker:string|null=null;private dead=false;private safe=false;private busy=false;
 constructor(private orgId:string,private storage:Store,private api:PilotAPI,private uuid:()=>string,private changed:()=>void=()=>{}){}
 invalidate(){this.dead=true;this.view.canSend=false;this.view.canNew=false;this.changed()}
 private key(){return 'reception-pilot:'+this.view.context!.contextKey}
 private failed(){this.safe=false;this.view.canSend=false;this.view.canNew=false;this.view.error='Estado não confirmado. Não reenvie; consulte o estado.'}
 async recover(){
  if(this.dead||this.busy)return;this.busy=true;this.view.busy=true;this.view.canSend=false;this.view.canNew=false;this.changed();
  try{
   const c=await this.api.context();
   if(this.dead)return;
   if(!c||c.orgId!==this.orgId||!UUID.test(c.actorId)||!/^[a-f0-9]{64}$/.test(c.contextKey)||typeof c.recipientLabel!=='string'||!c.recipientLabel||c.recipientLabel.length>100||(c.latest!==null&&!validPilotResult(c.latest)))throw Error();
   if(this.view.context&&this.view.context.contextKey!==c.contextKey){this.invalidate();throw Error()}
   this.view.context=c;this.marker=this.storage.getItem(this.key());
   if(this.marker!==null&&!UUID.test(this.marker))throw Error();
   let own:ReceptionResult|null=null;
   if(this.marker){own=await this.api.status(this.marker,c.contextKey);if(!validPilotResult(own))throw Error()}
   if(this.dead)return;
   this.view.result=c.latest??own;
   this.safe=(!this.marker||terminal(own))&&(c.latest===null||terminal(c.latest));
   this.view.canSend=this.safe&&!this.marker&&c.latest===null;
   this.view.canNew=this.safe&&!this.view.canSend;
   this.view.error=null;
  }catch{this.failed()}finally{this.busy=false;this.view.busy=false;this.changed()}
 }
 newMessage(){
  if(this.dead||this.busy||!this.safe||!this.view.canNew)return false;
  try{this.storage.removeItem(this.key());if(this.storage.getItem(this.key())!==null)throw Error();this.marker=null;this.view.result=null;this.view.canNew=false;this.view.canSend=true;this.view.error=null;this.changed();return true}catch{this.failed();this.changed();return false}
 }
 async send(text:string){
  if(this.dead||this.busy||!this.view.canSend||!validBaileysText(text))return;
  this.busy=true;this.view.busy=true;this.view.canSend=false;this.view.canNew=false;this.view.result=null;this.view.error=null;this.safe=false;this.changed();
  try{
   const c=this.view.context!;const intent=this.uuid();if(!UUID.test(intent))throw Error();
   // Persist UUID only before any network work. Never store message content.
   if(this.storage.getItem(this.key())!==null)throw Error();
   this.storage.setItem(this.key(),intent);if(this.storage.getItem(this.key())!==intent)throw Error();this.marker=intent;
   const current=await this.api.context();if(this.dead)return;
   if(current.contextKey!==c.contextKey||current.orgId!==c.orgId||current.actorId!==c.actorId||(current.latest?.intent_id??null)!==(c.latest?.intent_id??null))throw Error();
   const result=await this.api.submit({intentId:intent,contextKey:c.contextKey,previousIntentId:c.latest?.intent_id??null,text});
   if(this.dead)return;if(!validPilotResult(result))throw Error();
   this.view.result=result;this.view.context={...c,latest:result};this.safe=terminal(result);this.view.canNew=this.safe;this.view.error=null;
  }catch{this.failed()}finally{this.busy=false;this.view.busy=false;this.changed()}
 }
}
export const browserPilotAPI:PilotAPI={
 context:()=>request('context'),
 status:(intent,key)=>request('status?'+new URLSearchParams({intentId:intent,contextKey:key})),
 submit:(body)=>request('submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
};
async function request<T>(path:string,init?:RequestInit):Promise<T>{
 const response=await fetch('/api/reception-pilot/'+path,{...init,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
 if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='application/json')throw Error('unavailable');return response.json();
}
