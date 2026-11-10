import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {baileysTextUUID as UUID,validBaileysText} from '../baileys-text-contract';
import {createReceptionGatewayClient,rejectDuplicateJsonKeys, type ReceptionResult} from './reception-gateway-client';
export type PilotConfig=Parameters<typeof createReceptionGatewayClient>[0]&{appOrigin:string;recipientLabel:string;revision:string};
type Gateway=Pick<ReturnType<typeof createReceptionGatewayClient>,'context'|'submitPilot'|'status'>;
type Dependencies={config:Readonly<PilotConfig>;session:()=>Promise<SupabaseClient>;gateway?:Gateway};
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
class Denied extends Error{constructor(readonly status:number){super('pilot_unavailable')}}
async function body(request:Request){
 if(request.headers.get('content-type')!=='application/json')throw new Denied(400);
 const reader=request.body?.getReader();if(!reader)throw new Denied(400);
 let length=0;const chunks:Uint8Array[]=[];
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{
  while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>4096)throw new Denied(400);chunks.push(next.value)}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);rejectDuplicateJsonKeys(raw);return JSON.parse(raw) as Record<string,unknown>;
 })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Denied(400)),2000)})]);}
 catch{throw new Denied(400)}finally{clearTimeout(timer);void reader.cancel().catch(()=>{})}
}
/** Explicit construction only. Environment validation belongs to the server runtime. */
export function createReceptionPilotHandlers(dependencies?:Dependencies){
 let config:Readonly<PilotConfig>|undefined,gateway:Gateway|undefined,contextKey='';
 try{
  if(dependencies){
   config=Object.freeze({...dependencies.config});
   if(!['orgId','actorId','channelId','recipientBindingId','origin','principal','token','appOrigin','recipientLabel','revision'].every(key=>typeof (config as unknown as Record<string,unknown>)[key]==='string'))throw Error();
   const origin=new URL(config.appOrigin);
   if(origin.origin!==config.appOrigin||origin.protocol!=='https:'||!config.recipientLabel||config.recipientLabel.length>100||!/^[-a-zA-Z0-9_]{1,64}$/.test(config.revision))throw Error();
   const client=createReceptionGatewayClient(config,{enabled:true});
   gateway=dependencies.gateway??client;
   contextKey=createHash('sha256').update(JSON.stringify(['pilot-v1',config.orgId,config.actorId,config.channelId,config.principal,config.recipientBindingId,config.origin,config.recipientLabel,config.revision])).digest('hex');
  }
 }catch{config=undefined;gateway=undefined}
 async function authorize(){
  if(!config||!gateway||!dependencies)throw new Denied(503);
  const db=await dependencies.session();const {data,error}=await db.auth.getUser();
  if(error||!data.user||data.user.id!==config.actorId)throw new Denied(403);
  const member=await db.from('org_members').select('org_id,user_id').eq('user_id',data.user.id).eq('org_id',config.orgId).maybeSingle();
  if(member.error||!member.data||member.data.user_id!==data.user.id||member.data.org_id!==config.orgId)throw new Denied(403);
  return config;
 }
 const safe=(run:(request:Request)=>Promise<Response>)=>async(request:Request)=>{try{return await run(request)}catch(error){return reply({error:'pilot_unavailable'},error instanceof Denied?error.status:503)}};
 async function context(){const c=await authorize();const latest=await gateway!.context(c);await authorize();return reply({contextKey,orgId:c.orgId,actorId:c.actorId,recipientLabel:c.recipientLabel,latest})}
 return {
  context:safe(context),
  status:safe(async(request)=>{
   const c=await authorize();const url=new URL(request.url);
   if([...url.searchParams.keys()].sort().join(',')!=='contextKey,intentId'||url.searchParams.get('contextKey')!==contextKey)throw new Denied(409);
   const intent=url.searchParams.get('intentId')!;if(!UUID.test(intent))throw new Denied(400);
   const result=await gateway!.status(c,intent);await authorize();return reply(result);
  }),
  submit:safe(async(request)=>{
   const c=await authorize();
   if(request.method!=='POST'||request.headers.get('origin')!==c.appOrigin||new URL(request.url).origin!==c.appOrigin||!['same-origin',null].includes(request.headers.get('sec-fetch-site')))throw new Denied(403);
   const value=await body(request);
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='contextKey,intentId,previousIntentId,text'||typeof value.intentId!=='string'||!UUID.test(value.intentId)||!validBaileysText(value.text)||(value.previousIntentId!==null&&(typeof value.previousIntentId!=='string'||!UUID.test(value.previousIntentId))))throw new Denied(400);
   if(value.contextKey!==contextKey)throw new Denied(409);
   // Check live membership again immediately before the irreversible gateway call.
   await authorize();
   const result:ReceptionResult=await gateway!.submitPilot(c,value.intentId,value.text,value.previousIntentId as string|null);
   await authorize();return reply(result);
  })
 };
}
