import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-system-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function fmtBRL(n: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
}

async function builtInSofiaAnswer(admin: any, orgId: string, query: string): Promise<string> {
  const q = query.toLowerCase().trim();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const today = now.toISOString().slice(0, 10);

  const [
    { count: leadsMonth },
    { data: salesRows },
    { data: attendRows },
    { data: openBudgets },
    { data: channels },
    { data: todayAppts },
  ] = await Promise.all([
    admin.from('crm_patients').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('created_at', startMonth).lt('created_at', nextMonth),
    admin.from('crm_sales').select('amount, professional_id, patient_name, sale_date').eq('org_id', orgId).gte('sale_date', startMonth).lt('sale_date', nextMonth),
    admin.from('crm_attendances').select('status, in_funnel').eq('org_id', orgId).gte('appt_date', startMonth).lt('appt_date', nextMonth),
    admin.from('crm_patients').select('name, phone, clinicorp_status, clinicorp_amount').eq('org_id', orgId).in('clinicorp_status', ['OPEN', 'FOLLOWUP']).order('clinicorp_amount', { ascending: false, nullsFirst: false }).limit(8),
    admin.from('channels').select('instance_name, display_name, status').eq('org_id', orgId).order('created_at', { ascending: true }),
    admin.from('crm_attendances').select('from_time, patient_name, category, status').eq('org_id', orgId).eq('appt_date', today).order('from_time', { ascending: true }).limit(15),
  ]);

  const faturamentoMes = (salesRows ?? []).reduce((a: number, r: any) => a + Number(r.amount || 0), 0);
  const vendasMes = (salesRows ?? []).length;
  const agendFunil = (attendRows ?? []).filter((a: any) => a.in_funnel).length;
  const compFunil = (attendRows ?? []).filter((a: any) => a.in_funnel && a.status === 'compareceu').length;
  const faltasFunil = (attendRows ?? []).filter((a: any) => a.in_funnel && a.status === 'faltou').length;

  // Se perguntou por WhatsApp / conexões
  if (q.includes('whatsapp') || q.includes('conex') || q.includes('canal') || q.includes('ponte')) {
    const chLines = (channels ?? []).map((c: any) => `• ${c.display_name} (${c.instance_name}): ${c.status === 'connected' ? '🟢 Conectado' : '⚪ Desconectado'}`).join('\n');
    return `Status atual dos canais WhatsApp na VPS:\n${chLines}`;
  }

  // Se perguntou por orçamento / follow-up
  if (q.includes('orçamento') || q.includes('orcamento') || q.includes('follow') || q.includes('aberto')) {
    const list = (openBudgets ?? []).slice(0, 5).map((b: any) => `• ${b.name} — ${fmtBRL(b.clinicorp_amount)} (${b.clinicorp_status})`).join('\n');
    return `Principais orçamentos em aberto para follow-up:\n${list || 'Nenhum orçamento em aberto no momento.'}`;
  }

  // Se perguntou por agenda / hoje / consulta
  if (q.includes('agenda') || q.includes('hoje') || q.includes('consulta')) {
    if ((todayAppts ?? []).length > 0) {
      const list = (todayAppts ?? []).map((a: any) => `• ${a.from_time} — ${a.patient_name} (${a.category || 'Consulta'}) [${a.status}]`).join('\n');
      return `Consultas de hoje (${today.split('-').reverse().join('/')}):\n${list}`;
    }
    return `No mês atual (${String(month).padStart(2, '0')}/${year}) temos ${agendFunil} agendamentos no funil (${compFunil} comparecimentos e ${faltasFunil} faltas).`;
  }

  // Busca por paciente específico se houver palavras relevantes
  const words = q.replace(/[?!.,]/g, '').split(/\s+/).filter((w) => w.length >= 4 && !['como', 'qual', 'quais', 'estao', 'está', 'esta', 'online', 'sofia', 'responda', 'apenas', 'frase', 'curta', 'confirmando', 'resumo', 'faturamento', 'vendas', 'metas'].includes(w));
  if (q.includes('paciente') && words.length > 0) {
    const term = words[words.length - 1];
    const { data: pats } = await admin.from('crm_patients').select('name, phone, source, clinicorp_status, clinicorp_amount').eq('org_id', orgId).ilike('name', `%${term}%`).limit(5);
    if (pats && pats.length > 0) {
      return `Pacientes encontrados para "${term}":\n` + pats.map((p: any) => `• ${p.name} (${p.phone || 'sem tel'}) — Origem: ${p.source || '—'}${p.clinicorp_amount ? ` · Orçamento: ${fmtBRL(p.clinicorp_amount)} (${p.clinicorp_status})` : ''}`).join('\n');
    }
  }

  const connectedCount = (channels ?? []).filter((c: any) => c.status === 'connected').length;
  return (
    `Estou online! Aqui está o resumo atualizado de ${String(month).padStart(2, '0')}/${year} na ClinPrime:\n` +
    `• Faturamento do mês: ${fmtBRL(faturamentoMes)} (${vendasMes} orçamentos aprovados)\n` +
    `• Novos leads no mês: ${leadsMonth ?? 0}\n` +
    `• Funil de agenda: ${agendFunil} agendados · ${compFunil} comparecimentos · ${faltasFunil} faltas\n` +
    `• WhatsApps conectados na VPS: ${connectedCount} ativos (Recepção, Layla e Diana)`
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: rows } = await admin.from('platform_settings').select('key, value');
    const cfg = Object.fromEntries((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    const sysKey = req.headers.get('x-system-key') ?? '';
    const isSystem = Boolean(sysKey && cfg.cadence_secret && sysKey === cfg.cadence_secret);

    let userId = 'system';
    let orgId = '00000000-0000-0000-0000-000000000001';
    if (!isSystem) {
      const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
      const { data: { user } } = await admin.auth.getUser(jwt);
      if (!user) return json({ error: 'não autenticado' }, 401);
      userId = user.id;
      const { data: mem } = await admin.from('org_members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle();
      if (mem?.org_id) orgId = mem.org_id;
    }

    const { query, conversation_id } = await req.json();
    if (!query || !String(query).trim()) return json({ error: 'query vazia' }, 400);

    const DIFY_URL = cfg.dify_url;
    const DIFY_KEY = cfg.dify_key;

    if (DIFY_URL && DIFY_KEY) {
      try {
        const resp = await fetch(`${DIFY_URL}/chat-messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${DIFY_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: {},
            query,
            response_mode: 'streaming',
            user: `crm-copilot-${userId}`,
            conversation_id: conversation_id || '',
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (resp.ok && resp.body) {
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let answer = '';
          let convId = conversation_id || '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const ev = JSON.parse(payload);
                if (ev.conversation_id) convId = ev.conversation_id;
                if ((ev.event === 'agent_message' || ev.event === 'message') && ev.answer) {
                  answer += ev.answer;
                }
              } catch { /* linha parcial, ignora */ }
            }
          }
          if (answer.trim()) {
            return json({ answer: answer.trim(), conversation_id: convId });
          }
        }
      } catch {
        // Fallback para inteligência interna conectada ao banco do CRM
      }
    }

    const fallbackAnswer = await builtInSofiaAnswer(admin, orgId, String(query));
    return json({ answer: fallbackAnswer, conversation_id: conversation_id || 'sofia-local' });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
