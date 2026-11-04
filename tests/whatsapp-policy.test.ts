import { test } from 'node:test';
import assert from 'node:assert/strict';
const policy = await import('../supabase/functions/_shared/whatsapp-policy.ts').catch(() => ({})) as typeof import('../supabase/functions/_shared/whatsapp-policy.ts');
const raw = { id:'123', name:'appointment', language:'pt_BR', status:'APPROVED', category:'UTILITY', components:[{type:'HEADER',format:'TEXT',text:'Olá {{1}}'},{type:'BODY',text:'Consulta em {{1}}, às {{2}}.'},{type:'FOOTER',text:'Clínica'}] };
test('24h policy closes missing, invalid, future and exact-boundary inbound timestamps', () => {
 assert.equal(typeof policy.serviceWindow,'function');
 const now=Date.parse('2026-11-03T12:00:00Z');
 for(const at of [null,'broken','2026-11-03T12:00:01Z','2026-11-02T12:00:00Z']) assert.equal(policy.serviceWindow(at,now).open,false);
 assert.equal(policy.serviceWindow('2026-11-02T12:00:00.001Z',now).open,true);
 assert.equal(policy.serviceWindow(null,now).reason,'no_inbound');
});
test('catalog only supports approved complete text shapes and contiguous positional variables', () => {
 assert.equal(policy.parseTextTemplate(raw)?.body_parameter_count,2);
 for(const change of [{status:'PAUSED'},{status:'PENDING'},{status:undefined},{category:'AUTHENTICATION'},{parameter_format:'NAMED'},{language:''}]) assert.equal(policy.parseTextTemplate({...raw,...change}),null);
 for(const component of [{type:'BUTTONS',buttons:[]},{type:'HEADER',format:'IMAGE'},{type:'CAROUSEL'},{type:'BODY',text:'Hello {{2}}'},{type:'BODY',text:'Hello {{name}}'},{type:'BODY',text:'Hello {{1}'}]) assert.equal(policy.parseTextTemplate({...raw,components:[component]}),null);
 assert.equal(policy.parseTextTemplate({...raw,components:[...raw.components,raw.components[1]]}),null);
});
test('template rendering validates exact variable count, nonblank strings and safe lengths', () => {
 const item=policy.parseTextTemplate(raw)!;
 assert.equal(policy.renderTextTemplate(item,{header:['Ana'],body:['amanhã','10h']}),'Olá Ana\n\nConsulta em amanhã, às 10h.\n\nClínica');
 for(const variables of [{header:[],body:['amanhã','10h']},{header:['Ana'],body:['amanhã']},{header:['Ana'],body:['', '10h']},{header:['Ana'],body:[42,'10h']},{header:['A'.repeat(61)],body:['amanhã','10h']},{header:['Ana'],body:['a'.repeat(1024),'10h']},{header:['Ana'],body:['a\nb','10h']}]) assert.throws(()=>policy.renderTextTemplate(item,variables as never));
});
test('template send binds exact identity, variables and confirmed preview and builds text-only provider payload', () => {
 const item=policy.parseTextTemplate(raw)!;
 const intent={name:'appointment',language:'pt_BR',header:['Ana'],body:['amanhã','10h'],preview:'Olá Ana\n\nConsulta em amanhã, às 10h.\n\nClínica'};
 const prepared=policy.prepareTemplateSend([item],policy.normalizeTemplateIntent(intent));
 assert.equal(prepared.content,intent.preview);
 assert.deepEqual(prepared.templatePayload,{id:'123',name:'appointment',language:'pt_BR',header:['Ana'],body:['amanhã','10h']});
 assert.deepEqual(prepared.providerTemplate,{name:'appointment',language:{code:'pt_BR'},components:[{type:'header',parameters:[{type:'text',text:'Ana'}]},{type:'body',parameters:[{type:'text',text:'amanhã'},{type:'text',text:'10h'}]}]});
 for(const modified of [{...intent,name:'other'},{...intent,language:'en_US'},{...intent,preview:'Forged preview'}]) assert.throws(()=>policy.prepareTemplateSend([item],policy.normalizeTemplateIntent(modified)));
 for(const modified of [{...intent,extra:'ignored'},{...intent,body:[7]},{...intent,header:'Ana'},{...intent,preview:''}]) assert.throws(()=>policy.normalizeTemplateIntent(modified));
 assert.throws(()=>policy.prepareTemplateSend([item,item],policy.normalizeTemplateIntent(intent)));
});
test('unknown component features and non-text footer metadata are not silently discarded',()=>{
 for(const component of [{type:'BODY',text:'Hello',unknown_feature:true},{type:'FOOTER',text:'Footer',format:'IMAGE'},{type:'BODY',text:'Code',add_security_recommendation:true}]) assert.equal(policy.parseTextTemplate({...raw,components:[{type:'BODY',text:'Hello'},component]}),null);
 assert.equal(policy.parseTextTemplate({...raw,components:[{type:'BODY',text:'Hello',unknown_feature:true}]}),null);
});
