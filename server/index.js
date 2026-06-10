/* ==========================================================================
   Apex Odonto CRM — Main Server
   Express API conectando: Supabase + Evolution API + n8n
   ========================================================================== */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// Importar rotas
import patientsRoutes from './routes/patients.js';
import pipelineRoutes from './routes/pipeline.js';
import messagesRoutes from './routes/messages.js';
import appointmentsRoutes from './routes/appointments.js';
import automationsRoutes from './routes/automations.js';

// Importar serviços para health check
import evolutionApi from './services/evolutionApi.js';
import supabase from './lib/supabase.js';

const app = express();
const PORT = process.env.PORT || 3001;

/* ---------- Middlewares ---------- */
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// Logger simples para desenvolvimento
app.use((req, _res, next) => {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

/* ---------- Rotas da API ---------- */
app.use('/api/patients', patientsRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/automations', automationsRoutes);

/* ---------- Health Check ---------- */
app.get('/api/health', async (_req, res) => {
  const health = {
    server: 'ok',
    timestamp: new Date().toISOString(),
    supabase: 'checking...',
    evolution_api: 'checking...',
    n8n: 'checking...',
  };

  // Testar Supabase
  try {
    const { error } = await supabase.from('pipeline_stages').select('id').limit(1);
    health.supabase = error ? `error: ${error.message}` : 'connected';
  } catch (err) {
    health.supabase = `error: ${err.message}`;
  }

  // Testar Evolution API
  try {
    const evoStatus = await evolutionApi.getConnectionStatus();
    health.evolution_api = evoStatus.connected ? 'connected (WhatsApp online)' : `disconnected (${evoStatus.state})`;
  } catch (err) {
    health.evolution_api = `error: ${err.message}`;
  }

  // Testar n8n
  try {
    const n8nUrl = process.env.N8N_WEBHOOK_BASE_URL?.replace('/webhook', '') || 'http://localhost:5678';
    const n8nRes = await fetch(`${n8nUrl}/healthz`).catch(() => null);
    health.n8n = n8nRes?.ok ? 'connected' : 'unreachable';
  } catch {
    health.n8n = 'unreachable';
  }

  const allOk = health.supabase === 'connected';
  res.status(allOk ? 200 : 503).json(health);
});

/* ---------- Rota raiz ---------- */
app.get('/', (_req, res) => {
  res.json({
    name: 'Apex Odonto CRM API',
    version: '1.0.0',
    docs: {
      patients: 'GET/POST /api/patients',
      pipeline: 'GET /api/pipeline',
      messages: 'GET /api/messages/:patientId | POST /api/messages/send',
      appointments: 'GET/POST /api/appointments',
      automations: 'GET/POST /api/automations',
      health: 'GET /api/health',
      whatsapp_status: 'GET /api/messages/whatsapp/status',
      evolution_webhook: 'POST /api/messages/webhooks/evolution',
      n8n_webhook: 'POST /api/automations/webhooks/n8n',
    },
  });
});

/* ---------- 404 handler ---------- */
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Rota não encontrada' });
});

/* ---------- Error handler global ---------- */
app.use((err, _req, res, _next) => {
  console.error('❌ Erro não tratado:', err);
  res.status(500).json({ success: false, error: 'Erro interno do servidor' });
});

/* ---------- Inicializar ---------- */
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       🦷 Apex Odonto CRM — API Server       ║
╠══════════════════════════════════════════════╣
║  Server:     http://localhost:${PORT}            ║
║  Supabase:   ${(process.env.SUPABASE_URL || 'NOT SET').substring(0, 30).padEnd(30)}║
║  Evolution:  ${(process.env.EVOLUTION_API_URL || 'NOT SET').substring(0, 30).padEnd(30)}║
║  n8n:        ${(process.env.N8N_WEBHOOK_BASE_URL || 'NOT SET').substring(0, 30).padEnd(30)}║
╚══════════════════════════════════════════════╝
  `);
});

export default app;
