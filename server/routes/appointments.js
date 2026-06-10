/* ==========================================================================
   Apex Odonto CRM — Appointments Routes
   Agendamentos de consultas odontológicas
   ========================================================================== */

import { Router } from 'express';
import supabase from '../lib/supabase.js';
import automationEngine from '../services/automationEngine.js';
import n8nTrigger from '../services/n8nTrigger.js';

const router = Router();

/* ---------- GET /api/appointments ---------- */
router.get('/', async (req, res) => {
  try {
    const { date_from, date_to, dentist_id, status } = req.query;

    let query = supabase
      .from('appointments')
      .select(`
        *,
        patient:patients(id, name, phone, treatment_interest),
        dentist:users!appointments_dentist_id_fkey(id, name)
      `)
      .order('scheduled_at', { ascending: true });

    if (date_from) query = query.gte('scheduled_at', date_from);
    if (date_to) query = query.lte('scheduled_at', date_to);
    if (dentist_id) query = query.eq('dentist_id', dentist_id);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/appointments error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/appointments ---------- */
router.post('/', async (req, res) => {
  try {
    const { patient_id, dentist_id, title, scheduled_at, duration_minutes, notes } = req.body;

    if (!patient_id || !scheduled_at || !title) {
      return res.status(400).json({
        success: false,
        error: 'patient_id, title e scheduled_at são obrigatórios',
      });
    }

    // 1. Criar agendamento
    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert({
        patient_id,
        dentist_id: dentist_id || null,
        title,
        scheduled_at,
        duration_minutes: duration_minutes || 60,
        notes,
      })
      .select(`
        *,
        patient:patients(id, name, phone, treatment_interest)
      `)
      .single();

    if (error) throw error;

    // 2. Logar atividade
    await supabase.from('activity_logs').insert({
      patient_id,
      action: 'appointment_created',
      details: {
        title,
        scheduled_at,
        dentist_id,
      },
    });

    // 3. Disparar automação "tarefa concluída" (agendamento é uma tarefa)
    await automationEngine.processEvent('task_completed', {
      patient: appointment.patient,
      event_type: 'task_completed',
      appointment,
    });

    // 4. Disparar workflow n8n de confirmação de consulta
    if (appointment.patient) {
      await n8nTrigger.triggerAppointmentCreated(appointment, appointment.patient);
    }

    res.status(201).json({ success: true, data: appointment });
  } catch (err) {
    console.error('POST /api/appointments error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- PUT /api/appointments/:id ---------- */
router.put('/:id', async (req, res) => {
  try {
    const { data: appointment, error } = await supabase
      .from('appointments')
      .update(req.body)
      .eq('id', req.params.id)
      .select(`
        *,
        patient:patients(id, name, phone)
      `)
      .single();

    if (error) throw error;
    if (!appointment) return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });

    // Se a consulta foi concluída, logar e disparar automações
    if (req.body.status === 'completed') {
      await supabase.from('activity_logs').insert({
        patient_id: appointment.patient_id,
        action: 'appointment_completed',
        details: { appointment_id: appointment.id, title: appointment.title },
      });
    }

    res.json({ success: true, data: appointment });
  } catch (err) {
    console.error('PUT /api/appointments/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- DELETE /api/appointments/:id ---------- */
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('appointments')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true, message: 'Agendamento removido' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
