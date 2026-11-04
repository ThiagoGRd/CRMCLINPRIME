import { test } from 'node:test';
import assert from 'node:assert/strict';
const catalog=await import('../supabase/functions/_shared/whatsapp-catalog.ts').catch(()=>({})) as typeof import('../supabase/functions/_shared/whatsapp-catalog.ts');
const config={graph:'https://graph.facebook.com/v25.0',token:'synthetic',wabaId:'9001',phoneNumberId:'1001'};
const template={id:'123',name:'appointment',language:'pt_BR',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'Olá {{1}}'}]};
test('catalog verifies phone ownership and only returns approved supported templates',async()=>{
 assert.equal(typeof catalog.loadTextTemplateCatalog,'function');
 const calls:{url:string;init?:RequestInit}[]=[];
 const result=await catalog.loadTextTemplateCatalog(config,async(url,init)=>{calls.push({url:String(url),init});return Response.json({data:String(url).includes('/phone_numbers')?[{id:'1001'}]:[template,{...template,name:'paused_template',status:'PAUSED'},{...template,name:'unsupported_template',components:[{type:'BUTTONS'}]}]})});
 assert.equal(result.length,1);assert.equal(calls.length,2);assert.match(calls[0].url,/\/9001\/phone_numbers\?/);assert.match(calls[1].url,/\/9001\/message_templates\?/);
 assert.equal(calls[0].init?.method,'GET');assert.equal(calls[0].init?.redirect,'error');
 assert.ok(!calls[1].url.includes('synthetic'));
});
test('catalog fails closed on unavailable credentials, WABA mismatch, metadata failure and malformed response',async()=>{
 for(const patch of [{token:''},{wabaId:''},{phoneNumberId:''},{wabaId:'../other'}]) await assert.rejects(catalog.loadTextTemplateCatalog({...config,...patch},async()=>{throw Error('must not fetch')}));
 for(const response of [()=>Response.json({data:[{id:'9999'}]}),()=>Response.json({error:{code:1}},{status:403}),()=>Response.json({data:{}}),()=>new Response('broken')]) await assert.rejects(catalog.loadTextTemplateCatalog(config,async()=>response()));
});
test('pagination uses only same-origin constructed cursors and refuses partial or ambiguous catalog',async()=>{
 const calls:string[]=[];let page=0;
 const result=await catalog.loadTextTemplateCatalog(config,async(url)=>{calls.push(String(url));if(String(url).includes('/phone_numbers'))return Response.json({data:[{id:'1001'}]});page++;return Response.json(page===1?{data:[],paging:{next:'https://evil.invalid/steal?access_token=secret',cursors:{after:'cursor+one'}}}:{data:[template]})});
 assert.equal(result.length,1);assert.ok(calls.every(url=>url.startsWith(config.graph+'/9001/')));assert.match(calls[2],/after=cursor%2Bone/);
 await assert.rejects(catalog.loadTextTemplateCatalog(config,async(url)=>Response.json(String(url).includes('/phone_numbers')?{data:[{id:'1001'}]}:{data:[],paging:{next:'untrusted'}})));
 await assert.rejects(catalog.loadTextTemplateCatalog(config,async(url)=>Response.json({data:String(url).includes('/phone_numbers')?[{id:'1001'}]:[template,template]})));
});
test('conflicting approval entries for the same exact template fail closed',async()=>{
 await assert.rejects(catalog.loadTextTemplateCatalog(config,async(url)=>Response.json({data:String(url).includes('/phone_numbers')?[{id:'1001'}]:[template,{...template,status:'PAUSED'}]})));
});
