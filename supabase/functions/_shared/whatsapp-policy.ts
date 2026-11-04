// Conservative, pure policy shared with the preview UI. Server/database remain authoritative.
export type ServiceWindow = { open:boolean; last_inbound_at:string|null; expires_at:string|null; reason:'open'|'no_inbound'|'expired'|'invalid_timestamp' };
export function serviceWindow(lastInbound:string|null|undefined, now=Date.now()):ServiceWindow {
 if(!lastInbound) return {open:false,last_inbound_at:null,expires_at:null,reason:'no_inbound'};
 const at=Date.parse(lastInbound);
 if(!Number.isFinite(at)||!Number.isFinite(now)||at>now) return {open:false,last_inbound_at:lastInbound,expires_at:null,reason:'invalid_timestamp'};
 const expires=at+24*60*60*1000;const open=now<expires;
 return {open,last_inbound_at:lastInbound,expires_at:new Date(expires).toISOString(),reason:open?'open':'expired'};
}
export class PolicyError extends Error {
 code:string;
 constructor(code:string,message:string){super(message);this.name='PolicyError';this.code=code;}
}
export type TextTemplate = { id:string; name:string; language:string; header:string|null; body:string; footer:string|null; header_parameter_count:number; body_parameter_count:number };
export type TemplateIntent = {name:string;language:string;header:string[];body:string[];preview:string};
const isRecord=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const namePattern=/^[a-z0-9_]{1,512}$/;
const languagePattern=/^[a-z]{2,3}(?:_[A-Z]{2})?$/;
function parameterCount(text:string):number|null {
 const matches=[...text.matchAll(/\{\{([1-9][0-9]*)\}\}/g)];
 if(/[{}]/.test(text.replace(/\{\{[1-9][0-9]*\}\}/g,''))) return null;
 const indexes=[...new Set(matches.map(m=>Number(m[1])))].sort((a,b)=>a-b);
 if(indexes.length>20||indexes.some((n,i)=>n!==i+1)) return null;
 return indexes.length;
}
export function parseTextTemplate(raw:unknown):TextTemplate|null {
 if(!isRecord(raw)||raw.status!=='APPROVED'||!['UTILITY','MARKETING'].includes(String(raw.category))||
    (raw.parameter_format!==undefined&&raw.parameter_format!=='POSITIONAL')||
    typeof raw.id!=='string'||!raw.id.trim()||typeof raw.name!=='string'||!namePattern.test(raw.name)||
    typeof raw.language!=='string'||!languagePattern.test(raw.language)||!Array.isArray(raw.components)) return null;
 let header:string|null=null,body:string|null=null,footer:string|null=null;const seen=new Set();
 let headerCount=0,bodyCount=0;
 for(const component of raw.components) {
  if(!isRecord(component)||typeof component.type!=='string'||seen.has(component.type)||
     typeof component.text!=='string'||!component.text.trim()||Object.keys(component).some(k=>!['type','format','text','example'].includes(k))) return null;
  seen.add(component.type);const count=parameterCount(component.text);if(count===null) return null;
  if(component.type==='HEADER'&&component.format==='TEXT'&&component.text.length<=60&&count<=1) {header=component.text;headerCount=count;}
  else if(component.type==='BODY'&&(component.format===undefined||component.format==='TEXT')&&component.text.length<=1024) {body=component.text;bodyCount=count;}
  else if(component.type==='FOOTER'&&(component.format===undefined||component.format==='TEXT')&&component.text.length<=60&&count===0) footer=component.text;
  else return null;
 }
 if(body===null) return null;
 return {id:raw.id,name:raw.name,language:raw.language,header,body,footer,header_parameter_count:headerCount,body_parameter_count:bodyCount};
}
function variables(value:unknown,count?:number):string[] {
 if(!Array.isArray(value)||value.length>20||(count!==undefined&&value.length!==count)||value.some(v=>typeof v!=='string'||!v.trim()||v.length>1024||/[\r\n\t\u0000-\u001f\u007f]/.test(v))) {
  throw new PolicyError('template_parameters_invalid','Preencha exatamente as variáveis de texto do template, sem quebras de linha.');
 }
 return [...value] as string[];
}
export function normalizeTemplateIntent(raw:unknown):TemplateIntent {
 if(!isRecord(raw)||Object.keys(raw).some(k=>!['name','language','header','body','preview'].includes(k))||
    typeof raw.name!=='string'||!namePattern.test(raw.name)||typeof raw.language!=='string'||!languagePattern.test(raw.language)||
    typeof raw.preview!=='string'||!raw.preview.trim()||raw.preview.length>4096) throw new PolicyError('template_input_invalid','Template e prévia obrigatórios.');
 return {name:raw.name,language:raw.language,header:variables(raw.header),body:variables(raw.body),preview:raw.preview};
}
export function renderTextTemplate(template:TextTemplate,params:{header:readonly string[];body:readonly string[]}):string {
 const header=variables(params.header,template.header_parameter_count),body=variables(params.body,template.body_parameter_count);
 const fill=(text:string,values:string[])=>text.replace(/\{\{([1-9][0-9]*)\}\}/g,(_match,index)=>values[Number(index)-1]);
 const renderedHeader=template.header===null?null:fill(template.header,header);const renderedBody=fill(template.body,body);
 // Intentionally conservative product limits, not a claim to cover every Meta template shape.
 if((renderedHeader?.length??0)>60||renderedBody.length>1024) throw new PolicyError('template_parameters_invalid','A prévia excede o limite de texto suportado.');
 return [renderedHeader,renderedBody,template.footer].filter(v=>v!==null).join('\n\n');
}
export function prepareTemplateSend(catalog:TextTemplate[],intent:TemplateIntent) {
 const matches=catalog.filter(t=>t.name===intent.name&&t.language===intent.language);
 if(matches.length!==1) throw new PolicyError('template_not_available','Template não encontrado, não aprovado ou não suportado neste canal.');
 const template=matches[0];const content=renderTextTemplate(template,intent);
 if(content!==intent.preview) throw new PolicyError('template_preview_changed','O template mudou. Atualize e confira a prévia antes de enviar.');
 const components:( {type:'header'|'body';parameters:{type:'text';text:string}[]} )[]=[];
 if(intent.header.length) components.push({type:'header',parameters:intent.header.map(text=>({type:'text',text}))});
 if(intent.body.length) components.push({type:'body',parameters:intent.body.map(text=>({type:'text',text}))});
 return {content,templatePayload:{id:template.id,name:intent.name,language:intent.language,header:intent.header,body:intent.body},
  providerTemplate:{name:intent.name,language:{code:intent.language},...(components.length?{components}:{})}};
}
