/* ==========================================================================
   ClinPrime CRM — Serverless API Client (Conexão Direta ao Supabase Online)
   Comunica-se diretamente com o Supabase REST API e gerencia webhooks do n8n.
   ========================================================================== */

const SUPABASE_URL = 'https://sterdootrqzlnbbidkcj.supabase.co/rest/v1';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN0ZXJkb290cnF6bG5iYmlka2NqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4Mzk2OTIsImV4cCI6MjA5NTQxNTY5Mn0.tpB94R0XYFHCsjrNa3hElkRUAtg8Vh2GYRlJptfagsM';

// URL do n8n salva localmente no navegador (permite trocar na UI)
let N8N_BASE_URL = localStorage.getItem('clinprime_n8n_url') || 'https://n8n.clinprime.shop/webhook';

/* ==========================================================================
   AUTENTICAÇÃO — Supabase Auth (login obrigatório; RLS protege os dados)
   ========================================================================== */
const SUPABASE_ROOT_URL = SUPABASE_URL.replace('/rest/v1', '');
// Cliente único: auth + realtime compartilham a sessão do usuário
window.sb = window.supabase
  ? window.supabase.createClient(SUPABASE_ROOT_URL, SUPABASE_KEY)
  : null;

let AUTH_TOKEN = null;
let CURRENT_ORG = null; // { id, name, role, contact_label }

if (window.sb) {
  window.sb.auth.onAuthStateChange((_event, session) => {
    AUTH_TOKEN = session?.access_token || null;
    // Propaga o JWT para o WebSocket do Realtime (necessário com RLS ativo)
    if (AUTH_TOKEN && window.sb.realtime) {
      try { window.sb.realtime.setAuth(AUTH_TOKEN); } catch (e) { /* noop */ }
    }
  });
}

const AuthAPI = {
  async getSession() {
    const { data: { session } } = await window.sb.auth.getSession();
    AUTH_TOKEN = session?.access_token || null;
    return session;
  },

  async signIn(email, password) {
    const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    AUTH_TOKEN = data.session?.access_token || null;
    return { success: true, user: data.user };
  },

  async signUp(email, password, orgName) {
    const { data, error } = await window.sb.auth.signUp({ email, password });
    if (error) return { success: false, error: error.message };
    if (!data.session) {
      return { success: false, error: 'Confirme seu e-mail para ativar a conta e depois faça login.' };
    }
    AUTH_TOKEN = data.session.access_token;
    // Cria (ou reivindica) a organização do usuário
    await this.createOrganization(orgName || 'Minha Empresa');
    return { success: true, user: data.user };
  },

  async createOrganization(name) {
    const { data, error } = await window.sb.rpc('create_my_organization', { p_name: name });
    if (error) return { success: false, error: error.message };
    return { success: true, orgId: data };
  },

  async loadMyOrg() {
    // Garante org mesmo para quem logou sem ter (cria/reivindica)
    let res = await supabaseFetch('/org_members?select=role,display_name,org_id,organizations(id,name,contact_label,logo_url)&limit=1');
    if (res.success && res.data.length === 0) {
      await this.createOrganization('Minha Empresa');
      res = await supabaseFetch('/org_members?select=role,display_name,org_id,organizations(id,name,contact_label,logo_url)&limit=1');
    }
    if (res.success && res.data.length > 0) {
      const m = res.data[0];
      CURRENT_ORG = { id: m.org_id, role: m.role, displayName: m.display_name, ...(m.organizations || {}) };
      return CURRENT_ORG;
    }
    return null;
  },

  getOrg() { return CURRENT_ORG; },

  async signOut() {
    await window.sb.auth.signOut();
    AUTH_TOKEN = null; CURRENT_ORG = null;
    location.reload();
  }
};

/**
 * Wrapper para chamadas diretas à API REST do Supabase
 * Usa o JWT do usuário logado (RLS aplica o isolamento por organização)
 */
async function supabaseFetch(path, options = {}) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${AUTH_TOKEN || SUPABASE_KEY}`,
      ...options.headers,
    };

    if (options.body && typeof options.body === 'object') {
      options.body = JSON.stringify(options.body);
    }

    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...options,
      headers
    });

    if (res.status === 204) {
      return { success: true, data: null };
    }

    const data = await res.json();

    if (!res.ok) {
      console.error(`Supabase Error [${res.status}]:`, data);
      throw new Error(data.message || `Erro ${res.status}`);
    }

    return { success: true, data };
  } catch (err) {
    console.error(`Supabase Request failed [${path}]:`, err.message);
    throw err;
  }
}

/**
 * Disparador de Webhooks do n8n diretamente do Frontend
 */
async function triggerN8NWebhook(webhookPath, payload) {
  try {
    const url = `${N8N_BASE_URL}/${webhookPath}`;
    const evolutionConfig = {
      url: localStorage.getItem('clinprime_evolution_url') || 'http://localhost:8080',
      key: localStorage.getItem('clinprime_evolution_key') || 'sua_api_key_global',
      instance: localStorage.getItem('clinprime_evolution_instance') || 'Thiago Cruz'
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        evolution: evolutionConfig,
        _source: 'clinprime-crm-frontend',
        _timestamp: new Date().toISOString()
      })
    });

    if (!res.ok) {
      console.warn(`n8n webhook [${webhookPath}] retornou status ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`Falha ao disparar n8n em ${N8N_BASE_URL}:`, err.message);
    return false;
  }
}

/* ==========================================================================
   API de Pacientes
   ========================================================================== */
const PatientsAPI = {
  async getAll(filters = {}) {
    let queryPath = '/patients?select=*,deal:deals(id,stage_id,position,moved_at)&order=created_at.desc';
    
    if (filters.search) {
      queryPath += `&or=(name.ilike.%${filters.search}%,phone.ilike.%${filters.search}%)`;
    }
    if (filters.source) {
      queryPath += `&source=eq.${filters.source}`;
    }
    
    return supabaseFetch(queryPath);
  },

  async getById(id) {
    const res = await supabaseFetch(`/patients?select=*,deal:deals(id,stage_id,position,moved_at)&id=eq.${id}`);
    if (res.success && res.data.length > 0) {
      return { success: true, data: res.data[0] };
    }
    return { success: false, error: 'Paciente não encontrado' };
  },

  async create(patientData) {
    // 1. Criar paciente no Supabase
    const patientRes = await supabaseFetch('/patients', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: {
        name: patientData.name,
        phone: patientData.phone.replace(/\D/g, ''),
        email: patientData.email || null,
        treatment_interest: patientData.treatment_interest || null,
        treatment_value: patientData.treatment_value || null,
        entrada: patientData.entrada ?? null,
        source: patientData.source || 'manual',
        org_id: CURRENT_ORG?.id
      }
    });

    if (!patientRes.success || !patientRes.data.length) return patientRes;
    const newPatient = patientRes.data[0];

    // 2. Vincular no primeiro estágio do funil
    const stagesRes = await PipelineAPI.getStages();
    if (stagesRes.success && stagesRes.data.length > 0) {
      await supabaseFetch('/deals', {
        method: 'POST',
        body: {
          patient_id: newPatient.id,
          stage_id: stagesRes.data[0].id,
          position: 0,
          org_id: CURRENT_ORG?.id
        }
      });
    }

    // 3. Registrar log de atividade
    await LogActivity(newPatient.id, 'patient_created', { source: newPatient.source });

    // 4. Disparar automação de novo lead para o n8n
    await triggerN8NWebhook('novo-lead', {
      event: 'new_lead',
      patient: newPatient
    });

    return { success: true, data: newPatient };
  },

  async update(id, updates) {
    const patientRes = await supabaseFetch(`/patients?id=eq.${id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: {
        name: updates.name,
        phone: updates.phone.replace(/\D/g, ''),
        email: updates.email || null,
        treatment_interest: updates.treatment_interest || null,
        treatment_value: updates.treatment_value || null,
        entrada: updates.entrada ?? null
      }
    });

    if (patientRes.success && patientRes.data.length > 0) {
      return { success: true, data: patientRes.data[0] };
    }
    return patientRes;
  },

  async remove(id) {
    return supabaseFetch(`/patients?id=eq.${id}`, { method: 'DELETE' });
  },
};

/* ==========================================================================
   API do Pipeline (Funil Kanban)
   ========================================================================== */
const PipelineAPI = {
  async getAll() {
    // 1. Buscar estágios ordenados por posição
    const stagesRes = await supabaseFetch('/pipeline_stages?order=position.asc');
    if (!stagesRes.success) return stagesRes;

    // 2. Buscar deals com dados de pacientes vinculados
    const dealsRes = await supabaseFetch('/deals?select=*,patient:patients(*)&order=position.asc');
    if (!dealsRes.success) return dealsRes;

    // 3. Estruturar o retorno agrupado
    const pipeline = stagesRes.data.map(stage => {
      const stageDeals = dealsRes.data
        .filter(d => d.stage_id === stage.id && d.patient !== null)
        .map(d => ({
          ...d,
          patient: {
            ...d.patient,
            treatment_value: parseFloat(d.patient.treatment_value || 0)
          }
        }));

      return {
        ...stage,
        deals: stageDeals,
        total_value: stageDeals.reduce((sum, d) => sum + (d.patient?.treatment_value || 0), 0)
      };
    });

    return { success: true, data: pipeline };
  },

  async getStages() {
    return supabaseFetch('/pipeline_stages?order=position.asc');
  },

  async moveDeal(dealId, stageId, position = 0) {
    // 1. Obter informações atuais do deal para auditoria
    const currentDealRes = await supabaseFetch(`/deals?select=*,patient:patients(*),stage:pipeline_stages(name)&id=eq.${dealId}`);
    if (!currentDealRes.success || currentDealRes.data.length === 0) {
      return { success: false, error: 'Deal não encontrado' };
    }
    const deal = currentDealRes.data[0];

    // 2. Atualizar estágio no banco
    const updateRes = await supabaseFetch(`/deals?id=eq.${dealId}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: {
        stage_id: stageId,
        position,
        moved_at: new Date().toISOString()
      }
    });

    if (!updateRes.success) return updateRes;

    // 3. Buscar nome do novo estágio para os logs e gatilhos
    const newStageRes = await supabaseFetch(`/pipeline_stages?select=name&id=eq.${stageId}`);
    const newStageName = newStageRes.success && newStageRes.data.length > 0 ? newStageRes.data[0].name : 'Novo Estágio';

    // 4. Logar atividade
    await LogActivity(deal.patient_id, 'stage_moved', {
      from_stage: deal.stage?.name || 'Origem',
      to_stage: newStageName
    });

    // 5. Disparar automação no n8n se o estágio mudou
    if (deal.stage_id !== stageId) {
      await triggerN8NWebhook('estagio-mudou', {
        event: 'stage_change',
        patient: deal.patient,
        from_stage: deal.stage?.name,
        to_stage: newStageName
      });
    }

    return { success: true, data: updateRes.data[0] };
  },

  async createStage(name, color) {
    const stagesRes = await this.getStages();
    const nextPos = stagesRes.success ? stagesRes.data.length + 1 : 1;

    return supabaseFetch('/pipeline_stages', {
      method: 'POST',
      body: { name, color, position: nextPos }
    });
  },
};

/* ==========================================================================
   API de Mensagens (Chat WhatsApp)
   ========================================================================== */
const MessagesAPI = {
  async getHistory(patientId) {
    return supabaseFetch(`/messages?patient_id=eq.${patientId}&order=created_at.asc`);
  },

  async send(patientId, content, messageType = 'text') {
    // 1. Buscar dados do paciente (precisamos do telefone)
    const patientRes = await PatientsAPI.getById(patientId);
    if (!patientRes.success) return { success: false, error: 'Paciente não encontrado' };
    const patient = patientRes.data;

    // 2. Enviar de verdade pelo WhatsApp (Edge Function → Evolution API)
    const sendRes = await edgeInvoke('send_text', {
      phone: patient.phone,
      text: content,
      org_id: CURRENT_ORG?.id
    });
    if (!sendRes.success) {
      return { success: false, error: sendRes.error || 'Falha no envio via WhatsApp' };
    }

    // 3. Registrar a mensagem no histórico
    const msgRes = await supabaseFetch('/messages', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: {
        patient_id: patientId,
        direction: 'outbound',
        content,
        message_type: messageType,
        status: 'sent',
        org_id: CURRENT_ORG?.id
      }
    });

    if (!msgRes.success) return msgRes;

    // 4. Registrar logs
    await LogActivity(patientId, 'message_sent', { content: content.substring(0, 80) });

    return { success: true, data: msgRes.data[0] };
  },

  async getWhatsAppStatus() {
    // Consulta simulada via n8n ou retorna online padrão no modo frontend direto
    const localStatus = localStorage.getItem('clinprime_whatsapp_connected') === 'true';
    return { success: true, data: { connected: localStatus, state: localStatus ? 'open' : 'closed' } };
  },

  async getQrCode() {
    // O n8n é quem fará a ponte para expor o qrcode
    return { success: true, data: { qrcode: 'Configurado via n8n/Evolution' } };
  },
};

/* ==========================================================================
   API de Agendamentos
   ========================================================================== */
const AppointmentsAPI = {
  async getAll() {
    return supabaseFetch('/appointments?order=scheduled_at.asc');
  },

  async create(appointmentData) {
    const res = await supabaseFetch('/appointments', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: {
        patient_id: appointmentData.patient_id,
        title: appointmentData.title,
        scheduled_at: appointmentData.scheduled_at,
        duration_minutes: appointmentData.duration_minutes || 60,
        status: 'scheduled',
        org_id: CURRENT_ORG?.id
      }
    });

    if (!res.success || !res.data.length) return res;
    const appt = res.data[0];

    // Buscar dados do paciente para enviar ao n8n
    const patientRes = await PatientsAPI.getById(appt.patient_id);
    if (patientRes.success) {
      // Disparar lembrete no n8n
      await triggerN8NWebhook('confirmar-consulta', {
        event: 'appointment_created',
        appointment: appt,
        patient: patientRes.data
      });
    }

    return { success: true, data: appt };
  },

  async update(id, updates) {
    return supabaseFetch(`/appointments?id=eq.${id}`, {
      method: 'PATCH',
      body: updates
    });
  },

  async remove(id) {
    return supabaseFetch(`/appointments?id=eq.${id}`, { method: 'DELETE' });
  },
};

/* ==========================================================================
   API de Automações e Atividades
   ========================================================================== */
const AutomationsAPI = {
  async getRules() {
    return supabaseFetch('/automation_rules?order=created_at.asc');
  },

  async updateRule(id, updates) {
    return supabaseFetch(`/automation_rules?id=eq.${id}`, {
      method: 'PATCH',
      body: updates
    });
  },

  async simulateStaleLeads(days = 7) {
    // Realizar busca de leads inativos diretamente no Supabase REST
    const limitDate = new Date();
    limitDate.setDate(limitDate.getDate() - days);

    // Buscar pacientes
    const patientsRes = await supabaseFetch('/patients?select=id,name,phone,treatment_interest');
    if (!patientsRes.success) return patientsRes;

    let staleCount = 0;
    for (const patient of patientsRes.data) {
      // Buscar última mensagem
      const msgsRes = await supabaseFetch(`/messages?patient_id=eq.${patient.id}&order=created_at.desc&limit=1`);
      let isStale = false;
      
      if (msgsRes.success) {
        if (msgsRes.data.length === 0) {
          isStale = true; // sem mensagem nenhuma é inativo
        } else {
          const lastMsgDate = new Date(msgsRes.data[0].created_at);
          isStale = lastMsgDate < limitDate;
        }
      }

      if (isStale) {
        staleCount++;
        // Disparar evento de lead inativo no n8n
        await triggerN8NWebhook('lead-inativo', {
          event: 'lead_stale',
          patient: patient,
          days_since_last_contact: days
        });
      }
    }

    return { success: true, stale_count: staleCount };
  },

  async getActivityLog(limit = 50) {
    return supabaseFetch(`/activity_logs?select=*,patient:patients(id,name)&order=created_at.desc&limit=${limit}`);
  },
};

/**
 * Utilitário interno para registrar log de atividades no Supabase
 */
async function LogActivity(patientId, action, details = {}) {
  try {
    await supabaseFetch('/activity_logs', {
      method: 'POST',
      body: {
        patient_id: patientId,
        action,
        details,
        org_id: CURRENT_ORG?.id
      }
    });
  } catch (err) {
    console.warn('Erro ao gravar log de atividade:', err.message);
  }
}

// Polling local de mensagens em tempo real
let pollingInterval = null;
function startMessagePolling(patientId, callback, intervalMs = 4000) {
  stopMessagePolling();
  pollingInterval = setInterval(async () => {
    try {
      const result = await MessagesAPI.getHistory(patientId);
      if (result.success && result.data) {
        callback(result.data);
      }
    } catch (err) {
      // Silently fail polling
    }
  }, intervalMs);
}

function stopMessagePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/* ==========================================================================
   API de Controle de Atendimento (IA × Humano)
   Controla o campo chats.ai_service que o WF01 (Sofia) respeita:
     'pause'  → Sofia para de responder (humano assumiu)
     'active' → Sofia volta a responder
   A tabela chats usa phone com sufixo (ex: 558299800467@s.whatsapp.net),
   então casamos via LIKE com o telefone normalizado do paciente.
   ========================================================================== */
const ChatControlAPI = {
  async getAiStatus(phone) {
    const clean = (phone || '').replace(/\D/g, '');
    if (!clean) return { success: false, error: 'phone vazio' };
    const res = await supabaseFetch(`/chats?phone=like.${clean}*&select=ai_service,phone&limit=1`);
    if (res.success && res.data.length > 0) {
      const aiService = res.data[0].ai_service;
      // IA está ativa se ai_service NÃO começa com 'pause'
      const iaActive = !(aiService && String(aiService).startsWith('pause'));
      return { success: true, data: { ai_service: aiService, ia_active: iaActive } };
    }
    // Sem registro em chats ainda → considera IA ativa por padrão
    return { success: true, data: { ai_service: null, ia_active: true } };
  },

  async _setAi(phone, value) {
    const clean = (phone || '').replace(/\D/g, '');
    if (!clean) return { success: false, error: 'phone vazio' };
    return supabaseFetch(`/chats?phone=like.${clean}*`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: { ai_service: value, updated_at: new Date().toISOString() }
    });
  },

  // Humano assume → pausa a Sofia
  async assumir(phone) {
    return this._setAi(phone, 'pause');
  },

  // Devolve o atendimento para a Sofia
  async devolver(phone) {
    return this._setAi(phone, 'active');
  }
};

/* ==========================================================================
   Edge Function — proxy seguro para a Evolution API (multi-tenant)
   ========================================================================== */
async function edgeInvoke(action, payload = {}) {
  const res = await fetch(`${SUPABASE_ROOT_URL}/functions/v1/evolution-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${AUTH_TOKEN || SUPABASE_KEY}`,
    },
    body: JSON.stringify({ action, payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { success: false, error: data.error || `Erro ${res.status}`, detail: data.detail };
  return { success: true, data };
}

/* ==========================================================================
   API de Canais (WhatsApp / Instagram por organização)
   ========================================================================== */
const ChannelsAPI = {
  async list() {
    return supabaseFetch('/channels?order=created_at.asc');
  },
  async createWhatsApp(displayName) {
    return edgeInvoke('create_instance', { display_name: displayName, org_id: CURRENT_ORG?.id });
  },
  async getQr(channelId) {
    return edgeInvoke('get_qr', { channel_id: channelId });
  },
  async status(channelId) {
    return edgeInvoke('status', { channel_id: channelId });
  },
  async disconnect(channelId) {
    return edgeInvoke('disconnect', { channel_id: channelId });
  },
  async remove(channelId) {
    return edgeInvoke('delete_instance', { channel_id: channelId });
  },
};

/* ==========================================================================
   API de Respostas Rápidas
   ========================================================================== */
const QuickRepliesAPI = {
  async list() { return supabaseFetch('/quick_replies?order=shortcut.asc'); },
  async create(shortcut, content) {
    return supabaseFetch('/quick_replies', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: { shortcut, content, org_id: CURRENT_ORG?.id }
    });
  },
  async remove(id) { return supabaseFetch(`/quick_replies?id=eq.${id}`, { method: 'DELETE' }); },
};

/* ==========================================================================
   API do Builder de Automações
   ========================================================================== */
const AutomationsBuilderAPI = {
  async list() { return supabaseFetch('/automations?order=created_at.desc'); },
  async create(automation) {
    return supabaseFetch('/automations', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: { ...automation, org_id: CURRENT_ORG?.id }
    });
  },
  async update(id, updates) {
    return supabaseFetch(`/automations?id=eq.${id}`, { method: 'PATCH', body: updates });
  },
  async remove(id) { return supabaseFetch(`/automations?id=eq.${id}`, { method: 'DELETE' }); },
};

/* ==========================================================================
   API de Equipe (membros da organização)
   ========================================================================== */
const TeamAPI = {
  async list() {
    return supabaseFetch('/org_members?select=user_id,role,display_name&order=created_at.asc');
  },
};

/* ==========================================================================
   Metas & Vendas — métricas reais (RPC) + metas mensais
   ========================================================================== */
const MetasAPI = {
  async monthMetrics(year, month) {
    const r = await supabaseFetch('/rpc/get_month_metrics', {
      method: 'POST', body: { p_org: CURRENT_ORG?.id, p_year: year, p_month: month }
    });
    return r.success ? { success: true, data: r.data } : r;
  },
  async yearSummary(year) {
    const r = await supabaseFetch('/rpc/get_year_summary', {
      method: 'POST', body: { p_org: CURRENT_ORG?.id, p_year: year }
    });
    return r.success ? { success: true, data: r.data } : r;
  },
  async getGoal(year, month) {
    const r = await supabaseFetch(`/crm_goals?org_id=eq.${CURRENT_ORG?.id}&year=eq.${year}&month=eq.${month}&limit=1`);
    return r.success ? { success: true, data: r.data[0] || null } : r;
  },
  async saveGoal(goal) {
    // upsert por (org_id, year, month)
    return supabaseFetch('/crm_goals', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: { ...goal, org_id: CURRENT_ORG?.id }
    });
  }
};

/* ==========================================================================
   Agenda — lê a agenda real do Clinicorp via Edge Function
   ========================================================================== */
const AgendaAPI = {
  async _call(payload) {
    const res = await fetch(`${SUPABASE_ROOT_URL}/functions/v1/clinicorp-agenda`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${AUTH_TOKEN || SUPABASE_KEY}`,
      },
      body: JSON.stringify({ ...payload, org_id: CURRENT_ORG?.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, error: data.error || `Erro ${res.status}` };
    return { success: true, data };
  },
  async clinicorp(from, to) { return this._call({ from, to }); },
  async markAttendance(attendanceId, status) { return this._call({ action: 'mark', attendance_id: attendanceId, status }); },
  async createAppointment(p) { return this._call({ action: 'create', ...p }); },
  async cancelAppointment(clinicorpId) { return this._call({ action: 'cancel', appointment_id: clinicorpId }); }
};

/* ==========================================================================
   Copilot IA — fala com o agente Dify real via Edge Function
   ========================================================================== */
const CopilotAPI = {
  async ask(query, conversationId) {
    const res = await fetch(`${SUPABASE_ROOT_URL}/functions/v1/dify-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${AUTH_TOKEN || SUPABASE_KEY}`,
      },
      body: JSON.stringify({ query, conversation_id: conversationId || '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, error: data.error || `Erro ${res.status}` };
    return { success: true, answer: data.answer, conversationId: data.conversation_id };
  }
};

/* ==========================================================================
   Helpers de Inbox — tags e atribuição de atendente
   ========================================================================== */
const InboxAPI = {
  async setTags(patientId, tags) {
    return supabaseFetch(`/patients?id=eq.${patientId}`, { method: 'PATCH', body: { tags } });
  },
  async assign(patientId, userId) {
    return supabaseFetch(`/patients?id=eq.${patientId}`, { method: 'PATCH', body: { assigned_to: userId || null } });
  },
};

/* ==========================================================================
   Supabase Realtime — push de mensagens/contatos ao vivo (WebSocket)
   Usa o cliente autenticado (RLS aplica isolamento por organização)
   ========================================================================== */
function getRealtimeClient() {
  if (!window.sb) {
    console.warn('supabase-js não carregado — Realtime indisponível, usando polling.');
    return null;
  }
  return window.sb;
}

const RealtimeAPI = {
  // Nova mensagem inserida (inbound da Sofia/paciente ou outbound)
  onNewMessage(callback) {
    const sb = getRealtimeClient();
    if (!sb) return null;
    return sb.channel('rt-crm-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crm_messages' },
        payload => callback(payload.new))
      .subscribe();
  },

  // Novo contato ou mudança de paciente (lead novo entrando)
  onPatientChange(callback) {
    const sb = getRealtimeClient();
    if (!sb) return null;
    return sb.channel('rt-crm-patients')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_patients' },
        payload => callback(payload))
      .subscribe();
  },

  unsubscribe(channel) {
    if (channel && window.sb) window.sb.removeChannel(channel);
  }
};

/* ==========================================================================
   Exportar APIs como globais para uso no app.js
   ========================================================================== */
window.ApexAPI = {
  auth: AuthAPI,
  patients: PatientsAPI,
  pipeline: PipelineAPI,
  messages: MessagesAPI,
  appointments: AppointmentsAPI,
  automations: AutomationsAPI,
  automationsBuilder: AutomationsBuilderAPI,
  channels: ChannelsAPI,
  quickReplies: QuickRepliesAPI,
  team: TeamAPI,
  inbox: InboxAPI,
  copilot: CopilotAPI,
  metas: MetasAPI,
  agenda: AgendaAPI,
  chatControl: ChatControlAPI,
  realtime: RealtimeAPI,
  startMessagePolling,
  stopMessagePolling,
  // Helper para atualizar URLs de conexão na interface
  updateConfig(n8nUrl, evolutionUrl, evolutionKey, evolutionInstance) {
    if (n8nUrl) {
      localStorage.setItem('clinprime_n8n_url', n8nUrl);
      N8N_BASE_URL = n8nUrl;
    }
    if (evolutionUrl) localStorage.setItem('clinprime_evolution_url', evolutionUrl);
    if (evolutionKey) localStorage.setItem('clinprime_evolution_key', evolutionKey);
    if (evolutionInstance) localStorage.setItem('clinprime_evolution_instance', evolutionInstance);
  }
};

console.log('🔌 Apex Odonto CRM — Serverless API Client conectado diretamente ao Supabase Online!');
