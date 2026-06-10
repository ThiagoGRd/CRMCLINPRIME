/* ==========================================================================
   Apex Odonto CRM — Patients Routes
   CRUD completo de pacientes + integração com automações
   ========================================================================== */

import { Router } from 'express';
import supabase from '../lib/supabase.js';
import automationEngine from '../services/automationEngine.js';
import n8nTrigger from '../services/n8nTrigger.js';

const router = Router();

/* ---------- GET /api/patients ---------- */
router.get('/', async (req, res) => {
  try {
    const { search, source, dentist } = req.query;

    let query = supabase
      .from('patients')
      .select(`
        *,
        assigned_dentist_info:users!patients_assigned_dentist_fkey(id, name, email),
        deal:deals(id, stage_id, position, moved_at)
      `)
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
    }
    if (source) query = query.eq('source', source);
    if (dentist) query = query.eq('assigned_dentist', dentist);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/patients error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- GET /api/patients/:id ---------- */
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('patients')
      .select(`
        *,
        assigned_dentist_info:users!patients_assigned_dentist_fkey(id, name, email),
        deal:deals(id, stage_id, position, moved_at),
        messages(id, direction, content, message_type, status, created_at),
        appointments(id, title, scheduled_at, duration_minutes, status)
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Paciente não encontrado' });

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/patients/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/patients ---------- */
router.post('/', async (req, res) => {
  try {
    const { name, phone, email, cpf, treatment_interest, treatment_value, source, assigned_dentist, notes } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Nome e telefone são obrigatórios' });
    }

    // 1. Criar paciente
    const { data: patient, error: patientError } = await supabase
      .from('patients')
      .insert({
        name,
        phone: phone.replace(/\D/g, ''),
        email,
        cpf,
        treatment_interest,
        treatment_value: treatment_value || null,
        source: source || 'manual',
        assigned_dentist: assigned_dentist || null,
        notes,
      })
      .select()
      .single();

    if (patientError) throw patientError;

    // 2. Criar deal no primeiro estágio do funil
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
        position: 0,
      });
    }

    // 3. Logar atividade
    await supabase.from('activity_logs').insert({
      patient_id: patient.id,
      action: 'patient_created',
      details: { source: patient.source },
    });

    // 4. Disparar automações (novo lead)
    const automationResult = await automationEngine.processEvent('new_lead', {
      patient,
      event_type: 'new_lead',
    });

    // 5. Disparar workflow n8n diretamente também
    await n8nTrigger.triggerNewLead(patient);

    res.status(201).json({
      success: true,
      data: patient,
      automation: automationResult,
    });
  } catch (err) {
    console.error('POST /api/patients error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- PUT /api/patients/:id ---------- */
router.put('/:id', async (req, res) => {
  try {
    // Buscar dados atuais para comparação
    const { data: current } = await supabase
      .from('patients')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!current) {
      return res.status(404).json({ success: false, error: 'Paciente não encontrado' });
    }

    const updates = { ...req.body, updated_at: new Date().toISOString() };
    if (updates.phone) updates.phone = updates.phone.replace(/\D/g, '');

    const { data: patient, error } = await supabase
      .from('patients')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Detectar mudança de valor → disparar gatilho
    if (req.body.treatment_value && req.body.treatment_value !== current.treatment_value) {
      await automationEngine.processEvent('value_change', {
        patient,
        event_type: 'value_change',
        old_value: current.treatment_value,
        new_value: req.body.treatment_value,
      });

      await supabase.from('activity_logs').insert({
        patient_id: patient.id,
        action: 'value_updated',
        details: { old_value: current.treatment_value, new_value: req.body.treatment_value },
      });
    }

    res.json({ success: true, data: patient });
  } catch (err) {
    console.error('PUT /api/patients/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- DELETE /api/patients/:id ---------- */
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('patients')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true, message: 'Paciente removido' });
  } catch (err) {
    console.error('DELETE /api/patients/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
