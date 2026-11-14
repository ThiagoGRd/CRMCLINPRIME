import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {FilaList} from '../components/fila/fila-list';
import type {Task} from '../lib/tasks';
const now=new Date('2026-06-10T15:00:00Z');
const base:Task={id:'t',patientId:'p',patientName:'Paciente',patientPhone:'1',front:'recepcao',kind:'demanda',title:'x',ownerId:null,dueAt:'2026-06-10T18:00:00Z',status:'aberta',draft:null};
const noop=()=>{};
const cb={selectedId:null,onOpen:noop,onDone:noop,onSnooze:noop,onDefineNext:noop};
const render=(tasks:Task[],me:{userId:string;isManager:boolean},forgotten:React.ComponentProps<typeof FilaList>['forgotten']=[])=>
 renderToStaticMarkup(<FilaList tasks={tasks} now={now} me={me} memberIds={['me','other']} forgotten={forgotten} {...cb}/>);
test('non manager sees only own tasks',()=>{
 const html=render([{...base,id:'1',title:'Tarefa alheia vencida',ownerId:'other',dueAt:'2026-06-09T12:00:00Z'},{...base,id:'2',title:'Minha tarefa de hoje',ownerId:'me'}],{userId:'me',isManager:false});
 assert.match(html,/Minha tarefa de hoje/);assert.doesNotMatch(html,/Tarefa alheia vencida/);
});
test('empty queue shows empty state',()=>{
 assert.match(render([],{userId:'me',isManager:false}),/Nada pendente/);
});
test('manager sees unowned block',()=>{
 const html=render([{...base,title:'Sem dono',ownerId:null}],{userId:'me',isManager:true});
 assert.match(html,/Sem responsável/);assert.match(html,/Sem dono/);
});
test('non manager does not see unowned block',()=>{
 assert.doesNotMatch(render([{...base,ownerId:null}],{userId:'me',isManager:false}),/Sem responsável/);
});
test('forgotten patients: own for member, all for manager',()=>{
 const f=[{id:'a',name:'Esquecida Minha',phone:'1',front:'recepcao' as const,assignedTo:'me'},{id:'b',name:'Esquecida Alheia',phone:'2',front:'recepcao' as const,assignedTo:'other'}];
 const m=render([],{userId:'me',isManager:false},f);
 assert.match(m,/Sem próxima ação \(1\)/);assert.match(m,/Esquecida Minha/);assert.doesNotMatch(m,/Esquecida Alheia/);
 assert.match(render([],{userId:'me',isManager:true},f),/Sem próxima ação \(2\)/);
});
