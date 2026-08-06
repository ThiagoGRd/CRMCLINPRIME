import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function addMin(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
const ST_COMPARECEU = new Set(['5042370073067520','5859874752167936','5989519816392704','4998570332127232']);
const ST_FALTOU = new Set(['6239752731230208']);
function mapStatus(statusId) {
  const s = String(statusId ?? '');
  if (ST_COMPARECEU.has(s)) return 'compareceu';
  if (ST_FALTOU.has(s)) return 'faltou';
  return 'agendado';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'nao autenticado' }, 401);
    const body = await req.json();
    const { from, to, org_id, action } = body;
    const { data: mem } = await admin.from('org_members').select('org_id').eq('user_id', user.id);
    const orgIds = (mem ?? []).map((m) => m.org_id);
    const oid = org_id && orgIds.includes(org_id) ? org_id : orgIds[0];
    if (!oid) return json({ error: 'usuario sem organizacao' }, 403);

    if (action === 'mark') {
      const { attendance_id, status } = body;
      if (!attendance_id || !['agendado','compareceu','faltou'].includes(status)) return json({ error: 'parametros invalidos' }, 400);
      const { error } = await admin.from('crm_attendances').update({ status }).eq('id', attendance_id).eq('org_id', oid);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    const { data: org } = await admin.from('organizations').select('settings').eq('id', oid).single();
    const profId = String(org?.settings?.clinicorp_professional_id ?? '');
    const ff = org?.settings?.funnel_filter ?? null;
    function inFunnel(a) {
      if (!ff) return true;
      const uid = String(a.CreateUserId ?? '');
      const creatorOk = (ff.creator_ids ?? []).includes(uid) || (ff.include_api && String(a.CreatedBy ?? '') === 'API');
      const cats = ff.categories ?? [];
      const catOk = !cats.length || cats.includes(String(a.CategoryDescription ?? ''));
      return !!(creatorOk && catOk);
    }
    const { data: rows } = await admin.from('platform_settings').select('key, value');
    const cfg = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));
    const URL = cfg.clinicorp_url, SUB = cfg.clinicorp_subscriber, AUTH = cfg.clinicorp_auth;
    const CODE = cfg.clinicorp_code_link, BIZ = cfg.clinicorp_business_id;
    if (!URL || !SUB || !AUTH) return json({ error: 'Clinicorp nao configurado' }, 500);
    const H = { 'Authorization': AUTH, 'Content-Type': 'application/json' };

    if (action === 'push_lead') {
      const { name, phone, email, notes, board } = body;
      if (!name || !phone) return json({ error: 'name e phone obrigatorios' }, 400);
      const r = await fetch(`${URL}/crm/add_leads`, { method: 'POST', headers: H, body: JSON.stringify({
        subscriber_id: SUB, Name: name, Email: email || 'sememail@clinprime.com', Phone: String(phone),
        BoardName: board || 'Leads CRM', Notes: notes || 'Lead capturado pelo CRM ClinPrime',
      }) });
      const txt = await r.text();
      if (!r.ok) return json({ error: 'falha ao enviar lead', detail: txt.slice(0,200) }, 502);
      return json({ ok: true });
    }

    if (action === 'available_times') {
      const { date } = body;
      if (!date) return json({ error: 'date obrigatorio' }, 400);
      const r = await fetch(`${URL}/appointment/get_avaliable_times_calendar?` + new URLSearchParams({ subscriber_id: SUB, code_link: CODE, date }), { headers: H });
      const data = await r.json().catch(() => []);
      let times = [];
      for (const p of (Array.isArray(data) ? data : [data])) { if (!profId || String(p?.professional?.id) === profId) times = p?.times ?? []; }
      return json({ times });
    }

    if (action === 'cancel') {
      const id = body.appointment_id;
      if (!id) return json({ error: 'appointment_id obrigatorio' }, 400);
      const r = await fetch(`${URL}/appointment/cancel_appointment`, { method: 'POST', headers: H, body: JSON.stringify({ subscriber_id: SUB, id: String(id) }) });
      const txt = await r.text();
      if (!r.ok) return json({ error: 'falha ao cancelar', detail: txt.slice(0,200) }, 502);
      return json({ ok: true });
    }

    if (action === 'create') {
      const { name, phone, date, time, duration } = body;
      if (!name || !date || !time) return json({ error: 'name, date e time obrigatorios' }, 400);
      const cleanPhone = String(phone || '').replace(/\D/g, '').replace(/^55/, '');
      let patientId = null;
      if (cleanPhone) {
        const pg = await fetch(`${URL}/patient/get?` + new URLSearchParams({ subscriber_id: SUB, code_link: CODE, Phone: cleanPhone }), { headers: H });
        const pgd = await pg.json().catch(() => null); const cand = Array.isArray(pgd) ? pgd[0] : pgd;
        patientId = cand?.PatientId ?? cand?.Patient_PersonId ?? cand?.id ?? null;
      }
      if (!patientId) {
        const pc = await fetch(`${URL}/patient/create?` + new URLSearchParams({ subscriber_id: SUB, Name: name, Email: body.email || '', MobilePhone: cleanPhone, IgnoreSameName: 'X', IgnoreSameDoc: 'X' }), { method: 'POST', headers: H });
        const pcd = await pc.json().catch(() => null); const cand = Array.isArray(pcd) ? pcd[0] : pcd;
        patientId = cand?.PatientId ?? cand?.Patient_PersonId ?? cand?.id ?? null;
      }
      if (!patientId) return json({ error: 'nao consegui resolver o paciente' }, 502);
      const payload = { PatientName: name, MobilePhone: cleanPhone, fromTime: time, toTime: addMin(time, duration || 30), date: `${date}T03:00:00.000Z`, Clinic_BusinessId: Number(BIZ), Patient_PersonId: Number(patientId), Dentist_PersonId: Number(profId) };
      const r = await fetch(`${URL}/appointment/create_appointment_by_api?subscriber_id=${SUB}`, { method: 'POST', headers: H, body: JSON.stringify(payload) });
      const txt = await r.text();
      if (!r.ok) return json({ error: 'falha ao criar', detail: txt.slice(0,300) }, 502);
      return json({ ok: true });
    }

    function apptRow(a) {
      return {
        org_id: oid, appt_date: (a.date || '').slice(0,10), from_time: a.fromTime, phone: a.MobilePhone || '',
        patient_name: a.PatientName || a.Name || 'Sem nome', professional_id: profId, category: a.CategoryDescription || '',
        status: mapStatus(a.StatusId), create_user_id: String(a.CreateUserId ?? ''), created_by: String(a.CreatedBy ?? ''),
        in_funnel: inFunnel(a), synced_at: new Date().toISOString(),
      };
    }
    async function syncAttendances(f, t) {
      const resp = await fetch(`${URL}/appointment/list?` + new URLSearchParams({ subscriber_id: SUB, from: f, to: t }), { headers: H });
      if (!resp.ok) return { synced: 0 };
      const data = await resp.json(); const items = Array.isArray(data) ? data : (data.appointments ?? []);
      const rws = items.filter((a) => !a.Deleted && (!profId || String(a.Dentist_PersonId) === profId)).map(apptRow);
      if (rws.length) await admin.from('crm_attendances').upsert(rws, { onConflict: 'org_id,appt_date,phone,from_time' });

      // Reconciliacao: o Clinicorp filtra appointment/list por uma data de atividade, nao pela
      // data do agendamento -- quando um horario e remarcado/cancelado ele simplesmente some da
      // consulta do mes original. Como o upsert acima so ADICIONA/ATUALIZA, a linha antiga
      // 'agendado' ficava presa no banco pra sempre, contando pra sempre no KPI de Agendamentos.
      // So mexe em status='agendado' (provisorio); compareceu/faltou sao fatos historicos e nao
      // sao tocados aqui.
      const currentKeys = new Set(rws.map((r) => `${r.appt_date}|${r.phone}|${r.from_time}`));
      const { data: stored } = await admin.from('crm_attendances')
        .select('id, appt_date, phone, from_time')
        .eq('org_id', oid).eq('status', 'agendado').gte('appt_date', f).lte('appt_date', t);
      const staleIds = (stored ?? [])
        .filter((r) => !currentKeys.has(`${r.appt_date}|${r.phone || ''}|${r.from_time || ''}`))
        .map((r) => r.id);
      if (staleIds.length) await admin.from('crm_attendances').delete().in('id', staleIds);

      return { synced: rws.length, funil: rws.filter((r) => r.in_funnel).length, removidos_orfaos: staleIds.length };
    }
    function phoneCanon(p) {
      let d = String(p || '').replace(/\D/g, '');
      if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
      if (d.length < 10) return null;
      return d.slice(0, 2) + d.slice(-8);
    }
    async function syncSales(f, t) {
      // Vendas = orcamentos APPROVED da CLINICA INTEIRA (todos os profissionais).
      const resp = await fetch(`${URL}/estimates/list?` + new URLSearchParams({ subscriber_id: SUB, from: f, to: t }), { headers: H });
      if (!resp.ok) return { synced: 0 };
      const data = await resp.json(); const items = Array.isArray(data) ? data : (data.estimates ?? data.data ?? []);
      const net = (e) => Math.round(Number(e.Amount || 0) * (1 - Number(e.DiscountPercentage || 0) / 100) * 100) / 100;
      const allEst = items.map((e) => ({
        clinicorp_id: String(e.id), org_id: oid, phone: e.PatientMobilePhone || '', phone_canon: phoneCanon(e.PatientMobilePhone),
        patient_name: e.PatientName || null, status: String(e.Status || '').toUpperCase(), amount: net(e),
        est_date: (e.Date || '').slice(0,10) || null, professional_id: String(e.ProfessionalId || ''),
        professional_name: e.ProfessionalName || null, synced_at: new Date().toISOString(),
      }));
      if (allEst.length) await admin.from('crm_estimates').upsert(allEst, { onConflict: 'clinicorp_id' });
      const rws = items.filter((e) => String(e.Status).toUpperCase() === 'APPROVED').map((e) => ({
        org_id: oid, clinicorp_id: String(e.id), sale_date: (e.Date || '').slice(0,10), amount: net(e),
        professional_id: String(e.ProfessionalId || ''), patient_name: e.PatientName || e.Patient || null, status: 'aprovado', synced_at: new Date().toISOString(),
      }));
      if (rws.length) await admin.from('crm_sales').upsert(rws, { onConflict: 'clinicorp_id' });

      // Reconciliacao: mesmo motivo do syncAttendances -- um orcamento aprovado em julho que e
      // "tocado" de novo depois (ex: pagamento lancado) some da consulta de julho na API, mas a
      // venda antiga ficava presa em crm_sales contando faturamento pra sempre (venda fantasma).
      const currentIds = rws.map((r) => r.clinicorp_id);
      let del = admin.from('crm_sales').delete().eq('org_id', oid).gte('sale_date', f).lte('sale_date', t);
      if (currentIds.length) del = del.not('clinicorp_id', 'in', `(${currentIds.join(',')})`);
      const { data: removedRows } = await del.select('clinicorp_id');

      return { synced: rws.length, estimates: allEst.length, removidas_orfas: removedRows?.length ?? 0 };
    }
    async function syncFinance(f, t) {
      // list_cash_flow: [{month, in, out, ...}] -- in=entradas, out=saidas. NAO usar list_summary.
      const resp = await fetch(`${URL}/financial/list_cash_flow?` + new URLSearchParams({ subscriber_id: SUB, from: f, to: t, business_id: BIZ }), { headers: H });
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => []);
      const arr = Array.isArray(data) ? data : (data.values ?? [data]);
      let credit = 0, debit = 0;
      for (const v of arr) { credit += Math.abs(Number(v.in ?? 0)); debit += Math.abs(Number(v.out ?? 0)); }
      await admin.from('crm_finance').upsert({ org_id: oid, month_start: f, credit, debit, net: credit - debit, synced_at: new Date().toISOString() }, { onConflict: 'org_id,month_start' });
      return { credit, debit, net: credit - debit };
    }

    if (action === 'sync_month') {
      if (!from || !to) return json({ error: 'from e to obrigatorios' }, 400);
      const a = await syncAttendances(from, to);
      const s = await syncSales(from, to);
      let fin = null; try { fin = await syncFinance(from, to); } catch { /* opcional */ }
      let leadsUpd = null; try { const rf = await admin.rpc('refresh_patient_clinicorp', { p_org: oid }); leadsUpd = rf.data; } catch { /* opcional */ }
      return json({
        ok: true, agendamentos: a.synced, funil: a.funil, agendamentos_removidos_orfaos: a.removidos_orfaos,
        vendas: s.synced, estimates: s.estimates, vendas_removidas_orfas: s.removidas_orfas,
        leads_atualizados: leadsUpd, financeiro: fin,
      });
    }

    if (!from || !to) return json({ error: 'from e to obrigatorios' }, 400);
    const resp = await fetch(`${URL}/appointment/list?` + new URLSearchParams({ subscriber_id: SUB, from, to }), { headers: H });
    if (!resp.ok) return json({ error: 'falha no Clinicorp', status: resp.status }, 502);
    const data = await resp.json(); const items = Array.isArray(data) ? data : (data.appointments ?? []);
    const raw = items.filter((a) => !a.Deleted && (!profId || String(a.Dentist_PersonId) === profId));
    const appts = raw.map((a) => ({
      clinicorp_id: a.id, date: (a.date || '').slice(0,10), from: a.fromTime, to: a.toTime,
      patient: a.PatientName || a.Name || 'Sem nome', phone: a.MobilePhone || '', category: a.CategoryDescription || '',
      color: a.CategoryColor || '#6366f1', notes: a.Notes || '', clinicorp_status: mapStatus(a.StatusId),
      in_funnel: inFunnel(a), created_by_name: a.CreateUserName || '',
      confirmed: a.AlertInfo?.ConfirmSchedule && a.AlertInfo.ConfirmSchedule !== 'none',
    })).sort((x, y) => (x.date + x.from).localeCompare(y.date + y.from));
    if (raw.length) {
      await admin.from('crm_attendances').upsert(raw.map(apptRow), { onConflict: 'org_id,appt_date,phone,from_time' });
    }
    const { data: att } = await admin.from('crm_attendances').select('id, appt_date, phone, from_time, status').eq('org_id', oid).gte('appt_date', from).lte('appt_date', to);
    const key = (d, p, f) => `${d}|${p}|${f}`;
    const map = new Map((att ?? []).map((r) => [key(r.appt_date, r.phone || '', r.from_time || ''), r]));
    for (const a of appts) { const r = map.get(key(a.date, a.phone, a.from)); a.attendance_id = r?.id ?? null; a.status = r?.status ?? 'agendado'; }
    return json({ professional: org?.settings?.clinicorp_professional_name ?? 'Profissional', count: appts.length, appointments: appts });
  } catch (e) { return json({ error: String(e) }, 500); }
});
