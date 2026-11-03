// Browser checks use actual UI components and Supabase client against a local HTTP fixture.
// No credentials, patients or external services are used.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const toolRoot = process.env.CRM_BROWSER_TOOLS ?? '/tmp/crm-ui-tools/node_modules';
const {build} = await import(pathToFileURL(path.join(toolRoot, 'esbuild/lib/main.js')));
const {chromium} = await import(pathToFileURL(path.join(toolRoot, 'playwright/index.mjs')));
const {default: postcss} = await import('postcss');
const {default: tailwind} = await import('@tailwindcss/postcss');
const out = '/tmp/crm-browser-output'; await fs.mkdir(out, {recursive:true});
const org = 'org-a';
const patient = {id:'patient-a', org_id:org, name:'Maria Teste', phone:'11911112222', tags:[], treatment_interest:'Avaliação sintética',source:'Teste',clinicorp_status:null,clinicorp_amount:null,created_at:'2026-11-01T10:00:00Z'};
const channels = [
  {id:'number-r',org_id:org,type:'whatsapp_cloud',display_name:'Recepção teste',status:'connected',inbox_key:'reception',config:{display_phone:'11 3000-0001'},phone_number_id:'phone-r'},
  {id:'number-c',org_id:org,type:'whatsapp_cloud',display_name:'Comercial teste',status:'connected',inbox_key:'commercial',config:{display_phone:'11 3000-0002'},phone_number_id:'phone-c'},
  {id:'number-crc',org_id:org,type:'whatsapp_cloud',display_name:'CRC teste',status:'disconnected',inbox_key:'crc',config:{display_phone:'11 3000-0003'},phone_number_id:'phone-crc'},
];
const conversations = channels.map((channel,i) => ({id:['conversation-r','conversation-c','conversation-crc'][i],org_id:org,patient_id:patient.id,channel_id:channel.id,assigned_to:'member-a',status:'open',last_message_at:'2026-11-01T10:00:00Z',patient,channel}));
const messages = conversations.map((c,i) => ({id:`message-${i}`,org_id:org,patient_id:patient.id,conversation_id:c.id,channel_id:c.channel_id,direction:'inbound',content:['Olá recepção','Olá comercial','Olá CRC'][i],status:'received',created_at:'2026-11-01T10:00:00Z'}));
const pending=[]; const sends=[]; const errors=[]; const requests=[];
const tables={channels,crm_conversations:conversations,crm_patients:[patient],crm_messages:messages,crm_pending_items:pending,org_members:[{user_id:'member-a',org_id:org,display_name:'Layla Teste',created_at:'2026-11-01T10:00:00Z'}],quick_replies:[]};
let id=10;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','*');
 if(req.method==='OPTIONS'){res.end();return;}
 const json=(data,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
 try{
 if(url.pathname==='/app.js'){res.setHeader('content-type','application/javascript');res.end(await fs.readFile(path.join(out,'app.js')));return;}
 if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');res.end(await fs.readFile(path.join(out,'style.css')));return;}
 if(!url.pathname.startsWith('/rest/')&&!url.pathname.startsWith('/functions/')){res.setHeader('content-type','text/html');res.end('<!doctype html><html class="dark"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><body style="background:#101018;color:#eee;font-family:Arial"><div id="root"></div><script type="module" src="/app.js"></script></body></html>');return;}
 let raw='';for await (const chunk of req)raw+=chunk;
 const payload=raw?JSON.parse(raw):null;
 requests.push({method:req.method,path:url.pathname,params:Object.fromEntries(url.searchParams),payload});
 if(url.pathname==='/functions/v1/whatsapp-send'){
  sends.push(payload);
  const c=conversations.find(c=>c.id===payload.conversation_id&&c.channel_id===payload.channel_id);
  if(!c||c.channel.status!=='connected')return json({error:'wrong route'},409);
  await new Promise(r=>setTimeout(r,350));
  const message={id:`sent-${id++}`,org_id:org,patient_id:patient.id,conversation_id:c.id,channel_id:c.channel_id,direction:'outbound',content:payload.text,status:'sent',created_at:new Date().toISOString()};messages.push(message);return json({message});
 }
 if(url.pathname==='/rest/v1/rpc/resolve_pending_item'){
  const item=pending.find(i=>i.id===payload.p_id);
  if(!item||!payload.p_evidence?.trim())return json({message:'evidence required'},400);
  Object.assign(item,{status:'resolved',resolution_evidence:payload.p_evidence,resolved_by:'member-a',resolved_at:new Date().toISOString(),updated_at:new Date().toISOString()});return json(item);
 }
 const table=url.pathname.split('/').at(-1), rows=tables[table];
 if(!rows)return json({message:'unexpected table'},400);
 if(req.method==='POST'){
  const item={...payload,id:`pending-${id++}`,resolution_evidence:null,resolved_by:null,resolved_at:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};rows.push(item);return json(item,201);
 }
 let result=rows.filter(row=>[...url.searchParams].every(([key,value])=>{
  if(value.startsWith('eq.'))return String(row[key])===value.slice(3);
  if(value.startsWith('in.('))return value.slice(4,-1).split(',').includes(row[key]);
  return true;
 }));
 if(req.method==='PATCH'){result.forEach(row=>Object.assign(row,payload,{updated_at:new Date().toISOString()}));return json(result[0]??{});}
 const count=result.length;
 const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??500);
 result=result.slice(offset,offset+limit);
 res.setHeader('content-range',`${offset}-${offset+result.length-1}/${count}`);res.setHeader('Access-Control-Expose-Headers','content-range');return json(result);
 }catch(error){errors.push(String(error));json({message:String(error)},500);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;const base=`http://127.0.0.1:${port}`;
await build({entryPoints:[path.join(root,'tests/browser/fixture.tsx')],bundle:true,outfile:path.join(out,'app.js'),platform:'browser',jsx:'automatic',define:{'process.env.NEXT_PUBLIC_SUPABASE_URL':JSON.stringify(base),'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY':'"synthetic-test-key"','process.env.NODE_ENV':'"test"'},alias:{'@':root,'next/navigation':path.join(root,'tests/browser/navigation.tsx'),'next/link':path.join(root,'tests/browser/navigation.tsx')}});
const css=await postcss([tailwind()]).process(await fs.readFile('app/globals.css','utf8'),{from:path.join(root,'app/globals.css')});await fs.writeFile(path.join(out,'style.css'),css.css);
if (process.env.CRM_BROWSER_SERVE_ONLY === '1') {
 console.log(`Synthetic browser fixture: ${base}`);
 await new Promise(() => {});
}
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:/Maria Teste/}).click();
 await page.getByText('Olá recepção',{exact:true}).waitFor();assert.equal(await page.getByText('Olá comercial',{exact:true}).count(),0);
 await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Resposta apenas recepção');await page.getByRole('button',{name:'Enviar mensagem',exact:true}).click();
 await page.getByRole('tab',{name:'Comercial',exact:true}).click();await page.getByRole('button',{name:/Maria Teste/}).click();await page.getByText('Olá comercial',{exact:true}).waitFor();
 await page.waitForTimeout(500);assert.equal(await page.getByText('Resposta apenas recepção',{exact:true}).count(),0);assert.deepEqual(sends,[{conversation_id:'conversation-r',channel_id:'number-r',text:'Resposta apenas recepção'}]);
 await page.getByRole('button',{name:'Nova pendência',exact:true}).click();await page.getByLabel('Título',{exact:true}).fill('Confirmar retorno sintético');await page.getByLabel('Responsável',{exact:true}).selectOption('member-a');await page.getByLabel('Prazo',{exact:true}).fill('2026-11-15T09:00');await page.getByRole('button',{name:'Criar pendência',exact:true}).click();await page.getByRole('heading',{name:'Confirmar retorno sintético'}).waitFor();
 assert.equal(pending[0].conversation_id,'conversation-c');
 await page.goto(`${base}/?c=conversation-c`);await page.getByRole('heading',{name:'Confirmar retorno sintético'}).waitFor();
 await page.screenshot({path:path.join(out,'commercial-pending.png'),fullPage:true});
 await page.getByRole('button',{name:'Resolver manualmente'}).click();assert.equal(await page.getByRole('button',{name:'Confirmar resolução'}).isDisabled(),true);await page.getByLabel('Evidência da resolução').fill('Contato sintético confirmado manualmente');await page.getByRole('button',{name:'Confirmar resolução'}).click();await page.getByText('Nenhuma pendência nesta página.').waitFor();
 await page.getByLabel('Mostrar',{exact:true}).selectOption('resolved');await page.getByText('Evidência: Contato sintético confirmado manualmente').waitFor();assert.equal(pending[0].status,'resolved');
 await page.getByRole('tab',{name:'CRC',exact:true}).click();await page.getByRole('button',{name:/Maria Teste/}).click();await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Não enviar');assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true);assert.equal(sends.length,1);
 await page.goto(`${base}/?p=patient-a`);await page.getByText('Escolha o setor e a conversa deste paciente.',{exact:false}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Mensagem',exact:true}).count(),0);
 assert.deepEqual(pageErrors,[]);assert.deepEqual(errors,[]);
 console.log('PASS browser: isolated channel histories, exact send route, late response isolation, durable reload, explicit evidence resolution, disconnected block, ambiguous patient link.');
 console.log(`Screenshot: ${out}/commercial-pending.png`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
