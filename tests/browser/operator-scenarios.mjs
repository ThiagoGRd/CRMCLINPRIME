// Browser scenarios for an environment where Playwright is permitted.
// Importing this module never launches a browser. CUA-only environments use serve mode.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fixtureIds as ids} from './fixture-identities.ts';

export async function runOperatorScenarios({page,base,fixture,openConversation,sendText,waitUntil,out}) {
  const {sends,requests,audit,conversations}=fixture;
  const openPanel=async()=>{
    await page.getByRole('button',{name:'Abrir conversa',exact:true}).click();
    await page.getByRole('dialog',{name:'Abrir conversa',exact:true}).waitFor();
  };
  const selectPatient=async name=>{
    const dialog=page.getByRole('dialog',{name:'Abrir conversa',exact:true});
    await dialog.getByLabel('Buscar paciente',{exact:true}).fill(name);
    await dialog.getByRole('button',{name:new RegExp(name)}).click();
    await dialog.getByText(`Paciente selecionado:`,{exact:false}).waitFor();
    return dialog;
  };

  // Closing a partially completed form must not create a conversation or send.
  await page.goto(base);
  const beforeOpen={conversations:conversations.length,sends:sends.length};
  await openPanel();
  let dialog=await selectPatient('João Sintético');
  await dialog.getByLabel('Número de atendimento',{exact:true}).selectOption(ids.reception);
  await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();
  await page.getByRole('dialog',{name:'Abrir conversa',exact:true}).waitFor({state:'hidden'});
  assert.equal(conversations.length,beforeOpen.conversations);
  assert.equal(sends.length,beforeOpen.sends);
  await openPanel();
  dialog=page.getByRole('dialog',{name:'Abrir conversa',exact:true});
  assert.equal(await dialog.getByLabel('Número de atendimento',{exact:true}).inputValue(),'');
  assert.equal(await dialog.getByRole('button',{name:'Abrir conversa sem enviar',exact:true}).isDisabled(),true);
  dialog=await selectPatient('João Sintético');
  await dialog.getByLabel('Número de atendimento',{exact:true}).selectOption(ids.reception);
  await dialog.getByRole('button',{name:'Abrir conversa sem enviar',exact:true}).click();
  await page.getByRole('dialog',{name:'Abrir conversa',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('textbox',{name:'Mensagem',exact:true}).waitFor();
  await waitUntil(()=>conversations.length===beforeOpen.conversations+1,'exactly one new conversation');
  const created=conversations.find(row=>row.patient_id===ids.newPatient&&row.channel_id===ids.reception);
  assert.ok(created);
  assert.equal(sends.length,beforeOpen.sends,'opening a conversation cannot send');
  await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Sem inbound não pode enviar texto');
  assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Templates aprovados',exact:true}).isEnabled(),true);
  await openPanel();
  dialog=await selectPatient('João Sintético');
  await dialog.getByLabel('Número de atendimento',{exact:true}).selectOption(ids.reception);
  await dialog.getByRole('button',{name:'Abrir conversa sem enviar',exact:true}).click();
  await page.getByRole('dialog',{name:'Abrir conversa',exact:true}).waitFor({state:'hidden'});
  assert.equal(conversations.length,beforeOpen.conversations+1,'same patient/number route is reused');
  assert.equal(sends.length,beforeOpen.sends);

  // A no-inbound conversation needs a reviewed template, never a free-text fallback.
  await page.getByRole('button',{name:'Templates aprovados',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'Enviar template aprovado',exact:true});
  await picker.getByLabel('Template e idioma',{exact:true}).selectOption('synthetic-template-1');
  assert.equal(await picker.getByRole('button',{name:'Confirmar e enviar template',exact:true}).isDisabled(),true);
  await picker.getByRole('textbox',{name:'Mensagem variável 1',exact:true}).fill('João');
  const preview='Olá João, este é um retorno sintético da clínica.';
  await picker.getByText(preview,{exact:true}).waitFor();
  await picker.getByRole('button',{name:'Voltar',exact:true}).click();
  assert.equal(sends.length,beforeOpen.sends,'dismissed template preview cannot send');
  await page.getByRole('button',{name:'Templates aprovados',exact:true}).click();
  await picker.getByRole('button',{name:'Confirmar e enviar template',exact:true}).click();
  await picker.waitFor({state:'hidden'});
  await page.getByText(preview,{exact:false}).waitFor();
  assert.equal(sends.length,beforeOpen.sends+1);
  assert.deepEqual(sends.at(-1),{request_id:sends.at(-1).request_id,conversation_id:created.id,channel_id:ids.reception,kind:'template',template:{name:'retorno_sintetico',language:'pt_BR',header:[],body:['João'],preview}});
  assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true,'outbound template never opens a free-text window');

  // Unknown transport can be observed but is not proof of delivery or permission to resend.
  await openConversation(ids.receptionConversation);
  await page.getByRole('button',{name:'Conferir tentativa',exact:true}).click();
  let review=page.getByRole('dialog',{name:'Conferir tentativa de envio',exact:true});
  await review.getByLabel('Ação',{exact:true}).selectOption('observe');
  assert.equal(await review.getByRole('button',{name:'Confirmar conferência',exact:true}).isDisabled(),true);
  await review.getByLabel('O que foi conferido e qual é a evidência?',{exact:true}).fill('Conferência sintética: resultado ainda não confirmado.');
  const beforeObserve=sends.length;
  await review.getByRole('button',{name:'Confirmar conferência',exact:true}).click();
  await review.waitFor({state:'hidden'});
  await page.getByText('Conferência sintética: resultado ainda não confirmado.',{exact:true}).waitFor();
  assert.equal(audit.at(-1).operation,'observe');
  assert.equal(audit.at(-1).resulting_state,'uncertain');
  assert.equal(sends.length,beforeObserve);
  await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Resposta com retorno incerto');
  assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isDisabled(),true);

  // Durable provider acceptance can be saved locally without repeating transport.
  fixture.nextSendMode='accepted-before-storage';
  await sendText('Aceitação sintética aguardando registro');
  await waitUntil(()=>fixture.outbound.some(row=>row.content==='Aceitação sintética aguardando registro'&&row.provider_message_id),'accepted response retained');
  await page.getByRole('button',{name:'Conferir tentativa',exact:true}).last().click();
  review=page.getByRole('dialog',{name:'Conferir tentativa de envio',exact:true});
  assert.equal(await review.getByLabel('Ação',{exact:true}).inputValue(),'finalize');
  const beforeFinalize=sends.length;
  await review.getByLabel('O que foi conferido e qual é a evidência?',{exact:true}).fill('Aceitação sintética do provedor conferida.');
  await review.getByRole('button',{name:'Confirmar conferência',exact:true}).click();
  await review.waitFor({state:'hidden'});
  await page.getByText('Aceitação sintética aguardando registro',{exact:false}).waitFor();
  await page.getByText('Aceitação sintética do provedor conferida.',{exact:true}).waitFor();
  assert.equal(audit.at(-1).operation,'finalize');
  assert.equal(audit.at(-1).resulting_state,'sent');
  assert.equal(sends.length,beforeFinalize,'local finalization cannot repeat transport');

  // A marker with no server claim can be cancelled, then remains terminal on status lookup.
  await openConversation(ids.commercialConversation);
  await page.getByRole('button',{name:'Conferir tentativa',exact:true}).click();
  review=page.getByRole('dialog',{name:'Conferir tentativa de envio',exact:true});
  assert.equal(await review.getByLabel('Ação',{exact:true}).inputValue(),'cancel');
  await review.getByLabel('O que foi conferido e qual é a evidência?',{exact:true}).fill('Nenhum envio sintético iniciado; cancelar esta identidade.');
  const beforeCancel=sends.length;
  await review.getByRole('button',{name:'Confirmar conferência',exact:true}).click();
  await review.waitFor({state:'hidden'});
  await page.getByText('Nenhum envio sintético iniciado; cancelar esta identidade.',{exact:true}).waitFor();
  assert.equal(audit.at(-1).operation,'cancel');
  assert.equal(audit.at(-1).resulting_state,'cancelled');
  assert.equal(sends.length,beforeCancel);
  await page.reload();
  await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Nova mensagem após cancelamento confirmado');
  await page.waitForFunction(()=>{const button=document.querySelector('button[aria-label="Enviar mensagem"]');return button&&!button.disabled;});
  assert.equal(await page.getByRole('button',{name:'Enviar mensagem',exact:true}).isEnabled(),true);
  assert.equal(sends.length,beforeCancel);
  assert.ok(requests.some(row=>row.path==='/functions/v1/whatsapp-templates'));
  assert.ok(requests.some(row=>row.path==='/rest/v1/crm_outbound_reconciliations'));
  await page.screenshot({path:path.join(out,'operator-recovery.png'),fullPage:true});
}
