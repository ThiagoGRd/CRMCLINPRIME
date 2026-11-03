// Synthetic local HTTP boundary. No environment files, real identities or providers.
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {outboundResponse} from '../../supabase/functions/_shared/outbound.ts';

export const fixtureUserId = '00000000-0000-4000-8000-000000000011';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createFixture({sendDelayMs=350,nextSendMode='success'}={}) {
  const org = 'org-a';
  const patient = {id:'patient-a',org_id:org,name:'Maria Teste',phone:'11911112222',tags:[],treatment_interest:'Avaliação sintética',source:'Teste',clinicorp_status:null,clinicorp_amount:null,created_at:'2026-11-01T10:00:00Z'};
  const channels = [
    {id:'number-r',org_id:org,type:'whatsapp_cloud',display_name:'Recepção teste',status:'connected',inbox_key:'reception',config:{display_phone:'11 3000-0001'},phone_number_id:'phone-r'},
    {id:'number-c',org_id:org,type:'whatsapp_cloud',display_name:'Comercial teste',status:'connected',inbox_key:'commercial',config:{display_phone:'11 3000-0002'},phone_number_id:'phone-c'},
    {id:'number-crc',org_id:org,type:'whatsapp_cloud',display_name:'CRC teste',status:'disconnected',inbox_key:'crc',config:{display_phone:'11 3000-0003'},phone_number_id:'phone-crc'},
  ];
  const conversations = channels.map((channel,i) => ({id:['conversation-r','conversation-c','conversation-crc'][i],org_id:org,patient_id:patient.id,channel_id:channel.id,assigned_to:'member-a',status:'open',last_message_at:'2026-11-01T10:00:00Z',patient,channel}));
  const messages = conversations.map((c,i) => ({id:`message-${i}`,org_id:org,patient_id:patient.id,conversation_id:c.id,channel_id:c.channel_id,direction:'inbound',content:['Olá recepção','Olá comercial','Olá CRC'][i],status:'received',created_at:'2026-11-01T10:00:00Z'}));
  // 41 rows exercise actual legacy pagination, plus partial routes that must be excluded.
  for (let index=1; index<=41; index++) messages.push({id:`legacy-${String(index).padStart(3,'0')}`,org_id:org,patient_id:patient.id,conversation_id:null,channel_id:null,direction:'inbound',content:`Registro legado sintético ${String(index).padStart(3,'0')}`,status:'received',created_at:`2026-10-01T10:00:${String(index).padStart(2,'0')}Z`});
  messages.push({...messages[0],id:'partial-route',conversation_id:null,content:'Não mostrar: canal parcialmente identificado'});
  const pending = [], outbound = [];
  return {org,patient,channels,conversations,messages,pending,outbound,sendDelayMs,nextSendMode,id:10,sends:[],statusLookups:[],errors:[],requests:[],
    tables:{channels,crm_conversations:conversations,crm_patients:[patient],crm_messages:messages,crm_pending_items:pending,crm_outbound_requests:outbound,org_members:[{user_id:'member-a',org_id:org,display_name:'Layla Teste',created_at:'2026-11-01T10:00:00Z'}],quick_replies:[]}};
}

function selectRows(rows, params) {
  let result = rows.filter(row => [...params].every(([key,value]) => {
    if (key === 'or') {
      return value.slice(1,-1).split(',').some(filter => {
        const [column,operator,...rest] = filter.split('.');
        if (operator !== 'ilike') throw new Error(`Unsupported fixture OR operator: ${operator}`);
        return String(row[column] ?? '').toLocaleLowerCase().includes(rest.join('.').replaceAll('*','').toLocaleLowerCase());
      });
    }
    if (['select','order','offset','limit'].includes(key)) return true;
    if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
    if (value === 'is.null') return row[key] === null;
    if (value.startsWith('in.(')) return value.slice(4,-1).split(',').includes(String(row[key]));
    throw new Error(`Unsupported fixture filter: ${key}=${value}`);
  }));
  const ordering = (params.get('order') ?? '').split(',').filter(Boolean).map(value => value.split('.'));
  result.sort((a,b) => {
    for (const [column,direction,...options] of ordering) {
      if (a[column] == null || b[column] == null) {
        if (a[column] == null && b[column] == null) continue;
        return (a[column] == null ? 1 : -1) * (options.includes('nullsfirst') ? -1 : 1);
      }
      const compared = String(a[column]).localeCompare(String(b[column]));
      if (compared) return compared * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
  return result;
}

export function createFixtureServer(fixture,{out}={}) {
  return createServer(async (req,res) => {
    const url = new URL(req.url,'http://localhost');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','*');
    res.setHeader('Access-Control-Allow-Methods','*');
    if (req.method === 'OPTIONS') {res.end(); return;}
    const json = (data,status=200) => {res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
    const sendResult = (result,replayed) => {
      const response=outboundResponse(result,replayed);
      return json(response.body,response.status);
    };
    try {
      if (url.pathname === '/__fixture__/state' && req.method === 'GET') return json({sends:fixture.sends,statusLookups:fixture.statusLookups,outbound:fixture.outbound,requests:fixture.requests,errors:fixture.errors});
      if (out && ['/app.js','/style.css'].includes(url.pathname)) {
        res.setHeader('content-type',url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css');
        res.end(await fs.readFile(path.join(out,url.pathname.slice(1)))); return;
      }
      if (out && ['/', '/inbox', '/historico-legado', '/pendencias'].includes(url.pathname)) {
        res.setHeader('content-type','text/html');
        res.end('<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>ClinPrime synthetic fixture</title></head><body style="background:#101018;color:#eee;font-family:Arial"><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); return;
      }
      let raw=''; for await (const chunk of req) raw+=chunk;
      const payload = raw ? JSON.parse(raw) : null;
      fixture.requests.push({method:req.method,path:url.pathname,params:Object.fromEntries(url.searchParams),payload});
      if (url.pathname === '/functions/v1/whatsapp-send' && req.method === 'POST') {
        if (!uuid.test(payload?.request_id ?? '')) return json({error:'request_id must be a UUID'},400);
        if (payload.action === 'status') {
          if (Object.keys(payload).some(key => !['request_id','action'].includes(key))) return json({error:'status must not contain send fields'},400);
          fixture.statusLookups.push(payload);
          const attempt = fixture.outbound.find(row => row.request_id === payload.request_id);
          return sendResult(attempt ?? {request_id:payload.request_id,state:'not_found'},true);
        }
        if (Object.keys(payload).sort().join(',') !== 'channel_id,conversation_id,request_id,text' || typeof payload.text !== 'string' || !payload.text.trim()) return json({error:'invalid send contract'},400);
        const c = fixture.conversations.find(row => row.id === payload.conversation_id && row.channel_id === payload.channel_id);
        if (!c || c.channel.status !== 'connected') return json({error:'wrong route'},409);
        const previous = fixture.outbound.find(row => row.request_id === payload.request_id);
        if (previous) return sendResult(previous,true);
        const mode = fixture.nextSendMode; fixture.nextSendMode = 'success';
        if (mode === 'drop-before-claim') {req.socket.destroy(); return;}
        const attempt = {...payload,org_id:fixture.org,content:payload.text,state:'in_flight',failure_code:null,created_at:new Date().toISOString()};
        fixture.outbound.push(attempt);
        fixture.sends.push(payload);
        await new Promise(resolve => setTimeout(resolve,fixture.sendDelayMs));
        if (mode === 'uncertain-after-claim') {attempt.state='uncertain';attempt.failure_code='provider_network';req.socket.destroy();return;}
        const message = {id:`sent-${fixture.id++}`,org_id:fixture.org,patient_id:fixture.patient.id,conversation_id:c.id,channel_id:c.channel_id,direction:'outbound',content:payload.text,status:'sent',created_at:new Date().toISOString()};
        fixture.messages.push(message); attempt.state='sent'; attempt.message=message;
        return sendResult(attempt,false);
      }
      if (url.pathname === '/rest/v1/rpc/resolve_pending_item' && req.method === 'POST') {
        const item = fixture.pending.find(row => row.id === payload.p_id);
        if (!item || !payload.p_evidence?.trim()) return json({message:'evidence required'},400);
        Object.assign(item,{status:'resolved',resolution_evidence:payload.p_evidence,resolved_by:fixtureUserId,resolved_at:new Date().toISOString(),updated_at:new Date().toISOString()}); return json(item);
      }
      if (!url.pathname.startsWith('/rest/v1/')) return json({message:'unexpected fixture endpoint'},404);
      const table = url.pathname.split('/').at(-1), rows = fixture.tables[table];
      if (!rows) return json({message:'unexpected table'},400);
      if (table === 'crm_outbound_requests') {
        if (req.method !== 'GET' || url.searchParams.get('org_id') !== `eq.${fixture.org}` || !url.searchParams.get('conversation_id')?.startsWith('eq.')) return json({message:'outbound reads require organization and conversation'},400);
      }
      if (req.method === 'POST' && table === 'crm_pending_items') {
        const item = {...payload,id:`pending-${fixture.id++}`,resolution_evidence:null,resolved_by:null,resolved_at:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}; rows.push(item); return json(item,201);
      }
      const result = selectRows(rows,url.searchParams);
      if (req.method === 'PATCH' && ['crm_pending_items','crm_conversations','crm_patients'].includes(table)) {
        result.forEach(row => Object.assign(row,payload,{updated_at:new Date().toISOString()})); return json(result[0] ?? {});
      }
      if (req.method !== 'GET') return json({message:'unexpected fixture mutation'},405);
      const offset=Number(url.searchParams.get('offset') ?? 0), limit=Number(url.searchParams.get('limit') ?? 500);
      res.setHeader('Access-Control-Expose-Headers','content-range');
      const exactCount=(req.headers.prefer ?? '').split(',').some(value=>value.trim()==='count=exact');
      if (exactCount && offset>0 && offset>=result.length) {
        res.setHeader('content-range',`*/${result.length}`);
        return json({code:'PGRST103',message:'Requested range not satisfiable',details:`An offset of ${offset} was requested, but there are only ${result.length} rows.`,hint:null},416);
      }
      const page=result.slice(offset,offset+limit);
      const select = url.searchParams.get('select');
      // Preserve embedded relation objects for the Inbox, project plain selections like PostgREST.
      const projected = !select || select === '*' || select.includes('(') ? page : page.map(row => Object.fromEntries(select.split(',').map(key => [key,row[key]])));
      res.setHeader('content-range',page.length ? `${offset}-${offset+page.length-1}/${result.length}` : `*/${result.length}`);
      return json(projected);
    } catch (error) {
      fixture.errors.push(String(error)); json({message:String(error)},500);
    }
  });
}
