/* ==========================================================================
   Apex Odonto CRM — Messages Routes
   Chat WhatsApp: enviar/receber mensagens via Evolution API
   ========================================================================== */

import { Router } from 'express';
import supabase from '../lib/supabase.js';
import evolutionApi from '../services/evolutionApi.js';

const router = Router();

/* ---------- GET /api/messages/:patientId ---------- */
/* Histórico de mensagens de um paciente */
router.get('/:patientId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('patient_id', req.params.patientId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/messages/:patientId error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/messages/send ---------- */
/* Envia uma mensagem WhatsApp para um paciente */
router.post('/send', async (req, res) => {
  try {
    const { patient_id, content, message_type } = req.body;

    if (!patient_id || !content) {
      return res.status(400).json({ success: false, error: 'patient_id e content obrigatórios' });
    }

    // 1. Buscar telefone do paciente
    const { data: patient, error: patientError } = await supabase
      .from('patients')
      .select('id, name, phone')
      .eq('id', patient_id)
      .single();

    if (patientError || !patient) {
      return res.status(404).json({ success: false, error: 'Paciente não encontrado' });
    }

    // 2. Enviar via Evolution API
    let evoResult;
    try {
      evoResult = await evolutionApi.sendTextMessage(patient.phone, content);
    } catch (evoErr) {
      console.error('Evolution API send error:', evoErr.message);
      // Salvar mesmo assim como "failed" para manter histórico
      await supabase.from('messages').insert({
        patient_id,
        direction: 'outbound',
        content,
        message_type: message_type || 'text',
        status: 'failed',
      });
      return res.status(502).json({
        success: false,
        error: `Falha ao enviar WhatsApp: ${evoErr.message}`,
      });
    }

    // 3. Salvar mensagem no banco
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        patient_id,
        direction: 'outbound',
        content,
        message_type: message_type || 'text',
        status: 'sent',
        whatsapp_message_id: evoResult?.key?.id || null,
      })
      .select()
      .single();

    if (msgError) throw msgError;

    // 4. Logar atividade
    await supabase.from('activity_logs').insert({
      patient_id,
      action: 'message_sent',
      details: { content: content.substring(0, 100) },
    });

    res.json({ success: true, data: message });
  } catch (err) {
    console.error('POST /api/messages/send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST /api/webhooks/evolution ---------- */
/* Recebe mensagens incoming do WhatsApp via webhook da Evolution API */
router.post('/webhooks/evolution', async (req, res) => {
  try {
    const payload = req.body;

    // A Evolution API envia vários tipos de evento
    // Filtrar apenas mensagens recebidas
    if (payload.event !== 'messages.upsert' && payload.event !== 'MESSAGES_UPSERT') {
      return res.json({ success: true, ignored: true, event: payload.event });
    }

    const messageData = payload.data;
    if (!messageData || messageData.key?.fromMe) {
      // Ignorar mensagens enviadas por nós (evitar loop)
      return res.json({ success: true, ignored: true, reason: 'outbound_or_empty' });
    }

    // Extrair número do remetente (remover @s.whatsapp.net)
    const rawPhone = messageData.key?.remoteJid?.replace('@s.whatsapp.net', '') || '';
    const phone = rawPhone.replace(/\D/g, '');

    if (!phone) {
      return res.json({ success: true, ignored: true, reason: 'no_phone' });
    }

    // Extrair conteúdo da mensagem
    const textContent =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text ||
      messageData.message?.imageMessage?.caption ||
      '[Mídia recebida]';

    const messageType = messageData.message?.imageMessage
      ? 'image'
      : messageData.message?.audioMessage
        ? 'audio'
        : 'text';

    // Buscar paciente pelo telefone
    const { data: patient } = await supabase
      .from('patients')
      .select('id, name')
      .or(`phone.eq.${phone},phone.eq.55${phone},phone.like.%${phone.slice(-9)}%`)
      .limit(1)
      .single();

    if (!patient) {
      console.log(`📩 Mensagem de número desconhecido: ${phone}`);
      // Opcionalmente: criar lead automático
      return res.json({ success: true, unknown_contact: true, phone });
    }

    // Salvar mensagem no banco
    const { data: savedMessage, error } = await supabase
      .from('messages')
      .insert({
        patient_id: patient.id,
        direction: 'inbound',
        content: textContent,
        message_type: messageType,
        status: 'received',
        whatsapp_message_id: messageData.key?.id || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Logar atividade
    await supabase.from('activity_logs').insert({
      patient_id: patient.id,
      action: 'message_received',
      details: { from: phone, content: textContent.substring(0, 100) },
    });

    console.log(`📩 Mensagem recebida de ${patient.name} (${phone}): ${textContent.substring(0, 50)}...`);

    res.json({ success: true, data: savedMessage });
  } catch (err) {
    console.error('POST /api/webhooks/evolution error:', err.message);
    // Sempre retornar 200 para webhooks (evitar retry infinito)
    res.status(200).json({ success: false, error: err.message });
  }
});

/* ---------- GET /api/messages/whatsapp/status ---------- */
/* Verifica se o WhatsApp está conectado */
router.get('/whatsapp/status', async (_req, res) => {
  try {
    const status = await evolutionApi.getConnectionStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.json({ success: false, data: { connected: false, error: err.message } });
  }
});

/* ---------- GET /api/messages/whatsapp/qrcode ---------- */
/* Obtém QR Code para conectar o WhatsApp */
router.get('/whatsapp/qrcode', async (_req, res) => {
  try {
    const qr = await evolutionApi.getQrCode();
    res.json({ success: true, data: qr });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
