import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

type Check = { check: string; ok: boolean; detail: string };

Deno.serve(async (req) => {
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: rows } = await admin.from('platform_settings').select('key, value');
    const cfg = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));
    if (req.headers.get('x-system-key') !== cfg.cadence_secret) return json({ error: 'nao autorizado' }, 401);

    const results: Check[] = [];

    // 1) instâncias WhatsApp na VPS (recepcao, layla, diana)
    const { data: chans } = await admin.from('channels').select('instance_name, display_name, status, updated_at, config').eq('type', 'whatsapp');
    for (const ch of chans ?? []) {
      if (ch.instance_name === 'thiago') continue; // ponte pessoal opcional
      const ageMin = ch.updated_at ? (Date.now() - new Date(ch.updated_at).getTime()) / 60000 : 9999;
      const isOk = ch.status === 'connected' && ageMin < 15;
      results.push({
        check: `whatsapp: ${ch.display_name || ch.instance_name}`,
        ok: isOk,
        detail: `${ch.status} (sync há ${ageMin.toFixed(1)} min)`,
      });
    }

    // 2) frescor do sync Clinicorp
    const { data: s } = await admin.from('crm_sales').select('synced_at').order('synced_at', { ascending: false }).limit(1).maybeSingle();
    const ageH = s?.synced_at ? (Date.now() - new Date(s.synced_at).getTime()) / 3600000 : 9999;
    results.push({ check: 'sync clinicorp', ok: ageH < 36, detail: `ultimo sync ha ${ageH.toFixed(1)}h` });

    const now = new Date().toISOString();
    const { data: prevRows } = await admin.from('health_status').select('*');
    const prev = new Map((prevRows ?? []).map((r) => [r.check_name, r]));
    const alerts: string[] = [];
    for (const r of results) {
      const p = prev.get(r.check);
      const wasOk = p ? p.status === 'ok' : true;
      const hoursSinceAlert = p?.last_alert_at ? (Date.now() - new Date(p.last_alert_at).getTime()) / 3600000 : 9999;
      let last_alert_at = p?.last_alert_at ?? null;
      if (!r.ok && (wasOk || hoursSinceAlert >= 6)) { alerts.push(`\u{1F534} ${r.check}: ${r.detail}`); last_alert_at = now; }
      if (r.ok && p && !wasOk) alerts.push(`\u{1F7E2} ${r.check} normalizou (${r.detail})`);
      await admin.from('health_status').upsert({
        check_name: r.check, status: r.ok ? 'ok' : 'falha', detail: r.detail,
        last_ok_at: r.ok ? now : (p?.last_ok_at ?? null), last_alert_at, updated_at: now,
      }, { onConflict: 'check_name' });
    }

    return json({ ok: true, results, alerts });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
