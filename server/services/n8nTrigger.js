/* ==========================================================================
   Apex Odonto CRM — n8n Trigger Service
   Dispara workflows no n8n via webhooks
   ========================================================================== */

const N8N_BASE_URL = process.env.N8N_WEBHOOK_BASE_URL || 'http://localhost:5678/webhook';

/**
 * Dispara um workflow genérico no n8n
 * @param {string} webhookPath — Caminho do webhook (ex: 'novo-lead')
 * @param {object} payload — Dados a enviar
 */
export async function triggerWorkflow(webhookPath, payload) {
  const url = `${N8N_BASE_URL}/${webhookPath}`;

  const evolutionConfig = {
    url: process.env.EVOLUTION_API_URL || 'http://localhost:8080',
    key: process.env.EVOLUTION_API_KEY || 'sua_api_key_global',
    instance: process.env.EVOLUTION_INSTANCE_NAME || 'apex-odonto'
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        evolution: evolutionConfig,
        _source: 'apex-odonto-crm',
        _timestamp: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      console.warn(`⚠️ n8n webhook [${webhookPath}] retornou ${res.status}: ${errorText}`);
      return { success: false, status: res.status, error: errorText };
    }

    const data = await res.json().catch(() => ({}));
    console.log(`✅ n8n workflow [${webhookPath}] disparado com sucesso`);
    return { success: true, data };
  } catch (err) {
    // Se o n8n não estiver rodando, logar mas não quebrar a aplicação
    console.warn(`⚠️ Falha ao disparar n8n [${webhookPath}]: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Dispara workflow de boas-vindas para novo lead
 */
export async function triggerNewLead(patient) {
  return triggerWorkflow('novo-lead', {
    event: 'new_lead',
    patient: {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
      email: patient.email,
      treatment_interest: patient.treatment_interest,
      treatment_value: patient.treatment_value,
      source: patient.source,
    },
  });
}

/**
 * Dispara workflow de mudança de estágio no funil
 */
export async function triggerStageChange(patient, fromStage, toStage) {
  return triggerWorkflow('estagio-mudou', {
    event: 'stage_change',
    patient: {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
    },
    from_stage: fromStage,
    to_stage: toStage,
  });
}

/**
 * Dispara workflow de confirmação de consulta
 */
export async function triggerAppointmentCreated(appointment, patient) {
  return triggerWorkflow('confirmar-consulta', {
    event: 'appointment_created',
    appointment: {
      id: appointment.id,
      scheduled_at: appointment.scheduled_at,
      title: appointment.title,
      duration_minutes: appointment.duration_minutes,
    },
    patient: {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
    },
  });
}

/**
 * Dispara workflow de reengajamento de lead inativo
 */
export async function triggerStaleLeadReengagement(patient, daysSinceLastContact) {
  return triggerWorkflow('lead-inativo', {
    event: 'lead_stale',
    patient: {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
      treatment_interest: patient.treatment_interest,
    },
    days_since_last_contact: daysSinceLastContact,
  });
}

export default {
  triggerWorkflow,
  triggerNewLead,
  triggerStageChange,
  triggerAppointmentCreated,
  triggerStaleLeadReengagement,
};
