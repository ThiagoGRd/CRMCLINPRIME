/** Public, bounded operator facts. Never contains private provider routing. */
export const BAILEYS_TEXT_MAX_BYTES = 1024;
export const baileysTextUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type BaileysTextContext = {orgId:string;actorId:string;conversationId:string;channelId:string;sendAvailable:boolean;blocked:boolean;pendingIntentId:string|null;maxTextBytes:number};
export function validBaileysTextContext(value:unknown):value is BaileysTextContext {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>,keys=['orgId','actorId','conversationId','channelId','sendAvailable','blocked','pendingIntentId','maxTextBytes'];
 return Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))&&['orgId','actorId','conversationId','channelId'].every(k=>typeof v[k]==='string'&&baileysTextUUID.test(v[k]))&&typeof v.sendAvailable==='boolean'&&typeof v.blocked==='boolean'&&!(v.sendAvailable&&v.blocked)&&(v.pendingIntentId===null||(typeof v.pendingIntentId==='string'&&baileysTextUUID.test(v.pendingIntentId)&&v.blocked))&&typeof v.maxTextBytes==='number'&&Number.isInteger(v.maxTextBytes)&&v.maxTextBytes>=1&&v.maxTextBytes<=BAILEYS_TEXT_MAX_BYTES;
}
export function validBaileysText(text:unknown):text is string {
 return typeof text==='string'&&text.trim().length>0&&new TextEncoder().encode(text).length<=BAILEYS_TEXT_MAX_BYTES&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)&&!/[\uD800-\uDFFF]/u.test(text);
}
