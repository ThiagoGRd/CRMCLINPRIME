// Browser checks use real UI components and Supabase HTTP against synthetic local data.
// Automated browser execution is optional. Use SERVE_ONLY with the approved CUA tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createFixture,createFixtureServer,fixtureUserId} from './fixture-server.mjs';
import {fixtureIds as ids} from './fixture-identities.ts';
import {runOperatorScenarios} from './operator-scenarios.mjs';

const root=process.cwd();
const toolRoot=process.env.CRM_BROWSER_TOOLS ?? '/tmp/crm-ui-tools/node_modules';
const {build}=await import(pathToFileURL(path.join(toolRoot,'esbuild/lib/main.js')));
const {default:postcss}=await import('postcss');
const {default:tailwind}=await import('@tailwindcss/postcss');
const out=process.env.CRM_BROWSER_OUTPUT ?? '/tmp/crm-browser-output';
await fs.mkdir(out,{recursive:true});
const nextSendMode=process.env.CRM_BROWSER_SCENARIO ?? 'success';
assert.ok(['success','uncertain-after-claim','drop-before-claim','accepted-before-storage'].includes(nextSendMode),'Unknown synthetic delivery scenario');
const windowMode=process.env.CRM_BROWSER_WINDOW ?? 'open';
assert.ok(['open','expired'].includes(windowMode),'Unknown synthetic window scenario');
const fixture=createFixture({nextSendMode,windowMode});
const {pending,sends,errors,requests,statusLookups,outbound}=fixture;
const server=createFixtureServer(fixture,{out});
let browser;
try {
  let base=`http://127.0.0.1:${Number(process.env.CRM_BROWSER_PORT ?? 4178)}`;
  if (process.env.CRM_BROWSER_BUILD_ONLY !== '1') {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.CRM_BROWSER_PORT ?? 0),'127.0.0.1',resolve);});
    base=`http://127.0.0.1:${server.address().port}`;
  }
  await build({entryPoints:[path.join(root,'tests/browser/fixture.tsx')],bundle:true,outfile:path.join(out,'app.js'),platform:'browser',jsx:'automatic',define:{'process.env.NEXT_PUBLIC_SUPABASE_URL':JSON.stringify(base),'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY':'"synthetic-test-key"','process.env.NODE_ENV':'"test"'},alias:{'@/lib/supabase/client':path.join(root,'tests/browser/supabase-client.tsx'),'@':root,'next/navigation':path.join(root,'tests/browser/navigation.tsx'),'next/link':path.join(root,'tests/browser/navigation.tsx')}});
  const css=await postcss([tailwind()]).process(await fs.readFile('app/globals.css','utf8'),{from:path.join(root,'app/globals.css')});
  await fs.writeFile(path.join(out,'style.css'),css.css);
  if (process.env.CRM_BROWSER_BUILD_ONLY === '1') {
    console.log(`PASS bundle only: ${out}. No browser was launched.`);
  } else if (process.env.CRM_BROWSER_SERVE_ONLY === '1') {
    console.log(`Synthetic browser fixture: ${base}`);
    console.log(`Read-only synthetic request log: ${base}/__fixture__/state`);
    console.log(`Next send scenario: ${nextSendMode}; authenticated synthetic user: ${fixtureUserId}`);
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  } else {
    // Do not use this branch where browser automation must run through CUA.
    assert.equal(nextSendMode,'success','Automated suite manages its own failures; use default delivery scenario');
    assert.equal(windowMode,'open','Automated suite manages its own window scenarios; use default window');
    const {chromium}=await import(pathToFileURL(path.join(toolRoot,'playwright/index.mjs')));
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const pageErrors=[]; page.on('pageerror',error=>pageErrors.push(error.message));
    const waitUntil=async(predicate,label)=>{
      const deadline=Date.now()+10000;
      while(!predicate()&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
      assert.ok(predicate(),label);
    };
    const openConversation=async(id)=>{
      await page.goto(`${base}/?c=${id}`);
      await page.getByRole('textbox',{name:'Mensagem',exact:true}).waitFor();
      await page.getByText(id===ids.receptionConversation?'Olá recepção':id===ids.commercialConversation?'Olá comercial':'Olá CRC',{exact:false}).waitFor();
    };
    const sendText=async(text)=>{
      await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill(text);
      await page.getByRole('button',{name:'Enviar mensagem',exact:true}).click();
    };
    await page.goto(base);
    await page.getByRole('button',{name:/Maria Teste/}).click();
    await page.getByText('Olá recepção',{exact:false}).waitFor();
    assert.equal(await page.getByText('Olá comercial',{exact:false}).count(),0);
    await sendText('Resposta apenas recepção');
    await page.getByRole('tab',{name:'Comercial',exact:true}).click();
    await page.getByRole('button',{name:/Maria Teste/}).click();
    await page.getByText('Olá comercial',{exact:false}).waitFor();
    await waitUntil(()=>outbound.some(row=>row.state==='sent'),'first send settles');
    assert.equal(await page.getByText('Resposta apenas recepção',{exact:false}).count(),0);
    assert.equal(sends.length,1);
    assert.match(sends[0].request_id,/^[0-9a-f-]{36}$/i);
    assert.deepEqual(sends[0],{request_id:sends[0].request_id,conversation_id:ids.receptionConversation,channel_id:ids.reception,text:'Resposta apenas recepção'});

    await page.getByRole('button',{name:'Nova pendência',exact:true}).click();
    await page.getByLabel('Título',{exact:true}).fill('Confirmar retorno sintético');
    await page.getByLabel('Responsável',{exact:true}).selectOption(ids.member);
    await page.getByLabel('Prazo',{exact:true}).fill('2026-11-15T09:00');
    await page.getByRole('button',{name:'Criar pendência',exact:true}).click();
    await page.getByRole('heading',{name:'Confirmar retorno sintético'}).waitFor();
    assert.equal(pending[0].conversation_id,ids.commercialConversation);
    await openConversation(ids.commercialConversation);
    await page.getByRole('heading',{name:'Confirmar retorno sintético'}).waitFor();
    await page.screenshot({path:path.join(out,'commercial-pending.png'),fullPage:true});
    await page.getByRole('button',{name:'Resolver manualmente'}).click();
    assert.equal(await page.getByRole('button',{name:'Confirmar resolução'}).isDisabled(),true);
    await page.getByLabel('Evidência da resolução').fill('Contato sintético confirmado manualmente');
    await page.getByRole('button',{name:'Confirmar resolução'}).click();
    await page.getByText('Nenhuma pendência nesta página.').waitFor();
    await page.getByLabel('Mostrar',{exact:true}).selectOption('resolved');
    await page.getByText('Evidência: Contato sintético confirmado manualmente').waitFor();
    assert.equal(pending[0].status,'resolved');

    await page.getByRole('tab',{name:'CRC',exact:true}).click();
    await page.getByRole('button',{name:/Maria Teste/}).click();
    await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Não enviar');
    assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true);
    assert.equal(sends.length,1);
    await page.goto(`${base}/?p=${ids.patient}`);
    await page.getByText('O link do paciente não escolhe um número automaticamente.',{exact:false}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'Mensagem',exact:true}).count(),0);

    // A lost response keeps its request identity and blocks the same text, without a resend.
    await openConversation(ids.receptionConversation);
    fixture.nextSendMode='uncertain-after-claim';
    await sendText('Resposta com retorno incerto');
    await page.getByRole('button',{name:'Consultar tentativa',exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:'Consultar tentativa',exact:true}).click();
    await waitUntil(()=>statusLookups.length>0,'status-only lookup recorded');
    const uncertainRequest=sends.at(-1).request_id;
    assert.deepEqual(statusLookups.at(-1),{request_id:uncertainRequest,action:'status'});
    assert.equal(sends.length,2);
    await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Resposta com retorno incerto');
    assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true);
    await page.reload();
    await page.getByRole('button',{name:'Consultar tentativa',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Resposta com retorno incerto');
    assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true);
    assert.equal(sends.length,2);

    // Lost before claim: no server row exists, so only durable browser metadata protects reload.
    await openConversation(ids.commercialConversation);
    fixture.nextSendMode='drop-before-claim';
    await sendText('Texto privado que nunca deve persistir no navegador');
    await page.getByRole('button',{name:'Consultar tentativa',exact:true}).waitFor();
    const lostRequest=requests.filter(row=>row.path==='/functions/v1/whatsapp-send'&&row.payload?.text).at(-1).payload;
    assert.equal(outbound.some(row=>row.request_id===lostRequest.request_id),false);
    const stored=await page.evaluate(()=>Object.entries(localStorage));
    const marker=stored.find(([,value])=>value.includes(lostRequest.request_id));
    assert.ok(marker,'identity persisted before send');
    assert.ok(marker[0].includes(ids.org)&&marker[0].includes(fixtureUserId),'recovery key is scoped to organization and authenticated user');
    const metadata=JSON.parse(marker[1]);
    assert.equal(metadata.request_id,lostRequest.request_id);
    assert.deepEqual(Object.keys(metadata).sort(),['channel_id','conversation_id','created_at','request_id']);
    assert.ok(Number.isFinite(Date.parse(metadata.created_at)),'metadata has a valid timestamp');
    assert.equal(stored.some(([,value])=>value.includes(lostRequest.text)),false,'message text is never persisted');
    const beforeReload=requests.length;
    await page.reload();
    await page.getByText('Tentativa recuperada após recarga. O texto não é guardado neste navegador.',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Outra mensagem não pode contornar a dúvida');
    assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Consultar tentativa',exact:true}).click();
    await waitUntil(()=>statusLookups.filter(row=>row.request_id===lostRequest.request_id).length>=2,'reload and manual lookup remain status-only');
    assert.equal(requests.slice(beforeReload).filter(row=>row.path==='/functions/v1/whatsapp-send').every(row=>row.payload.action==='status'),true);
    assert.equal(sends.length,2);
    assert.equal(outbound.some(row=>row.request_id===lostRequest.request_id),false);

    // Navigation follows the real history component; its page never exposes a send control.
    const historyStart=requests.length;
    await page.getByRole('link',{name:'Consultar histórico antigo sem canal',exact:true}).click();
    await page.getByRole('heading',{name:'Histórico legado',exact:true}).waitFor();
    await page.getByText('Registro legado sintético 001',{exact:false}).waitFor();
    assert.equal(await page.getByText('Olá recepção',{exact:false}).count(),0);
    assert.equal(await page.getByText('Não mostrar: canal parcialmente identificado',{exact:false}).count(),0);
    assert.equal(await page.getByRole('textbox',{name:'Mensagem',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).count(),0);
    await page.getByRole('button',{name:'Próxima página de mensagens',exact:true}).click();
    await page.getByText('Registro legado sintético 041',{exact:false}).waitFor();
    assert.equal(await page.getByText('Registro legado sintético 001',{exact:false}).count(),0);
    await page.getByRole('button',{name:'Página anterior de mensagens',exact:true}).click();
    await page.getByText('Registro legado sintético 001',{exact:false}).waitFor();
    assert.equal(requests.slice(historyStart).some(row=>row.method!=='GET'),false,'legacy history is read-only');
    await page.screenshot({path:path.join(out,'legacy-read-only.png'),fullPage:true});
    await page.goBack();
    await page.getByRole('textbox',{name:'Mensagem',exact:true}).waitFor();
    await page.goForward();
    await page.getByRole('heading',{name:'Histórico legado',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).count(),0);
    const outboundQueries=requests.filter(row=>row.path==='/rest/v1/crm_outbound_requests');
    assert.ok(outboundQueries.length>0);
    assert.ok(outboundQueries.every(row=>row.params.org_id===`eq.${ids.org}`&&row.params.conversation_id?.startsWith('eq.')));
    await runOperatorScenarios({page,base,fixture,openConversation,sendText,waitUntil,out});
    assert.deepEqual(pageErrors,[]); assert.deepEqual(errors,[]);
    console.log('PASS browser: scoped histories/send UUIDs, late-response isolation, durable pending items, evidence resolution, disconnected block, ambiguous patient link, uncertain delivery, status-only no resend, metadata-only reload-before-claim recovery, legacy pagination/read-only/navigation, explicit template/window policy, audited operator recovery, open/reuse conversation without sending.');
    console.log(`Screenshots: ${out}/commercial-pending.png and ${out}/legacy-read-only.png`);
  }
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
}
