/* ==========================================================================
   Apex Odonto CRM — Pipeline Routes
   Gestão do funil Kanban: estágios, deals e movimentação
   ========================================================================== */

import { Router } from 'express';
import supabase from '../lib/supabase.js';
import automationEngine from '../services/automationEngine.js';
import n8nTrigger from '../services/n8nTrigger.js';

const router = Router();

/* ---------- GET /api/pipeline ---------- */
/* Retorna todos os estágios com seus deals e pacientes */
router.get('/', async (req, res) => {
  try {
    // Buscar estágios ordenados
    const { data: stages, error: stageError } = await supabase
      .from('pipeline_stages')
      .select('*')
      .order('position', { ascending: true });

    if (stageError) throw stageError;

    // Buscar deals com dados do paciente
    const { data: deals, error: dealError } = await supabase
      .from('deals')
      .select(`
        *,
        patient:patients(*)
      `)
      .order('position', { ascending: true });

    if (dealError) throw dealError;

    // Agrupar deals por estágio
    const pipeline = stages.map(stage => ({
      ...stage,
      deals: deals.filter(d => d.stage_id === stage.id),
      total_value: deals
        .filter(d => d.stage_id === stage.id)
        .reduce((sum, d) => sum + (d.patient?.treatment_value || 0), 0),
    }));

    res.json({ success: true, data: pipeline });
  } catch (err) {
    console.error('GET /api/pipeline error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- GET /api/pipeline/stages ---------- */
router.get('/stages', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pipeline_stages')
      .select('*')
      .order('position', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/pipeline/stages ---------- */
router.post('/stages', async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Nome do estágio obrigatório' });

    // Encontrar a maior posição atual
    const { data: maxStage } = await supabase
      .from('pipeline_stages')
      .select('position')
      .order('position', { ascending: false })
      .limit(1)
      .single();

    const { data, error } = await supabase
      .from('pipeline_stages')
      .insert({
        name,
        color: color || '#6c5ce7',
        position: (maxStage?.position || 0) + 1,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- PUT /api/pipeline/deals/:id/move ---------- */
/* Move um deal para outro estágio (drag & drop do Kanban) */
router.put('/deals/:id/move', async (req, res) => {
  try {
    const { stage_id, position } = req.body;
    if (!stage_id) return res.status(400).json({ success: false, error: 'stage_id obrigatório' });

    // Buscar deal atual com paciente e estágio anterior
    const { data: currentDeal, error: findError } = await supabase
      .from('deals')
      .select(`
        *,
        patient:patients(*),
        current_stage:pipeline_stages!deals_stage_id_fkey(name)
      `)
      .eq('id', req.params.id)
      .single();

    if (findError || !currentDeal) {
      return res.status(404).json({ success: false, error: 'Deal não encontrado' });
    }

    const previousStageId = currentDeal.stage_id;

    // Atualizar deal
    const { data: updatedDeal, error: updateError } = await supabase
      .from('deals')
      .update({
        stage_id,
        position: position ?? 0,
        moved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Buscar nome do novo estágio
    const { data: newStage } = await supabase
      .from('pipeline_stages')
      .select('name')
      .eq('id', stage_id)
      .single();

    // Logar atividade
    await supabase.from('activity_logs').insert({
      patient_id: currentDeal.patient_id,
      action: 'stage_moved',
      details: {
        from_stage: currentDeal.current_stage?.name,
        to_stage: newStage?.name,
      },
    });

    // Disparar automações de mudança de estágio
    if (previousStageId !== stage_id) {
      await automationEngine.processEvent('stage_change', {
        patient: currentDeal.patient,
        event_type: 'stage_change',
        from_stage: currentDeal.current_stage?.name,
        to_stage: newStage?.name,
      });

      await n8nTrigger.triggerStageChange(
        currentDeal.patient,
        currentDeal.current_stage?.name,
        newStage?.name
      );
    }

    res.json({
      success: true,
      data: updatedDeal,
      moved: { from: currentDeal.current_stage?.name, to: newStage?.name },
    });
  } catch (err) {
    console.error('PUT /api/pipeline/deals/:id/move error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
