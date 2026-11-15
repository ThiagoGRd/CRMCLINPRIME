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
// Só estes tipos saem com o tipo real. Qualquer outro (html, svg...) vira download binário:
// um arquivo enviado por um paciente nunca pode ser interpretado como página pelo navegador.
const SAFE_TYPE = /^(image\/(jpeg|png|webp|gif)|audio\/[a-z0-9.+-]+|application\/pdf)$/;

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
  // O limite de tempo vale só até a resposta começar; cortar depois interromperia arquivo grande em rede lenta.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    upstream = await fetch(`${bridge}/media?wamid=${encodeURIComponent(wamid)}`, {
      headers: { 'x-system-key': cfg.cadence_secret },
      signal: ctl.signal,
    });
  } catch {
    return json({ error: 'Mídia indisponível no momento.' }, 502);
  } finally {
    clearTimeout(timer);
  }
  if (upstream.status === 404) return json({ error: 'Mensagem sem mídia.' }, 404);
  if (!upstream.ok) return json({ error: 'Mídia indisponível no momento.' }, 502);

  const upstreamType = (upstream.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const safe = SAFE_TYPE.test(upstreamType);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': safe ? upstreamType : 'application/octet-stream',
      'Content-Disposition': safe ? 'inline' : 'attachment',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      // Dado de saúde: não deixar cópia no disco do navegador.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
