import type { SupabaseClient } from '@supabase/supabase-js';
import type { InboxKey } from './inbox';

export type ConversationPatient = {id:string; org_id:string; name:string; phone:string|null};
export type StartConversationChannel = {
  id:string; org_id:string; type:string; display_name:string; status:string;
  inbox_key:string|null; phone_number_id:string|null; config:{display_phone?:string}|null;
};
export type OpenedConversation = {id:string; channel_id:string; inbox_key:InboxKey};
type ConversationRow = {id:string; org_id:string; patient_id:string; channel_id:string};
const patientColumns='id,org_id,name,phone';
const channelColumns='id,org_id,type,display_name,status,inbox_key,phone_number_id,config';
const conversationColumns='id,org_id,patient_id,channel_id';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireIdentity(value:string, label:string) {
  if (!uuid.test(value)) throw new Error(`Selecione ${label} válido.`);
}

/** A known disconnected number can be organized, but this never grants sending. */
export function conversationChannelProblem(channel:StartConversationChannel|undefined):string|null {
  if (!channel) return 'Selecione o número de atendimento.';
  if (channel.type!=='whatsapp_cloud') return 'Este canal não usa a API oficial do WhatsApp.';
  if (!['reception','commercial','crc'].includes(channel.inbox_key??'')) return 'Este número ainda não tem um setor definido.';
  if (!channel.phone_number_id?.trim()) return 'Este canal ainda não tem um número do WhatsApp identificado.';
  return null;
}

export async function getConversationPatient(client:SupabaseClient,orgId:string,patientId:string):Promise<ConversationPatient|null> {
  requireIdentity(orgId,'uma organização'); requireIdentity(patientId,'um paciente');
  const {data,error}=await client.from('crm_patients').select(patientColumns).eq('org_id',orgId).eq('id',patientId).maybeSingle();
  if(error)throw new Error('Não foi possível consultar o paciente. Tente novamente.');
  if(!data)return null;
  if(data.org_id!==orgId||data.id!==patientId)throw new Error('Paciente indisponível nesta organização.');
  return data as ConversationPatient;
}

/** Separate filters avoid interpreting user text as a PostgREST filter expression. */
export async function searchConversationPatients(client:SupabaseClient,orgId:string,search:string):Promise<ConversationPatient[]> {
  requireIdentity(orgId,'uma organização');
  const value=search.trim().slice(0,100);
  const escape=(text:string)=>text.replace(/[\\%_]/g,'\\$&');
  const base=()=>client.from('crm_patients').select(patientColumns).eq('org_id',orgId).order('name').order('id').limit(30);
  const queries=[value?base().ilike('name',`%${escape(value)}%`):base()];
  const digits=value.replace(/\D/g,'');
  if(digits)queries.push(base().ilike('phone',`%${digits}%`));
  const results=await Promise.all(queries);
  if(results.some(result=>result.error))throw new Error('Não foi possível buscar pacientes. Tente novamente.');
  const patients=new Map<string,ConversationPatient>();
  for(const result of results)for(const row of result.data??[]){
    if(row.org_id!==orgId)throw new Error('Não foi possível confirmar a organização dos pacientes.');
    patients.set(row.id,row as ConversationPatient);
  }
  return [...patients.values()].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')||a.id.localeCompare(b.id)).slice(0,30);
}

/** Read fresh identity; do not trust a stale channel picker or a cached patient. */
export async function openConversation(client:SupabaseClient,input:{orgId:string;patientId:string;channelId:string}):Promise<OpenedConversation> {
  const {orgId,patientId,channelId}=input;
  requireIdentity(orgId,'uma organização'); requireIdentity(patientId,'um paciente'); requireIdentity(channelId,'um número');
  const [patient,channelResult]=await Promise.all([
    getConversationPatient(client,orgId,patientId),
    client.from('channels').select(channelColumns).eq('org_id',orgId).eq('id',channelId).maybeSingle(),
  ]);
  if(!patient)throw new Error('Paciente não encontrado nesta organização.');
  if(channelResult.error)throw new Error('Não foi possível verificar o número de atendimento.');
  const channel=channelResult.data as StartConversationChannel|null;
  if(!channel||channel.org_id!==orgId||channel.id!==channelId)throw new Error('Número indisponível nesta organização.');
  const problem=conversationChannelProblem(channel);if(problem)throw new Error(problem);
  const accept=(row:ConversationRow|null):OpenedConversation|null=>{
    if(!row)return null;
    if(!uuid.test(row.id)||row.org_id!==orgId||row.patient_id!==patientId||row.channel_id!==channelId)throw new Error('Não foi possível confirmar a identidade da conversa.');
    return {id:row.id,channel_id:row.channel_id,inbox_key:channel.inbox_key as InboxKey};
  };
  const find=async()=>{
    const {data,error}=await client.from('crm_conversations').select(conversationColumns)
      .eq('org_id',orgId).eq('patient_id',patientId).eq('channel_id',channelId).maybeSingle();
    if(error)throw new Error('Não foi possível consultar a conversa. Tente novamente.');
    return accept(data as ConversationRow|null);
  };
  const existing=await find();if(existing)return existing;
  // The unique tenant/patient/channel constraint arbitrates concurrent submissions.
  // Never upsert/update status, assignee or timestamps of an existing conversation.
  const {data,error}=await client.from('crm_conversations').insert({org_id:orgId,patient_id:patientId,channel_id:channelId})
    .select(conversationColumns).maybeSingle();
  if(!error){const inserted=accept(data as ConversationRow|null);if(inserted)return inserted;}
  // A unique conflict or lost response is recovered by exact identity, not a resend.
  const recovered=await find();if(recovered)return recovered;
  throw new Error('Não foi possível confirmar a abertura. Tente novamente; a mesma conversa será reutilizada.');
}
