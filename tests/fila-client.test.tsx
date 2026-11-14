import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {FilaList} from '../components/fila/fila-list';
import type {Task} from '../lib/tasks';
const now=new Date('2026-06-10T15:00:00Z');
const base:Task={id:'t',patientId:'p',patientName:'Paciente',patientPhone:'1',front:'recepcao',kind:'demanda',title:'x',ownerId:null,dueAt:'2026-06-10T18:00:00Z',status:'aberta',draft:null};
const noop=()=>{};
const cb={state:'ready' as const,forgottenError:false,onRetry:noop,selectedId:null,onOpen:noop,onDone:noop,onSnooze:noop,onDefineNext:noop};
const render=(tasks:Task[],me:{userId:string;isManager:boolean;front?:'recepcao'|'comercial'|null},forgotten:React.ComponentProps<typeof FilaList>['forgotten']=[],extra:Partial<React.ComponentProps<typeof FilaList>>={})=>
 renderToStaticMarkup(<FilaList tasks={tasks} now={now} me={{front:null,...me}} memberIds={['me','other']} forgotten={forgotten} {...cb} {...extra}/>);
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
test('loading never claims the queue is empty',()=>{
 const html=render([],{userId:'me',isManager:false},[],{state:'loading'});
 assert.match(html,/Carregando a fila/);assert.doesNotMatch(html,/Nada pendente/);
});
test('error shows retry and never claims the queue is empty',()=>{
 const html=render([],{userId:'me',isManager:false},[],{state:'error'});
 assert.match(html,/Não foi possível carregar a fila/);assert.match(html,/Tentar de novo/);assert.doesNotMatch(html,/Nada pendente/);
});
test('forgotten query error is reported in its section',()=>{
 const html=render([],{userId:'me',isManager:false},[],{forgottenError:true});
 assert.match(html,/Não foi possível carregar os pacientes sem próxima ação/);
});
test('unassigned forgotten patient is visible to the same front only',()=>{
 const f=[{id:'a',name:'Sem Dona Recepcao',phone:'1',front:'recepcao' as const,assignedTo:null},{id:'b',name:'Sem Dona Comercial',phone:'2',front:'comercial' as const,assignedTo:null}];
 const html=render([],{userId:'me',isManager:false,front:'recepcao'},f);
 assert.match(html,/Sem Dona Recepcao/);assert.doesNotMatch(html,/Sem Dona Comercial/);
});
test('task whose owner left the team goes under Sem responsavel',()=>{
 const html=render([{...base,title:'Tarefa de quem saiu',ownerId:'saiu'}],{userId:'me',isManager:true},[],{memberIds:['u1','u9']});
 assert.match(html,/Sem responsável \(1\)/);assert.match(html,/Tarefa de quem saiu/);
});
test('stale notice shows when cached data is displayed after a failed refresh',()=>{
 assert.match(render([],{userId:'me',isManager:false},[],{stale:true}),/Não foi possível atualizar agora\. Mostrando a última versão\./);
 assert.doesNotMatch(render([],{userId:'me',isManager:false}),/Mostrando a última versão/);
});
test('truncated forgotten list says how many are shown',()=>{
 const f=[{id:'a',name:'Esquecida',phone:'1',front:'recepcao' as const,assignedTo:'me'}];
 assert.match(render([],{userId:'me',isManager:true},f,{forgottenTotal:1100}),/Mostrando 1 de 1100/);
});
