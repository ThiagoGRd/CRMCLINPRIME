/** Server-side gateway client. Callers must supply trusted fixed configuration. */
import {createHash} from 'node:crypto';
import {validBaileysText,baileysTextUUID as UUID} from '../baileys-text-contract';
export type ReceptionScope={orgId:string;channelId:string;actorId:string};
export type ReceptionResult={intent_id:string;state:'recorded'|'dispatching'|'api_accepted'|'uncertain'|'rejected_before_dispatch';provider_message_ids:string[];delivery_state:'unverified'};
type Config=ReceptionScope & {origin:string;principal:string;token:string;recipientBindingId:string};
const PATH='/crm-recepcao/v1/text-intents';
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const unavailable=()=>new Error('Reception gateway unavailable');
/** Structural preflight before JSON.parse can discard repeated object members.
 * String tokens are decoded with the native JSON parser, so escaped equivalent
 * keys collide too. JSON grammar, nesting and trailing input are checked here.
 * The caller already enforces the 4096-byte input ceiling.
 */
export function rejectDuplicateJsonKeys(source:string):void{
 let offset=0;
 const whitespace=()=>{while(/[\t\n\r ]/.test(source[offset]??'!'))offset++};
 const stringToken=():string=>{
  if(source[offset]!== '\"')throw unavailable();
  const start=offset++;
  while(offset<source.length){
   const character=source[offset++];
   if(character==='\\'){offset++;continue}
   if(character==='\"')return JSON.parse(source.slice(start,offset)) as string;
  }
  throw unavailable();
 };
 const value=(depth:number):void=>{
  if(depth>32)throw unavailable();
  whitespace();
  if(source[offset]==='\"'){stringToken();return}
  if(source[offset]==='{'){
   offset++;whitespace();const keys=new Set<string>();
   if(source[offset]==='}'){offset++;return}
   while(true){
    whitespace();const key=stringToken();if(keys.has(key))throw unavailable();keys.add(key);
    whitespace();if(source[offset++]!==':')throw unavailable();value(depth+1);whitespace();
    const delimiter=source[offset++];if(delimiter==='}')return;if(delimiter!==',')throw unavailable();
   }
  }
  if(source[offset]==='['){
   offset++;whitespace();if(source[offset]===']'){offset++;return}
   while(true){value(depth+1);whitespace();const delimiter=source[offset++];if(delimiter===']')return;if(delimiter!==',')throw unavailable()}
  }
  const start=offset;
  while(offset<source.length&&!/[,}\]\t\n\r ]/.test(source[offset]))offset++;
  const primitive=JSON.parse(source.slice(start,offset));
  if(primitive!==null&&typeof primitive!=='number'&&typeof primitive!=='boolean')throw unavailable();
 };
 value(0);whitespace();if(offset!==source.length)throw unavailable();
}
const validScope=(s:ReceptionScope)=>s&&[s.orgId,s.channelId,s.actorId].every(v=>typeof v==='string'&&UUID.test(v));
/** Inputs MUST originate in authenticated server context, never browser assertions.
 * Versioned SHA-256 UUIDv8 domain separation preserves org/channel/actor scope.
 */
export function receptionGatewayIntentId(scope:ReceptionScope,intentId:string):string{
 if(!validScope(scope)||typeof intentId!=='string'||!UUID.test(intentId))throw unavailable();
 const bytes=createHash('sha256').update(JSON.stringify(['crm-recepcao/text-intent/v1',scope.orgId,scope.channelId,scope.actorId,intentId])).digest().subarray(0,16);
 bytes[6]=(bytes[6]&0x0f)|0x80;bytes[8]=(bytes[8]&0x3f)|0x80;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function createReceptionGatewayClient(config:Config,options:{enabled?:boolean;timeoutMs?:number;fetcher?:typeof fetch}={}){
 if(typeof window!=='undefined')throw unavailable();
 let origin:URL;try{origin=new URL(config.origin)}catch{throw unavailable()}
 if(origin.protocol!=='https:'||origin.origin!==config.origin||origin.username||origin.password||!validScope(config)||!ID.test(config.principal)||!UUID.test(config.recipientBindingId)||!/^[-_A-Za-z0-9]{32,256}$/.test(config.token))throw unavailable();
 // Copy trusted configuration: caller mutations cannot change routing mid-flight.
 const fixed=Object.freeze({...config}), enabled=options.enabled===true, fetcher=options.fetcher??fetch;
 const timeout=options.timeoutMs??5000;
 if(!Number.isFinite(timeout)||timeout<1||timeout>10000)throw unavailable();
 async function request(scope:ReceptionScope,intent:string,text?:string,pilot?:{previous:string|null},context=false):Promise<ReceptionResult|null>{
  if(!enabled||!validScope(scope)||scope.orgId!==fixed.orgId||scope.channelId!==fixed.channelId||scope.actorId!==fixed.actorId||(text!==undefined&&!validBaileysText(text)))throw unavailable();
  const id=receptionGatewayIntentId(scope,intent),url=fixed.origin+(context?'/crm-recepcao/v1/bindings/'+fixed.recipientBindingId:PATH+(pilot?'-pilot':'')+(text===undefined?'/'+id:''));
  if(pilot&&pilot.previous!==null&&!UUID.test(pilot.previous))throw unavailable();
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const guard=()=>{if(controller.signal.aborted)throw unavailable()};
  const run=async()=>{
   const response=await fetcher(url,{method:text===undefined?'GET':'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal,headers:{Authorization:`Bearer ${fixed.token}`,'Content-Type':'application/json',Accept:'application/json'},...(text===undefined?{}:{body:JSON.stringify({intent_id:id,recipient_binding_id:fixed.recipientBindingId,text,...(pilot?{previous_intent_id:pilot.previous}:{})})})});
   if(controller.signal.aborted||response.status!==200||response.redirected||response.headers.has('location')||response.url&&response.url!==url||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||(response.headers.get('content-encoding')??'identity')!=='identity'){
    void response.body?.cancel().catch(()=>{});throw unavailable();
   }
   const length=response.headers.get('content-length');
   if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096)){void response.body?.cancel().catch(()=>{});throw unavailable()}
   if(!response.body)throw unavailable();const reader=response.body.getReader();
   const cancel=()=>{void reader.cancel().catch(()=>{})};controller.signal.addEventListener('abort',cancel,{once:true});
   let size=0;const chunks:Uint8Array[]=[];
   try{
    while(true){guard();const chunk=await reader.read();guard();if(chunk.done)break;size+=chunk.value.length;if(size>4096)throw unavailable();chunks.push(chunk.value)}
    if(length!==null&&Number(length)!==size)throw unavailable();
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    rejectDuplicateJsonKeys(source);
    let value=JSON.parse(source);
    if(context){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='latest')throw unavailable();value=value.latest;if(value===null)return null;}
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='delivery_state,intent_id,provider_message_ids,state'||(context?(typeof value.intent_id!=='string'||!UUID.test(value.intent_id)):value.intent_id!==id)||value.delivery_state!=='unverified'||!['recorded','dispatching','api_accepted','uncertain','rejected_before_dispatch'].includes(value.state)||!Array.isArray(value.provider_message_ids)||
       (value.state==='api_accepted'?value.provider_message_ids.length!==1||typeof value.provider_message_ids[0]!=='string'||!ID.test(value.provider_message_ids[0]):value.provider_message_ids.length!==0))throw unavailable();
    return value as ReceptionResult;
   }finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock()}
  };
  try{return await Promise.race([run(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable())},timeout)})])}
  catch{throw unavailable()}
  finally{clearTimeout(timer);controller.abort()}
 }
 return {context:(scope:ReceptionScope)=>request(scope,fixed.recipientBindingId,undefined,undefined,true),submitPilot:(scope:ReceptionScope,intent:string,text:string,previous:string|null)=>request(scope,intent,text,{previous}) as Promise<ReceptionResult>,submit:(scope:ReceptionScope,intent:string,text:string)=>request(scope,intent,text) as Promise<ReceptionResult>,status:(scope:ReceptionScope,intent:string)=>request(scope,intent) as Promise<ReceptionResult>};
}
