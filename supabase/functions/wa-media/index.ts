// Entrega a mídia (foto, áudio, documento) de UMA mensagem do WhatsApp a quem está logado.
// O arquivo fica na VPS; aqui só se confere o acesso e se repassa o conteúdo.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Não autenticado.' }, 401);
  const url = Deno.env.get('SUPABASE_URL')!;

  // Cliente com o login de quem pede: o RLS decide se a mensagem é da organização dessa pessoa.
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await caller.auth.getUser();
  if (authError || !auth.user) return json({ error: 'Não autenticado.' }, 401);

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!UUID.test(id)) return json({ error: 'Mensagem inválida.' }, 400);

  const { data: msg, error: msgError } = await caller
    .from('messages').select('whatsapp_message_id').eq('id', id).maybeSingle();
  if (msgError) return json({ error: 'Não foi possível verificar a mensagem.' }, 500);
  const wamid = msg?.whatsapp_message_id as string | undefined;
  if (!wamid || !wamid.includes(':')) return json({ error: 'Mensagem sem mídia.' }, 404);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: rows } = await admin.from('platform_settings').select('key, value').in('key', ['vps_bridge_url', 'cadence_secret']);
  const cfg = Object.fromEntries((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  const bridge = cfg.vps_bridge_url || 'https://evolution.clinprime.shop/crm-bridge';
  if (!cfg.cadence_secret) return json({ error: 'Mídia indisponível.' }, 503);

  let upstream: Response;
  try {
    upstream = await fetch(`${bridge}/media?wamid=${encodeURIComponent(wamid)}`, {
      headers: { 'x-system-key': cfg.cadence_secret },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return json({ error: 'Mídia indisponível no momento.' }, 502);
  }
  if (upstream.status === 404) return json({ error: 'Mensagem sem mídia.' }, 404);
  if (!upstream.ok) return json({ error: 'Mídia indisponível no momento.' }, 502);

  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
