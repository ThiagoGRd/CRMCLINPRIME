// Read-only current catalog for this authenticated conversation's exact channel.
// Never creates/submits a template, dispatches a message or returns credentials.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { validateSendRoute } from '../_shared/routing.ts';
import { loadTextTemplateCatalog } from '../_shared/whatsapp-catalog.ts';
import { PolicyError } from '../_shared/whatsapp-policy.ts';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRAPH='https://graph.facebook.com/v25.0';
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'method not allowed'},405);
 try {
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt=/^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization')??'')?.[1];
  if(!jwt)return json({error:'não autenticado'},401);
  const {data:{user},error:authError}=await admin.auth.getUser(jwt);if(authError||!user)return json({error:'não autenticado'},401);
  let input;try{input=await req.json()}catch{return json({error:'JSON inválido'},400)}
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.conversation_id!=='string'||!UUID.test(input.conversation_id)||typeof input.channel_id!=='string'||!UUID.test(input.channel_id)||
     (input.action!==undefined&&input.action!=='window'))return json({error:'conversa e canal obrigatórios'},400);
  const {conversation_id,channel_id}=input;
  const {data:conversation,error:conversationError}=await admin.from('crm_conversations').select('id,org_id,patient_id,channel_id').eq('id',conversation_id).maybeSingle();
  if(conversationError||!conversation)return json({error:'conversa não encontrada'},404);
  const {data:member,error:memberError}=await admin.from('org_members').select('org_id').eq('user_id',user.id).eq('org_id',conversation.org_id).maybeSingle();
  if(memberError||!member)return json({error:'sem acesso'},403);
  const {data:channel,error:channelError}=await admin.from('channels').select('id,org_id,type,status,phone_number_id,inbox_key,waba_id').eq('id',channel_id).eq('org_id',conversation.org_id).maybeSingle();
  const routeError=validateSendRoute({conversation_id,channel_id},conversation,channel);
  if(channelError||routeError||!channel)return json({error:routeError??'canal indisponível'},409);
  const {data:window,error:windowError}=await admin.rpc('get_crm_whatsapp_window',{p_conversation_id:conversation_id,p_channel_id:channel_id,p_user_id:user.id});
  if(windowError||!window||typeof window.open!=='boolean')return json({code:'window_unavailable',error:'Não foi possível verificar a janela de atendimento.'},503);
  if(input.action==='window')return json({window,checked_at:new Date().toISOString()});
  const {data:secret,error:secretError}=await admin.from('channel_secrets').select('access_token').eq('channel_id',channel.id).maybeSingle();
  if(secretError)throw new PolicyError('template_catalog_unavailable','Não foi possível verificar o acesso ao canal.');
  const templates=await loadTextTemplateCatalog({graph:GRAPH,token:secret?.access_token??Deno.env.get('WA_ACCESS_TOKEN')??'',wabaId:channel.waba_id,phoneNumberId:channel.phone_number_id});
  return json({templates,window,checked_at:new Date().toISOString()});
 }catch(error){return json({code:'template_catalog_unavailable',error:error instanceof PolicyError?error.message:'Não foi possível verificar os templates aprovados deste canal.'},503)}
});
