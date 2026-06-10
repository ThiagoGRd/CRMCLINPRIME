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

// Mapeamentos de Estágios: HTML Kanban <=> IDs do Banco de Dados
const STAGE_MAP = {
  'lead': '9cc16adf-3c10-491a-95a3-697bfeaff056',        // Pré-Avaliação
  'contacted': '8570e7f9-90d1-4bc2-b703-00c2517fb310',   // Consulta Agendada
  'proposal': 'e7ba0e1d-fa8c-4154-8e0e-235bfc4ed11d',    // Avaliação Realizada
  'negotiating': 'b15655e9-f800-48af-be45-26bf6ed3c6b1', // Orçamento Enviado
  'won': 'ac959a7f-a337-4a78-8c1a-f18edb24be4a',         // Tratamento Iniciado
  'concluded': 'cf96c3c6-02fc-425c-9b0a-cfb50aaf4f01'     // Concluído
};

const STAGE_REV_MAP = {
  '9cc16adf-3c10-491a-95a3-697bfeaff056': 'lead',
  '8570e7f9-90d1-4bc2-b703-00c2517fb310': 'contacted',
  'e7ba0e1d-fa8c-4154-8e0e-235bfc4ed11d': 'proposal',
  'b15655e9-f800-48af-be45-26bf6ed3c6b1': 'negotiating',
  'ac959a7f-a337-4a78-8c1a-f18edb24be4a': 'won',
  'cf96c3c6-02fc-425c-9b0a-cfb50aaf4f01': 'concluded'
};

// Inicialização da Aplicação
document.addEventListener("DOMContentLoaded", async () => {
  showToast("Conectando ao banco de dados Supabase...", "info");
  
  // Executa carga inicial de dados
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
  
  // Verificar conexão inicial do WhatsApp
  if (window.ApexAPI && window.ApexAPI.checkWhatsAppConnection) {
    window.ApexAPI.checkWhatsAppConnection();
  }
});

// Sincronizar estado com o Banco de Dados Real (Substitui o localStorage antigo)
async function refreshState() {
  if (!window.ApexAPI) {
    console.error("Camada de API Client (api-client.js) não foi carregada.");
    return;
  }

  try {
    // 1. Carregar Pacientes
    const patientsRes = await window.ApexAPI.patients.getAll();
    if (patientsRes.success) {
      state.leads = patientsRes.data.map(p => ({
        id: p.id,
        name: p.name,
        email: p.email || '',
        phone: formatPhoneDisplay(p.phone),
        value: parseFloat(p.treatment_value || 0),
        stage: STAGE_REV_MAP[p.deal?.[0]?.stage_id || p.deal?.stage_id] || 'lead',
        source: p.treatment_interest || p.source || 'Geral',
        unread: 0,
        messages: [] // mensagens são carregadas sob demanda para economizar tráfego
      }));
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
          time: `${h}:${mi}`
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
        initCalendar();
      } else if (panelId === 'chat') {
        renderChatList();
        renderActiveChat();
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
}

function initCharts() {
  const ctx = document.getElementById('salesChart');
  if (!ctx) return;
  
  if (salesChartInstance) {
    salesChartInstance.destroy();
  }
  
  const salesData = [18000, 24000, 19000, 32000, 28000, 42000];
  const targetData = [20000, 20000, 25000, 25000, 30000, 30000];
  
  salesChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['Semana 1', 'Semana 2', 'Semana 3', 'Semana 4', 'Semana 5', 'Semana 6'],
      datasets: [
        {
          label: 'Planos Contratados',
          data: salesData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.05)',
          borderWidth: 3,
          fill: true,
          tension: 0.4
        },
        {
          label: 'Meta da Clínica',
          data: targetData,
          borderColor: '#6366f1',
          borderDash: [5, 5],
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
function initKanban() {
  const stages = ['lead', 'contacted', 'proposal', 'negotiating', 'won'];
  
  stages.forEach(stage => {
    const wrapper = document.getElementById(`cards-${stage}`);
    if (!wrapper) return;
    
    wrapper.innerHTML = "";
    
    const stageLeads = state.leads.filter(l => l.stage === stage);
    
    const countEl = document.getElementById(`count-${stage}`);
    const valueEl = document.getElementById(`value-${stage}`);
    
    if (countEl) countEl.textContent = stageLeads.length;
    
    const totalVal = stageLeads.reduce((acc, l) => acc + parseFloat(l.value || 0), 0);
    if (valueEl) valueEl.textContent = formatCurrency(totalVal);
    
    stageLeads.forEach(lead => {
      const card = document.createElement("div");
      card.className = "kanban-card";
      card.draggable = true;
      card.id = lead.id;
      card.addEventListener("dragstart", dragStart);
      card.addEventListener("dragend", dragEnd);
      
      card.innerHTML = `
        <div class="kanban-card-title">${lead.name}</div>
        <span class="kanban-card-tag">${lead.source}</span>
        <div class="kanban-card-meta">
          <span class="kanban-card-value">${formatCurrency(lead.value)}</span>
          <span>${lead.phone}</span>
        </div>
      `;
      
      card.addEventListener("dblclick", () => openEditLeadModal(lead.id));
      wrapper.appendChild(card);
    });
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

window.drop = async function(e, targetStage) {
  e.preventDefault();
  if (!draggedCardId) return;
  
  const lead = state.leads.find(l => l.id === draggedCardId);
  if (lead && lead.stage !== targetStage) {
    try {
      // Buscar o deal real no pipeline do backend
      const pipelineRes = await window.ApexAPI.pipeline.getAll();
      if (pipelineRes.success) {
        let dealId = null;
        pipelineRes.data.forEach(st => {
          st.deals.forEach(d => {
            if (d.patient_id === draggedCardId) {
              dealId = d.id;
            }
          });
        });
        
        if (dealId) {
          const targetStageId = STAGE_MAP[targetStage];
          const moveRes = await window.ApexAPI.pipeline.moveDeal(dealId, targetStageId);
          if (moveRes.success) {
            showToast(`Paciente "${lead.name}" movido para: ${getStageName(targetStage)}!`, 'success');
            await refreshState();
            initKanban();
          }
        } else {
          showToast("Deal correspondente não encontrado no banco.", "warning");
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
  btnSuggestAI.addEventListener("click", generateIAScript);
  btnChatSchedule.addEventListener("click", openScheduleModalFromChat);
  
  renderChatList();

  // Polling global inteligente de 5s para o chat (atualiza contatos e mensagens em tempo real se o painel do chat estiver ativo)
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
              lead.messages = res.data.map(m => ({
                sender: m.direction === 'inbound' ? 'incoming' : 'outgoing',
                text: m.content,
                time: new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
              }));
              renderActiveChat();
            }
          }
        } catch (err) {
          console.warn("Falha no polling silencioso do chat ativo:", err.message);
        }
      }
    }
  }, 5000);
}

function renderChatList() {
  const container = document.getElementById("chat-list-container");
  if (!container) return;
  
  container.innerHTML = "";
  
  if (state.leads.length === 0) {
    container.innerHTML = `<div style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">Nenhum contato ativo.</div>`;
    return;
  }
  
  state.leads.forEach(lead => {
    const activeClass = state.activeChatLeadId === lead.id ? 'active' : '';
    const lastMsg = lead.messages && lead.messages.length > 0 
      ? lead.messages[lead.messages.length - 1].text 
      : "Clique para abrir o chat";
    const initials = lead.name.split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase();
    
    let badgeColor = '#10b981';
    if (state.activeChannel === 'instagram') badgeColor = 'var(--color-accent-purple)';
    if (state.activeChannel === 'email') badgeColor = 'var(--color-primary)';
    
    const unreadMarkup = lead.unread > 0 
      ? `<span class="badge badge-danger" style="margin-left:auto; border-radius:50%; width:18px; height:18px; padding:0; display:flex; align-items:center; justify-content:center; font-size:10px;">${lead.unread}</span>` 
      : '';
      
    const item = document.createElement("div");
    item.className = `chat-item ${activeClass}`;
    item.innerHTML = `
      <div class="chat-item-avatar">
        ${initials}
        <div class="chat-item-badge" style="background-color: ${badgeColor};"></div>
      </div>
      <div class="chat-item-details">
        <div class="chat-item-name">${lead.name}</div>
        <div class="chat-item-msg">${lastMsg}</div>
      </div>
      ${unreadMarkup}
    `;
    
    item.addEventListener("click", () => selectActiveChat(lead.id));
    container.appendChild(item);
  });
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
      lead.messages = res.data.map(m => ({
        sender: m.direction === 'inbound' ? 'incoming' : 'outgoing',
        text: m.content,
        time: new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      }));
      renderActiveChat();
    }
  } catch (err) {
    console.error(err);
    showToast("Erro ao carregar mensagens.", "danger");
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
    bubble.innerHTML = `
      <div>${msg.text}</div>
      <div class="chat-bubble-time">${msg.time}</div>
    `;
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
    
    const dayMeetings = state.meetings.filter(m => m.date === fullDateStr);
    let dotsHtml = "";
    dayMeetings.forEach(m => {
      dotsHtml += `<div class="calendar-event-dot" style="background-color: #10b981;" title="${m.title}"></div>`;
    });
    
    dayEl.innerHTML = `
      <span class="calendar-day-num">${d}</span>
      <div class="calendar-day-events">
        ${dotsHtml}
      </div>
    `;
    
    dayEl.addEventListener("click", () => {
      document.getElementById("meeting-date").value = fullDateStr;
      openModal("modal-meeting");
    });
    container.appendChild(dayEl);
  }
  
  btnPrev.replaceWith(btnPrev.cloneNode(true));
  btnNext.replaceWith(btnNext.cloneNode(true));
  
  document.getElementById("btn-calendar-prev").addEventListener("click", () => {
    state.calendarDate.setMonth(state.calendarDate.getMonth() - 1);
    initCalendar();
  });
  
  document.getElementById("btn-calendar-next").addEventListener("click", () => {
    state.calendarDate.setMonth(state.calendarDate.getMonth() + 1);
    initCalendar();
  });
  
  renderUpcomingAgenda();
}

function renderUpcomingAgenda() {
  const container = document.getElementById("agenda-list-container");
  if (!container) return;
  
  container.innerHTML = "";
  
  if (state.meetings.length === 0) {
    container.innerHTML = `<div style="font-size: 13px; color: var(--text-muted);">Nenhum agendamento para hoje.</div>`;
    return;
  }
  
  const sorted = [...state.meetings].sort((a, b) => new Date(a.date) - new Date(b.date));
  
  sorted.forEach(m => {
    const lead = state.leads.find(l => l.id === m.leadId);
    const leadName = lead ? lead.name : "Paciente não associado";
    const dateFormatted = m.date.split('-').reverse().join('/');
    
    container.innerHTML += `
      <div class="card agenda-item" style="background-color: var(--bg-tertiary); padding: 12px 16px; border-left-color:#10b981; margin-bottom: 8px;">
        <span class="agenda-time">${dateFormatted} às ${m.time}</span>
        <div class="agenda-title">${m.title}</div>
        <div class="agenda-contact">Paciente: ${leadName}</div>
      </div>
    `;
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

function sendAIMessage() {
  const input = document.getElementById("ai-chat-input");
  const container = document.getElementById("ai-chat-messages");
  
  if (!input || !input.value.trim()) return;
  const userText = input.value.trim();
  
  container.innerHTML += `<div class="ai-panel-bubble user">${userText}</div>`;
  input.value = "";
  container.scrollTop = container.scrollHeight;
  
  setTimeout(() => {
    let aiResponse = "Perfeito, Dr. Henrique. Posso auxiliar com scripts de Invisalign, implantes ou nos dashboards de agendamento do consultório. O que deseja?";
    
    if (userText.toLowerCase().includes("confirmação") || userText.toLowerCase().includes("melhorar")) {
      aiResponse = "Para melhorar a taxa de comparecimento (evitando faltas), recomendo programar um fluxo no n8n:<br>1. Enviar mensagem automática 24 horas antes solicitando confirmação rápida (sim/não).<br>2. Se o paciente não responder até 4 horas antes, disparar um alerta na recepção para uma ligação rápida.";
    } else if (userText.toLowerCase().includes("script") || userText.toLowerCase().includes("invisalign")) {
      aiResponse = "Aqui está um script de agendamento de Invisalign de alta conversão:<br><br><i>'Olá [Nome]! Tudo bem? O Dr. Henrique finalizou a simulação 3D do seu sorriso com Invisalign. Ficou sensacional! Ele tem horário nesta quinta às 14h ou 16h para te mostrar como seus dentes vão se mover. Qual horário fica melhor?'</i>";
    } else if (userText.toLowerCase().includes("n8n")) {
      aiResponse = "O n8n nos ajuda a conectar o consultório com tudo:<br>1. Quando um lead vem do Facebook Ads, o n8n cria a ficha no CRM.<br>2. O n8n chama a IA para triagem automática.<br>3. Dispara a mensagem no WhatsApp.<br>4. Se confirmado, atualiza a agenda no Google Calendar e notifica o dentista responsável. Tudo sem intervenção manual!";
    }
    
    container.innerHTML += `<div class="ai-panel-bubble ai">${aiResponse}</div>`;
    container.scrollTop = container.scrollHeight;
  }, 1000);
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
  
  document.getElementById("btn-quick-automation").addEventListener("click", triggerQuickAdSimulation);
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
  const stage = document.getElementById("lead-stage").value;
  const source = document.getElementById("lead-source").value;
  
  const patientData = {
    name,
    email: email || null,
    phone,
    treatment_value: value || null,
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

  try {
    const res = await window.ApexAPI.appointments.create({
      patient_id: leadId,
      title,
      scheduled_at,
      duration_minutes: 60
    });
    
    if (res.success) {
      showToast(`Agendamento de consulta salvo!`, 'success');
      await refreshState();
      closeModal("modal-meeting");
      initCalendar();
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

