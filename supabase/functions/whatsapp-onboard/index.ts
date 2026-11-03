// Finaliza o Embedded Signup (coexistência com o app WhatsApp Business):
// troca o code por token, assina o webhook na WABA e cria um canal por número.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}
const GRAPH = 'https://graph.facebook.com/v25.0';
const APP_ID = Deno.env.get('WA_APP_ID') ?? '1807826200432927';
const APP_SECRET = Deno.env.get('WA_APP_SECRET') ?? '';

async function graph(path: string, token: string, init?: RequestInit) {
  const r = await fetch(`${GRAPH}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error?.message ?? `Graph ${r.status}`);
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'nao autenticado' }, 401);
    if (!APP_SECRET) return json({ error: 'WA_APP_SECRET nao configurado' }, 500);

    const { code, waba_id, org_id } = await req.json();
    if (!code) return json({ error: 'code ausente' }, 400);
    const { data: mem } = await admin.from('org_members').select('org_id').eq('user_id', user.id);
    const orgIds = (mem ?? []).map((m) => m.org_id);
    const oid = org_id && orgIds.includes(org_id) ? org_id : orgIds[0];
    if (!oid) return json({ error: 'usuario sem organizacao' }, 403);

    // 1. code -> token de negócio (vale para as WABAs que o usuário autorizou no popup)
    const tr = await fetch(`${GRAPH}/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&code=${encodeURIComponent(code)}`);
    const tok = await tr.json();
    if (!tr.ok || !tok.access_token) return json({ error: tok?.error?.message ?? 'falha ao trocar o code' }, 502);
    const token = tok.access_token as string;

    // 2. WABAs: a do evento do popup ou, se ele não chegou, as que o token enxerga
    let wabaIds: string[] = waba_id ? [String(waba_id)] : [];
    if (!wabaIds.length) {
      const dbg = await (await fetch(`${GRAPH}/debug_token?input_token=${token}&access_token=${APP_ID}|${APP_SECRET}`)).json();
      const scope = (dbg?.data?.granular_scopes ?? []).find((s: any) => s.scope === 'whatsapp_business_management');
      wabaIds = scope?.target_ids ?? [];
    }
    if (!wabaIds.length) return json({ error: 'nenhuma conta do WhatsApp autorizada' }, 400);

    const connected: { phone: string; name: string }[] = [];
    for (const waba of wabaIds) {
      // 3. faz a Meta mandar os eventos dessa WABA para o nosso webhook
      await graph(`/${waba}/subscribed_apps`, token, { method: 'POST' });
      // 4. um canal por número (coexistência: o número já vem registrado, sem /register)
      const { data: numbers } = await graph(`/${waba}/phone_numbers?fields=id,display_phone_number,verified_name`, token);
      for (const n of numbers ?? []) {
        const { data: existing } = await admin.from('channels').select('id, org_id').eq('phone_number_id', n.id).maybeSingle();
        if (existing && existing.org_id !== oid) return json({ error: `o número ${n.display_phone_number} já está conectado a outra organização` }, 409);
        const row = {
          org_id: oid, type: 'whatsapp_cloud', status: 'connected', phone_number_id: n.id, waba_id: waba,
          display_name: n.verified_name || n.display_phone_number, config: { display_phone: n.display_phone_number },
        };
        const { data: ch, error } = existing
          ? await admin.from('channels').update(row).eq('id', existing.id).select('id').single()
          : await admin.from('channels').insert(row).select('id').single();
        if (error) throw error;
        const { error: se } = await admin.from('channel_secrets').upsert({ channel_id: ch.id, access_token: token, updated_at: new Date().toISOString() });
        if (se) throw se;
        connected.push({ phone: n.display_phone_number, name: row.display_name });
      }
    }
    // shortcut: sincronização de contatos/histórico (POST /{phone}/smb_app_data) não é disparada — só pode rodar uma vez,
    // então fica para quando o webhook souber importar os eventos history/smb_app_state_sync.
    return json({ connected });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
