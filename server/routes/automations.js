/* ==========================================================================
   Apex Odonto CRM — Automations Routes
   Gestão de regras de automação + webhook de callback do n8n
   ========================================================================== */

import { Router } from 'express';
import supabase from '../lib/supabase.js';
import automationEngine from '../services/automationEngine.js';

const router = Router();

/* ---------- GET /api/automations ---------- */
/* Lista todas as regras de automação */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('automation_rules')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/automations ---------- */
/* Cria uma nova regra de automação */
router.post('/', async (req, res) => {
  try {
    const { trigger_type, action_type, config, is_active } = req.body;

    if (!trigger_type || !action_type) {
      return res.status(400).json({
        success: false,
        error: 'trigger_type e action_type são obrigatórios',
      });
    }

    const { data, error } = await supabase
      .from('automation_rules')
      .insert({
        trigger_type,
        action_type,
        config: config || {},
        is_active: is_active !== false,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- PUT /api/automations/:id ---------- */
/* Atualiza uma regra (ativar/desativar, mudar ação, etc.) */
router.put('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('automation_rules')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- DELETE /api/automations/:id ---------- */
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('automation_rules')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true, message: 'Regra removida' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/automations/simulate-stale ---------- */
/* Simula verificação de leads inativos */
router.post('/simulate-stale', async (req, res) => {
  try {
    const daysThreshold = req.body.days || 7;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysThreshold);

    // Buscar pacientes sem mensagem recente
    const { data: patients } = await supabase
      .from('patients')
      .select(`
        *,
        latest_message:messages(created_at)
      `)
      .order('created_at', { ascending: true });

    const stalePatients = (patients || []).filter(p => {
      const msgs = p.latest_message || [];
      if (msgs.length === 0) return true;
      const lastMsg = new Date(Math.max(...msgs.map(m => new Date(m.created_at).getTime())));
      return lastMsg < cutoffDate;
    });

    if (stalePatients.length === 0) {
      return res.json({ success: true, message: 'Nenhum lead inativo encontrado', stale_count: 0 });
    }

    // Disparar automação para cada lead inativo
    const results = [];
    for (const patient of stalePatients.slice(0, 5)) { // Limitar a 5 por vez
      const result = await automationEngine.processEvent('lead_stale', {
        patient,
        event_type: 'lead_stale',
      });
      results.push({ patient_name: patient.name, ...result });
    }

    res.json({ success: true, stale_count: stalePatients.length, processed: results });
  } catch (err) {
    console.error('POST /api/automations/simulate-stale error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/webhooks/n8n ---------- */
/* Recebe callbacks do n8n (ex: resultado de workflow, lead de landing page, etc.) */
router.post('/webhooks/n8n', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📦 Webhook n8n recebido:', JSON.stringify(payload).substring(0, 200));

    // Tipos de callback do n8n
    switch (payload.event) {
      case 'lead_captured': {
        // n8n capturou lead de landing page, Meta Ads, etc.
        const { data: patient, error } = await supabase
          .from('patients')
          .insert({
            name: payload.name,
            phone: payload.phone?.replace(/\D/g, ''),
            email: payload.email || null,
            treatment_interest: payload.treatment_interest || null,
            source: payload.source || 'n8n',
          })
          .select()
          .single();

        if (error) throw error;

        // Criar deal no primeiro estágio
        const { data: firstStage } = await supabase
          .from('pipeline_stages')
          .select('id')
          .order('position', { ascending: true })
          .limit(1)
          .single();

        if (firstStage) {
          await supabase.from('deals').insert({
            patient_id: patient.id,
            stage_id: firstStage.id,
          });
        }

        // Disparar automação de novo lead
        await automationEngine.processEvent('new_lead', {
          patient,
          event_type: 'new_lead',
        });

        return res.json({ success: true, data: patient });
      }

      case 'workflow_completed': {
        // Logar execução do workflow
        console.log(`✅ Workflow n8n concluído: ${payload.workflow_name || 'desconhecido'}`);
        return res.json({ success: true, acknowledged: true });
      }

      default:
        console.log(`ℹ️  Evento n8n não tratado: ${payload.event}`);
        return res.json({ success: true, ignored: true });
    }
  } catch (err) {
    console.error('POST /api/webhooks/n8n error:', err.message);
    res.status(200).json({ success: false, error: err.message });
  }
});

/* ---------- GET /api/automations/activity-log ---------- */
/* Retorna log de atividades recentes */
router.get('/activity-log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    const { data, error } = await supabase
      .from('activity_logs')
      .select(`
        *,
        patient:patients(id, name)
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
