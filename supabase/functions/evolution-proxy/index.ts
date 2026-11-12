import { createClient } from 'jsr:@supabase/supabase-js@2';
import { waIdToLocal, phoneCanon } from '../_shared/wa.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-system-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

const SOURCE_BY_INSTANCE: Record<string, string> = {
  recepcao: 'WhatsApp Recepção',
  layla: 'WhatsApp CRC (Layla)',
  diana: 'WhatsApp Comercial (Diana)',
  thiago: 'WhatsApp Diretoria',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: settingsRows } = await supabaseAdmin.from('platform_settings').select('key, value');
    const settings = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value]));
    const EVO = settings.evolution_url;
    const KEY = settings.evolution_global_key;
    const VPS_BRIDGE = settings.vps_bridge_url || 'https://evolution.clinprime.shop/crm-bridge';
    const SYSTEM_KEY = settings.cadence_secret;

    const body = await req.json().catch(() => ({}));
    const { action, payload = {} } = body;

    // --- Rota de sistema (chamada pelo daemon crm_sync.py na VPS) ---
    const reqSystemKey = req.headers.get('x-system-key');
    if (reqSystemKey && SYSTEM_KEY && reqSystemKey === SYSTEM_KEY) {
      const orgId = payload.org_id || '00000000-0000-0000-0000-000000000001';

      if (action === 'vps_sync') {
        const now = new Date().toISOString();
        const { data: channels } = await supabaseAdmin
          .from('channels')
          .select('id, instance_name, status, config')
          .eq('org_id', orgId);

        const chByInstance = new Map<string, any>();
        for (const ch of channels ?? []) {
          if (ch.instance_name) chByInstance.set(ch.instance_name, ch);
        }

        // 1. Atualizar status das pontes da VPS
        const statuses = (payload.statuses ?? {}) as Record<string, string>;
        for (const [inst, st] of Object.entries(statuses)) {
          const ch = chByInstance.get(inst);
          if (ch) {
            const normStatus = st === 'connected' ? 'connected' : 'disconnected';
            await supabaseAdmin
              .from('channels')
              .update({ status: normStatus, updated_at: now })
              .eq('id', ch.id);
          }
        }

        // Buscar 1ª etapa do funil para novos leads
        const { data: firstStage } = await supabaseAdmin
          .from('crm_pipeline_stages')
          .select('id')
          .eq('org_id', orgId)
          .order('position', { ascending: true })
          .limit(1)
          .maybeSingle();

        const patientCache = new Map<string, { id: string; name: string; last_message_at: string | null; chat_session_id: string | null }>();
        const patientUpdates = new Map<string, Record<string, unknown>>();

        async function resolvePatient(rawPhone: string, contactName: string | null, instanceName: string, chatId: string | null, msgIso: string) {
          const localPhone = waIdToLocal(rawPhone);
          const canon = phoneCanon(localPhone);
          if (!canon) return null;

          let pat = patientCache.get(canon);
          if (!pat) {
            const { data: foundId } = await supabaseAdmin.rpc('find_patient_by_phone', {
              p_org: orgId,
              p_canon: canon,
            });
            if (foundId) {
              const { data: existing } = await supabaseAdmin
                .from('crm_patients')
                .select('id, name, last_message_at, chat_session_id')
                .eq('id', foundId)
                .maybeSingle();
              if (existing) {
                pat = existing;
                patientCache.set(canon, pat);
              }
            }
          }

          const cleanContactName = contactName && !/^\+?\d+$/.test(contactName.replace(/\s+/g, '')) ? contactName.trim() : null;

          if (pat) {
            const u = patientUpdates.get(pat.id) ?? {};
            if (!pat.last_message_at || msgIso > pat.last_message_at) {
              u.last_message_at = msgIso;
              pat.last_message_at = msgIso;
            }
            if (cleanContactName && (/^\+?\d+$/.test((pat.name || '').replace(/\D/g, '')) || pat.name === localPhone)) {
              u.name = cleanContactName;
              pat.name = cleanContactName;
            }
            if (chatId && chatId !== pat.chat_session_id) {
              u.chat_session_id = chatId;
              pat.chat_session_id = chatId;
            }
            if (Object.keys(u).length > 0) {
              patientUpdates.set(pat.id, u);
            }
            return pat.id;
          }

          const sourceLabel = SOURCE_BY_INSTANCE[instanceName] || 'Whatsapp';
          const { data: created, error: createErr } = await supabaseAdmin
            .from('crm_patients')
            .insert({
              org_id: orgId,
              name: cleanContactName || localPhone,
              phone: localPhone,
              source: sourceLabel,
              channel: 'whatsapp',
              chat_session_id: chatId,
              last_message_at: msgIso,
            })
            .select('id, name, last_message_at, chat_session_id')
            .single();

          if (createErr) {
            const { data: retryId } = await supabaseAdmin.rpc('find_patient_by_phone', {
              p_org: orgId,
              p_canon: canon,
            });
            return retryId ?? null;
          }

          patientCache.set(canon, created);
          if (firstStage?.id) {
            await supabaseAdmin.from('crm_deals').insert({
              org_id: orgId,
              patient_id: created.id,
              stage_id: firstStage.id,
            });
          }
          return created.id;
        }

        // 2. Processar lote de mensagens sincronizadas da VPS (bulk upsert)
        const incomingMsgs = Array.isArray(payload.messages) ? payload.messages : [];
        const msgByWamid = new Map<string, Record<string, unknown>>();

        for (const item of incomingMsgs) {
          const instanceName = String(item.instance || '');
          const ch = chByInstance.get(instanceName);
          if (!ch || !item.phone || !item.wamid) continue;

          const msgIso = item.timestamp
            ? new Date(Number(item.timestamp) * 1000).toISOString()
            : now;

          const patientId = await resolvePatient(
            String(item.phone),
            item.sender_name || item.chat_label || null,
            instanceName,
            item.chat_id || null,
            msgIso
          );
          if (!patientId) continue;

          const wamid = String(item.wamid);
          msgByWamid.set(wamid, {
            org_id: orgId,
            patient_id: patientId,
            channel_id: ch.id,
            direction: item.from_owner ? 'outbound' : 'inbound',
            content: String(item.content || '[mensagem]'),
            message_type: String(item.message_type || 'text'),
            status: item.from_owner ? 'sent' : 'received',
            whatsapp_message_id: wamid,
            created_at: msgIso,
          });
        }

        const msgRows = Array.from(msgByWamid.values());
        let synced = 0;
        if (msgRows.length > 0) {
          const { error: msgErr } = await supabaseAdmin
            .from('crm_messages')
            .upsert(msgRows, { onConflict: 'whatsapp_message_id' });
          if (!msgErr) synced = msgRows.length;
        }

        for (const [patId, u] of patientUpdates.entries()) {
          await supabaseAdmin.from('crm_patients').update(u).eq('id', patId);
        }

        // 3. Buscar mensagens outbound em fila ('queued') para envio pela VPS
        const { data: queuedRows } = await supabaseAdmin
          .from('crm_messages')
          .select('id, patient_id, channel_id, content, created_at')
          .eq('org_id', orgId)
          .eq('direction', 'outbound')
          .eq('status', 'queued')
          .order('created_at', { ascending: true })
          .limit(20);

        const queuedOutbound = [];
        for (const q of queuedRows ?? []) {
          const { data: pat } = await supabaseAdmin
            .from('crm_patients')
            .select('phone, chat_session_id')
            .eq('id', q.patient_id)
            .maybeSingle();
          const ch = (channels ?? []).find((c: any) => c.id === q.channel_id) ?? chByInstance.get('recepcao');
          if (pat?.phone && ch?.instance_name) {
            queuedOutbound.push({
              id: q.id,
              instance: ch.instance_name,
              phone: pat.phone,
              chat_id: pat.chat_session_id,
              text: q.content,
            });
          }
        }

        return json({ ok: true, synced, queued_outbound: queuedOutbound });
      }

      if (action === 'vps_ack_outbound') {
        const { message_id, ok, wamid } = payload;
        if (!message_id) return json({ error: 'message_id obrigatório' }, 400);
        const updates: Record<string, unknown> = {
          status: ok ? 'sent' : 'failed',
        };
        if (wamid) updates.whatsapp_message_id = wamid;
        await supabaseAdmin.from('crm_messages').update(updates).eq('id', message_id);
        return json({ ok: true });
      }
    }

    // --- Rotas autenticadas por usuário logado no CRM (ou x-system-key) ---
    let orgIds: string[] = [];
    if (reqSystemKey && SYSTEM_KEY && reqSystemKey === SYSTEM_KEY) {
      orgIds = ['00000000-0000-0000-0000-000000000001'];
    } else {
      const authHeader = req.headers.get('Authorization') ?? '';
      const jwt = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabaseAdmin.auth.getUser(jwt);
      if (!user) return json({ error: 'não autenticado' }, 401);

      const { data: memberships } = await supabaseAdmin.from('org_members').select('org_id, role').eq('user_id', user.id);
      orgIds = (memberships ?? []).map((m: any) => m.org_id);
      if (!orgIds.length) return json({ error: 'usuário sem organização' }, 403);
    }
    const orgId = payload.org_id && orgIds.includes(payload.org_id) ? payload.org_id : orgIds[0];

    const evoFetch = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${EVO}${path}`, {
        ...init,
        headers: { apikey: KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      const text = await res.text();
      try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
      catch { return { ok: res.ok, status: res.status, data: text }; }
    };

    const getChannel = async (id: string) => {
      const { data } = await supabaseAdmin.from('channels').select('*').eq('id', id).single();
      if (!data || !orgIds.includes(data.org_id)) return null;
      return data;
    };

    switch (action) {
      case 'status': {
        const ch = await getChannel(payload.channel_id);
        if (!ch) return json({ error: 'canal não encontrado' }, 404);

        if (ch.config?.provider === 'vps_esquadrao') {
          try {
            const r = await fetch(`${VPS_BRIDGE}/status?instance=${encodeURIComponent(ch.instance_name)}`, {
              headers: { 'x-system-key': SYSTEM_KEY },
              signal: AbortSignal.timeout(4000),
            });
            if (r.ok) {
              const d = await r.json();
              const instState = d?.instances?.[ch.instance_name]?.status ?? ch.status;
              const status = instState === 'connected' ? 'connected' : 'disconnected';
              await supabaseAdmin.from('channels').update({ status, updated_at: new Date().toISOString() }).eq('id', ch.id);
              return json({ status, state: status === 'connected' ? 'open' : 'closed' });
            }
          } catch {
            // Fallback para o status atualizado pelo daemon crm_sync da VPS
          }
          return json({ status: ch.status, state: ch.status === 'connected' ? 'open' : 'closed' });
        }

        const r = await evoFetch(`/instance/connectionState/${encodeURIComponent(ch.instance_name)}`);
        const state = r.data?.instance?.state ?? 'unknown';
        const status = state === 'open' ? 'connected' : (state === 'connecting' ? 'connecting' : 'disconnected');
        await supabaseAdmin.from('channels').update({ status, updated_at: new Date().toISOString() }).eq('id', ch.id);
        return json({ status, state });
      }
      case 'get_qr': {
        const ch = await getChannel(payload.channel_id);
        if (!ch) return json({ error: 'canal não encontrado' }, 404);
        if (ch.config?.provider === 'vps_esquadrao') {
          return json({
            qr: null,
            code: null,
            message: ch.status === 'connected'
              ? 'Instância já conectada na VPS.'
              : 'Para parear este número na VPS, execute: ./whatsapp/conectar.sh ' + ch.instance_name,
          });
        }
        const r = await evoFetch(`/instance/connect/${encodeURIComponent(ch.instance_name)}`);
        return json({ qr: r.data?.base64 ?? null, code: r.data?.pairingCode ?? null });
      }
      case 'create_instance': {
        const display = (payload.display_name || 'WhatsApp').toString();
        const instanceName = `${display.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}-${crypto.randomUUID().slice(0, 6)}`;
        const created = await evoFetch('/instance/create', {
          method: 'POST',
          body: JSON.stringify({ instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
        });
        if (!created.ok) return json({ error: 'falha ao criar instância', detail: created.data }, 502);
        const { data: channel } = await supabaseAdmin.from('channels')
          .insert({ org_id: orgId, type: 'whatsapp', instance_name: instanceName, display_name: display, status: 'connecting' })
          .select().single();
        const qr = created.data?.qrcode?.base64 ?? null;
        return json({ channel, qr });
      }
      case 'disconnect': {
        const ch = await getChannel(payload.channel_id);
        if (!ch) return json({ error: 'canal não encontrado' }, 404);
        if (ch.config?.provider === 'vps_esquadrao') {
          return json({ error: 'As pontes principais da VPS são gerenciadas pelo serviço Esquadrão na VPS.' }, 400);
        }
        const r = await evoFetch(`/instance/logout/${encodeURIComponent(ch.instance_name)}`, { method: 'DELETE' });
        await supabaseAdmin.from('channels').update({ status: 'disconnected' }).eq('id', ch.id);
        return json({ ok: r.ok });
      }
      case 'delete_instance': {
        const ch = await getChannel(payload.channel_id);
        if (!ch) return json({ error: 'canal não encontrado' }, 404);
        if (ch.config?.provider === 'vps_esquadrao') {
          return json({ error: 'Canal fixo da VPS não pode ser removido pela interface.' }, 400);
        }
        await evoFetch(`/instance/logout/${encodeURIComponent(ch.instance_name)}`, { method: 'DELETE' });
        await evoFetch(`/instance/delete/${encodeURIComponent(ch.instance_name)}`, { method: 'DELETE' });
        await supabaseAdmin.from('channels').delete().eq('id', ch.id);
        return json({ ok: true });
      }
      case 'send_text': {
        const { phone, text, channel_id } = payload;
        if (!phone || !text) return json({ error: 'phone e text são obrigatórios' }, 400);
        const { data: chs } = await supabaseAdmin.from('channels').select('*').eq('org_id', orgId).eq('type', 'whatsapp');
        const ch = (channel_id ? (chs ?? []).find((c: any) => c.id === channel_id) : null)
          ?? (chs ?? []).find((c: any) => c.status === 'connected')
          ?? (chs ?? [])[0];
        if (!ch) return json({ error: 'nenhum canal WhatsApp conectado nesta organização' }, 400);

        if (ch.config?.provider === 'vps_esquadrao') {
          const r = await fetch(`${VPS_BRIDGE}/send`, {
            method: 'POST',
            headers: { 'x-system-key': SYSTEM_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance: ch.instance_name, phone: String(phone).replace(/\D/g, ''), text }),
            signal: AbortSignal.timeout(8000),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) return json({ error: d.error || 'falha no envio via VPS', detail: d }, 502);
          return json({ ok: true, result: d });
        }

        const r = await evoFetch(`/message/sendText/${encodeURIComponent(ch.instance_name)}`, {
          method: 'POST',
          body: JSON.stringify({ number: String(phone).replace(/\D/g, ''), text }),
        });
        if (!r.ok) return json({ error: 'falha no envio', detail: r.data }, 502);
        return json({ ok: true, result: r.data });
      }
      default:
        return json({ error: `ação desconhecida: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
