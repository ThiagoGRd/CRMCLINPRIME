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
    // mesma chave de sistema do cadence-runner
    if (req.headers.get('x-system-key') !== cfg.cadence_secret) return json({ error: 'nao autorizado' }, 401);

    const results: Check[] = [];

    // 1) n8n (motor da Sofia)
    try {
      const r = await fetch('https://n8n.clinprime.shop/healthz', { signal: AbortSignal.timeout(10000) });
      results.push({ check: 'n8n', ok: r.ok, detail: `HTTP ${r.status}` });
    } catch (e) {
      results.push({ check: 'n8n', ok: false, detail: String(e).slice(0, 120) });
    }

    // 2) instancias WhatsApp (Evolution)
    const { data: chans } = await admin.from('channels').select('instance_name, display_name').eq('type', 'whatsapp');
    for (const ch of chans ?? []) {
      try {
        const r = await fetch(`${cfg.evolution_url}/instance/connectionState/${encodeURIComponent(ch.instance_name)}`, {
          headers: { apikey: cfg.evolution_global_key }, signal: AbortSignal.timeout(10000),
        });
        const d = await r.json().catch(() => null);
        const state = d?.instance?.state ?? d?.state ?? 'desconhecido';
        results.push({ check: `whatsapp: ${ch.display_name || ch.instance_name}`, ok: state === 'open', detail: `estado ${state}` });
      } catch (e) {
        results.push({ check: `whatsapp: ${ch.display_name || ch.instance_name}`, ok: false, detail: String(e).slice(0, 120) });
      }
    }

    // 3) frescor do sync Clinicorp (roda a cada visita ao Dashboard/Metas; >36h parado = ninguem usou OU quebrou)
    const { data: s } = await admin.from('crm_sales').select('synced_at').order('synced_at', { ascending: false }).limit(1).maybeSingle();
    const ageH = s?.synced_at ? (Date.now() - new Date(s.synced_at).getTime()) / 3600000 : 9999;
    results.push({ check: 'sync clinicorp', ok: ageH < 36, detail: `ultimo sync ha ${ageH.toFixed(1)}h` });

    // persiste estado + decide alertas (transicao ok->falha, re-alerta a cada 6h, aviso de normalizacao)
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

    // envia alerta por WhatsApp (melhor esforco: se a propria instancia caiu, nao ha por onde enviar)
    let sent = false;
    const phone = String(cfg.alert_phone ?? '').replace(/\D/g, '');
    if (alerts.length && phone) {
      const inst = (chans ?? [])[0]?.instance_name;
      if (inst) {
        try {
          const r = await fetch(`${cfg.evolution_url}/message/sendText/${encodeURIComponent(inst)}`, {
            method: 'POST',
            headers: { apikey: cfg.evolution_global_key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ number: phone, text: `⚕️ Monitor ClinPrime CRM\n\n${alerts.join('\n')}` }),
            signal: AbortSignal.timeout(10000),
          });
          sent = r.ok;
        } catch { /* melhor esforco */ }
      }
    }

    return json({ ok: true, results, alerts, alert_sent: sent, alert_phone_configurado: !!phone });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
