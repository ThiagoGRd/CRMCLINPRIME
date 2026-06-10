/* ==========================================================================
   Apex Odonto CRM — Automation Engine
   Motor de regras que consulta o banco e executa ações automaticamente
   ========================================================================== */

import supabase from '../lib/supabase.js';
import evolutionApi from './evolutionApi.js';
import n8nTrigger from './n8nTrigger.js';

/**
 * Processa um evento e executa as regras de automação ativas para ele
 * @param {string} eventType — 'stage_change' | 'new_lead' | 'value_change' | 'task_completed' | 'lead_stale'
 * @param {object} context — Dados do evento (paciente, estágio anterior/novo, etc.)
 */
export async function processEvent(eventType, context) {
  try {
    // 1. Buscar regras ativas para este tipo de evento
    const { data: rules, error } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('trigger_type', eventType)
      .eq('is_active', true);

    if (error) {
      console.error(`❌ Erro ao buscar regras de automação: ${error.message}`);
      return { triggered: false, error: error.message };
    }

    if (!rules || rules.length === 0) {
      console.log(`ℹ️  Nenhuma regra ativa para o evento: ${eventType}`);
      return { triggered: false, reason: 'no_active_rules' };
    }

    const results = [];

    // 2. Executar cada regra encontrada
    for (const rule of rules) {
      const result = await executeAction(rule, context);
      results.push({ rule_id: rule.id, action: rule.action_type, ...result });

      // 3. Logar a atividade
      await logActivity(context.patient?.id, eventType, {
        rule_id: rule.id,
        action_type: rule.action_type,
        result,
      });
    }

    return { triggered: true, results };
  } catch (err) {
    console.error(`❌ Erro no motor de automação: ${err.message}`);
    return { triggered: false, error: err.message };
  }
}

/**
 * Executa uma ação específica baseada na regra
 */
async function executeAction(rule, context) {
  const { action_type, config } = rule;
  const patient = context.patient;

  switch (action_type) {
    case 'send_whatsapp': {
      // Montar mensagem baseada no template da regra ou padrão
      const message = buildMessage(rule, context);

      // Tentar enviar via Evolution API diretamente
      try {
        const evoResult = await evolutionApi.sendTextMessage(patient.phone, message);

        // Salvar mensagem no banco
        await supabase.from('messages').insert({
          patient_id: patient.id,
          direction: 'outbound',
          content: message,
          message_type: 'text',
          status: 'sent',
          whatsapp_message_id: evoResult?.key?.id || null,
        });

        return { success: true, method: 'evolution_api', message };
      } catch (evoErr) {
        // Fallback: disparar via n8n
        console.warn(`⚠️  Evolution API falhou, tentando via n8n: ${evoErr.message}`);
        const n8nResult = await n8nTrigger.triggerWorkflow('enviar-whatsapp', {
          phone: patient.phone,
          message,
          patient_id: patient.id,
        });
        return { success: n8nResult.success, method: 'n8n_fallback', message };
      }
    }

    case 'send_email': {
      // Disparar via n8n (que tem nós de email configurados)
      const emailResult = await n8nTrigger.triggerWorkflow('enviar-email', {
        email: patient.email,
        name: patient.name,
        subject: config?.email_subject || 'Novidades da sua clínica odontológica',
        body: config?.email_body || buildMessage(rule, context),
      });
      return { success: emailResult.success, method: 'n8n' };
    }

    case 'move_stage': {
      // Mover paciente para o próximo estágio
      const targetStageId = config?.target_stage_id;
      if (!targetStageId) {
        return { success: false, error: 'target_stage_id não configurado' };
      }

      const { error } = await supabase
        .from('deals')
        .update({ stage_id: targetStageId, moved_at: new Date().toISOString() })
        .eq('patient_id', patient.id);

      return { success: !error, error: error?.message };
    }

    case 'create_task': {
      // Criar um agendamento/tarefa via n8n
      const taskResult = await n8nTrigger.triggerWorkflow('criar-tarefa', {
        patient_id: patient.id,
        patient_name: patient.name,
        task_title: config?.task_title || `Follow-up: ${patient.name}`,
      });
      return { success: taskResult.success, method: 'n8n' };
    }

    case 'notify_team': {
      // Notificar equipe via n8n (pode ser Slack, Email, WhatsApp do grupo)
      const notifyResult = await n8nTrigger.triggerWorkflow('notificar-equipe', {
        message: buildMessage(rule, context),
        patient_name: patient.name,
        event_type: context.event_type,
      });
      return { success: notifyResult.success, method: 'n8n' };
    }

    default:
      console.warn(`⚠️  Ação desconhecida: ${action_type}`);
      return { success: false, error: `unknown_action: ${action_type}` };
  }
}

/**
 * Constrói a mensagem baseada no template da regra e contexto do evento
 */
function buildMessage(rule, context) {
  const patient = context.patient;
  const templates = {
    stage_change: `Olá ${patient?.name}! 🦷 Seu tratamento avançou para a etapa "${context.to_stage || 'próxima etapa'}". Em breve nossa equipe entrará em contato com os próximos passos. Qualquer dúvida, estamos aqui!`,
    new_lead: `Olá ${patient?.name}! 😊 Bem-vindo(a) à nossa clínica! Recebemos seu interesse em ${patient?.treatment_interest || 'nossos serviços'}. Em breve nossa equipe entrará em contato para agendar sua avaliação. 🦷`,
    value_change: `📋 Atenção equipe: O valor do tratamento de ${patient?.name} foi atualizado de R$ ${context.old_value || '—'} para R$ ${context.new_value || '—'}.`,
    task_completed: `Olá ${patient?.name}! ✅ Sua consulta foi registrada com sucesso. Estamos preparando tudo para o próximo passo do seu tratamento!`,
    lead_stale: `Olá ${patient?.name}! 😊 Faz um tempinho que conversamos sobre ${patient?.treatment_interest || 'seu tratamento'}. Temos condições especiais neste mês! Posso te ajudar? 🦷`,
  };

  // Usar template customizado da regra, se existir
  if (rule.config?.message_template) {
    return rule.config.message_template
      .replace('{nome}', patient?.name || '')
      .replace('{tratamento}', patient?.treatment_interest || '')
      .replace('{valor}', patient?.treatment_value || '')
      .replace('{etapa}', context.to_stage || '');
  }

  return templates[rule.trigger_type] || `Mensagem automática para ${patient?.name}`;
}

/**
 * Registra atividade no log
 */
async function logActivity(patientId, action, details) {
  try {
    await supabase.from('activity_logs').insert({
      patient_id: patientId || null,
      action,
      details,
    });
  } catch (err) {
    console.warn(`⚠️  Falha ao logar atividade: ${err.message}`);
  }
}

export default { processEvent };
