import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {ReceptionPilotControls} from '../components/inbox/reception-pilot-controls';
test('rendered pilot labels fixed destination independently of legacy patient and has explicit recovery',()=>{
 const html=renderToStaticMarkup(<ReceptionPilotControls view={{context:{contextKey:'a',orgId:'o',actorId:'a',recipientLabel:'Teste aprovado fictício',latest:null},result:null,canSend:true,canNew:false,busy:false,error:null}} text="fixture" setText={()=>{}} send={()=>{}} recover={()=>{}} newMessage={()=>{}}/>);
 assert.match(html,/Recepção/);assert.match(html,/Teste aprovado fictício/);assert.match(html,/paciente aberto/);assert.match(html,/Consultar estado/);assert.match(html,/Enviar teste/);
});
test('busy control labels the current operation rather than a previous accepted result',()=>{
 const html=renderToStaticMarkup(<ReceptionPilotControls view={{context:{contextKey:'a',orgId:'o',actorId:'a',recipientLabel:'Fictício',latest:null},result:{intent_id:'old',state:'api_accepted',provider_message_ids:['old'],delivery_state:'unverified'},canSend:false,canNew:false,busy:true,error:null}} text="" setText={()=>{}} send={()=>{}} recover={()=>{}} newMessage={()=>{}}/>);
 assert.match(html,/tentativa atual/);assert.doesNotMatch(html,/API aceitou/);
});
