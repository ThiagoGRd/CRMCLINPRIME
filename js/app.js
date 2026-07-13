/* ==========================================================================
   Apex Odonto CRM - Lógica da Aplicação (Conexão Supabase + n8n + Evolution)
   ========================================================================== */

// Estado Global da Aplicação
let state = {
  leads: [],
  meetings: [],
  activeChatLeadId: null,
  activeChannel: 'whatsapp',
  calendarDate: new Date(),
  // Regras de Automação (DKW System Triggers) mapeadas para o Supabase
  automationRules: {
    stage: { id: null, active: true, action: 'whatsapp' },
    stale: { id: null, active: true, action: 'whatsapp_reengage' },
    created: { id: null, active: true, action: 'whatsapp_welcome' },
    value: { id: null, active: true, action: 'notify_director' },
    task: { id: null, active: true, action: 'promote_lead' }
  }
};

// Mapeamentos de Estágios: construídos DINAMICAMENTE a partir das etapas da organização
// (cada cliente tem suas próprias etapas no crm_pipeline_stages)
let STAGE_MAP = {};
let STAGE_REV_MAP = {};
let ORG_STAGES = []; // etapas reais do funil (crm_pipeline_stages), ordenadas por position

function buildStageMaps(stages) {
  const buckets = ['lead', 'contacted', 'proposal', 'negotiating', 'won', 'concluded'];
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  STAGE_MAP = {}; STAGE_REV_MAP = {};
  sorted.forEach((s, i) => {
    const key = buckets[Math.min(i, buckets.length - 1)];
    if (!STAGE_MAP[key]) STAGE_MAP[key] = s.id;
    STAGE_REV_MAP[s.id] = key;
  });
}

// Inicialização da Aplicação — exige login (SaaS)
document.addEventListener("DOMContentLoaded", async () => {
  initAuthScreen();
  const session = await window.ApexAPI.auth.getSession();
  if (session) {
    await bootApp();
  }
  // sem sessão: a tela de login (já visível) cuida do resto
});

async function bootApp() {
  const org = await window.ApexAPI.auth.loadMyOrg();
  if (!org) {
    showToast("Não foi possível carregar sua organização.", "danger");
    return;
  }

  // Identidade do usuário logado (para filtros "Minhas" e atribuição)
  try {
    const { data: { session } } = await window.sb.auth.getSession();
    state.myUserId = session?.user?.id || null;
    // Autentica o WebSocket do Realtime ANTES de subscrever (RLS exige o JWT)
    if (session?.access_token && window.sb.realtime) {
      window.sb.realtime.setAuth(session.access_token);
    }
  } catch (e) { state.myUserId = null; }

  // Membros da equipe (para o select de atribuição)
  try {
    const teamRes = await window.ApexAPI.team.list();
    state.teamMembers = teamRes.success ? teamRes.data : [];
  } catch (e) { state.teamMembers = []; }

  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("app-wrapper").style.display = "";
  renderSidebarUser(org);

  await refreshState();

  initSidebar();
  initLeadsTable();
  initKanban();
  initCharts();
  initChat();
  initAutomation();
  initCalendar();
  initAIWidget();
  initModals();
  initAutomationRulesUI();
  initAPIConfigUI();
  initConnections();
  initInboxPro();
  initAutomationBuilder();
  initMetas();
}

/* ==========================================================================
   Tela de Login / Cadastro
   ========================================================================== */
function initAuthScreen() {
  const tabLogin = document.getElementById("auth-tab-login");
  const tabSignup = document.getElementById("auth-tab-signup");
  const orgGroup = document.getElementById("auth-org-group");
  const form = document.getElementById("form-auth");
  const submitBtn = document.getElementById("btn-auth-submit");
  const errorBox = document.getElementById("auth-error");
  let mode = "login";

  function setMode(m) {
    mode = m;
    const active = "flex:1; background:none; border:none; color:var(--text-white); padding:10px; font-weight:700; border-bottom:2px solid var(--color-primary); cursor:pointer;";
    const inactive = "flex:1; background:none; border:none; color:var(--text-muted); padding:10px; font-weight:600; border-bottom:2px solid transparent; cursor:pointer;";
    tabLogin.style.cssText = m === "login" ? active : inactive;
    tabSignup.style.cssText = m === "signup" ? active : inactive;
    orgGroup.style.display = m === "signup" ? "" : "none";
    submitBtn.textContent = m === "login" ? "Entrar" : "Criar conta grátis";
    errorBox.style.display = "none";
  }
  tabLogin.addEventListener("click", () => setMode("login"));
  tabSignup.addEventListener("click", () => setMode("signup"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.textContent = "Aguarde...";
    try {
      const email = document.getElementById("auth-email").value.trim();
      const password = document.getElementById("auth-password").value;
      let res;
      if (mode === "signup") {
        const orgName = document.getElementById("auth-org").value.trim() || "Minha Empresa";
        res = await window.ApexAPI.auth.signUp(email, password, orgName);
      } else {
        res = await window.ApexAPI.auth.signIn(email, password);
      }
      if (!res.success) {
        errorBox.textContent = res.error === "Invalid login credentials" ? "E-mail ou senha incorretos." : res.error;
        errorBox.style.display = "";
        return;
      }
      await bootApp();
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "login" ? "Entrar" : "Criar conta grátis";
    }
  });
}

function renderSidebarUser(org) {
  const name = org.displayName || "Usuário";
  document.getElementById("sidebar-user-name").textContent = name;
  document.getElementById("sidebar-org-name").textContent = org.name || "";
  document.getElementById("sidebar-user-avatar").textContent = name.substring(0, 2).toUpperCase();
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout && !btnLogout.dataset.bound) {
    btnLogout.dataset.bound = "1";
    btnLogout.addEventListener("click", () => window.ApexAPI.auth.signOut());
  }
}

// Sincronizar estado com o Banco de Dados Real (Substitui o localStorage antigo)
async function refreshState() {
  if (!window.ApexAPI) {
    console.error("Camada de API Client (api-client.js) não foi carregada.");
    return;
  }

  try {
    // 0. Carregar etapas da organização e montar o mapa dinâmico do kanban
    try {
      const stagesRes = await window.ApexAPI.pipeline.getStages();
      if (stagesRes.success && stagesRes.data.length) {
        ORG_STAGES = [...stagesRes.data].sort((a, b) => a.position - b.position);
        buildStageMaps(stagesRes.data);
      }
    } catch (e) { console.warn('Falha ao carregar etapas:', e.message); }

    // 1. Carregar Pacientes
    const patientsRes = await window.ApexAPI.patients.getAll();
    if (patientsRes.success) {
      state.leads = patientsRes.data.map(p => {
        // Preserva o histórico de mensagens e mensagens não-lidas já em memória para evitar que sumam no refresh/realtime
        const existingLead = state.leads ? state.leads.find(l => l.id === p.id) : null;
        
        return {
          id: p.id,
          name: p.name,
          email: p.email || '',
          phone: formatPhoneDisplay(p.phone),
          phoneRaw: p.phone, // telefone cru (com código do país) para casar com a tabela chats
          tags: p.tags || [],
          assignedTo: p.assigned_to || null,
          channel: p.channel || 'whatsapp',
          createdAt: p.created_at,
          lastMessageAt: p.last_message_at || p.created_at,
          value: parseFloat(p.treatment_value || 0),
          stage: STAGE_REV_MAP[p.deal?.[0]?.stage_id || p.deal?.stage_id] || 'lead',
          stageId: p.deal?.[0]?.stage_id || p.deal?.stage_id || null, // etapa real (id) no funil
          notes: p.notes || '',
          source: p.treatment_interest || p.source || 'Geral',
          ccStatus: p.clinicorp_status || null,       // status real no Clinicorp (APPROVED/OPEN/FOLLOWUP/REJECTED)
          ccAmount: parseFloat(p.clinicorp_amount || 0),
          ccCount: p.clinicorp_est_count || 0,
          unread: existingLead ? existingLead.unread : 0,
          messages: existingLead ? existingLead.messages : [] // Preserva as mensagens carregadas sob demanda
        };
      });
    }

    // 2. Carregar Consultas
    const meetingsRes = await window.ApexAPI.appointments.getAll();
    if (meetingsRes.success) {
      state.meetings = meetingsRes.data.map(m => {
        const dateObj = new Date(m.scheduled_at);
        const y = dateObj.getFullYear();
        const mo = String(dateObj.getMonth() + 1).padStart(2, '0');
        const d = String(dateObj.getDate()).padStart(2, '0');
        const h = String(dateObj.getHours()).padStart(2, '0');
        const mi = String(dateObj.getMinutes()).padStart(2, '0');
        
        return {
          id: m.id,
          title: m.title,
          leadId: m.patient_id,
          date: `${y}-${mo}-${d}`,
          time: `${h}:${mi}`,
          dateObj: m.scheduled_at
        };
      });
    }

    // 3. Carregar Regras de Automação
    const rulesRes = await window.ApexAPI.automations.getRules();
    if (rulesRes.success) {
      rulesRes.data.forEach(rule => {
        let key = null;
        if (rule.trigger_type === 'stage_change') key = 'stage';
        else if (rule.trigger_type === 'lead_stale') key = 'stale';
        else if (rule.trigger_type === 'new_lead') key = 'created';
        else if (rule.trigger_type === 'value_change') key = 'value';
        else if (rule.trigger_type === 'task_completed') key = 'task';

        if (key) {
          state.automationRules[key] = {
            id: rule.id,
            active: rule.is_active,
            action: rule.action_type,
            config: rule.config
          };
        }
      });
    }

    updateDashboardKPIs();
    renderRecentActivity();
  } catch (err) {
    console.error("Erro de sincronização de estado:", err);
    showToast("Falha na sincronização. Verifique se o backend está rodando.", "danger");
  }
}

// Sidebar & Navegação
function initSidebar() {
  const navItems = document.querySelectorAll(".nav-item");
  const panels = document.querySelectorAll(".content-panel");
  const headerTitle = document.getElementById("header-active-title");

  navItems.forEach(item => {
    item.addEventListener("click", async () => {
      const panelId = item.getAttribute("data-panel");
      
      navItems.forEach(nav => nav.classList.remove("active"));
      panels.forEach(panel => panel.classList.remove("active"));
      
      item.classList.add("active");
      
      const targetPanel = document.getElementById(`panel-${panelId}`);
      if (targetPanel) {
        targetPanel.classList.add("active");
      }
      
      headerTitle.textContent = item.textContent.trim();
      
      // Sempre atualizar o estado ao navegar para manter os dados atualizados
      await refreshState();
      
      if (panelId === 'dashboard') {
        initCharts();
      } else if (panelId === 'pipeline') {
        initKanban();
      } else if (panelId === 'contacts') {
        initLeadsTable();
      } else if (panelId === 'calendar') {
        loadClinicorpAgenda();
      } else if (panelId === 'chat') {
        renderChatList();
        renderActiveChat();
      } else if (panelId === 'connections') {
        renderChannelsList();
      } else if (panelId === 'automation') {
        renderAutomationsList();
      } else if (panelId === 'metas') {
        renderMetas();
      } else if (panelId === 'followup') {
        renderFollowup();
      }
    });
  });
}

// ==========================================================================
// Dashboard KPIs & Charts
// ==========================================================================
let salesChartInstance = null;

function updateDashboardKPIs() {
  const wonLeads = state.leads.filter(l => l.stage === 'won');
  const activeLeads = state.leads.filter(l => l.stage !== 'won');
  
  const totalRevenue = wonLeads.reduce((acc, l) => acc + parseFloat(l.value || 0), 0);
  document.getElementById("kpi-revenue").textContent = formatCurrency(totalRevenue);
  
  document.getElementById("kpi-leads").textContent = activeLeads.length;
  
  const totalLeads = state.leads.length;
  const conversionRate = totalLeads > 0 ? (wonLeads.length / totalLeads) * 100 : 0;
  document.getElementById("kpi-conversion").textContent = `${conversionRate.toFixed(1)}%`;
  
  const averageTicket = wonLeads.length > 0 ? totalRevenue / wonLeads.length : 0;
  document.getElementById("kpi-ticket").textContent = formatCurrency(averageTicket);

  // Tendências REAIS calculadas dos dados (substitui textos decorativos)
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const newThisWeek = state.leads.filter(l => l.createdAt && (now - new Date(l.createdAt).getTime()) < weekMs).length;
  const meetingsAhead = state.meetings.filter(m => m.dateObj && new Date(m.dateObj).getTime() > now).length;

  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set("kpi-revenue-trend", wonLeads.length ? `${wonLeads.length} tratamentos fechados` : "nenhum fechamento ainda");
  set("kpi-leads-trend", `+${newThisWeek} novos esta semana`);
  set("kpi-conversion-trend", `${wonLeads.length} de ${totalLeads || 0} contatos`);
  set("kpi-ticket-trend", meetingsAhead ? `${meetingsAhead} consultas agendadas` : "agenda livre");
}

// Agrupa os leads em 6 semanas reais a partir dos dados carregados
function computeWeeklySeries() {
  const weeks = 6;
  const now = new Date();
  const labels = [], novos = [], fechados = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = new Date(now); end.setDate(now.getDate() - i * 7);
    const start = new Date(end); start.setDate(end.getDate() - 7);
    labels.push(i === 0 ? 'Esta semana' : `${weeks - i}ª sem`);
    const inWeek = (d) => d && new Date(d) > start && new Date(d) <= end;
    novos.push(state.leads.filter(l => inWeek(l.createdAt)).length);
    fechados.push(state.leads.filter(l => l.stage === 'won' && inWeek(l.createdAt)).length);
  }
  return { labels, novos, fechados };
}

function initCharts() {
  const ctx = document.getElementById('salesChart');
  if (!ctx) return;
  
  if (salesChartInstance) {
    salesChartInstance.destroy();
  }
  
  // Série REAL: contatos novos e fechamentos por semana (últimas 6 semanas)
  const { labels, novos, fechados } = computeWeeklySeries();

  salesChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Contatos novos',
          data: novos,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.06)',
          borderWidth: 3,
          fill: true,
          tension: 0.4
        },
        {
          label: 'Tratamentos fechados',
          data: fechados,
          borderColor: '#10b981',
          backgroundColor: 'transparent',
          borderWidth: 2,
          fill: false,
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: '#9ca3af',
            font: { family: 'Inter', size: 12 }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#9ca3af', font: { family: 'Inter' } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { 
            color: '#9ca3af', 
            font: { family: 'Inter' },
            callback: value => 'R$ ' + value / 1000 + 'k'
          }
        }
      }
    }
  });
}

async function renderRecentActivity() {
  const container = document.getElementById("recent-activity-list");
  if (!container) return;
  
  try {
    const res = await window.ApexAPI.automations.getActivityLog(10);
    if (!res.success) return;
    
    container.innerHTML = "";
    
    if (res.data.length === 0) {
      container.innerHTML = `<div style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 16px;">Nenhuma atividade recente registrada.</div>`;
      return;
    }
    
    res.data.forEach(act => {
      let circleColor = 'var(--color-primary)';
      let text = '';
      
      const pacName = act.patient?.name || 'Paciente';
      
      if (act.action === 'patient_created') {
        circleColor = 'var(--color-primary)';
        text = `Nova ficha criada para o paciente <b>${pacName}</b> (Origem: ${act.details.source || 'manual'}).`;
      } else if (act.action === 'stage_moved') {
        circleColor = 'var(--color-warning)';
        text = `Paciente <b>${pacName}</b> movido de <i>${act.details.from_stage}</i> para <b>${act.details.to_stage}</b>.`;
      } else if (act.action === 'message_sent') {
        circleColor = 'var(--color-success)';
        text = `Mensagem WhatsApp enviada para <b>${pacName}</b>: "${act.details.content.substring(0, 40)}..."`;
      } else if (act.action === 'message_received') {
        circleColor = '#ff7675';
        text = `Mensagem recebida de <b>${pacName}</b>: "${act.details.content.substring(0, 40)}..."`;
      } else if (act.action === 'value_updated') {
        circleColor = '#ffeaa7';
        text = `Valor de tratamento do paciente <b>${pacName}</b> atualizado para ${formatCurrency(act.details.new_value)}.`;
      } else {
        circleColor = 'var(--text-muted)';
        text = `Evento [${act.action}] executado para o paciente <b>${pacName}</b>.`;
      }
      
      const timeStr = formatRelativeTime(act.created_at);
      
      container.innerHTML += `
        <div class="activity-item">
          <div class="activity-circle" style="background-color: ${circleColor}; box-shadow: 0 0 8px ${circleColor};"></div>
          <div class="activity-desc">${text}</div>
          <div class="activity-time">${timeStr}</div>
        </div>
      `;
    });
  } catch (err) {
    console.error("Erro ao renderizar atividades:", err);
  }
}

// ==========================================================================
// Funil de Tratamentos (Kanban Board)
// ==========================================================================

// Badge do status REAL no Clinicorp — avisa quando o lead já tem orçamento feito/aprovado
const CC_BADGE = {
  APPROVED: { label: '✓ Orçamento aprovado', bg: 'rgba(16,185,129,.15)', fg: '#10b981' },
  FOLLOWUP: { label: '↻ Orçamento em follow-up', bg: 'rgba(245,158,11,.15)', fg: '#f59e0b' },
  OPEN:     { label: '• Orçamento em aberto', bg: 'rgba(59,130,246,.15)', fg: '#3b82f6' },
  REJECTED: { label: '✕ Orçamento reprovado', bg: 'rgba(148,163,184,.15)', fg: '#94a3b8' },
};
function clinicorpBadge(lead) {
  const info = lead.ccStatus && CC_BADGE[lead.ccStatus];
  if (!info) return '';
  const val = lead.ccAmount ? ' · ' + formatCurrency(lead.ccAmount) : '';
  const extra = lead.ccCount > 1 ? ` (${lead.ccCount})` : '';
  return `<div class="cc-badge" title="Status real no Clinicorp" style="display:inline-flex;align-items:center;gap:4px;margin-top:6px;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;background:${info.bg};color:${info.fg};">${info.label}${val}${extra}</div>`;
}

// Kanban DINÂMICO: uma coluna por etapa real do funil (crm_pipeline_stages).
// Evita o desalinhamento entre etapas do banco (7) e colunas fixas (5).
const STAGE_DOTS = ['badge-primary', 'badge-warning', 'badge-primary', 'badge-warning', 'badge-warning', 'badge-success', 'badge-success'];
let funnelMonth = 'all'; // filtro mensal do funil (por created_at do lead)

function populateFunnelMonths() {
  const sel = document.getElementById('funnel-month');
  if (!sel) return;
  const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const months = [...new Set(state.leads.map(l => (l.createdAt || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  const cur = sel.value || 'all';
  sel.innerHTML = '<option value="all">Todos os meses</option>' + months.map(m => {
    const [y, mm] = m.split('-');
    return `<option value="${m}">${MES[parseInt(mm, 10) - 1]}/${y}</option>`;
  }).join('');
  sel.value = cur;
  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => { funnelMonth = sel.value; initKanban(); });
  }
}

// Ficha do paciente (modal de leitura + botão WhatsApp), aberta ao clicar no nome
window.openPatientFicha = function(id) {
  const lead = state.leads.find(l => l.id === id);
  if (!lead) return;
  const esc = (s) => (s == null ? '' : String(s)).replace(/</g, '&lt;');
  document.getElementById('ficha-title').textContent = lead.name || 'Ficha do Paciente';

  // botão Atender — abre a conversa no Multiatendimento
  const waBtn = document.getElementById('ficha-wa-btn');
  waBtn.style.display = '';
  waBtn.removeAttribute('href');
  waBtn.style.cursor = 'pointer';
  waBtn.onclick = (e) => { e.preventDefault(); openInboxForLead(id); };

  const cc = lead.ccStatus && CC_BADGE[lead.ccStatus];
  const ccLine = cc
    ? `<span style="color:${cc.fg};font-weight:600;">${cc.label}${lead.ccAmount ? ' · ' + formatCurrency(lead.ccAmount) : ''}</span>`
    : '<span style="color:var(--text-muted);">Sem orçamento no Clinicorp</span>';
  const stageName = (ORG_STAGES.find(s => s.id === lead.stageId) || {}).name || (ORG_STAGES[0] && ORG_STAGES[0].name) || '—';
  const row = (label, val) => val ? `<div style="display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05);"><span style="color:var(--text-muted);font-size:13px;">${label}</span><span style="font-size:13px;text-align:right;">${val}</span></div>` : '';

  document.getElementById('ficha-body').innerHTML =
    row('Telefone', esc(lead.phone)) +
    row('Etapa no funil', esc(stageName)) +
    row('Status Clinicorp', ccLine) +
    row('Interesse / Tratamento', esc(lead.source)) +
    row('Origem', esc(lead.channel)) +
    row('Etiquetas', (lead.tags || []).map(esc).join(', ')) +
    row('Entrou em', lead.createdAt ? new Date(lead.createdAt).toLocaleDateString('pt-BR') : '') +
    (lead.notes ? `<div style="margin-top:14px;"><div style="color:var(--text-muted);font-size:13px;margin-bottom:6px;">Anotações</div><div style="font-size:13px;line-height:1.5;background:var(--bg-tertiary);padding:12px;border-radius:8px;">${esc(lead.notes)}</div></div>` : '');

  document.getElementById('ficha-edit-btn').onclick = () => { closeModal('modal-patient-ficha'); openEditLeadModal(id); };
  openModal('modal-patient-ficha');
};

function initKanban() {
  const board = document.getElementById('kanban-board');
  if (!board) return;
  if (!ORG_STAGES.length) return; // etapas ainda não carregadas
  populateFunnelMonths();
  const firstId = ORG_STAGES[0].id;
  board.innerHTML = '';

  // aplica o filtro mensal (por mês de entrada do lead)
  const src = funnelMonth === 'all'
    ? state.leads
    : state.leads.filter(l => (l.createdAt || '').slice(0, 7) === funnelMonth);

  ORG_STAGES.forEach((s, idx) => {
    // lead sem deal cai na primeira etapa; senão, na etapa real do seu deal
    const stageLeads = src.filter(l => (l.stageId || firstId) === s.id);
    const totalVal = stageLeads.reduce((acc, l) => acc + (parseFloat(l.value || 0) || parseFloat(l.ccAmount || 0) || 0), 0);

    const col = document.createElement('div');
    col.className = 'kanban-column';
    col.dataset.stage = s.id;
    col.innerHTML = `
      <div class="column-header">
        <span class="column-title"><span class="badge ${STAGE_DOTS[Math.min(idx, STAGE_DOTS.length - 1)]}">●</span> ${s.name}</span>
        <span class="column-count">${stageLeads.length}</span>
      </div>
      <span class="column-value">${formatCurrency(totalVal)}</span>
      <div class="nav-divider" style="margin: 8px 0;"></div>
      <div class="column-cards-wrapper" ondragover="allowDrop(event)" ondrop="drop(event, '${s.id}')"></div>`;
    const wrapper = col.querySelector('.column-cards-wrapper');

    // Renderiza no máximo RENDER_CAP cards por coluna (a contagem no header é a real)
    const RENDER_CAP = 250;
    const toRender = stageLeads.slice(0, RENDER_CAP);
    toRender.forEach(lead => {
      const card = document.createElement('div');
      card.className = 'kanban-card' + (lead.ccStatus === 'APPROVED' ? ' kanban-card-cc-alert' : '');
      card.draggable = true;
      card.id = lead.id;
      card.addEventListener('dragstart', dragStart);
      card.addEventListener('dragend', dragEnd);
      const val = parseFloat(lead.value || 0) || parseFloat(lead.ccAmount || 0) || 0;
      card.innerHTML = `
        <div class="kanban-card-title">${lead.name}</div>
        <span class="kanban-card-tag">${lead.source}</span>
        ${clinicorpBadge(lead)}
        <div class="kanban-card-meta">
          <span class="kanban-card-value">${formatCurrency(val)}</span>
          <span>${lead.phone}</span>
        </div>`;
      const titleEl = card.querySelector('.kanban-card-title');
      if (titleEl) {
        titleEl.style.cursor = 'pointer';
        titleEl.addEventListener('click', (e) => { e.stopPropagation(); openPatientFicha(lead.id); });
      }
      card.addEventListener('dblclick', () => openEditLeadModal(lead.id));
      wrapper.appendChild(card);
    });
    if (stageLeads.length > RENDER_CAP) {
      const more = document.createElement('div');
      more.style.cssText = 'padding:10px; text-align:center; color:var(--text-muted); font-size:12px;';
      more.textContent = `+${stageLeads.length - RENDER_CAP} lead(s) — use a busca em Pacientes`;
      wrapper.appendChild(more);
    }
    board.appendChild(col);
  });
}

let draggedCardId = null;

function dragStart(e) {
  draggedCardId = e.target.id;
  e.target.classList.add("dragging");
}

function dragEnd(e) {
  e.target.classList.remove("dragging");
}

window.allowDrop = function(e) {
  e.preventDefault();
}

window.drop = async function(e, targetStageId) {
  e.preventDefault();
  if (!draggedCardId) return;

  const lead = state.leads.find(l => l.id === draggedCardId);
  const stageName = (ORG_STAGES.find(s => s.id === targetStageId) || {}).name || '';
  if (lead && lead.stageId !== targetStageId) {
    try {
      const pipelineRes = await window.ApexAPI.pipeline.getAll();
      if (pipelineRes.success) {
        let dealId = null;
        pipelineRes.data.forEach(st => st.deals.forEach(d => { if (d.patient_id === draggedCardId) dealId = d.id; }));

        if (dealId) {
          const moveRes = await window.ApexAPI.pipeline.moveDeal(dealId, targetStageId);
          if (moveRes.success) {
            showToast(`Paciente "${lead.name}" movido para: ${stageName}!`, 'success');
            await refreshState();
            initKanban();
          }
        } else {
          // Lead ainda sem deal (ex.: importado): cria o deal já na etapa de destino
          const created = await window.ApexAPI.pipeline.createDeal(draggedCardId, targetStageId);
          if (created && created.success) {
            showToast(`Paciente "${lead.name}" movido para: ${stageName}!`, 'success');
            await refreshState();
            initKanban();
          } else {
            showToast("Não foi possível mover: deal não encontrado.", "warning");
          }
        }
      }
    } catch (err) {
      console.error(err);
      showToast("Erro ao mover paciente no servidor.", "danger");
    }
  }
  draggedCardId = null;
}

// ==========================================================================
// Tabela de Pacientes
// ==========================================================================
function initLeadsTable() {
  const tableBody = document.getElementById("leads-table-body");
  const searchInput = document.getElementById("search-leads");
  const filterStage = document.getElementById("filter-stage");
  
  if (!tableBody) return;
  
  const renderTable = (filteredLeads) => {
    tableBody.innerHTML = "";
    
    if (filteredLeads.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px;">
            Nenhum paciente encontrado com os filtros atuais.
          </td>
        </tr>
      `;
      return;
    }
    
    filteredLeads.forEach(lead => {
      const tr = document.createElement("tr");
      const initials = lead.name.split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase();
      const stageBadge = getStageBadge(lead.stage);
      
      tr.innerHTML = `
        <td>
          <div class="lead-name-cell">
            <div class="lead-initials">${initials}</div>
            <div>
              <div style="font-weight: 600; color: var(--text-white);">${lead.name}</div>
              <div style="font-size: 11px; color: var(--text-muted);">Ficha: ${lead.id}</div>
            </div>
          </div>
        </td>
        <td>${lead.email || '—'}</td>
        <td>${lead.phone}</td>
        <td style="font-weight: 600; color: var(--color-success);">${formatCurrency(lead.value)}</td>
        <td>${stageBadge}</td>
        <td><span class="badge badge-primary" style="background-color:rgba(16, 185, 129, 0.1); color:#10b981">${lead.source}</span></td>
        <td>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="openEditLeadModal('${lead.id}')">Editar</button>
            <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; border-color: rgba(239, 68, 68, 0.2); color: var(--color-danger);" onclick="deleteLead('${lead.id}')">Excluir</button>
          </div>
        </td>
      `;
      tableBody.appendChild(tr);
    });
  };
  
  const applyFilters = () => {
    const query = searchInput.value.toLowerCase();
    const stage = filterStage.value;
    
    const filtered = state.leads.filter(lead => {
      const matchesSearch = lead.name.toLowerCase().includes(query) || 
                            (lead.email && lead.email.toLowerCase().includes(query)) || 
                            lead.phone.includes(query);
      const matchesStage = stage === 'all' || lead.stage === stage;
      return matchesSearch && matchesStage;
    });
    
    renderTable(filtered);
  };
  
  searchInput.addEventListener("input", applyFilters);
  filterStage.addEventListener("change", applyFilters);
  
  renderTable(state.leads);
}

window.deleteLead = async function(id) {
  if (confirm("Tem certeza de que deseja excluir a ficha deste paciente?")) {
    try {
      const res = await window.ApexAPI.patients.remove(id);
      if (res.success) {
        showToast("Paciente excluído com sucesso.", "info");
        await refreshState();
        initLeadsTable();
        initKanban();
        renderChatList();
      }
    } catch (err) {
      showToast("Erro ao excluir paciente: " + err.message, "danger");
    }
  }
}

// ==========================================================================
// Multiatendimento (Chat)
// ==========================================================================
function initChat() {
  const channelTabs = document.querySelectorAll(".channel-tab");
  const chatListContainer = document.getElementById("chat-list-container");
  const messageInput = document.getElementById("chat-message-input");
  const btnSend = document.getElementById("btn-send-message");
  const btnSuggestAI = document.getElementById("btn-generate-script");
  const btnChatSchedule = document.getElementById("btn-chat-schedule");
  
  if (!chatListContainer) return;
  
  channelTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      channelTabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeChannel = tab.getAttribute("data-channel");
      renderChatList();
    });
  });
  
  messageInput.addEventListener("keypress", (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });
  
  btnSend.addEventListener("click", sendChatMessage);
  if (btnSuggestAI) btnSuggestAI.addEventListener("click", generateIAScript);
  btnChatSchedule.addEventListener("click", openScheduleModalFromChat);

  // Botão Assumir / Devolver atendimento (controla a Sofia)
  const btnToggleAi = document.getElementById("btn-toggle-ai");
  if (btnToggleAi) btnToggleAi.addEventListener("click", toggleAiAtendimento);

  renderChatList();

  // ⚡ Supabase Realtime — push instantâneo de mensagens e novos contatos
  initRealtime();

  // Polling de 8s como FALLBACK (caso o WebSocket caia). Realtime é o canal principal.
  setInterval(async () => {
    const chatPanel = document.getElementById("panel-chat");
    if (chatPanel && chatPanel.classList.contains("active")) {
      await refreshState();
      renderChatList();
      if (state.activeChatLeadId) {
        try {
          const res = await window.ApexAPI.messages.getHistory(state.activeChatLeadId);
          if (res.success) {
            const lead = state.leads.find(l => l.id === state.activeChatLeadId);
            if (lead) {
              lead.messages = res.data.map(mapDbMessage);
              renderActiveChat();
            }
          }
        } catch (err) {
          console.warn("Falha no polling silencioso do chat ativo:", err.message);
        }
      }
    }
  }, 8000);
}

// ==========================================================================
// Realtime — recebe mensagens e novos contatos ao vivo (WebSocket)
// ==========================================================================
function initRealtime() {
  if (!window.ApexAPI.realtime) return;

  // Reassina os canais se a conexão cair/reconectar (token expira, wifi etc.)
  if (window.sb?.realtime) {
    window.sb.realtime.onClose?.(() => console.warn("Realtime desconectado — reconectando..."));
  }

  // Nova mensagem chegou/saiu em qualquer conversa
  window.ApexAPI.realtime.onNewMessage(async (msg) => {
    const lead = state.leads.find(l => l.id === msg.patient_id);

    if (lead) {
      // Conversa já existe na memória: anexa a bolha
      const bubble = mapDbMessage(msg);
      lead.messages = lead.messages || [];
      // Evita duplicar (Realtime + feedback otimista do envio)
      const dup = lead.messages.some(m => m.text === bubble.text && m.sender === bubble.sender);
      if (!dup) lead.messages.push(bubble);

      // Bump: conversa sobe pro topo da lista
      lead.lastMessageAt = msg.created_at || new Date().toISOString();

      if (state.activeChatLeadId === lead.id) {
        renderActiveChat(); // já faz autoscroll pro fim
      } else if (msg.direction === 'inbound') {
        lead.unread = (lead.unread || 0) + 1;
        notifyNewMessage(lead.name, msg.content);
      }
      renderChatList();
    } else {
      // Paciente ainda não está na memória (lead novo): recarrega a base
      await refreshState();
      renderChatList();
    }
  });

  // Novo contato entrando ou atualização de contato (lead novo via WhatsApp / status de RLS / trigger de bot)
  window.ApexAPI.realtime.onPatientChange(async (payload) => {
    await refreshState();
    renderChatList();
    if (state.activeChatLeadId) {
      renderActiveChat();
    }
    if (typeof updateDashboardKPIs === "function") updateDashboardKPIs();
  });

  console.log('⚡ Realtime conectado — mensagens ao vivo ativadas.');
}

function notifyNewMessage(name, text) {
  showToast(`💬 ${name}: ${text.substring(0, 60)}`, "info");
}

// ==========================================================================
// Controle de Atendimento: Assumir (pausa Sofia) / Devolver (reativa Sofia)
// ==========================================================================
async function toggleAiAtendimento() {
  const lead = state.leads.find(l => l.id === state.activeChatLeadId);
  if (!lead) return;

  const btn = document.getElementById("btn-toggle-ai");
  const currentlyActive = btn?.dataset.iaActive === "true";

  btn.disabled = true;
  try {
    if (currentlyActive) {
      // IA está ativa → humano assume (pausa Sofia)
      const res = await window.ApexAPI.chatControl.assumir(lead.phoneRaw || lead.phone);
      if (res.success) {
        showToast(`👤 Você assumiu o atendimento de ${lead.name}. A Sofia foi pausada.`, "success");
        updateAiControls(false);
      } else {
        showToast("Não foi possível pausar a Sofia (contato sem conversa ativa ainda).", "warning");
      }
    } else {
      // Humano estava atendendo → devolve para a Sofia
      const res = await window.ApexAPI.chatControl.devolver(lead.phoneRaw || lead.phone);
      if (res.success) {
        showToast(`🤖 Atendimento devolvido para a Sofia.`, "success");
        updateAiControls(true);
      }
    }
  } catch (err) {
    showToast("Erro ao alternar atendimento: " + err.message, "danger");
  } finally {
    btn.disabled = false;
  }
}

function updateAiControls(iaActive) {
  const badge = document.getElementById("chat-ai-badge");
  const btn = document.getElementById("btn-toggle-ai");
  if (!badge || !btn) return;

  badge.style.display = "inline-flex";
  btn.style.display = "inline-flex";
  btn.dataset.iaActive = iaActive ? "true" : "false";

  if (iaActive) {
    badge.textContent = "🤖 Sofia atendendo";
    badge.style.backgroundColor = "rgba(108, 92, 231, 0.18)";
    badge.style.color = "#a29bfe";
    btn.textContent = "Assumir atendimento";
    btn.className = "btn btn-sm btn-primary";
  } else {
    badge.textContent = "👤 Você atendendo";
    badge.style.backgroundColor = "rgba(16, 185, 129, 0.18)";
    badge.style.color = "#10b981";
    btn.textContent = "Devolver p/ Sofia";
    btn.className = "btn btn-sm btn-secondary";
  }
}

function hideAiControls() {
  const badge = document.getElementById("chat-ai-badge");
  const btn = document.getElementById("btn-toggle-ai");
  if (badge) badge.style.display = "none";
  if (btn) btn.style.display = "none";
}

function renderChatList() {
  const container = document.getElementById("chat-list-container");
  if (!container) return;

  container.innerHTML = "";

  // Busca + filtros (Todas / Minhas / Sem dono)
  const search = (state.chatSearch || '').toLowerCase();
  const filter = state.chatFilter || 'all';
  let list = state.leads;
  if (search) list = list.filter(l => l.name.toLowerCase().includes(search) || (l.phoneRaw || '').includes(search.replace(/\D/g, '') || '___'));
  if (filter === 'mine') list = list.filter(l => l.assignedTo === state.myUserId);
  if (filter === 'unassigned') list = list.filter(l => !l.assignedTo);

  // Conversa mais recente sempre no topo
  list = [...list].sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

  if (list.length === 0) {
    container.innerHTML = `<div style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">Nenhuma conversa encontrada.</div>`;
    return;
  }

  list.forEach(lead => {
    const activeClass = state.activeChatLeadId === lead.id ? 'active' : '';
    const lastMsg = lead.messages && lead.messages.length > 0
      ? lead.messages[lead.messages.length - 1].text
      : "Clique para abrir o chat";
    const initials = lead.name.split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase();

    const channelIcon = lead.channel === 'instagram' ? '📸' : '💬';
    const badgeColor = lead.channel === 'instagram' ? '#e1306c' : '#10b981';

    const tagsMarkup = (lead.tags || []).slice(0, 3).map(t =>
      `<span style="font-size:9px; padding:1px 6px; border-radius:8px; background:rgba(108,92,231,.25); color:#a29bfe;">${t}</span>`
    ).join(' ');

    const unreadMarkup = lead.unread > 0
      ? `<span class="badge badge-danger" style="margin-left:auto; border-radius:50%; width:18px; height:18px; padding:0; display:flex; align-items:center; justify-content:center; font-size:10px;">${lead.unread}</span>`
      : '';

    const item = document.createElement("div");
    item.className = `chat-item ${activeClass}`;
    item.innerHTML = `
      <div class="chat-item-avatar">
        ${initials}
        <div class="chat-item-badge" style="background-color: ${badgeColor};" title="${lead.channel}"></div>
      </div>
      <div class="chat-item-details">
        <div class="chat-item-name">${channelIcon} ${lead.name}</div>
        <div class="chat-item-msg">${(lastMsg || '').substring(0, 42)}</div>
        ${tagsMarkup ? `<div style="display:flex; gap:4px; margin-top:3px;">${tagsMarkup}</div>` : ''}
      </div>
      ${unreadMarkup}
    `;

    item.addEventListener("click", () => selectActiveChat(lead.id));
    container.appendChild(item);
  });
}

// Converte mensagem do banco para o formato da UI (com suporte a mídia e notas internas)
function mapDbMessage(m) {
  return {
    sender: m.direction === 'inbound' ? 'incoming' : 'outgoing',
    text: m.content,
    type: m.message_type || 'text',
    mediaUrl: m.media_url || null,
    time: new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };
}

async function selectActiveChat(leadId) {
  state.activeChatLeadId = leadId;
  const lead = state.leads.find(l => l.id === leadId);
  if (lead) lead.unread = 0;

  renderChatList();

  // Buscar histórico de mensagens real no Supabase
  try {
    const res = await window.ApexAPI.messages.getHistory(leadId);
    if (res.success && lead) {
      lead.messages = res.data.map(mapDbMessage);
      renderActiveChat();
    }
  } catch (err) {
    console.error(err);
    showToast("Erro ao carregar mensagens.", "danger");
  }

  // Carregar status do atendimento (IA ativa × humano) e atualizar controles
  if (lead) {
    try {
      const statusRes = await window.ApexAPI.chatControl.getAiStatus(lead.phoneRaw || lead.phone);
      if (statusRes.success) {
        updateAiControls(statusRes.data.ia_active);
      } else {
        hideAiControls();
      }
    } catch (err) {
      hideAiControls();
    }
    renderChatSidePanel(lead);
  }
}

function renderActiveChat() {
  const messagesContainer = document.getElementById("chat-messages-container");
  const profileContainer = document.getElementById("chat-active-profile");
  
  const metaEmail = document.getElementById("chat-meta-email");
  const metaPhone = document.getElementById("chat-meta-phone");
  const metaValue = document.getElementById("chat-meta-value");
  const metaStage = document.getElementById("chat-meta-stage");
  
  if (!messagesContainer) return;
  
  if (!state.activeChatLeadId) {
    messagesContainer.innerHTML = `
      <div style="margin: auto; text-align: center; color: var(--text-muted); font-size: 13px;">
        Selecione um paciente ao lado para gerenciar as comunicações e confirmar agendamentos.
      </div>
    `;
    return;
  }
  
  const lead = state.leads.find(l => l.id === state.activeChatLeadId);
  if (!lead) return;
  
  profileContainer.innerHTML = `
    <div class="chat-user-avatar">${lead.name.split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase()}</div>
    <div>
      <div class="chat-user-name">${lead.name}</div>
      <div class="chat-user-status">WhatsApp Clínico | ${lead.phone}</div>
    </div>
  `;
  
  metaEmail.textContent = lead.email || '—';
  metaPhone.textContent = lead.phone;
  metaValue.textContent = formatCurrency(lead.value);
  metaStage.textContent = getStageName(lead.stage);
  
  messagesContainer.innerHTML = "";
  
  if (lead.messages.length === 0) {
    messagesContainer.innerHTML = `
      <div style="margin: auto; text-align: center; color: var(--text-muted); font-size: 13px;">
        Nenhuma conversa iniciada. Envie uma mensagem no WhatsApp.
      </div>
    `;
    return;
  }
  
  lead.messages.forEach(msg => {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${msg.sender}`;

    let body = '';
    if (msg.type === 'internal_note') {
      bubble.style.cssText = 'background:rgba(245,158,11,.12); border:1px dashed rgba(245,158,11,.4); align-self:center; max-width:80%;';
      body = `<div style="font-size:11px; color:#f59e0b; font-weight:700; margin-bottom:2px;">📝 Nota interna</div><div>${msg.text}</div>`;
    } else if (msg.type === 'image' && msg.mediaUrl) {
      body = `<img src="${msg.mediaUrl}" style="max-width:240px; border-radius:8px; display:block; margin-bottom:4px;" loading="lazy">` + (msg.text ? `<div>${msg.text}</div>` : '');
    } else if (msg.type === 'audio' && msg.mediaUrl) {
      body = `<audio controls src="${msg.mediaUrl}" style="max-width:240px;"></audio>`;
    } else if (msg.type === 'document' && msg.mediaUrl) {
      body = `<a href="${msg.mediaUrl}" target="_blank" style="color:var(--color-primary);">📎 ${msg.text || 'Documento'}</a>`;
    } else {
      body = `<div>${msg.text}</div>`;
    }

    bubble.innerHTML = `${body}<div class="chat-bubble-time">${msg.time}</div>`;
    messagesContainer.appendChild(bubble);
  });
  
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById("chat-message-input");
  if (!input || !input.value.trim() || !state.activeChatLeadId) return;
  
  const lead = state.leads.find(l => l.id === state.activeChatLeadId);
  if (!lead) return;
  
  const msgText = input.value.trim();
  input.value = "";
  
  try {
    const res = await window.ApexAPI.messages.send(state.activeChatLeadId, msgText);
    if (res.success) {
      // Feedback imediato na UI
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      
      lead.messages.push({
        sender: "outgoing",
        text: msgText,
        time: timeStr
      });
      
      renderActiveChat();
      renderChatList();
    }
  } catch (err) {
    showToast("Falha ao enviar mensagem via WhatsApp: " + err.message, "danger");
  }
}

function generateIAScript() {
  const input = document.getElementById("chat-message-input");
  if (!input || !state.activeChatLeadId) return;
  
  const lead = state.leads.find(l => l.id === state.activeChatLeadId);
  if (!lead) return;
  
  const lastIncomingMsg = [...lead.messages].reverse().find(m => m.sender === 'incoming');
  const msgText = lastIncomingMsg ? lastIncomingMsg.text : "";
  
  let suggested = `Olá ${lead.name}, confirmando seu agendamento de avaliação para o tratamento de ${lead.source} com o Dr. Henrique nesta quinta às 15:00. Podemos confirmar?`;
  
  if (msgText.toLowerCase().includes("dor") || msgText.toLowerCase().includes("urgente")) {
    suggested = `Olá ${lead.name}! Sentimos muito pela dor. Já alinhamos com o Dr. Henrique e conseguimos um encaixe de emergência hoje às 16:30. Consegue comparecer?`;
  } else if (lead.stage === 'proposal') {
    suggested = `Olá ${lead.name}! O planejamento clínico para seu tratamento de ${lead.source} ficou pronto. O Dr. Henrique gostaria de te apresentar as condições de parcelamento facilitado em até 12x. Vamos agendar para fechar o plano?`;
  }
  
  input.value = suggested;
  input.focus();
  showToast("Script odontológico gerado pela IA inserido no chat!", "success");
}

// ==========================================================================
// Simulador n8n Automations & Flow Builder
// ==========================================================================
function initAutomation() {
  const btnTestFlow = document.getElementById("btn-test-flow");
  if (!btnTestFlow) return;
  
  btnTestFlow.addEventListener("click", triggerN8NWorkflow);
}

function triggerN8NWorkflow() {
  const consoleLogs = document.getElementById("n8n-console-logs");
  const execStatus = document.getElementById("n8n-exec-status");
  
  if (!consoleLogs) return;
  
  showToast("Iniciando execução de teste no n8n...", "info");
  
  consoleLogs.innerHTML = "";
  execStatus.textContent = "EXECUTANDO";
  execStatus.className = "badge badge-warning";
  
  const nodes = document.querySelectorAll(".flow-node");
  nodes.forEach(n => n.classList.remove("active-node"));
  
  const logs = [
    {
      delay: 500,
      nodeId: "node-webhook",
      text: "⚡ [Webhook Trigger] Entrada detectada via Facebook Lead Ads API.\nCarga útil JSON recebida:\n" + JSON.stringify({
        event: "lead_captured",
        form_id: "form_implantes_2026",
        patient: {
          name: "Aline Silva",
          phone: "5511988889999",
          email: "aline.silva@outlook.com",
          message: "Tenho interesse em implantes dentários, perdi dois dentes atrás."
        }
      }, null, 2)
    },
    {
      delay: 2000,
      nodeId: "node-ai",
      text: "\n\n🤖 [AI Agent Node] Analisando payload com IA Triadora...\n- Interesse identificado: Implante Dentário\n- Prioridade classificada: ALTA (perda de elementos dentários)\n- Recomendação de mensagem: Focada em agendamento cirúrgico.\n- Saída gerada:\n" + JSON.stringify({
        intent: "implante",
        priority: "high",
        suggested_treatment_value: 9500
      }, null, 2)
    },
    {
      delay: 3500,
      nodeId: "node-crm",
      text: "\n\n📂 [CRM Node] Enviando chamada REST API para criação de ficha...\n- Endpoint: POST /api/v1/patients\n- Chamada realizada no backend real..."
    },
    {
      delay: 5000,
      nodeId: "node-whatsapp",
      text: "\n\n💬 [WhatsApp Node] Enviando notificação via Evolution API...\n- Executando trigger automático 'new_lead'..."
    },
    {
      delay: 6500,
      nodeId: "node-calendar",
      text: "\n\n📅 [Google Calendar Node] Reservando pré-agenda...\n- Salvando compromisso inicial..."
    }
  ];
  
  logs.forEach((step) => {
    setTimeout(() => {
      const activeNode = document.getElementById(step.nodeId);
      if (activeNode) {
        nodes.forEach(n => n.classList.remove("active-node"));
        activeNode.classList.add("active-node");
      }
      
      consoleLogs.innerHTML += step.text;
      consoleLogs.scrollTop = consoleLogs.scrollHeight;
    }, step.delay);
  });
  
  setTimeout(async () => {
    execStatus.textContent = "SUCESSO";
    execStatus.className = "badge badge-success";
    
    // Dispara chamada de webhook real no backend para Aline Silva
    try {
      const payload = {
        event: "lead_captured",
        name: "Aline Silva",
        email: "aline.silva@outlook.com",
        phone: "5511988889999",
        treatment_interest: "Implante Dentário",
        source: "Facebook Ads"
      };

      const res = await fetch('http://localhost:3001/api/automations/webhooks/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const data = await res.json();
      if (data.success) {
        showToast("[n8n] Fluxo finalizado! Paciente Aline Silva salva no Supabase real e no CRM.", "success");
        await refreshState();
        initKanban();
        initLeadsTable();
        renderChatList();
      }
    } catch (err) {
      console.error(err);
      showToast("Falha ao registrar webhook da simulação.", "danger");
    }
  }, 7500);
}

// ==========================================================================
// Configuração Visual das Regras (DKW System UI Sync)
// ==========================================================================
function initAutomationRulesUI() {
  const rules = ['stage', 'stale', 'created', 'value', 'task'];
  
  rules.forEach(rule => {
    const toggle = document.getElementById(`rule-toggle-${rule}`);
    const actionSelect = document.getElementById(`rule-action-${rule}`);
    
    if (toggle && actionSelect) {
      // Sincroniza estado inicial com a UI
      toggle.checked = state.automationRules[rule].active;
      actionSelect.value = state.automationRules[rule].action;
      
      // Evento de Toggle de ativação
      toggle.addEventListener("change", async () => {
        const ruleId = state.automationRules[rule].id;
        if (ruleId) {
          try {
            await window.ApexAPI.automations.updateRule(ruleId, { is_active: toggle.checked });
            state.automationRules[rule].active = toggle.checked;
            showToast(`Gatilho "${getRuleLabel(rule)}" ${toggle.checked ? 'ativado' : 'desativado'}.`, 'info');
          } catch (err) {
            showToast("Erro ao salvar regra: " + err.message, "danger");
            toggle.checked = !toggle.checked;
          }
        }
      });
      
      // Evento de Mudança de Ação
      actionSelect.addEventListener("change", async () => {
        const ruleId = state.automationRules[rule].id;
        if (ruleId) {
          try {
            await window.ApexAPI.automations.updateRule(ruleId, { action_type: actionSelect.value });
            state.automationRules[rule].action = actionSelect.value;
            showToast(`Ação do gatilho "${getRuleLabel(rule)}" atualizada para: "${getActionLabel(actionSelect.value)}".`, 'success');
          } catch (err) {
            showToast("Erro ao atualizar ação: " + err.message, "danger");
            actionSelect.value = state.automationRules[rule].action;
          }
        }
      });
    }
  });
  
  // Simular lead parado
  const btnSimulateStale = document.getElementById("btn-simulate-stale");
  if (btnSimulateStale) {
    btnSimulateStale.addEventListener("click", async () => {
      showToast("Executando verificação de leads inativos...", "info");
      try {
        const res = await window.ApexAPI.automations.simulateStaleLeads(7);
        if (res.success) {
          if (res.stale_count > 0) {
            showToast(`Sucesso! Encontrados ${res.stale_count} leads inativos. Disparando WhatsApp...`, "success");
            await refreshState();
            renderActiveChat();
          } else {
            showToast("Nenhum lead inativo (há mais de 7 dias) encontrado.", "warning");
          }
        }
      } catch (err) {
        showToast("Erro na simulação: " + err.message, "danger");
      }
    });
  }
}

function getRuleLabel(rule) {
  const labels = {
    stage: 'Negócio avançou de etapa',
    stale: 'Lead parado há muitos dias',
    created: 'Novo negócio criado',
    value: 'Valor alterado',
    task: 'Tarefa concluída'
  };
  return labels[rule] || rule;
}

function getActionLabel(action) {
  const labels = {
    none: 'Nenhuma Ação',
    send_whatsapp: 'Enviar WhatsApp via Evolution API',
    send_email: 'Enviar E-mail Clínico',
    tag: 'Adicionar Tag Alta Prioridade',
    whatsapp_reengage: 'Enviar WhatsApp de Reengajamento',
    move_stage: 'Avançar Paciente no Funil',
    whatsapp_welcome: 'Enviar Mensagem de Boas-vindas',
    notify_team: 'Notificar Equipe de Recepção',
    notify_director: 'Alertar Diretor Clínico',
    n8n_log: 'Registrar no n8n Audit',
    promote_lead: 'Avançar Paciente no Funil',
    request_review: 'Enviar WhatsApp solicitando Review'
  };
  return labels[action] || action;
}

// ==========================================================================
// Agenda / Calendário
// ==========================================================================
function initCalendar() {
  const monthYearEl = document.getElementById("calendar-month-year");
  const container = document.getElementById("calendar-days-container");
  const btnPrev = document.getElementById("btn-calendar-prev");
  const btnNext = document.getElementById("btn-calendar-next");
  
  if (!container) return;
  
  const year = state.calendarDate.getFullYear();
  const month = state.calendarDate.getMonth();
  
  const monthNames = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
  ];
  
  monthYearEl.textContent = `${monthNames[month]} ${year}`;
  container.innerHTML = "";
  
  const weekDays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  weekDays.forEach(day => {
    const dayLabel = document.createElement("div");
    dayLabel.className = "calendar-day-label";
    dayLabel.textContent = day;
    container.appendChild(dayLabel);
  });
  
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  
  for (let i = 0; i < firstDay; i++) {
    const emptyDay = document.createElement("div");
    emptyDay.className = "calendar-day empty";
    container.appendChild(emptyDay);
  }
  
  const now = new Date();
  const currentMonthStr = String(month + 1).padStart(2, '0');
  
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, '0');
    const fullDateStr = `${year}-${currentMonthStr}-${dayStr}`;
    
    const dayEl = document.createElement("div");
    dayEl.className = "calendar-day";
    
    const isToday = now.getDate() === d && now.getMonth() === month && now.getFullYear() === year;
    if (isToday) dayEl.classList.add("today");
    
    const dayAppts = (state.clinicorpAgenda || []).filter(a => a.date === fullDateStr);
    let dotsHtml = "";
    dayAppts.slice(0, 4).forEach(a => {
      dotsHtml += `<div class="calendar-event-dot" style="background-color: ${a.color || '#6366f1'};" title="${a.from} ${a.patient}"></div>`;
    });
    if (dayAppts.length > 4) dotsHtml += `<span style="font-size:9px; color:var(--text-muted);">+${dayAppts.length - 4}</span>`;

    if (state.selectedDay === fullDateStr) {
      dayEl.classList.add("selected");
      dayEl.style.outline = "2px solid var(--color-primary)";
      dayEl.style.outlineOffset = "-2px";
    }

    dayEl.innerHTML = `
      <span class="calendar-day-num">${d}</span>
      <div class="calendar-day-events">${dotsHtml}</div>
    `;

    dayEl.addEventListener("click", () => {
      state.selectedDay = fullDateStr;
      initCalendar();
    });
    container.appendChild(dayEl);
  }
  
  btnPrev.replaceWith(btnPrev.cloneNode(true));
  btnNext.replaceWith(btnNext.cloneNode(true));
  
  document.getElementById("btn-calendar-prev").addEventListener("click", () => {
    state.calendarDate.setMonth(state.calendarDate.getMonth() - 1);
    loadClinicorpAgenda();
  });

  document.getElementById("btn-calendar-next").addEventListener("click", () => {
    state.calendarDate.setMonth(state.calendarDate.getMonth() + 1);
    loadClinicorpAgenda();
  });

  renderDayAgenda();
}

// Busca a agenda do mês visível no Clinicorp e redesenha
async function loadClinicorpAgenda() {
  const year = state.calendarDate.getFullYear();
  const month = state.calendarDate.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month + 1)}-01`;
  const to = `${year}-${pad(month + 1)}-${new Date(year, month + 1, 0).getDate()}`;

  const titleEl = document.getElementById("calendar-month-year");
  if (titleEl) titleEl.dataset.loading = "1";
  try {
    const res = await window.ApexAPI.agenda.clinicorp(from, to);
    state.clinicorpAgenda = res.success ? (res.data.appointments || []) : [];
    state.agendaProfessional = res.success ? res.data.professional : '';
    if (!res.success) showToast("Não consegui carregar a agenda do Clinicorp: " + (res.error || ""), "warning");
  } catch (e) {
    state.clinicorpAgenda = [];
    showToast("Erro ao buscar agenda: " + e.message, "danger");
  }
  // Default: dia selecionado = hoje (se no mês visível) senão dia 1
  const now = new Date();
  if (!state.selectedDay || !state.selectedDay.startsWith(`${year}-${pad(month + 1)}`)) {
    state.selectedDay = (now.getFullYear() === year && now.getMonth() === month)
      ? `${year}-${pad(month + 1)}-${pad(now.getDate())}`
      : from;
  }
  initCalendar();
}

function renderDayAgenda() {
  const container = document.getElementById("agenda-list-container");
  const titleEl = document.querySelector('#panel-calendar .right-section-title');
  if (!container) return;

  const dia = state.selectedDay;
  const diaFmt = dia ? dia.split('-').reverse().join('/') : '';
  if (titleEl) titleEl.textContent = `Agenda ${state.agendaProfessional || ''} — ${diaFmt}`;

  const doDia = (state.clinicorpAgenda || []).filter(a => a.date === dia)
    .sort((a, b) => (a.from || '').localeCompare(b.from || ''));

  if (doDia.length === 0) {
    container.innerHTML = `<div style="font-size: 13px; color: var(--text-muted);">Nenhuma consulta nesse dia.</div>`;
    return;
  }

  const statusBadge = (s) => {
    if (s === 'compareceu') return '<span style="font-size:10px; padding:2px 8px; border-radius:10px; background:rgba(16,185,129,.2); color:#10b981;">✓ Compareceu</span>';
    if (s === 'faltou') return '<span style="font-size:10px; padding:2px 8px; border-radius:10px; background:rgba(239,68,68,.2); color:#ef4444;">✕ Faltou</span>';
    return '';
  };

  container.innerHTML = doDia.map((a, i) => `
    <div class="card agenda-item" data-att="${a.attendance_id || ''}" style="background-color: var(--bg-tertiary); padding: 12px 16px; border-left: 3px solid ${a.color || '#6366f1'}; margin-bottom: 8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="agenda-time">${a.from} - ${a.to} ${a.confirmed ? '✅' : ''}</span>
        ${statusBadge(a.status)}
      </div>
      <div class="agenda-title">${a.patient}</div>
      <div class="agenda-contact">${a.category || 'Consulta'}${a.phone ? ' · ' + a.phone : ''}</div>
      ${a.notes ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${a.notes}</div>` : ''}
      <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
        ${a.attendance_id ? `
        <button class="btn btn-sm" data-mark="compareceu" data-id="${a.attendance_id}" style="font-size:11px; padding:3px 10px; background:${a.status==='compareceu'?'#10b981':'var(--bg-secondary)'}; color:${a.status==='compareceu'?'#fff':'var(--text-muted)'}; border:1px solid var(--bg-tertiary);">✓ Compareceu</button>
        <button class="btn btn-sm" data-mark="faltou" data-id="${a.attendance_id}" style="font-size:11px; padding:3px 10px; background:${a.status==='faltou'?'#ef4444':'var(--bg-secondary)'}; color:${a.status==='faltou'?'#fff':'var(--text-muted)'}; border:1px solid var(--bg-tertiary);">✕ Faltou</button>` : ''}
        ${a.clinicorp_id ? `<button class="btn btn-sm" data-cancel="${a.clinicorp_id}" data-nome="${a.patient}" style="font-size:11px; padding:3px 10px; background:var(--bg-secondary); color:var(--text-muted); border:1px solid var(--bg-tertiary); margin-left:auto;">🗑 Cancelar</button>` : ''}
      </div>
    </div>
  `).join('');

  // Botão cancelar consulta (Clinicorp)
  container.querySelectorAll('button[data-cancel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cid = btn.dataset.cancel;
      if (!confirm(`Cancelar a consulta de ${btn.dataset.nome}? Isso remove do Clinicorp.`)) return;
      btn.disabled = true; btn.textContent = 'Cancelando...';
      const res = await window.ApexAPI.agenda.cancelAppointment(cid);
      if (res.success) {
        showToast('Consulta cancelada no Clinicorp', 'success');
        loadClinicorpAgenda();
      } else {
        showToast('Erro ao cancelar: ' + (res.error || ''), 'danger');
        btn.disabled = false; btn.textContent = '🗑 Cancelar';
      }
    });
  });

  // Liga os botões de comparecimento
  container.querySelectorAll('button[data-mark]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const novoStatus = btn.dataset.mark;
      btn.disabled = true;
      const res = await window.ApexAPI.agenda.markAttendance(id, novoStatus);
      if (res.success) {
        const appt = (state.clinicorpAgenda || []).find(x => x.attendance_id === id);
        if (appt) appt.status = novoStatus;
        showToast(novoStatus === 'compareceu' ? '✓ Comparecimento registrado' : '✕ Falta registrada', 'success');
        renderDayAgenda();
      } else {
        showToast('Erro ao marcar: ' + (res.error || ''), 'danger');
        btn.disabled = false;
      }
    });
  });
}

// ==========================================================================
// Copilot IA Odonto
// ==========================================================================
function initAIWidget() {
  const trigger = document.getElementById("ai-trigger");
  const panel = document.getElementById("ai-panel");
  const closeBtn = document.getElementById("ai-panel-close");
  const sendBtn = document.getElementById("btn-send-ai-msg");
  const chatInput = document.getElementById("ai-chat-input");
  
  if (!trigger) return;
  
  trigger.addEventListener("click", () => {
    panel.classList.toggle("active");
  });
  
  closeBtn.addEventListener("click", () => {
    panel.classList.remove("active");
  });
  
  sendBtn.addEventListener("click", sendAIMessage);
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === 'Enter') sendAIMessage();
  });
}

let copilotConversationId = null;

async function sendAIMessage() {
  const input = document.getElementById("ai-chat-input");
  const container = document.getElementById("ai-chat-messages");

  if (!input || !input.value.trim()) return;
  const userText = input.value.trim();

  container.innerHTML += `<div class="ai-panel-bubble user">${userText}</div>`;
  input.value = "";
  container.scrollTop = container.scrollHeight;

  // Indicador de "digitando..."
  const typingId = `typing-${Date.now()}`;
  container.innerHTML += `<div class="ai-panel-bubble ai" id="${typingId}" style="opacity:.6;">Sofia está pensando…</div>`;
  container.scrollTop = container.scrollHeight;

  try {
    const res = await window.ApexAPI.copilot.ask(userText, copilotConversationId);
    document.getElementById(typingId)?.remove();
    if (res.success) {
      copilotConversationId = res.conversationId || copilotConversationId;
      const html = (res.answer || "(sem resposta)").replace(/\n/g, "<br>");
      container.innerHTML += `<div class="ai-panel-bubble ai">${html}</div>`;
    } else {
      container.innerHTML += `<div class="ai-panel-bubble ai" style="color:#ef4444;">Não consegui falar com a IA agora: ${res.error}</div>`;
    }
  } catch (err) {
    document.getElementById(typingId)?.remove();
    container.innerHTML += `<div class="ai-panel-bubble ai" style="color:#ef4444;">Erro: ${err.message}</div>`;
  }
  container.scrollTop = container.scrollHeight;
}

// ==========================================================================
// Modais e Formulários
// ==========================================================================
function initModals() {
  document.getElementById("btn-add-lead-header").addEventListener("click", () => openAddLeadModal());
  document.getElementById("modal-lead-close").addEventListener("click", () => closeModal("modal-lead"));
  document.getElementById("btn-cancel-lead").addEventListener("click", () => closeModal("modal-lead"));
  document.getElementById("form-add-lead").addEventListener("submit", handleLeadSubmit);
  
  document.getElementById("modal-meeting-close").addEventListener("click", () => closeModal("modal-meeting"));
  document.getElementById("btn-cancel-meeting").addEventListener("click", () => closeModal("modal-meeting"));
  document.getElementById("form-add-meeting").addEventListener("submit", handleMeetingSubmit);
  
  const meetingDateInput = document.getElementById("meeting-date");
  if (meetingDateInput) {
    meetingDateInput.addEventListener("change", (e) => {
      loadAvailableTimes(e.target.value);
    });
  }
}

function openModal(id) {
  document.getElementById(id).classList.add("active");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("active");
}

function openAddLeadModal() {
  document.getElementById("modal-lead-title").textContent = "Novo Paciente";
  document.getElementById("form-lead-id").value = "";
  document.getElementById("form-add-lead").reset();
  openModal("modal-lead");
}

window.openEditLeadModal = function(id) {
  const lead = state.leads.find(l => l.id === id);
  if (!lead) return;
  
  document.getElementById("modal-lead-title").textContent = "Editar Paciente";
  document.getElementById("form-lead-id").value = lead.id;
  document.getElementById("lead-name").value = lead.name;
  document.getElementById("lead-email").value = lead.email;
  document.getElementById("lead-phone").value = lead.phone.replace(/\D/g, '');
  document.getElementById("lead-value").value = lead.value;
  document.getElementById("lead-stage").value = lead.stage;
  document.getElementById("lead-source").value = lead.source;
  
  openModal("modal-lead");
}

async function handleLeadSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById("form-lead-id").value;
  const name = document.getElementById("lead-name").value;
  const email = document.getElementById("lead-email").value;
  const phone = document.getElementById("lead-phone").value;
  const value = parseFloat(document.getElementById("lead-value").value);
  const entradaEl = document.getElementById("lead-entrada");
  const entrada = entradaEl ? parseFloat(entradaEl.value) : NaN;
  const stage = document.getElementById("lead-stage").value;
  const source = document.getElementById("lead-source").value;

  const patientData = {
    name,
    email: email || null,
    phone,
    treatment_value: value || null,
    entrada: !isNaN(entrada) ? entrada : null,
    treatment_interest: source || null,
    source: 'manual'
  };

  try {
    if (id) {
      // Editar paciente
      const res = await window.ApexAPI.patients.update(id, patientData);
      if (res.success) {
        // Se mudou o estágio, mover o deal
        const currentLead = state.leads.find(l => l.id === id);
        if (currentLead && currentLead.stage !== stage) {
          const pipelineRes = await window.ApexAPI.pipeline.getAll();
          let dealId = null;
          if (pipelineRes.success) {
            pipelineRes.data.forEach(st => {
              st.deals.forEach(d => {
                if (d.patient_id === id) dealId = d.id;
              });
            });
          }
          if (dealId) {
            await window.ApexAPI.pipeline.moveDeal(dealId, STAGE_MAP[stage]);
          }
        }
        showToast(`Ficha de "${name}" atualizada!`, 'success');
      }
    } else {
      // Criar paciente
      const res = await window.ApexAPI.patients.create(patientData);
      if (res.success) {
        // Mover para o estágio Kanban correto se for diferente de 'lead' (Triagem)
        const targetStageId = STAGE_MAP[stage];
        const stagesRes = await window.ApexAPI.pipeline.getStages();
        if (stagesRes.success && stagesRes.data.length > 0) {
          const firstStageId = stagesRes.data[0].id;
          if (targetStageId && targetStageId !== firstStageId) {
            const pipelineRes = await window.ApexAPI.pipeline.getAll();
            let dealId = null;
            if (pipelineRes.success) {
              pipelineRes.data.forEach(st => {
                st.deals.forEach(d => {
                  if (d.patient_id === res.data.id) dealId = d.id;
                });
              });
            }
            if (dealId) {
              await window.ApexAPI.pipeline.moveDeal(dealId, targetStageId);
            }
          }
        }
        showToast(`Paciente "${name}" cadastrado!`, 'success');
        // Envia o lead novo para o CRM do Clinicorp (fire-and-forget)
        window.ApexAPI.agenda.pushLead({
          name, phone, email: email || undefined,
          notes: `Lead do CRM ClinPrime — interesse: ${source || 'geral'}`,
          board: 'Leads CRM'
        }).then(r => { if (r.success) showToast('Lead também enviado ao Clinicorp 📋', 'info'); });
      }
    }

    closeModal("modal-lead");
    await refreshState();
    initKanban();
    initLeadsTable();
    renderChatList();
  } catch (err) {
    showToast("Erro ao salvar ficha: " + err.message, "danger");
  }
}

async function handleMeetingSubmit(e) {
  e.preventDefault();
  
  const title = document.getElementById("meeting-title").value;
  const leadId = document.getElementById("meeting-lead").value;
  const date = document.getElementById("meeting-date").value;
  const time = document.getElementById("meeting-time").value;
  
  // Criar data local formatada ISO
  const scheduled_at = new Date(`${date}T${time}:00`).toISOString();
  const lead = state.leads.find(l => l.id === leadId);

  try {
    // 1. Cria de verdade no Clinicorp (agenda real do Dr. Thiago)
    const clini = await window.ApexAPI.agenda.createAppointment({
      name: lead ? lead.name : title,
      phone: lead ? (lead.phoneRaw || lead.phone) : '',
      date, time, duration: 30
    });
    if (!clini.success) {
      showToast('Não foi possível criar no Clinicorp: ' + (clini.error || ''), 'danger');
      return;
    }

    // 2. Registra também no CRM (histórico/dashboard)
    await window.ApexAPI.appointments.create({ patient_id: leadId, title, scheduled_at, duration_minutes: 30 });

    showToast('Consulta criada no Clinicorp e no CRM! 📅', 'success');
    closeModal("modal-meeting");
    if (document.getElementById('panel-calendar')?.classList.contains('active')) {
      loadClinicorpAgenda();
    }
  } catch (err) {
    showToast("Erro ao agendar consulta: " + err.message, "danger");
  }
}

function openScheduleModalFromChat() {
  const select = document.getElementById("meeting-lead");
  select.innerHTML = "";
  
  state.leads.forEach(l => {
    select.innerHTML += `<option value="${l.id}">${l.name}</option>`;
  });
  
  if (state.activeChatLeadId) {
    select.value = state.activeChatLeadId;
  }
  
  const today = new Date().toISOString().split('T')[0];
  document.getElementById("meeting-date").value = today;
  
  openModal("modal-meeting");
  
  // Carrega os horários livres da data inicial
  loadAvailableTimes(today);
}

async function loadAvailableTimes(dateStr) {
  const timeSelect = document.getElementById("meeting-time");
  const confirmBtn = document.getElementById("btn-confirm-meeting");
  
  if (!timeSelect) return;
  
  // Desativa os campos e exibe indicador de carregamento
  timeSelect.disabled = true;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.dataset.originalText = confirmBtn.textContent;
    confirmBtn.textContent = "Buscando horários...";
  }
  timeSelect.innerHTML = `<option value="">Carregando horários...</option>`;
  
  try {
    const res = await window.ApexAPI.agenda.clinicorp(dateStr, dateStr);
    const appointments = res.success ? (res.data.appointments || []) : [];
    if (!res.success) {
      console.warn("Falha ao buscar agenda do Clinicorp, exibindo horários livres padrão:", res.error);
      showToast("Não foi possível sincronizar com o Clinicorp. Exibindo horários padrão.", "warning");
    }
    
    // Slots padrão (das 08:00 às 18:00 com 30min de intervalo, sem 12:00-13:00)
    const defaultSlots = [
      "08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
      "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30"
    ];
    
    const normalizeTime = (t) => (t || '').slice(0, 5);
    const toMins = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    
    const availableSlots = defaultSlots.filter(slotStart => {
      // Cada consulta tem duração estimada de 60 minutos
      const slotEnd = (() => {
        const [h, m] = slotStart.split(':').map(Number);
        const total = h * 60 + m + 60;
        const fh = String(Math.floor(total / 60)).padStart(2, '0');
        const fm = String(total % 60).padStart(2, '0');
        return `${fh}:${fm}`;
      })();
      
      const slotStartMins = toMins(slotStart);
      const slotEndMins = toMins(slotEnd);
      
      // Verifica conflito de horário com agendamentos existentes
      const hasConflict = appointments.some(appt => {
        const apptStart = normalizeTime(appt.from);
        const apptEnd = normalizeTime(appt.to);
        const apptStartMins = toMins(apptStart);
        const apptEndMins = toMins(apptEnd);
        
        return slotStartMins < apptEndMins && slotEndMins > apptStartMins;
      });
      
      if (hasConflict) return false;
      
      // Remove horários que já passaram se for hoje
      const todayStr = new Date().toLocaleDateString('en-CA');
      if (dateStr === todayStr) {
        const now = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();
        if (slotStartMins <= nowMins) {
          return false;
        }
      }
      
      return true;
    });
    
    timeSelect.innerHTML = "";
    if (availableSlots.length === 0) {
      timeSelect.innerHTML = `<option value="">Nenhum horário disponível</option>`;
      timeSelect.disabled = true;
      if (confirmBtn) confirmBtn.disabled = true;
    } else {
      availableSlots.forEach(slot => {
        timeSelect.innerHTML += `<option value="${slot}">${slot}</option>`;
      });
      timeSelect.disabled = false;
      if (confirmBtn) confirmBtn.disabled = false;
    }
  } catch (err) {
    console.error("Erro ao carregar horários disponíveis:", err);
    showToast("Erro ao carregar horários disponíveis: " + err.message, "danger");
    timeSelect.innerHTML = `<option value="">Erro ao carregar horários</option>`;
    timeSelect.disabled = true;
    if (confirmBtn) confirmBtn.disabled = true;
  } finally {
    if (confirmBtn) {
      confirmBtn.textContent = confirmBtn.dataset.originalText || "Confirmar Agendamento";
    }
  }
}

// Simulação de Webhook Ads real
async function triggerQuickAdSimulation() {
  showToast("Novo paciente se cadastrando via Facebook Ads...", "info");
  
  setTimeout(async () => {
    const names = ["Camila Ribeiro", "Lucas Pinheiro", "Renata Vasconcelos", "Pedro Guedes"];
    const name = names[Math.floor(Math.random() * names.length)];
    const treatments = ["Implante Dentário", "Invisalign / Ortodontia", "Clareamento Dental"];
    const treatment = treatments[Math.floor(Math.random() * treatments.length)];
    
    const randomPhone = "55119" + Math.floor(Math.random() * 90000000 + 10000000);
    
    try {
      // Chama o endpoint real de webhook no backend!
      const res = await fetch('http://localhost:3001/api/automations/webhooks/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: "lead_captured",
          name,
          email: `${name.toLowerCase().replace(" ", ".")}@outlook.com`,
          phone: randomPhone,
          treatment_interest: treatment,
          source: 'Facebook Ads'
        })
      });
      
      const data = await res.json();
      if (data.success) {
        showToast(`Novo paciente "${name}" capturado via Webhook Facebook Ads!`, "success");
        await refreshState();
        initKanban();
        initLeadsTable();
        renderChatList();
      }
    } catch (err) {
      showToast("Erro ao testar webhook: " + err.message, "danger");
    }
  }, 1500);
}

// ==========================================================================
// Utilitários Auxiliares
// ==========================================================================
function formatCurrency(val) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);
}

function formatPhoneDisplay(phone) {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  if (clean.length === 13) { // 5511999999999
    return `(${clean.substring(2, 4)}) ${clean.substring(4, 9)}-${clean.substring(9)}`;
  }
  if (clean.length === 11) { // 11999999999
    return `(${clean.substring(0, 2)}) ${clean.substring(2, 7)}-${clean.substring(7)}`;
  }
  return phone;
}

function getStageName(stage) {
  const stages = {
    'lead': 'Pré-Avaliação',
    'contacted': 'Consulta Agendada',
    'proposal': 'Avaliação Realizada',
    'negotiating': 'Orçamento Enviado',
    'won': 'Tratamento Iniciado',
    'concluded': 'Concluído'
  };
  return stages[stage] || stage;
}

function getStageBadge(stage) {
  if (stage === 'lead') return '<span class="badge badge-primary">Pré-Avaliação</span>';
  if (stage === 'contacted') return '<span class="badge badge-warning">Consulta Agendada</span>';
  if (stage === 'proposal') return '<span class="badge badge-primary">Avaliação Realizada</span>';
  if (stage === 'negotiating') return '<span class="badge badge-warning">Orçamento Enviado</span>';
  if (stage === 'won') return '<span class="badge badge-success">Tratamento Iniciado</span>';
  if (stage === 'concluded') return '<span class="badge badge-success" style="background-color: #00b894;">Concluído</span>';
  return `<span class="badge">${stage}</span>`;
}

function formatRelativeTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  
  if (diffSec < 60) return "Agora mesmo";
  if (diffMin < 60) return `Há ${diffMin} min`;
  if (diffHr < 24) return `Há ${diffHr} h`;
  return date.toLocaleDateString('pt-BR');
}

// Toast Notificações
function showToast(message, type = 'info') {
  const container = document.getElementById("toast-container");
  if (!container) return;
  
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  let icon = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width: 18px; height: 18px;">
      <path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 111.063 1.06l-.041.02a.75.75 0 11-1.063-1.06zm-2.775-4.33a.75.75 0 011.06-.02L12 9.168l2.465-2.278a.75.75 0 111.02 1.1l-3 2.775a.75.75 0 01-1.02 0l-3-2.775a.75.75 0 01-.02-1.06z" />
    </svg>
  `;
  if (type === 'success') {
    icon = `
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width: 18px; height: 18px; color: var(--color-success);">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    `;
  }
  
  toast.innerHTML = `
    ${icon}
    <div class="toast-message">${message}</div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add("show");
  }, 50);
  
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.remove();
    }, 400);
  }, 4000);
}

function initAPIConfigUI() {
  const form = document.getElementById('form-api-config');
  const n8nUrlInput = document.getElementById('config-n8n-url');
  const evoUrlInput = document.getElementById('config-evolution-url');
  const evoInstanceInput = document.getElementById('config-evolution-instance');
  const evoKeyInput = document.getElementById('config-evolution-key');

  if (form) {
    n8nUrlInput.value = localStorage.getItem('apex_n8n_url') || 'http://localhost:5678/webhook';
    evoUrlInput.value = localStorage.getItem('apex_evolution_url') || 'http://localhost:8080';
    evoInstanceInput.value = localStorage.getItem('apex_evolution_instance') || 'apex-odonto';
    evoKeyInput.value = localStorage.getItem('apex_evolution_key') || '';

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      
      const n8nUrl = n8nUrlInput.value.trim();
      const evoUrl = evoUrlInput.value.trim();
      const evoInstance = evoInstanceInput.value.trim();
      const evoKey = evoKeyInput.value.trim();

      if (window.ApexAPI && window.ApexAPI.updateConfig) {
        window.ApexAPI.updateConfig(n8nUrl, evoUrl, evoKey, evoInstance);
        showToast('Configurações de integração atualizadas com sucesso!', 'success');
      }
    });
  }
}


/* ==========================================================================
   CONEXÕES — WhatsApp (QR via Evolution) e Instagram
   ========================================================================== */
let waQrPollTimer = null;
let waActiveChannelId = null;

function initConnections() {
  const btnWa = document.getElementById("btn-connect-whatsapp");
  const btnIg = document.getElementById("btn-connect-instagram");
  const btnCreate = document.getElementById("btn-wa-create");
  const modalClose = document.getElementById("modal-whatsapp-close");

  if (!btnWa) return;

  btnWa.addEventListener("click", () => {
    document.getElementById("whatsapp-step-name").style.display = "";
    document.getElementById("whatsapp-step-qr").style.display = "none";
    document.getElementById("wa-display-name").value = "";
    openModal("modal-whatsapp");
  });

  btnIg.addEventListener("click", () => {
    showToast("Instagram Direct: integração via app Meta em homologação. O WhatsApp já está 100% disponível.", "info");
  });

  modalClose.addEventListener("click", () => {
    stopQrPolling();
    closeModal("modal-whatsapp");
    renderChannelsList();
  });

  btnCreate.addEventListener("click", async () => {
    const name = document.getElementById("wa-display-name").value.trim() || "WhatsApp";
    btnCreate.disabled = true;
    btnCreate.textContent = "Criando instância...";
    try {
      const res = await window.ApexAPI.channels.createWhatsApp(name);
      if (!res.success) {
        const detail = res.detail ? ` — ${JSON.stringify(res.detail).substring(0, 120)}` : "";
        showToast("Erro ao criar instância: " + (res.error || "") + detail, "danger");
        return;
      }
      waActiveChannelId = res.data.channel?.id;
      document.getElementById("whatsapp-step-name").style.display = "none";
      document.getElementById("whatsapp-step-qr").style.display = "";
      renderQr(res.data.qr);
      startQrPolling();
    } finally {
      btnCreate.disabled = false;
      btnCreate.textContent = "Gerar QR Code";
    }
  });

  renderChannelsList();
}

function renderQr(qrBase64) {
  const box = document.getElementById("wa-qr-box");
  if (!box) return;
  if (qrBase64) {
    const src = qrBase64.startsWith("data:") ? qrBase64 : `data:image/png;base64,${qrBase64}`;
    box.innerHTML = `<img src="${src}" style="width:240px; height:240px; display:block;">`;
  } else {
    box.innerHTML = `<span style="color:#333; font-size:13px;">Gerando QR... aguarde</span>`;
  }
}

function startQrPolling() {
  stopQrPolling();
  let attempts = 0;
  waQrPollTimer = setInterval(async () => {
    attempts++;
    if (!waActiveChannelId || attempts > 40) { stopQrPolling(); return; }
    try {
      const st = await window.ApexAPI.channels.status(waActiveChannelId);
      const statusEl = document.getElementById("wa-qr-status");
      if (st.success && st.data.status === "connected") {
        stopQrPolling();
        if (statusEl) statusEl.innerHTML = `<span style="color:#10b981; font-weight:700;">✅ WhatsApp conectado com sucesso!</span>`;
        showToast("📱 WhatsApp conectado! Mensagens já caem no Multiatendimento.", "success");
        setTimeout(() => { closeModal("modal-whatsapp"); renderChannelsList(); }, 1800);
      } else if (attempts % 6 === 0) {
        // QR expira ~40s — renova
        const qr = await window.ApexAPI.channels.getQr(waActiveChannelId);
        if (qr.success && qr.data.qr) renderQr(qr.data.qr);
      }
    } catch (e) { /* segue tentando */ }
  }, 3000);
}

function stopQrPolling() {
  if (waQrPollTimer) { clearInterval(waQrPollTimer); waQrPollTimer = null; }
}

async function renderChannelsList() {
  const container = document.getElementById("channels-list");
  if (!container) return;
  try {
    const res = await window.ApexAPI.channels.list();
    if (!res.success || res.data.length === 0) {
      container.innerHTML = `<div style="font-size:13px; color:var(--text-muted);">Nenhum canal conectado ainda. Clique em "Conectar WhatsApp" para começar.</div>`;
      return;
    }
    container.innerHTML = "";
    res.data.forEach(ch => {
      const isConnected = ch.status === "connected";
      const dot = isConnected ? "#10b981" : (ch.status === "connecting" ? "#f59e0b" : "#ef4444");
      const statusLabel = isConnected ? "Conectado" : (ch.status === "connecting" ? "Aguardando QR" : "Desconectado");
      const icon = ch.type === "instagram" ? "📸" : "💬";
      const card = document.createElement("div");
      card.className = "card";
      card.style.cssText = "padding:16px 20px; display:flex; align-items:center; gap:14px;";
      card.innerHTML = `
        <div style="font-size:22px;">${icon}</div>
        <div style="flex:1;">
          <div style="font-weight:700; color:var(--text-white);">${ch.display_name || ch.instance_name}</div>
          <div style="font-size:12px; color:var(--text-muted);">${ch.instance_name}</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; font-size:13px;">
          <span style="width:9px; height:9px; border-radius:50%; background:${dot}; display:inline-block;"></span>
          ${statusLabel}
        </div>
        <button class="btn btn-secondary btn-sm" data-act="qr" data-id="${ch.id}">QR</button>
        <button class="btn btn-secondary btn-sm" data-act="remove" data-id="${ch.id}" style="color:#ef4444;">Excluir</button>
      `;
      card.querySelector('[data-act="qr"]').addEventListener("click", async () => {
        waActiveChannelId = ch.id;
        document.getElementById("whatsapp-step-name").style.display = "none";
        document.getElementById("whatsapp-step-qr").style.display = "";
        openModal("modal-whatsapp");
        const qr = await window.ApexAPI.channels.getQr(ch.id);
        renderQr(qr.success ? qr.data.qr : null);
        startQrPolling();
      });
      card.querySelector('[data-act="remove"]').addEventListener("click", async () => {
        if (!confirm(`Excluir o canal "${ch.display_name || ch.instance_name}"? O WhatsApp será desconectado.`)) return;
        const r = await window.ApexAPI.channels.remove(ch.id);
        if (r.success) { showToast("Canal removido.", "success"); renderChannelsList(); }
        else showToast("Erro ao remover: " + (r.error || ""), "danger");
      });
      container.appendChild(card);
    });
  } catch (e) {
    container.innerHTML = `<div style="font-size:13px; color:#ef4444;">Erro ao carregar canais: ${e.message}</div>`;
  }
}

/* ==========================================================================
   INBOX PRO — busca, filtros, tags, atribuição e respostas rápidas
   ========================================================================== */
function initInboxPro() {
  // Busca
  const search = document.getElementById("chat-search");
  if (search) search.addEventListener("input", () => {
    state.chatSearch = search.value;
    renderChatList();
  });

  // Filtros (Todas / Minhas / Sem dono)
  document.querySelectorAll(".chat-filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chat-filter-chip").forEach(c => {
        c.style.background = "transparent"; c.style.color = "var(--text-muted)";
      });
      chip.style.background = "var(--color-primary)"; chip.style.color = "#fff";
      state.chatFilter = chip.dataset.filter;
      renderChatList();
    });
  });

  // Atribuição de atendente
  const assignSelect = document.getElementById("chat-assign-select");
  if (assignSelect) {
    assignSelect.innerHTML = `<option value="">Sem atendente</option>` +
      (state.teamMembers || []).map(m => `<option value="${m.user_id}">${m.display_name || 'Membro'}</option>`).join("");
    assignSelect.addEventListener("change", async () => {
      const lead = state.leads.find(l => l.id === state.activeChatLeadId);
      if (!lead) return;
      const r = await window.ApexAPI.inbox.assign(lead.id, assignSelect.value || null);
      if (r.success) {
        lead.assignedTo = assignSelect.value || null;
        showToast(assignSelect.value ? "Conversa atribuída." : "Atribuição removida.", "success");
        renderChatList();
      }
    });
  }

  // Tags
  const tagInput = document.getElementById("chat-tag-input");
  if (tagInput) {
    tagInput.addEventListener("keypress", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const lead = state.leads.find(l => l.id === state.activeChatLeadId);
      const val = tagInput.value.trim().toLowerCase();
      if (!lead || !val) return;
      if (!(lead.tags || []).includes(val)) {
        lead.tags = [...(lead.tags || []), val];
        await window.ApexAPI.inbox.setTags(lead.id, lead.tags);
        renderChatSidePanel(lead);
        renderChatList();
      }
      tagInput.value = "";
    });
  }

  // Respostas rápidas
  const btnQR = document.getElementById("btn-quick-replies");
  const input = document.getElementById("chat-message-input");
  if (btnQR) btnQR.addEventListener("click", () => toggleQuickReplies());
  if (input) input.addEventListener("input", () => {
    if (input.value === "/") { input.value = ""; toggleQuickReplies(true); }
  });
}

function renderChatSidePanel(lead) {
  const assignSelect = document.getElementById("chat-assign-select");
  if (assignSelect) assignSelect.value = lead.assignedTo || "";

  const tagsBox = document.getElementById("chat-tags-container");
  if (tagsBox) {
    tagsBox.innerHTML = (lead.tags || []).map(t =>
      `<span style="font-size:11px; padding:3px 9px; border-radius:10px; background:rgba(108,92,231,.2); color:#a29bfe; display:inline-flex; align-items:center; gap:5px;">${t}<b style="cursor:pointer;" data-tag="${t}">×</b></span>`
    ).join("");
    tagsBox.querySelectorAll("b[data-tag]").forEach(x => {
      x.addEventListener("click", async () => {
        lead.tags = (lead.tags || []).filter(t => t !== x.dataset.tag);
        await window.ApexAPI.inbox.setTags(lead.id, lead.tags);
        renderChatSidePanel(lead);
        renderChatList();
      });
    });
  }
}

async function toggleQuickReplies(forceOpen = false) {
  const picker = document.getElementById("quick-replies-picker");
  if (!picker) return;
  const isOpen = picker.style.display !== "none";
  if (isOpen && !forceOpen) { picker.style.display = "none"; return; }

  picker.style.display = "";
  picker.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:8px;">Carregando...</div>`;
  const res = await window.ApexAPI.quickReplies.list();
  const items = res.success ? res.data : [];

  picker.innerHTML = "";
  items.forEach(qr => {
    const row = document.createElement("div");
    row.style.cssText = "padding:8px 10px; border-radius:8px; cursor:pointer; display:flex; gap:10px; align-items:center;";
    row.onmouseenter = () => row.style.background = "var(--bg-tertiary)";
    row.onmouseleave = () => row.style.background = "transparent";
    row.innerHTML = `<span style="font-size:11px; font-weight:700; color:var(--color-primary); min-width:70px;">/${qr.shortcut}</span><span style="font-size:12px; color:var(--text-white); flex:1;">${qr.content.substring(0, 60)}</span><b style="color:#ef4444; cursor:pointer;" title="Excluir">×</b>`;
    row.querySelector("b").addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.ApexAPI.quickReplies.remove(qr.id);
      toggleQuickReplies(true);
    });
    row.addEventListener("click", () => {
      const input = document.getElementById("chat-message-input");
      const lead = state.leads.find(l => l.id === state.activeChatLeadId);
      input.value = qr.content.replace(/\{nome\}/gi, lead ? lead.name.split(" ")[0] : "");
      picker.style.display = "none";
      input.focus();
    });
    picker.appendChild(row);
  });

  const addRow = document.createElement("div");
  addRow.style.cssText = "padding:8px 10px; font-size:12px; color:var(--color-primary); cursor:pointer; border-top:1px solid var(--bg-tertiary); margin-top:4px;";
  addRow.textContent = "+ Criar resposta rápida";
  addRow.addEventListener("click", async () => {
    const shortcut = prompt("Atalho (ex: boasvindas):");
    if (!shortcut) return;
    const content = prompt("Texto da resposta (use {nome} para personalizar):");
    if (!content) return;
    await window.ApexAPI.quickReplies.create(shortcut.replace(/\W/g, ""), content);
    toggleQuickReplies(true);
  });
  picker.appendChild(addRow);
}

/* ==========================================================================
   BUILDER DE AUTOMAÇÕES — gatilho → condição → ação
   ========================================================================== */
const TRIGGER_LABELS = {
  new_contact: "👤 Novo contato",
  new_message: "💬 Nova mensagem",
  stage_change: "📊 Mudança de etapa",
  tag_added: "🏷️ Tag adicionada",
  inactivity: "⏰ Inatividade 24h+",
  appointment_created: "📅 Agendamento criado",
};
const ACTION_LABELS = {
  send_message: "Enviar WhatsApp",
  add_tag: "Adicionar tag",
  move_stage: "Mover etapa",
  notify_team: "Notificar equipe",
};

function initAutomationBuilder() {
  const btnNew = document.getElementById("btn-new-automation");
  if (!btnNew) return;

  btnNew.addEventListener("click", () => {
    document.getElementById("form-automation").reset();
    document.getElementById("automation-id").value = "";
    document.getElementById("modal-automation-title").textContent = "Nova Automação";
    openModal("modal-automation");
  });
  document.getElementById("modal-automation-close").addEventListener("click", () => closeModal("modal-automation"));
  document.getElementById("btn-cancel-automation").addEventListener("click", () => closeModal("modal-automation"));

  document.getElementById("form-automation").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("automation-id").value;
    const data = {
      name: document.getElementById("automation-name").value.trim(),
      trigger_type: document.getElementById("automation-trigger").value,
      conditions: { raw: document.getElementById("automation-condition").value.trim() || null },
      actions: [{
        type: document.getElementById("automation-action").value,
        value: document.getElementById("automation-action-value").value.trim(),
      }],
      is_active: true,
    };
    const res = id
      ? await window.ApexAPI.automationsBuilder.update(id, data)
      : await window.ApexAPI.automationsBuilder.create(data);
    if (res.success) {
      showToast("Automação salva! ⚡", "success");
      closeModal("modal-automation");
      renderAutomationsList();
    } else {
      showToast("Erro ao salvar automação.", "danger");
    }
  });

  renderAutomationsList();
}

async function renderAutomationsList() {
  const container = document.getElementById("automations-list");
  if (!container) return;
  const res = await window.ApexAPI.automationsBuilder.list();
  const items = res.success ? res.data : [];

  if (items.length === 0) {
    container.innerHTML = `<div style="font-size:13px; color:var(--text-muted);">Nenhuma automação ainda. Crie a primeira — ex: enviar boas-vindas quando um novo contato chegar.</div>`;
    return;
  }

  container.innerHTML = "";
  items.forEach(a => {
    const action = (a.actions && a.actions[0]) || {};
    const row = document.createElement("div");
    row.className = "card";
    row.style.cssText = "padding:14px 18px; display:flex; align-items:center; gap:14px; background:var(--bg-tertiary);";
    row.innerHTML = `
      <label style="position:relative; display:inline-block; width:36px; height:20px; flex-shrink:0;">
        <input type="checkbox" ${a.is_active ? "checked" : ""} style="opacity:0; width:0; height:0;">
        <span style="position:absolute; inset:0; border-radius:20px; background:${a.is_active ? "var(--color-primary)" : "#444"}; transition:.2s;"></span>
        <span style="position:absolute; top:2px; left:${a.is_active ? "18px" : "2px"}; width:16px; height:16px; border-radius:50%; background:#fff; transition:.2s;"></span>
      </label>
      <div style="flex:1;">
        <div style="font-weight:700; color:var(--text-white); font-size:14px;">${a.name}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">
          ${TRIGGER_LABELS[a.trigger_type] || a.trigger_type} → ${ACTION_LABELS[action.type] || action.type || "?"}
          ${action.value ? `: "${String(action.value).substring(0, 50)}..."` : ""}
        </div>
      </div>
      <span style="font-size:11px; color:var(--text-muted);">${a.runs_count || 0} execuções</span>
      <button class="btn btn-secondary btn-sm" data-act="del" style="color:#ef4444;">Excluir</button>
    `;
    row.querySelector("input[type=checkbox]").addEventListener("change", async (e) => {
      await window.ApexAPI.automationsBuilder.update(a.id, { is_active: e.target.checked });
      renderAutomationsList();
    });
    row.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`Excluir a automação "${a.name}"?`)) return;
      await window.ApexAPI.automationsBuilder.remove(a.id);
      renderAutomationsList();
    });
    container.appendChild(row);
  });
}

/* ==========================================================================
   METAS & VENDAS — funil, meta×realizado, resumo anual (substitui a planilha)
   ========================================================================== */
const MES_NOMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function initMetas() {
  const mSel = document.getElementById('metas-month');
  const ySel = document.getElementById('metas-year');
  if (!mSel || !ySel) return;

  const now = new Date();
  mSel.innerHTML = MES_NOMES.map((n, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${n}</option>`).join('');
  const anoAtual = now.getFullYear();
  ySel.innerHTML = [anoAtual - 1, anoAtual, anoAtual + 1].map(y => `<option value="${y}" ${y === anoAtual ? 'selected' : ''}>${y}</option>`).join('');

  mSel.addEventListener('change', renderMetas);
  ySel.addEventListener('change', renderMetas);

  // Modal de metas
  document.getElementById('btn-edit-goals').addEventListener('click', openGoalsModal);
  document.getElementById('modal-goals-close').addEventListener('click', () => closeModal('modal-goals'));
  document.getElementById('btn-cancel-goals').addEventListener('click', () => closeModal('modal-goals'));
  document.getElementById('form-goals').addEventListener('submit', handleGoalsSubmit);

  // Modal de detalhamento
  const dc = document.getElementById('modal-metas-detail-close');
  if (dc) dc.addEventListener('click', () => closeModal('modal-metas-detail'));
}

function metasPeriodo() {
  return {
    year: parseInt(document.getElementById('metas-year').value),
    month: parseInt(document.getElementById('metas-month').value)
  };
}

async function renderMetas() {
  const { year, month } = metasPeriodo();
  await loadMetasData(year, month);

  // Sincroniza agenda+vendas do Clinicorp em background e recarrega quando terminar
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${new Date(year, month, 0).getDate()}`;
  const badge = document.getElementById('metas-sync-badge');
  if (badge) badge.textContent = '⟳ sincronizando Clinicorp...';
  window.ApexAPI.agenda.syncMonth(from, to).then(res => {
    if (badge) badge.textContent = res.success ? '✓ sincronizado com Clinicorp' : '';
    // recarrega só se ainda estiver no mesmo mês
    const p = metasPeriodo();
    if (p.year === year && p.month === month) loadMetasData(year, month);
  });
}

async function loadMetasData(year, month) {
  const [mRes, gRes] = await Promise.all([
    window.ApexAPI.metas.monthMetrics(year, month),
    window.ApexAPI.metas.getGoal(year, month)
  ]);
  const m = mRes.success ? mRes.data : {};
  const g = gRes.success ? (gRes.data || {}) : {};
  renderFunnel(m);
  renderGoalsCards(m, g);
  renderYearTable(year);
  renderFinance(year, month);
}

async function renderFinance(year, month) {
  const cont = document.getElementById('metas-finance');
  if (!cont) return;
  const res = await window.ApexAPI.metas.finance(year, month);
  const f = (res.success && res.data && res.data[0]) ? res.data[0] : null;
  if (!f) { cont.innerHTML = `<div style="grid-column:1/-1; font-size:13px; color:var(--text-muted);">Sincronizando financeiro do Clinicorp...</div>`; return; }
  const card = (label, val, cor) => `
    <div class="card" style="padding:18px;">
      <div style="font-size:12px; color:var(--text-muted);">${label}</div>
      <div style="font-size:24px; font-weight:800; color:${cor}; margin-top:4px;">${formatCurrency(val || 0)}</div>
    </div>`;
  const net = f.net || 0;
  cont.innerHTML =
    card('Entradas', f.credit, '#10b981') +
    card('Saídas', f.debit, '#ef4444') +
    card('Saldo', net, net >= 0 ? '#10b981' : '#ef4444');
}

function renderFunnel(m) {
  const cont = document.getElementById('metas-funnel');
  if (!cont) return;
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  const etapas = [
    { label: 'Leads', metric: 'leads', val: m.leads || 0, cor: '#6366f1', taxa: null },
    { label: 'Agendamentos', metric: 'agendamentos', val: m.agendamentos || 0, cor: '#a29bfe', taxa: `${pct(m.taxa_lead_agend)} dos leads` },
    { label: 'Comparecimentos', metric: 'comparecimentos', val: m.comparecimentos || 0, cor: '#74b9ff', taxa: `${pct(m.taxa_agend_comp)} dos agend.` },
    { label: 'Vendas', metric: 'vendas', val: m.vendas || 0, cor: '#10b981', taxa: `${pct(m.taxa_comp_venda)} dos compar.` },
  ];
  cont.innerHTML = etapas.map(e => `
    <div class="card metric-drill" data-metric="${e.metric}" style="padding:18px; border-top:3px solid ${e.cor}; cursor:pointer; transition:transform .1s;" title="Clique para ver a lista">
      <div style="font-size:12px; color:var(--text-muted);">${e.label} <span style="opacity:.5;">↗</span></div>
      <div style="font-size:30px; font-weight:800; color:var(--text-white); margin:4px 0;">${e.val}</div>
      <div style="font-size:11px; color:var(--text-muted);">${e.taxa || '&nbsp;'}</div>
    </div>
  `).join('');
  cont.querySelectorAll('.metric-drill').forEach(el => {
    el.addEventListener('click', () => openMetasDetail(el.dataset.metric));
    el.addEventListener('mouseenter', () => el.style.transform = 'translateY(-2px)');
    el.addEventListener('mouseleave', () => el.style.transform = 'none');
  });
}

// ==========================================================================
// Detalhamento dos leads / agendamentos / comparecimentos (modal)
// ==========================================================================
async function openMetasDetail(metric) {
  const { year, month } = metasPeriodo();
  const titulo = { leads:'Leads', agendamentos:'Agendamentos', comparecimentos:'Comparecimentos', vendas:'Vendas' }[metric] || metric;
  document.getElementById('metas-detail-title').textContent = `${titulo} — ${MES_NOMES[month-1]}/${year}`;
  const body = document.getElementById('metas-detail-body');
  body.innerHTML = '<div style="padding:20px; color:var(--text-muted);">Carregando...</div>';
  openModal('modal-metas-detail');

  const res = await window.ApexAPI.metas.detail(metric, year, month);
  if (!res.success) { body.innerHTML = `<div style="padding:20px; color:#ef4444;">Erro: ${res.error||''}</div>`; return; }
  const rows = res.data || [];
  if (!rows.length) { body.innerHTML = `<div style="padding:20px; color:var(--text-muted);">Nenhum registro nesse mês.</div>`; return; }

  const esc = (s) => (s==null?'':String(s)).replace(/</g,'&lt;');
  const fmtDate = (d) => d ? String(d).split('T')[0].split('-').reverse().join('/') : '';
  let head, makeRow;
  if (metric === 'vendas') {
    head = '<th>Paciente</th><th>Valor</th><th>Data</th><th>Status</th>';
    makeRow = r => `<td>${esc(r.patient_name||'—')}</td><td>${formatCurrency(r.amount||0)}</td><td>${fmtDate(r.sale_date)}</td><td>${esc(r.status||'')}</td>`;
  } else if (metric === 'leads') {
    head = '<th>Nome</th><th>Telefone</th><th>Origem</th><th>Status/Tags</th><th>Cadastro</th>';
    makeRow = r => `<td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.source||'')}</td><td>${esc((r.tags||[]).join(', '))}</td><td>${fmtDate(r.created_at)}</td>`;
  } else {
    head = '<th>Paciente</th><th>Telefone</th><th>Data</th><th>Hora</th><th>Procedimento</th><th>Status</th>';
    makeRow = r => `<td>${esc(r.patient_name)}</td><td>${esc(r.phone||'')}</td><td>${fmtDate(r.appt_date)}</td><td>${esc(r.from_time||'')}</td><td>${esc(r.category||'')}</td><td>${esc(r.status||'')}</td>`;
  }
  body.innerHTML = `
    <div style="font-size:13px; color:var(--text-muted); margin-bottom:10px;">${rows.length} registro(s)</div>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead><tr style="text-align:left; color:var(--text-muted); border-bottom:1px solid var(--bg-tertiary);">${head}</tr></thead>
      <tbody>${rows.map(r=>`<tr style="border-bottom:1px solid rgba(255,255,255,.04);">${makeRow(r)}</tr>`).join('')}</tbody>
    </table>`;
}

function renderGoalsCards(m, g) {
  const cont = document.getElementById('metas-goals');
  if (!cont) return;
  const card = (titulo, real, meta, fmt) => {
    const metaNum = parseFloat(meta || 0);
    const realNum = parseFloat(real || 0);
    const pct = metaNum > 0 ? Math.min(100, Math.round((realNum / metaNum) * 100)) : 0;
    const cor = pct >= 100 ? '#10b981' : (pct >= 60 ? '#f59e0b' : '#6366f1');
    return `
      <div class="card" style="padding:18px;">
        <div style="font-size:13px; color:var(--text-muted); margin-bottom:6px;">${titulo}</div>
        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <span style="font-size:22px; font-weight:800; color:var(--text-white);">${fmt(realNum)}</span>
          <span style="font-size:12px; color:var(--text-muted);">meta ${metaNum > 0 ? fmt(metaNum) : '—'}</span>
        </div>
        <div style="height:7px; background:var(--bg-tertiary); border-radius:6px; margin-top:10px; overflow:hidden;">
          <div style="height:100%; width:${pct}%; background:${cor};"></div>
        </div>
        <div style="font-size:11px; color:${cor}; margin-top:5px;">${metaNum > 0 ? pct + '% da meta' : 'defina a meta'}</div>
      </div>`;
  };
  const money = (v) => formatCurrency(v);
  const num = (v) => Math.round(v).toString();
  cont.innerHTML =
    card('Faturamento', m.faturamento, g.meta_faturamento, money) +
    card('Vendas', m.vendas, g.meta_vendas, num) +
    card('Leads', m.leads, g.meta_leads, num) +
    card('Agendamentos', m.agendamentos, g.meta_agendamentos, num) +
    card('Comparecimentos', m.comparecimentos, g.meta_comparecimentos, num) +
    card('Ticket médio', m.ticket_medio, g.meta_ticket_medio, money);
}

async function renderYearTable(year) {
  const table = document.getElementById('metas-year-table');
  if (!table) return;
  const res = await window.ApexAPI.metas.yearSummary(year);
  const meses = res.success ? res.data : [];
  const money = (v) => formatCurrency(v || 0);
  let head = `<thead><tr style="text-align:left; color:var(--text-muted); border-bottom:1px solid var(--bg-tertiary);">
    <th style="padding:8px;">Mês</th><th>Leads</th><th>Agend.</th><th>Compar.</th><th>Vendas</th><th>Faturamento</th><th>Entrada</th></tr></thead>`;
  let tot = { leads: 0, agendamentos: 0, comparecimentos: 0, vendas: 0, faturamento: 0, entrada: 0 };
  let rows = (meses || []).map((m, i) => {
    ['leads','agendamentos','comparecimentos','vendas','faturamento','entrada'].forEach(k => tot[k] += (m[k] || 0));
    const vazio = !(m.leads || m.agendamentos || m.vendas || m.faturamento);
    return `<tr style="border-bottom:1px solid rgba(255,255,255,.04); ${vazio ? 'opacity:.4;' : ''}">
      <td style="padding:8px; color:var(--text-white);">${MES_NOMES[i]}</td>
      <td>${m.leads || 0}</td><td>${m.agendamentos || 0}</td><td>${m.comparecimentos || 0}</td>
      <td>${m.vendas || 0}</td><td>${money(m.faturamento)}</td><td>${money(m.entrada)}</td></tr>`;
  }).join('');
  let footer = `<tr style="border-top:2px solid var(--bg-tertiary); font-weight:700; color:var(--text-white);">
    <td style="padding:8px;">Total</td><td>${tot.leads}</td><td>${tot.agendamentos}</td><td>${tot.comparecimentos}</td>
    <td>${tot.vendas}</td><td>${money(tot.faturamento)}</td><td>${money(tot.entrada)}</td></tr>`;
  table.innerHTML = head + '<tbody>' + rows + footer + '</tbody>';
}

async function openGoalsModal() {
  const { year, month } = metasPeriodo();
  document.getElementById('modal-goals-title').textContent = `Metas — ${MES_NOMES[month - 1]}/${year}`;
  const res = await window.ApexAPI.metas.getGoal(year, month);
  const g = res.success && res.data ? res.data : {};
  document.getElementById('goal-faturamento').value = g.meta_faturamento || '';
  document.getElementById('goal-vendas').value = g.meta_vendas || '';
  document.getElementById('goal-leads').value = g.meta_leads || '';
  document.getElementById('goal-agendamentos').value = g.meta_agendamentos || '';
  document.getElementById('goal-comparecimentos').value = g.meta_comparecimentos || '';
  document.getElementById('goal-ticket').value = g.meta_ticket_medio || '';
  document.getElementById('goal-dias').value = g.dias_trabalhados || '';
  document.getElementById('goal-marketing').value = g.investimento_marketing || '';
  openModal('modal-goals');
}

async function handleGoalsSubmit(e) {
  e.preventDefault();
  const { year, month } = metasPeriodo();
  const num = (id) => parseFloat(document.getElementById(id).value) || 0;
  const goal = {
    year, month,
    meta_faturamento: num('goal-faturamento'),
    meta_vendas: num('goal-vendas'),
    meta_leads: num('goal-leads'),
    meta_agendamentos: num('goal-agendamentos'),
    meta_comparecimentos: num('goal-comparecimentos'),
    meta_ticket_medio: num('goal-ticket'),
    dias_trabalhados: num('goal-dias') || 22,
    investimento_marketing: num('goal-marketing'),
  };
  const res = await window.ApexAPI.metas.saveGoal(goal);
  if (res.success) {
    showToast('Metas salvas! 🎯', 'success');
    closeModal('modal-goals');
    renderMetas();
  } else {
    showToast('Erro ao salvar metas: ' + (res.error || ''), 'danger');
  }
}

/* ==========================================================================
   Follow-up: orçamentos em aberto + cadência de resgate de faltas
   ========================================================================== */
const CC_LABEL = {
  OPEN: { txt: 'Em aberto', color: '#3b82f6' },
  FOLLOWUP: { txt: 'Follow-up', color: '#f59e0b' },
};
const CAD_SIT = {
  active: { txt: 'Na cadência', color: '#3b82f6' },
  responded: { txt: 'Respondeu', color: '#10b981' },
  rescheduled: { txt: 'Reagendou', color: '#10b981' },
  completed: { txt: 'Concluída', color: '#94a3b8' },
  paused_human: { txt: 'Humano assumiu', color: '#94a3b8' },
  stopped: { txt: 'Parada', color: '#94a3b8' },
};

function waLink(phoneRaw) {
  const d = String(phoneRaw || '').replace(/\D/g, '');
  if (!d) return null;
  return `https://wa.me/${d.startsWith('55') ? d : '55' + d}`;
}

async function renderFollowup() {
  // troca de sub-abas
  document.querySelectorAll('.followup-tab').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      document.querySelectorAll('.followup-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.futab;
      document.getElementById('futab-orcamentos').style.display = tab === 'orcamentos' ? '' : 'none';
      document.getElementById('futab-faltas').style.display = tab === 'faltas' ? '' : 'none';
    });
  });
  await renderOpenBudgets();
  await renderCadencePanel();
}

async function renderOpenBudgets() {
  const body = document.getElementById('followup-body');
  const summary = document.getElementById('followup-summary');
  if (!body) return;
  body.innerHTML = '<tr><td style="padding:14px; color:var(--text-muted);" colspan="5">Carregando...</td></tr>';
  const res = await window.ApexAPI.followup.openBudgets();
  const rows = (res.success ? res.data : []) || [];
  const total = rows.reduce((a, r) => a + parseFloat(r.clinicorp_amount || 0), 0);
  const nFup = rows.filter(r => r.clinicorp_status === 'FOLLOWUP').length;
  const card = (label, val, cor) => `<div class="card" style="padding:16px; min-width:170px;"><div style="font-size:12px; color:var(--text-muted);">${label}</div><div style="font-size:22px; font-weight:800; color:${cor || 'var(--text-white)'}; margin-top:4px;">${val}</div></div>`;
  summary.innerHTML =
    card('Pacientes com orçamento aberto', rows.length) +
    card('Valor total em jogo', formatCurrency(total), '#10b981') +
    card('Em follow-up', nFup, '#f59e0b');

  if (!rows.length) { body.innerHTML = '<tr><td style="padding:14px; color:var(--text-muted);" colspan="5">Nenhum orçamento em aberto 🎉</td></tr>'; return; }
  const esc = (s) => (s == null ? '' : String(s)).replace(/</g, '&lt;');
  const fmtDate = (d) => d ? String(d).split('T')[0].split('-').reverse().join('/') : '';
  body.innerHTML = rows.map(r => {
    const st = CC_LABEL[r.clinicorp_status] || { txt: r.clinicorp_status, color: '#94a3b8' };
    const btn = `<button class="btn btn-primary" style="padding:6px 12px; font-size:12px;" onclick="openInboxForLead('${r.id}')">💬 Atender</button>`;
    return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);">
      <td style="padding:12px; cursor:pointer;" onclick="openPatientFicha('${r.id}')"><span style="font-weight:600;">${esc(r.name)}</span></td>
      <td style="padding:12px;"><span style="color:${st.color}; font-weight:600;">${st.txt}</span></td>
      <td style="padding:12px; font-weight:700;">${formatCurrency(r.clinicorp_amount || 0)}</td>
      <td style="padding:12px; color:var(--text-muted);">${fmtDate(r.clinicorp_date)}</td>
      <td style="padding:12px;">${btn}</td>
    </tr>`;
  }).join('');
}

let CADENCE_CACHE = null;
async function renderCadencePanel() {
  const res = await window.ApexAPI.followup.getCadence();
  if (!res.success) return;
  const cad = res.data; CADENCE_CACHE = cad;
  const steps = [...(cad.steps || [])].sort((a, b) => a.step - b.step);

  // toggle liga/desliga
  const toggle = document.getElementById('cadence-toggle');
  const label = document.getElementById('cadence-status-label');
  toggle.checked = !!cad.active;
  label.textContent = cad.active ? 'Ligada' : 'Desligada';
  label.style.color = cad.active ? '#10b981' : 'var(--text-muted)';
  if (!toggle.dataset.bound) {
    toggle.dataset.bound = '1';
    toggle.addEventListener('change', async () => {
      const on = toggle.checked;
      if (on && !confirm('Ligar a cadência? A Layla passará a enviar mensagens automáticas (WhatsApp real) para quem faltou, de hora em hora, das 9h às 18h.')) {
        toggle.checked = false; return;
      }
      const upd = await window.ApexAPI.followup.saveCadence(cad.id, { active: on });
      if (upd.success) { showToast(on ? 'Cadência ligada ✅' : 'Cadência desligada', on ? 'success' : 'info'); renderCadencePanel(); }
      else { showToast('Erro ao alterar: ' + (upd.error || ''), 'danger'); toggle.checked = !on; }
    });
  }

  // mensagens editáveis
  const box = document.getElementById('cadence-messages');
  const rotulo = ['1º toque (mesmo dia)', '2º toque (+2 dias)', '3º toque (+5 dias)', '4º toque (+10 dias)'];
  box.innerHTML = steps.map((s, i) => `
    <div class="card" style="padding:14px; margin-bottom:10px;">
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:6px;">${rotulo[i] || ('Toque ' + s.step)}</div>
      <textarea data-step="${s.step}" class="form-control cadence-msg" rows="3" style="width:100%; resize:vertical;">${(s.message || '').replace(/</g, '&lt;')}</textarea>
    </div>`).join('');

  const saveBtn = document.getElementById('cadence-save-msgs');
  if (!saveBtn.dataset.bound) {
    saveBtn.dataset.bound = '1';
    saveBtn.addEventListener('click', async () => {
      const base = [...(CADENCE_CACHE.steps || [])].sort((a, b) => a.step - b.step);
      const newSteps = base.map(s => {
        const ta = document.querySelector(`.cadence-msg[data-step="${s.step}"]`);
        return { ...s, message: ta ? ta.value : s.message };
      });
      const upd = await window.ApexAPI.followup.saveCadence(CADENCE_CACHE.id, { steps: newSteps });
      if (upd.success) { showToast('Mensagens salvas ✅', 'success'); renderCadencePanel(); }
      else showToast('Erro ao salvar: ' + (upd.error || ''), 'danger');
    });
  }

  // estatísticas + inscrições
  const enr = await window.ApexAPI.followup.enrollments();
  const list = (enr.success ? enr.data : []) || [];
  const byStatus = list.reduce((m, e) => { m[e.status] = (m[e.status] || 0) + 1; return m; }, {});
  const stat = (label, val, cor) => `<div class="card" style="padding:14px; min-width:130px;"><div style="font-size:12px; color:var(--text-muted);">${label}</div><div style="font-size:20px; font-weight:800; color:${cor || 'var(--text-white)'}; margin-top:4px;">${val}</div></div>`;
  document.getElementById('cadence-stats').innerHTML =
    stat('Na cadência', byStatus.active || 0, '#3b82f6') +
    stat('Responderam', byStatus.responded || 0, '#10b981') +
    stat('Reagendaram', byStatus.rescheduled || 0, '#10b981') +
    stat('Concluídas', byStatus.completed || 0);

  const tbody = document.getElementById('cadence-enrollments');
  const esc = (s) => (s == null ? '' : String(s)).replace(/</g, '&lt;');
  const fmtDT = (d) => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  if (!list.length) {
    tbody.innerHTML = '<tr><td style="padding:14px; color:var(--text-muted);" colspan="4">Ninguém na cadência ainda. Quando alguém do funil faltar, entra aqui automaticamente (com a cadência ligada).</td></tr>';
  } else {
    tbody.innerHTML = list.map(e => {
      const sit = CAD_SIT[e.status] || { txt: e.status, color: '#94a3b8' };
      return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);">
        <td style="padding:12px; font-weight:600;">${esc(e.patient_name || e.phone)}</td>
        <td style="padding:12px;">${e.current_step}/4</td>
        <td style="padding:12px; color:var(--text-muted);">${e.status === 'active' ? fmtDT(e.next_send_at) : '—'}</td>
        <td style="padding:12px;"><span style="color:${sit.color}; font-weight:600;">${sit.txt}</span></td>
      </tr>`;
    }).join('');
  }

  // faltantes do funil (no-shows) com a situação por telefone
  const enrByPhone = {};
  list.forEach(e => { const k = String(e.phone || '').replace(/\D/g, '').slice(-8); if (k) enrByPhone[k] = e.status; });
  await renderNoShows(enrByPhone);
}

function openFichaByPhone(phone) {
  const k = String(phone || '').replace(/\D/g, '').slice(-8);
  const lead = state.leads.find(l => String(l.phoneRaw || '').replace(/\D/g, '').slice(-8) === k);
  if (lead) openPatientFicha(lead.id);
}

// Abre a conversa do paciente DENTRO do Multiatendimento (painel de chat)
window.openInboxForLead = function(leadId) {
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead) { showToast('Paciente não encontrado no CRM.', 'warning'); return; }
  // troca para o painel de chat
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.content-panel').forEach(p => p.classList.remove('active'));
  const nav = [...document.querySelectorAll('.nav-item')].find(n => n.getAttribute('data-panel') === 'chat');
  if (nav) nav.classList.add('active');
  const panel = document.getElementById('panel-chat');
  if (panel) panel.classList.add('active');
  const title = document.getElementById('header-active-title');
  if (title && nav) title.textContent = nav.textContent.trim();
  const modal = document.getElementById('modal-patient-ficha');
  if (modal) modal.classList.remove('active');
  renderChatList();
  selectActiveChat(leadId);
};
window.openInboxByPhone = function(phone) {
  const k = String(phone || '').replace(/\D/g, '').slice(-8);
  const lead = state.leads.find(l => String(l.phoneRaw || '').replace(/\D/g, '').slice(-8) === k);
  if (!lead) { showToast('Paciente ainda não está no Multiatendimento.', 'warning'); return; }
  openInboxForLead(lead.id);
};

async function renderNoShows(enrByPhone) {
  const body = document.getElementById('noshow-body');
  const countEl = document.getElementById('noshow-count');
  if (!body) return;
  body.innerHTML = '<tr><td style="padding:14px; color:var(--text-muted);" colspan="5">Carregando...</td></tr>';
  const res = await window.ApexAPI.followup.noShows();
  const rows = (res.success ? res.data : []) || [];
  // dedup por telefone, mantém a falta mais recente (já vem ordenado desc)
  const seen = new Set(); const uniq = [];
  for (const r of rows) { const k = String(r.phone || '').replace(/\D/g, '').slice(-8); if (!k || seen.has(k)) continue; seen.add(k); uniq.push(r); }
  if (countEl) countEl.textContent = `(${uniq.length} pacientes)`;
  if (!uniq.length) { body.innerHTML = '<tr><td style="padding:14px; color:var(--text-muted);" colspan="5">Nenhum faltante do funil 🎉</td></tr>'; return; }

  const esc = (s) => (s == null ? '' : String(s)).replace(/</g, '&lt;');
  const fmtDate = (d) => d ? String(d).split('T')[0].split('-').reverse().join('/') : '';
  body.innerHTML = uniq.map(r => {
    const k = String(r.phone || '').replace(/\D/g, '').slice(-8);
    const st = enrByPhone[k];
    const sit = st ? (CAD_SIT[st] || { txt: st, color: '#94a3b8' }) : { txt: 'Não contatado', color: '#94a3b8' };
    const phoneDigits = String(r.phone || '').replace(/\D/g, '');
    const btn = phoneDigits
      ? `<button class="btn btn-primary" style="padding:6px 12px; font-size:12px;" onclick="openInboxByPhone('${phoneDigits}')">💬 Atender</button>`
      : '<span style="color:var(--text-muted); font-size:12px;">sem telefone</span>';
    return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);">
      <td style="padding:12px; cursor:pointer;" onclick="openFichaByPhone('${phoneDigits}')"><span style="font-weight:600;">${esc(r.patient_name || 'Sem nome')}</span></td>
      <td style="padding:12px; color:var(--text-muted);">${fmtDate(r.appt_date)}</td>
      <td style="padding:12px; color:var(--text-muted);">${esc(r.category || '—')}</td>
      <td style="padding:12px;"><span style="color:${sit.color}; font-weight:600;">${sit.txt}</span></td>
      <td style="padding:12px;">${btn}</td>
    </tr>`;
  }).join('');
}
