// Webhook da WhatsApp Cloud API (Meta). Público (verify_jwt = false): a autenticidade
// vem da assinatura X-Hub-Signature-256 (HMAC do corpo com o App Secret).
// Cada conversa nova vira lead (origem Whatsapp) na 1ª etapa do funil.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { waIdToLocal, parseMessage } from '../_shared/wa.ts';

type WebhookMessage = Record<string, unknown> & { id: string; timestamp?: string | number; from: string; to: string };
type WebhookPayload = {
  entry?: Array<{ changes?: Array<{ field?: string; value?: {
    metadata?: { phone_number_id?: string };
    contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
    messages?: WebhookMessage[];
    message_echoes?: WebhookMessage[];
    statuses?: Array<{ id: string; status: string }>;
  } }> }>;
};

const VERIFY_TOKEN = Deno.env.get('WA_VERIFY_TOKEN') ?? '';
const APP_SECRET = Deno.env.get('WA_APP_SECRET') ?? '';

async function validSignature(raw: string, header: string | null) {
  if (!APP_SECRET || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
  const got = header.slice(7);
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verificação do webhook (feita uma vez pela Meta ao cadastrar a URL).
  if (req.method === 'GET') {
    const ok = VERIFY_TOKEN && url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('x-hub-signature-256')))) return new Response('invalid signature', { status: 401 });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: WebhookPayload;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  let failed = false;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const pnid = v.metadata?.phone_number_id;
      if (!pnid) continue;
      const { data: channel, error: channelError } = await admin.from('channels').select('id, org_id').eq('phone_number_id', pnid).maybeSingle();
      if (channelError) { failed = true; console.error('falha consultando canal', channelError); continue; }
      if (!channel) { console.warn('phone_number_id sem canal cadastrado', pnid); continue; }

      try {
        if (change.field === 'messages') {
          const names = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
          for (const m of v.messages ?? []) await saveMessage(admin, channel, m.from, names[m.from], m, 'inbound');
          for (const s of v.statuses ?? []) {
            const { error } = await admin.from('crm_messages').update({ status: s.status }).eq('whatsapp_message_id', s.id).eq('org_id', channel.org_id).eq('channel_id', channel.id);
            if (error) throw error;
          }
        } else if (change.field === 'smb_message_echoes') {
          // Coexistência: mensagem enviada pelo app WhatsApp Business no celular.
          for (const m of v.message_echoes ?? []) await saveMessage(admin, channel, m.to, null, m, 'outbound');
        }
        // shortcut: history/smb_app_state_sync (sincronização inicial da coexistência) ignorados; importar depois se precisar do histórico antigo.
      } catch (e) {
        // Falhas pedem reenvio; wamid único torna mensagens repetidas idempotentes.
        failed = true;
        console.error('erro processando evento', change.field, e);
      }
    }
  }
  return new Response(failed ? 'retry' : 'ok', { status: failed ? 503 : 200 });
});

async function saveMessage(admin: SupabaseClient, channel: { id: string; org_id: string }, waId: string, name: string | null, m: WebhookMessage, direction: 'inbound' | 'outbound') {
  const patientId = await findOrCreatePatient(admin, channel.org_id, waId, name);
  const p = parseMessage(m);
  const ts = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString();
  const { error } = await admin.from('crm_messages').upsert({
    org_id: channel.org_id, patient_id: patientId, channel_id: channel.id, direction,
    content: p.content, message_type: p.type, status: direction === 'inbound' ? 'received' : 'sent',
    whatsapp_message_id: m.id, created_at: ts,
    // shortcut: guarda só o media id da Meta; um proxy de mídia baixa o arquivo quando o inbox exibir.
    media_url: p.mediaId ? `wa-media:${p.mediaId}` : null, media_mime: p.mime,
  }, { onConflict: 'whatsapp_message_id', ignoreDuplicates: true });
  if (error) throw error;
  // The database assigns the exact patient/channel conversation and advances activity
  // monotonically. Duplicate and out-of-order events cannot rewind the Inbox.
}

async function findOrCreatePatient(admin: SupabaseClient, orgId: string, waId: string, name: string | null): Promise<string> {
  const { data, error } = await admin.rpc('ensure_whatsapp_patient', {
    p_org: orgId, p_phone: waIdToLocal(waId), p_name: name,
  });
  if (error || !data) throw error ?? new Error('falha ao identificar paciente');
  return data;
}
