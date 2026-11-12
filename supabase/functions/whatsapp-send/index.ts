// Envio de texto pelo WhatsApp (suporta as pontes Baileys conectadas na VPS + WhatsApp Cloud API da Meta).
// Responde pelo canal selecionado no Inbox ou pelo último canal usado na conversa com o paciente.
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
const TOKEN = Deno.env.get('WA_ACCESS_TOKEN') ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'nao autenticado' }, 401);

    const { patient_id, text, channel_id } = await req.json();
    const body = String(text ?? '').trim();
    if (!patient_id || !body) return json({ error: 'parametros invalidos' }, 400);
    if (body.length > 4096) return json({ error: 'mensagem acima de 4096 caracteres' }, 400);

    const { data: patient } = await admin
      .from('crm_patients')
      .select('id, org_id, phone, chat_session_id')
      .eq('id', patient_id)
      .maybeSingle();
    if (!patient?.phone) return json({ error: 'paciente sem telefone' }, 404);

    const { data: mem } = await admin
      .from('org_members')
      .select('org_id')
      .eq('user_id', user.id)
      .eq('org_id', patient.org_id)
      .maybeSingle();
    if (!mem) return json({ error: 'sem acesso' }, 403);

    // Buscar todos os canais da organização
    const { data: allChannels } = await admin
      .from('channels')
      .select('id, type, instance_name, display_name, status, phone_number_id, config')
      .eq('org_id', patient.org_id)
      .order('created_at', { ascending: true });

    const channels = allChannels ?? [];
    if (!channels.length) return json({ error: 'nenhum canal de WhatsApp cadastrado' }, 409);

    // 1. Canal explícito enviado pelo Inbox
    let channel = channel_id ? channels.find((c: any) => c.id === channel_id) : null;

    // 2. Se não informado, usa o último canal da conversa do paciente
    if (!channel) {
      const { data: lastMsg } = await admin
        .from('crm_messages')
        .select('channel_id')
        .eq('patient_id', patient.id)
        .not('channel_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastMsg?.channel_id) {
        channel = channels.find((c: any) => c.id === lastMsg.channel_id) ?? null;
      }
    }

    // 3. Fallback: primeiro canal conectado (priorizando recepcao -> layla -> diana)
    if (!channel) {
      channel = channels.find((c: any) => c.status === 'connected') ?? channels[0];
    }

    // --- Caso A: Canal conectado na VPS (Esquadrão Baileys: recepcao, layla, diana) ---
    if (channel.config?.provider === 'vps_esquadrao' || channel.type === 'whatsapp') {
      const { data: settingsRows } = await admin.from('platform_settings').select('key, value');
      const settings = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value]));
      const vpsBridgeUrl = settings.vps_bridge_url || 'https://evolution.clinprime.shop/crm-bridge';
      const systemKey = settings.cadence_secret;

      let sentWamid: string | null = null;
      let status: 'sent' | 'queued' = 'queued';

      try {
        const r = await fetch(`${vpsBridgeUrl}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-system-key': systemKey,
          },
          body: JSON.stringify({
            instance: channel.instance_name,
            phone: localToWa(patient.phone),
            chat_id: patient.chat_session_id,
            text: body,
          }),
          signal: AbortSignal.timeout(7000),
        });
        const res = await r.json().catch(() => ({}));
        if (r.ok && res?.ok) {
          status = 'sent';
          sentWamid = res.messageId ? `${channel.instance_name}:${res.messageId}` : `${channel.instance_name}:crm-${crypto.randomUUID()}`;
        }
      } catch {
        // Se a chamada direta oscilar, fica como 'queued' e o crm_sync.py na VPS envia em até 2s!
        status = 'queued';
        sentWamid = `${channel.instance_name}:queued-${crypto.randomUUID()}`;
      }

      const now = new Date().toISOString();
      const { data: inserted, error } = await admin
        .from('crm_messages')
        .insert({
          org_id: patient.org_id,
          patient_id: patient.id,
          channel_id: channel.id,
          direction: 'outbound',
          content: body,
          message_type: 'text',
          status,
          whatsapp_message_id: sentWamid,
          sent_by: user.id,
          created_at: now,
        })
        .select('id,patient_id,channel_id,direction,content,status,created_at')
        .single();

      if (error) return json({ error: error.message }, 500);
      await admin.from('crm_patients').update({ last_message_at: now }).eq('id', patient.id);
      return json({ message: inserted, channel: { id: channel.id, name: channel.display_name } });
    }

    // --- Caso B: WhatsApp Cloud API (Meta) ---
    if (!channel.phone_number_id) return json({ error: 'canal sem phone_number_id configurado' }, 409);
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
      const code = res?.error?.code;
      const msg = code === 131047 ? 'Mais de 24h sem mensagem do paciente: só é possível enviar um template aprovado.' : res?.error?.message ?? 'falha no envio';
      return json({ error: msg, code }, 502);
    }

    const now = new Date().toISOString();
    const { data: inserted, error } = await admin.from('crm_messages').insert({
      org_id: patient.org_id,
      patient_id: patient.id,
      channel_id: channel.id,
      direction: 'outbound',
      content: body,
      message_type: 'text',
      status: 'sent',
      whatsapp_message_id: res.messages?.[0]?.id,
      sent_by: user.id,
      created_at: now,
    }).select('id,patient_id,channel_id,direction,content,status,created_at').single();
    if (error) return json({ error: error.message }, 500);
    await admin.from('crm_patients').update({ last_message_at: now }).eq('id', patient.id);
    return json({ message: inserted });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
