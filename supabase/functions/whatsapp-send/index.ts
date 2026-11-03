// Envio de texto pelo WhatsApp Cloud API, chamado pelo inbox (usuário logado).
// Responde pelo mesmo número por onde o paciente falou por último.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { localToWa } from '../_shared/wa.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}
const GRAPH = 'https://graph.facebook.com/v25.0';
// shortcut: um token de System User para todos os números; com Embedded Signup cada org terá o seu (channels.config).
const TOKEN = Deno.env.get('WA_ACCESS_TOKEN') ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'nao autenticado' }, 401);
    if (!TOKEN) return json({ error: 'WA_ACCESS_TOKEN nao configurado' }, 500);

    const { patient_id, text } = await req.json();
    const body = String(text ?? '').trim();
    if (!patient_id || !body) return json({ error: 'parametros invalidos' }, 400);
    if (body.length > 4096) return json({ error: 'mensagem acima de 4096 caracteres' }, 400);

    const { data: patient } = await admin.from('crm_patients').select('id, org_id, phone').eq('id', patient_id).maybeSingle();
    if (!patient?.phone) return json({ error: 'paciente sem telefone' }, 404);
    const { data: mem } = await admin.from('org_members').select('org_id').eq('user_id', user.id).eq('org_id', patient.org_id).maybeSingle();
    if (!mem) return json({ error: 'sem acesso' }, 403);

    const { data: last } = await admin.from('crm_messages').select('channel_id')
      .eq('patient_id', patient.id).eq('direction', 'inbound').not('channel_id', 'is', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    let q = admin.from('channels').select('id, phone_number_id').eq('org_id', patient.org_id).eq('type', 'whatsapp_cloud').not('phone_number_id', 'is', null);
    q = last?.channel_id ? q.eq('id', last.channel_id) : q.order('created_at');
    const { data: channel } = await q.limit(1).maybeSingle();
    if (!channel) return json({ error: 'nenhum numero de WhatsApp conectado' }, 409);

    const r = await fetch(`${GRAPH}/${channel.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
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
      org_id: patient.org_id, patient_id: patient.id, channel_id: channel.id, direction: 'outbound',
      content: body, message_type: 'text', status: 'sent', whatsapp_message_id: res.messages?.[0]?.id, sent_by: user.id,
    }).select('id,patient_id,direction,content,created_at').single();
    if (error) return json({ error: error.message }, 500);
    return json({ message: inserted });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
