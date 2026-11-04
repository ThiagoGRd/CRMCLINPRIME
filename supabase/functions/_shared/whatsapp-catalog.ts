import { parseTextTemplate, PolicyError, type TextTemplate } from './whatsapp-policy.ts';
type CatalogConfig={graph:string;token:string;wabaId:string|null|undefined;phoneNumberId:string|null|undefined};
type Fetcher=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;
const unavailable=()=>new PolicyError('template_catalog_unavailable','Não foi possível verificar os templates aprovados deste canal. Confira WABA, permissões e conexão.');
export async function loadTextTemplateCatalog(config:CatalogConfig,fetcher:Fetcher=fetch):Promise<TextTemplate[]> {
 // No token in URLs, redirects, remote paging URLs, cache fallback or cross-WABA lookup.
 if(!config.token||!config.wabaId||!config.phoneNumberId||!/^\d+$/.test(config.wabaId)||
    !/^[a-zA-Z0-9_-]+$/.test(config.phoneNumberId)||!/^https:\/\/graph\.facebook\.com\/v[0-9]+\.[0-9]+$/.test(config.graph)) throw unavailable();
 async function list(edge:string,fields:string):Promise<unknown[]> {
  const rows:unknown[]=[];const seen=new Set<string>();let after='';
  for(let page=0;page<10;page++) {
   const url=new URL(`${config.graph}/${config.wabaId}/${edge}`);url.searchParams.set('fields',fields);url.searchParams.set('limit','100');if(after)url.searchParams.set('after',after);
   let response:Response;let data;
   try {response=await fetcher(url.toString(),{method:'GET',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{Authorization:`Bearer ${config.token}`}});if(!response.ok)throw unavailable();data=await response.json();}catch{throw unavailable();}
   if(!data||!Array.isArray(data.data)||data.error||data.data.length>100)throw unavailable();
   rows.push(...data.data);
   if(!data.paging?.next)return rows;
   const cursor=data.paging?.cursors?.after;
   if(typeof cursor!=='string'||!cursor||cursor.length>2048||seen.has(cursor))throw unavailable();
   seen.add(cursor);after=cursor;
  }
  throw unavailable();
 }
 const phones=await list('phone_numbers','id');
 if(!phones.some(phone=>phone!==null&&typeof phone==='object'&&'id' in phone&&phone.id===config.phoneNumberId))throw unavailable();
 const rows=await list('message_templates','id,name,language,status,category,components,parameter_format');
 const templates:TextTemplate[]=[];const keys=new Set<string>();
 for(const row of rows){
  if(row&&typeof row==='object'&&'name' in row&&'language' in row&&typeof row.name==='string'&&typeof row.language==='string'){
   const key=`${row.name}:${row.language}`;if(keys.has(key))throw unavailable();keys.add(key);
  }
  const template=parseTextTemplate(row);if(template)templates.push(template);
 }
 return templates;
}
