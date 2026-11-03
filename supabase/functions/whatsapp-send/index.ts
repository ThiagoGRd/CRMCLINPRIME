// Envio de texto pelo WhatsApp Cloud API, chamado pelo inbox (usuário logado).
// A conversa e o número são explícitos; nunca há fallback para outro canal.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { localToWa } from '../_shared/wa.ts';
import { validateSendRoute } from '../_shared/routing.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}
const GRAPH = 'https://graph.facebook.com/v25.0';
// Token do System User: fallback para números sem token próprio (ex.: número de teste da Meta).
const TOKEN = Deno.env.get('WA_ACCESS_TOKEN') ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'nao autenticado' }, 401);

    const { conversation_id, channel_id, text } = await req.json();
    const body = typeof text === 'string' ? text.trim() : '';
    if (!conversation_id || !channel_id || !body) return json({ error: 'conversation_id, channel_id e texto obrigatorios' }, 400);
    if (body.length > 4096) return json({ error: 'mensagem acima de 4096 caracteres' }, 400);

    const { data: conversation, error: conversationError } = await admin.from('crm_conversations')
      .select('id,org_id,patient_id,channel_id').eq('id', conversation_id).maybeSingle();
    if (conversationError || !conversation) return json({ error: 'conversa nao encontrada' }, 404);
    const { data: mem, error: memberError } = await admin.from('org_members').select('org_id')
      .eq('user_id', user.id).eq('org_id', conversation.org_id).maybeSingle();
    if (memberError || !mem) return json({ error: 'sem acesso' }, 403);
    const { data: channel } = await admin.from('channels').select('id,org_id,type,status,phone_number_id')
      .eq('id', channel_id).eq('org_id', conversation.org_id).maybeSingle();
    const routeError = validateSendRoute({ conversation_id, channel_id }, conversation, channel);
    if (routeError || !channel) return json({ error: routeError }, 409);
    const { data: patient } = await admin.from('crm_patients').select('id,org_id,phone')
      .eq('id', conversation.patient_id).eq('org_id', conversation.org_id).maybeSingle();
    if (!patient?.phone) return json({ error: 'paciente sem telefone' }, 404);
    // Número conectado pelo Embedded Signup tem token próprio (channel_secrets).
    const { data: secret } = await admin.from('channel_secrets').select('access_token').eq('channel_id', channel.id).maybeSingle();
    const token = secret?.access_token ?? TOKEN;
    if (!token) return json({ error: 'numero sem token de acesso' }, 500);

    const r = await fetch(`${GRAPH}/${channel.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: localToWa(patient.phone), type: 'text', text: { body } }),
    });
    const res = await r.json();
    if (!r.ok) {
      // 131047 = fora da janela de 24h: só template aprovado pode ser enviado.
      const code = res?.error?.code;
      const msg = code === 131047 ? 'Mais de 24h sem mensagem do paciente: só é possível enviar um template aprovado.' : res?.error?.message ?? 'falha no envio';
      return json({ error: msg, code }, 502);
    }

    const { data: inserted, error } = await admin.from('crm_messages').insert({
      org_id: patient.org_id, patient_id: patient.id, conversation_id: conversation.id, channel_id: channel.id, direction: 'outbound',
      content: body, message_type: 'text', status: 'sent', whatsapp_message_id: res.messages?.[0]?.id, sent_by: user.id,
    }).select('id,patient_id,conversation_id,channel_id,direction,content,created_at').single();
    if (error) return json({ error: 'Mensagem aceita pelo WhatsApp, mas falhou ao salvar no CRM. Confira antes de reenviar.', delivery_accepted: true }, 500);
    return json({ message: inserted });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
