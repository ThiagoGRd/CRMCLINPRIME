import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-system-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function firstName(full: unknown) {
  const t = String(full || '').trim().split(/\s+/)[0] || '';
  if (!t) return 'tudo bem';
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}
function nextBusiness(ts: Date, biz: { tz?: number; start?: number; end?: number; days?: number[] }) {
  const tz = Number(biz?.tz ?? -3);
  const startH = Number(biz?.start ?? 9), endH = Number(biz?.end ?? 18);
  const days = biz?.days ?? [1, 2, 3, 4, 5, 6];
  const d = new Date(ts.getTime());
  for (let i = 0; i < 14 * 24; i++) {
    const local = new Date(d.getTime() + tz * 3600 * 1000);
    const dow = local.getUTCDay();
    const h = local.getUTCHours();
    if (days.includes(dow) && h >= startH && h < endH) return d;
    d.setTime(d.getTime() + 3600 * 1000);
  }
  return d;
}
function isBusinessNow(ts: Date, biz: { tz?: number; start?: number; end?: number; days?: number[] }) {
  const tz = Number(biz?.tz ?? -3);
  const startH = Number(biz?.start ?? 9), endH = Number(biz?.end ?? 18);
  const days = biz?.days ?? [1, 2, 3, 4, 5, 6];
  const local = new Date(ts.getTime() + tz * 3600 * 1000);
  return days.includes(local.getUTCDay()) && local.getUTCHours() >= startH && local.getUTCHours() < endH;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dry_run;
    const orgId = body.org_id || '00000000-0000-0000-0000-000000000001';

    const { data: setRows } = await admin.from('platform_settings').select('key, value');
    const cfg = Object.fromEntries((setRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    const sysKey = req.headers.get('x-system-key') ?? '';
    const okAuth = sysKey && (sysKey === cfg.cadence_secret || sysKey === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (!okAuth) return json({ error: 'nao autorizado' }, 401);

    const { data: cad } = await admin.from('crm_cadences').select('*').eq('org_id', orgId).eq('key', 'resgate_falta').single();
    if (!cad) return json({ error: 'cadencia nao encontrada' }, 404);
    const enabled = !!cad.active;
    if (!enabled && !dryRun) return json({ ok: true, enabled: false, note: 'cadencia desligada' });

    const steps = (cad.steps ?? []).slice().sort((a: { step: number }, b: { step: number }) => a.step - b.step);
    const biz = cad.business ?? { start: 9, end: 18, days: [1, 2, 3, 4, 5, 6], tz: -3 };
    const now = new Date();

    const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data: faltas } = await admin.from('crm_attendances')
      .select('id, phone, patient_name, appt_date, status, in_funnel')
      .eq('org_id', orgId).eq('status', 'faltou').eq('in_funnel', true).gte('appt_date', since);
    const { data: existing } = await admin.from('crm_cadence_enrollments')
      .select('attendance_id').eq('org_id', orgId).eq('cadence_key', 'resgate_falta');
    const enrolledIds = new Set((existing ?? []).map((e: { attendance_id: string }) => e.attendance_id));
    const toEnroll = (faltas ?? []).filter((f: { id: string; phone: string }) => {
      const ph = String(f.phone || '').replace(/\D/g, '');
      return ph.length >= 10 && !enrolledIds.has(f.id);
    });
    const newEnrollments = toEnroll.map((f: { id: string; phone: string; patient_name: string }) => ({
      org_id: orgId, cadence_key: 'resgate_falta', attendance_id: f.id,
      phone: String(f.phone).replace(/\D/g, ''), patient_name: f.patient_name,
      anchor_at: now.toISOString(), current_step: 0,
      next_send_at: nextBusiness(now, biz).toISOString(), status: 'active',
    }));
    if (!dryRun && newEnrollments.length) {
      await admin.from('crm_cadence_enrollments').upsert(newEnrollments, { onConflict: 'org_id,cadence_key,attendance_id' });
    }

    const { data: due } = await admin.from('crm_cadence_enrollments')
      .select('*').eq('org_id', orgId).eq('cadence_key', 'resgate_falta')
      .eq('status', 'active').lte('next_send_at', now.toISOString());

    const { data: chs } = await admin.from('channels').select('*').eq('org_id', orgId).eq('type', 'whatsapp');
    // Prefer Layla (CRC Agendamento) for resgate_falta cadence, fallback to any connected channel
    const channel =
      (chs ?? []).find((c: { instance_name: string; status: string }) => c.instance_name === 'layla' && c.status === 'connected') ??
      (chs ?? []).find((c: { status: string }) => c.status === 'connected') ??
      (chs ?? [])[0];
    const EVO = cfg.evolution_url, KEY = cfg.evolution_global_key;
    const VPS_BRIDGE = (cfg.vps_bridge_url || 'https://evolution.clinprime.shop/crm-bridge').replace(/\/+$/, '');

    const plan = [];
    let sent = 0, stopped = 0;
    const inWindow = isBusinessNow(now, biz);

    for (const e of (due ?? [])) {
      const phoneDigits = String(e.phone || '').replace(/\D/g, '');
      const last8 = phoneDigits.slice(-8);

      const { data: chat } = await admin.from('chats').select('ai_service, consulta_agendada').ilike('phone', `%${last8}`).limit(1).maybeSingle();
      if (String(chat?.ai_service ?? '').startsWith('pause')) {
        if (!dryRun) await admin.from('crm_cadence_enrollments').update({ status: 'paused_human' }).eq('id', e.id);
        stopped++; plan.push({ phone: e.phone, name: e.patient_name, action: 'stop', reason: 'humano assumiu (pause)' }); continue;
      }

      // Check replies in both chat_messages and crm_messages (inbound via VPS bridges)
      const { data: repliesLegacy } = await admin.from('chat_messages')
        .select('id').ilike('phone', `%${last8}`).neq('user_message', '').gt('created_at', e.anchor_at).limit(1);

      let repliedCrm = false;
      const { data: patRow } = await admin.from('crm_patients')
        .select('id').eq('org_id', orgId).ilike('phone', `%${last8}`).limit(1).maybeSingle();
      if (patRow?.id) {
        const { data: repliesCrm } = await admin.from('crm_messages')
          .select('id').eq('patient_id', patRow.id).eq('direction', 'inbound').gt('created_at', e.anchor_at).limit(1);
        repliedCrm = !!(repliesCrm && repliesCrm.length > 0);
      }

      if ((repliesLegacy && repliesLegacy.length) || repliedCrm) {
        if (!dryRun) await admin.from('crm_cadence_enrollments').update({ status: 'responded' }).eq('id', e.id);
        stopped++; plan.push({ phone: e.phone, name: e.patient_name, action: 'stop', reason: 'paciente respondeu (Layla assume)' }); continue;
      }

      const today = now.toISOString().slice(0, 10);
      const { data: future } = await admin.from('crm_attendances')
        .select('id').eq('org_id', orgId).ilike('phone', `%${last8}`).gte('appt_date', today)
        .neq('status', 'faltou').limit(1);
      if (future && future.length) {
        if (!dryRun) await admin.from('crm_cadence_enrollments').update({ status: 'rescheduled' }).eq('id', e.id);
        stopped++; plan.push({ phone: e.phone, name: e.patient_name, action: 'stop', reason: 'reagendou' }); continue;
      }

      const stepDef = steps[e.current_step];
      if (!stepDef) { if (!dryRun) await admin.from('crm_cadence_enrollments').update({ status: 'completed' }).eq('id', e.id); continue; }
      const msg = String(stepDef.message).replace(/\{nome\}/g, firstName(e.patient_name));

      if (!inWindow) { plan.push({ phone: e.phone, name: e.patient_name, step: stepDef.step, action: 'defer', reason: 'fora do horario comercial' }); continue; }

      if (dryRun) {
        plan.push({ phone: e.phone, name: e.patient_name, step: stepDef.step, channel: channel?.instance_name ?? null, action: 'would_send', message: msg });
        continue;
      }

      if (!channel) { plan.push({ phone: e.phone, action: 'error', reason: 'sem canal WhatsApp' }); continue; }

      const isVpsBridge = channel.config?.provider === 'vps_esquadrao' || ['recepcao', 'layla', 'diana', 'thiago'].includes(channel.instance_name);
      let sendOk = false;
      let sendStatus = 0;

      if (isVpsBridge) {
        const destPhone = phoneDigits.startsWith('55') ? phoneDigits : `55${phoneDigits}`;
        const r = await fetch(`${VPS_BRIDGE}/send`, {
          method: 'POST',
          headers: { 'x-system-key': cfg.cadence_secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance: channel.instance_name, phone: destPhone, text: msg }),
        });
        sendStatus = r.status;
        const rData = await r.json().catch(() => ({}));
        sendOk = r.ok && !!(rData?.ok || rData?.success);
      } else if (EVO && KEY) {
        const r = await fetch(`${EVO}/message/sendText/${encodeURIComponent(channel.instance_name)}`, {
          method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: e.phone, text: msg }),
        });
        sendStatus = r.status;
        sendOk = r.ok;
      }

      if (!sendOk) { plan.push({ phone: e.phone, action: 'error', reason: 'falha no envio WhatsApp', status: sendStatus }); continue; }

      await admin.from('chat_messages').insert({
        phone: e.phone, user_message: '', bot_message: msg, user_name: e.patient_name || '',
        conversation_id: e.phone, message_type: 'text', app: 'cadence', active: true,
      });
      if (patRow?.id) {
        await admin.from('crm_messages').insert({
          org_id: orgId, patient_id: patRow.id, channel_id: channel.id,
          direction: 'outbound', content: msg, message_type: 'text', status: 'sent',
        });
      }

      const nextStep = e.current_step + 1;
      const upd: Record<string, unknown> = { current_step: nextStep, last_sent_at: now.toISOString() };
      if (nextStep >= steps.length) { upd.status = 'completed'; upd.next_send_at = null; }
      else {
        const off = Number(steps[nextStep].offset_hours || 0);
        upd.next_send_at = nextBusiness(new Date(new Date(e.anchor_at).getTime() + off * 3600 * 1000), biz).toISOString();
      }
      await admin.from('crm_cadence_enrollments').update(upd).eq('id', e.id);
      sent++;
      plan.push({ phone: e.phone, name: e.patient_name, step: stepDef.step, channel: channel.instance_name, action: 'sent' });
    }

    return json({
      ok: true, dry_run: dryRun, enabled,
      channel: channel?.instance_name ?? null,
      enrolled: dryRun ? toEnroll.length : newEnrollments.length,
      due: (due ?? []).length, sent, stopped, plan,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
