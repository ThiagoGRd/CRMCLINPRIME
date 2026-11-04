// Synthetic local HTTP boundary. No environment files, real identities or providers.
// This models UI/API response contracts; database correctness belongs to the SQL suites.
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {outboundResponse} from '../../supabase/functions/_shared/outbound.ts';
import {normalizeTemplateIntent, parseTextTemplate, prepareTemplateSend, PolicyError, serviceWindow} from '../../supabase/functions/_shared/whatsapp-policy.ts';
import {validateSendRoute} from '../../supabase/functions/_shared/routing.ts';
import {fixtureIds as ids, fixtureId} from './fixture-identities.ts';

export const fixtureUserId = ids.user;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createFixture({sendDelayMs=350,nextSendMode='success',windowMode='open'}={}) {
  const org=ids.org;
  const recent=new Date(Date.now()-(windowMode==='expired'?25:1)*60*60*1000).toISOString();
  const patient={id:ids.patient,org_id:org,name:'Maria Teste',phone:'11911112222',tags:[],treatment_interest:'Avaliação sintética',source:'Teste',clinicorp_status:null,clinicorp_amount:null,created_at:recent};
  const newPatient={...patient,id:ids.newPatient,name:'João Sintético',phone:'11933334444'};
  const channels=[
    {id:ids.reception,org_id:org,type:'whatsapp_cloud',display_name:'Recepção teste',status:'connected',inbox_key:'reception',config:{display_phone:'11 3000-0001'},phone_number_id:'phone-r',created_at:recent},
    {id:ids.commercial,org_id:org,type:'whatsapp_cloud',display_name:'Comercial teste',status:'connected',inbox_key:'commercial',config:{display_phone:'11 3000-0002'},phone_number_id:'phone-c',created_at:recent},
    {id:ids.crc,org_id:org,type:'whatsapp_cloud',display_name:'CRC teste',status:'disconnected',inbox_key:'crc',config:{display_phone:'11 3000-0003'},phone_number_id:'phone-crc',created_at:recent},
  ];
  const conversations=channels.map((channel,index)=>({id:[ids.receptionConversation,ids.commercialConversation,ids.crcConversation][index],org_id:org,patient_id:patient.id,channel_id:channel.id,assigned_to:ids.member,status:'open',last_message_at:recent,created_at:recent}));
  const messages=conversations.map((c,index)=>({id:fixtureId(401+index),org_id:org,patient_id:patient.id,conversation_id:c.id,channel_id:c.channel_id,direction:'inbound',content:['Olá recepção','Olá comercial','Olá CRC'][index],status:'received',created_at:recent}));
  // 41 rows exercise actual legacy pagination, plus partial routes that must be excluded.
  for(let index=1;index<=41;index++) messages.push({id:fixtureId(1000+index),org_id:org,patient_id:patient.id,conversation_id:null,channel_id:null,direction:'inbound',content:`Registro legado sintético ${String(index).padStart(3,'0')}`,status:'received',created_at:`2026-10-01T10:00:${String(index).padStart(2,'0')}Z`});
  messages.push({...messages[0],id:fixtureId(1100),conversation_id:null,content:'Não mostrar: canal parcialmente identificado'});
  const template=parseTextTemplate({id:'synthetic-template-1',name:'retorno_sintetico',language:'pt_BR',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'Olá {{1}}, este é um retorno sintético da clínica.'}]});
  const pending=[],outbound=[],audit=[],cancellations=[];
  return {org,patient,newPatient,channels,conversations,messages,pending,outbound,audit,cancellations,templates:[template],sendDelayMs,nextSendMode,nextConversationMode:'success',id:5000,sends:[],statusLookups:[],reviews:[],errors:[],requests:[],
    tables:{channels,crm_conversations:conversations,crm_patients:[patient,newPatient],crm_messages:messages,crm_pending_items:pending,crm_outbound_requests:outbound,crm_outbound_reconciliations:audit,
      org_members:[{user_id:ids.member,org_id:org,display_name:'Layla Teste',created_at:recent},{user_id:ids.user,org_id:org,display_name:'Administrador Teste',created_at:recent}],quick_replies:[]}};
}

function ilike(value,pattern) {
  let source='';
  for(let index=0;index<pattern.length;index++) {
    const char=pattern[index];
    if(char==='\\'&&index+1<pattern.length) source+=pattern[++index].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    else if(char==='%'||char==='*') source+='.*';
    else if(char==='_') source+='.';
    else source+=char.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp(`^${source}$`,'iu').test(String(value??''));
}

function selectRows(rows,params) {
  const result=rows.filter(row=>[...params].every(([key,value])=>{
    if(key==='or') return value.slice(1,-1).split(',').some(filter=>{
      const [column,operator,...rest]=filter.split('.');
      if(operator!=='ilike') throw new Error(`Unsupported fixture OR operator: ${operator}`);
      return ilike(row[column],rest.join('.'));
    });
    if(['select','order','offset','limit'].includes(key))return true;
    if(value.startsWith('eq.'))return String(row[key])===value.slice(3);
    if(value.startsWith('ilike.'))return ilike(row[key],value.slice(6));
    if(value==='is.null')return row[key]===null;
    if(value.startsWith('in.('))return value.slice(4,-1).split(',').includes(String(row[key]));
    throw new Error(`Unsupported fixture filter: ${key}=${value}`);
  }));
  const ordering=(params.get('order')??'').split(',').filter(Boolean).map(value=>value.split('.'));
  return result.sort((a,b)=>{
    for(const [column,direction,...options] of ordering) {
      if(a[column]==null||b[column]==null){if(a[column]==null&&b[column]==null)continue;return(a[column]==null?1:-1)*(options.includes('nullsfirst')?-1:1);}
      const compared=String(a[column]).localeCompare(String(b[column]));
      if(compared)return compared*(direction==='desc'?-1:1);
    }
    return 0;
  });
}

function projectRows(rows,select,fixture,table) {
  // Embedded relations are resolved at read time, including newly inserted conversations.
  if(table==='crm_conversations'&&select?.includes('('))return rows.map(row=>({...row,
    patient:fixture.tables.crm_patients.find(patient=>patient.id===row.patient_id)??null,
    channel:fixture.channels.find(channel=>channel.id===row.channel_id)??null}));
  return !select||select==='*'||select.includes('(')?rows:rows.map(row=>Object.fromEntries(select.split(',').map(key=>[key,row[key]])));
}

function currentWindow(fixture,conversation) {
  const last=fixture.messages.filter(row=>row.conversation_id===conversation.id&&row.channel_id===conversation.channel_id&&row.direction==='inbound').sort((a,b)=>a.created_at.localeCompare(b.created_at)).at(-1);
  return serviceWindow(last?.created_at);
}

function saveMessage(fixture,attempt) {
  if(attempt.message)return attempt.message;
  const conversation=fixture.conversations.find(row=>row.id===attempt.conversation_id);
  const message={id:fixtureId(fixture.id++),org_id:fixture.org,patient_id:conversation.patient_id,conversation_id:conversation.id,channel_id:conversation.channel_id,direction:'outbound',content:attempt.content,status:'sent',created_at:new Date().toISOString()};
  fixture.messages.push(message);attempt.state='sent';attempt.message=message;conversation.last_message_at=message.created_at;
  return message;
}

export function createFixtureServer(fixture,{out}={}) {
  return createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','*');
    if(req.method==='OPTIONS'){res.end();return;}
    const json=(data,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
    const sendResult=(result,replayed,reconciled=false)=>{const response=outboundResponse(result,replayed);return json(response.body,reconciled?200:response.status);};
    const rowsResponse=(rows,status=200)=>{
      if(req.headers.accept?.includes('application/vnd.pgrst.object+json')) {
        if(rows.length!==1)return json({code:'PGRST116',details:`The result contains ${rows.length} rows`,hint:null,message:'Cannot coerce the result to a single JSON object'},406);
        return json(rows[0],status);
      }
      return json(rows,status);
    };
    const mutationResponse=(rows,status=200)=>{
      if(!(req.headers.prefer??'').includes('return=representation')){res.statusCode=status===201?201:204;res.end();return;}
      return rowsResponse(projectRows(rows,url.searchParams.get('select'),fixture,url.pathname.split('/').at(-1)),status);
    };
    try {
      if(url.pathname==='/__fixture__/state'&&req.method==='GET')return json({sends:fixture.sends,statusLookups:fixture.statusLookups,outbound:fixture.outbound,reviews:fixture.reviews,audit:fixture.audit,cancellations:fixture.cancellations,conversations:fixture.conversations,pending:fixture.pending,requests:fixture.requests,errors:fixture.errors});
      if(out&&['/app.js','/style.css'].includes(url.pathname)){res.setHeader('content-type',url.pathname.endsWith('.js')?'application/javascript':'text/css');res.end(await fs.readFile(path.join(out,url.pathname.slice(1))));return;}
      if(out&&['/','/inbox','/historico-legado','/pendencias'].includes(url.pathname)){
        res.setHeader('content-type','text/html');res.end('<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>ClinPrime synthetic fixture</title></head><body style="background:#101018;color:#eee;font-family:Arial"><div id="root"></div><script type="module" src="/app.js"></script></body></html>');return;
      }
      let raw='';for await(const chunk of req)raw+=chunk;
      const payload=raw?JSON.parse(raw):null;
      fixture.requests.push({method:req.method,path:url.pathname,params:Object.fromEntries(url.searchParams),payload});
      if(url.pathname==='/functions/v1/whatsapp-templates'&&req.method==='POST') {
        if(!uuid.test(payload?.conversation_id??'')||!uuid.test(payload?.channel_id??'')||(payload.action!==undefined&&payload.action!=='window'))return json({error:'conversa e canal obrigatórios'},400);
        const conversation=fixture.conversations.find(row=>row.id===payload.conversation_id);
        const channel=fixture.channels.find(row=>row.id===payload.channel_id);
        const problem=validateSendRoute(payload,conversation,channel);
        if(problem)return json({error:problem},409);
        const result={window:currentWindow(fixture,conversation),checked_at:new Date().toISOString()};
        return json(payload.action==='window'?result:{...result,templates:fixture.templates});
      }
      if(url.pathname==='/functions/v1/whatsapp-send'&&req.method==='POST') {
        if(!uuid.test(payload?.request_id??''))return json({error:'request_id must be a UUID'},400);
        if(payload.action==='status') {
          if(Object.keys(payload).some(key=>!['request_id','action'].includes(key)))return json({error:'status must not contain send fields'},400);
          fixture.statusLookups.push(payload);
          const attempt=fixture.cancellations.find(row=>row.request_id===payload.request_id)??fixture.outbound.find(row=>row.request_id===payload.request_id);
          return sendResult(attempt??{request_id:payload.request_id,state:'not_found'},true);
        }
        if(payload.action==='reconcile') {
          if(!uuid.test(payload.conversation_id??'')||!['cancel','observe','finalize'].includes(payload.operation)||typeof payload.evidence!=='string'||!payload.evidence.trim()||payload.evidence.length>2000)return json({error:'Conversa, operação e evidência obrigatórias.'},400);
          const conversation=fixture.conversations.find(row=>row.id===payload.conversation_id);
          if(!conversation)return json({error:'sem acesso'},403);
          let attempt=fixture.outbound.find(row=>row.request_id===payload.request_id)??fixture.cancellations.find(row=>row.request_id===payload.request_id);
          if(attempt&&attempt.conversation_id!==conversation.id)return json({request_id:payload.request_id,error:'Esta operação não corresponde à conversa da tentativa.',retryable:false},409);
          const previous=attempt?.state??'not_found';
          if(payload.operation==='cancel') {
            if(attempt&&!['pending','cancelled'].includes(attempt.state))return json({request_id:payload.request_id,error:'O envio já foi iniciado. Não é seguro cancelar.',retryable:false},409);
            if(!attempt){attempt={request_id:payload.request_id,conversation_id:conversation.id,channel_id:conversation.channel_id,org_id:fixture.org,state:'cancelled'};fixture.cancellations.push(attempt);}
            attempt.state='cancelled';
          } else {
            if(!attempt)return json({request_id:payload.request_id,error:'Tentativa não encontrada.',retryable:false},404);
            if(payload.operation==='finalize') {
              if(!attempt.provider_message_id||!['in_flight','uncertain','sent'].includes(attempt.state))return json({request_id:payload.request_id,error:'Não há confirmação durável do WhatsApp.',retryable:false},409);
              saveMessage(fixture,attempt);
            } else if(!['in_flight','uncertain'].includes(attempt.state))return json({request_id:payload.request_id,error:'Observação indisponível neste estado.',retryable:false},409);
          }
          const reconciliation={id:fixtureId(fixture.id++),request_id:payload.request_id,org_id:fixture.org,conversation_id:conversation.id,actor_id:fixtureUserId,operation:payload.operation,evidence:payload.evidence.trim(),previous_state:previous,resulting_state:attempt.state,created_at:new Date().toISOString()};
          fixture.audit.push(reconciliation);fixture.reviews.push(payload);
          // Acknowledges the audit write, not delivery. Actual SQL semantics are tested elsewhere.
          return sendResult({...attempt,reconciliation},true,true);
        }
        const kind=payload.kind??'text';
        const keys=Object.keys(payload).sort().join(',');
        const allowed=kind==='template'?'channel_id,conversation_id,kind,request_id,template':payload.kind===undefined?'channel_id,conversation_id,request_id,text':'channel_id,conversation_id,kind,request_id,text';
        if(payload.action!==undefined||!['text','template'].includes(kind)||keys!==allowed||!uuid.test(payload.conversation_id??'')||!uuid.test(payload.channel_id??''))return json({error:'invalid send contract'},400);
        const conversation=fixture.conversations.find(row=>row.id===payload.conversation_id);
        const channel=fixture.channels.find(row=>row.id===payload.channel_id);
        const problem=validateSendRoute(payload,conversation,channel);
        if(problem)return json({error:problem},409);
        let content,templatePayload=null;
        if(kind==='template') {
          let intent;
          try{intent=normalizeTemplateIntent(payload.template);}catch(error){return json({request_id:payload.request_id,code:error.code,error:error.message,retryable:false},400);}
          try{const prepared=prepareTemplateSend(fixture.templates,intent);content=prepared.content;templatePayload=prepared.templatePayload;}
          catch(error){if(error instanceof PolicyError)return json({request_id:payload.request_id,code:error.code,error:error.message,retryable:false},409);throw error;}
        } else {content=typeof payload.text==='string'?payload.text.trim():'';}
        if(!content||content.length>4096)return json({error:'invalid send content'},400);
        const previous=fixture.outbound.find(row=>row.request_id===payload.request_id)??fixture.cancellations.find(row=>row.request_id===payload.request_id);
        if(previous) {
          if(previous.conversation_id!==conversation.id||previous.channel_id!==channel.id||(previous.content!==undefined&&(previous.content!==content||previous.message_kind!==kind)))return json({request_id:payload.request_id,error:'Esta tentativa já pertence a outra mensagem.',retryable:false},409);
          return sendResult(previous,true);
        }
        if(kind==='text'&&!currentWindow(fixture,conversation).open)return json({request_id:payload.request_id,code:'outside_service_window',error:'Mais de 24h sem mensagem do paciente neste canal: use um template aprovado.',retryable:false},422);
        const mode=fixture.nextSendMode;fixture.nextSendMode='success';
        if(mode==='drop-before-claim'){req.socket.destroy();return;}
        const attempt={request_id:payload.request_id,conversation_id:conversation.id,channel_id:channel.id,org_id:fixture.org,content,message_kind:kind,template_payload:templatePayload,provider_message_id:null,state:'in_flight',failure_code:null,created_at:new Date().toISOString()};
        fixture.outbound.push(attempt);fixture.sends.push(payload);
        await new Promise(resolve=>setTimeout(resolve,fixture.sendDelayMs));
        if(mode==='uncertain-after-claim'){attempt.state='uncertain';attempt.failure_code='provider_network';req.socket.destroy();return;}
        attempt.provider_message_id=`wamid.synthetic.${payload.request_id}`;
        if(mode==='accepted-before-storage'){attempt.state='uncertain';attempt.failure_code='storage_failed';return sendResult(attempt,false);}
        saveMessage(fixture,attempt);
        return sendResult(attempt,false);
      }
      if(url.pathname==='/rest/v1/rpc/resolve_pending_item'&&req.method==='POST') {
        const item=fixture.pending.find(row=>row.id===payload.p_id);
        if(!item||!payload.p_evidence?.trim())return json({message:'evidence required'},400);
        Object.assign(item,{status:'resolved',resolution_evidence:payload.p_evidence,resolved_by:fixtureUserId,resolved_at:new Date().toISOString(),updated_at:new Date().toISOString()});return json(item);
      }
      if(!url.pathname.startsWith('/rest/v1/'))return json({message:'unexpected fixture endpoint'},404);
      const table=url.pathname.split('/').at(-1),rows=fixture.tables[table];
      if(!rows)return json({message:'unexpected table'},400);
      if(['crm_outbound_requests','crm_outbound_reconciliations'].includes(table)) {
        if(req.method!=='GET'||url.searchParams.get('org_id')!==`eq.${fixture.org}`||!url.searchParams.get('conversation_id')?.startsWith('eq.'))return json({message:'outbound reads require organization and conversation'},400);
      }
      if(req.method==='POST'&&table==='crm_conversations') {
        if(!payload||Object.keys(payload).sort().join(',')!=='channel_id,org_id,patient_id'||[payload.org_id,payload.patient_id,payload.channel_id].some(value=>!uuid.test(value??'')))return json({message:'invalid conversation identity'},400);
        const patient=fixture.tables.crm_patients.find(row=>row.id===payload.patient_id&&row.org_id===payload.org_id);
        const channel=fixture.channels.find(row=>row.id===payload.channel_id&&row.org_id===payload.org_id);
        if(!patient||!channel)return json({code:'23503',message:'invalid synthetic route'},400);
        if(rows.some(row=>row.org_id===payload.org_id&&row.patient_id===payload.patient_id&&row.channel_id===payload.channel_id))return json({code:'23505',message:'duplicate conversation route'},409);
        const item={...payload,id:fixtureId(fixture.id++),assigned_to:null,status:'open',last_message_at:null,created_at:new Date().toISOString()};rows.push(item);
        const mode=fixture.nextConversationMode;fixture.nextConversationMode='success';
        if(mode==='drop-after-insert'){req.socket.destroy();return;}
        return mutationResponse([item],201);
      }
      if(req.method==='POST'&&table==='crm_pending_items') {
        const item={...payload,id:fixtureId(fixture.id++),resolution_evidence:null,resolved_by:null,resolved_at:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};rows.push(item);return mutationResponse([item],201);
      }
      const result=selectRows(rows,url.searchParams);
      if(req.method==='PATCH'&&['crm_pending_items','crm_conversations','crm_patients'].includes(table)) {
        result.forEach(row=>Object.assign(row,payload,{updated_at:new Date().toISOString()}));return mutationResponse(result);
      }
      if(req.method!=='GET')return json({message:'unexpected fixture mutation'},405);
      const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??500);
      res.setHeader('Access-Control-Expose-Headers','content-range');
      const exactCount=(req.headers.prefer??'').split(',').some(value=>value.trim()==='count=exact');
      if(exactCount&&offset>0&&offset>=result.length){res.setHeader('content-range',`*/${result.length}`);return json({code:'PGRST103',message:'Requested range not satisfiable',details:`An offset of ${offset} was requested, but there are only ${result.length} rows.`,hint:null},416);}
      const page=result.slice(offset,offset+limit);
      res.setHeader('content-range',page.length?`${offset}-${offset+page.length-1}/${result.length}`:`*/${result.length}`);
      return rowsResponse(projectRows(page,url.searchParams.get('select'),fixture,table));
    }catch(error){fixture.errors.push(String(error));json({message:String(error)},500);}
  });
}
