-- ==========================================================================
-- Apex Odonto CRM — Schema Migration
-- Execute este SQL no Supabase SQL Editor
-- ==========================================================================

-- 1. Tabela de Usuários do Sistema
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT CHECK (role IN ('admin', 'dentist', 'receptionist')) DEFAULT 'receptionist',
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Tabela de Pacientes (Leads)
CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  cpf TEXT,
  treatment_interest TEXT,
  treatment_value NUMERIC(10,2),
  source TEXT DEFAULT 'manual',
  assigned_dentist UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Estágios do Funil
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  position INT NOT NULL,
  color TEXT DEFAULT '#6c5ce7',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Deals (Posição do paciente no funil)
CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  position INT DEFAULT 0,
  moved_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Mensagens WhatsApp
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  direction TEXT CHECK (direction IN ('inbound', 'outbound')) NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  status TEXT DEFAULT 'sent',
  whatsapp_message_id TEXT,
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Agendamentos / Consultas
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  dentist_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INT DEFAULT 60,
  status TEXT CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled')) DEFAULT 'scheduled',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. Regras de Automação
CREATE TABLE IF NOT EXISTS automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Log de Atividades
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================================================
-- ÍNDICES para performance
-- ==========================================================================
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_patients_source ON patients(source);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_deals_patient ON deals(patient_id);
CREATE INDEX IF NOT EXISTS idx_messages_patient ON messages(patient_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_scheduled ON appointments(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_patient ON activity_logs(patient_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger ON automation_rules(trigger_type, is_active);

-- ==========================================================================
-- DADOS INICIAIS — Estágios do Funil Odontológico
-- ==========================================================================
INSERT INTO pipeline_stages (name, position, color) VALUES
  ('Pré-Avaliação', 1, '#a29bfe'),
  ('Consulta Agendada', 2, '#74b9ff'),
  ('Avaliação Realizada', 3, '#ffeaa7'),
  ('Orçamento Enviado', 4, '#fab1a0'),
  ('Tratamento Iniciado', 5, '#55efc4'),
  ('Concluído', 6, '#00b894')
ON CONFLICT DO NOTHING;

-- ==========================================================================
-- DADOS INICIAIS — Regras de Automação Padrão
-- ==========================================================================
INSERT INTO automation_rules (trigger_type, action_type, config, is_active) VALUES
  ('new_lead', 'send_whatsapp', '{"message_template": "Olá {nome}! 😊 Bem-vindo(a) à nossa clínica odontológica! Recebemos seu interesse em {tratamento}. Em breve nossa equipe entrará em contato para agendar sua avaliação. 🦷"}', true),
  ('stage_change', 'send_whatsapp', '{"message_template": "Olá {nome}! 🦷 Seu tratamento avançou para a etapa \"{etapa}\". Em breve nossa equipe entrará em contato com os próximos passos!"}', true),
  ('lead_stale', 'send_whatsapp', '{"message_template": "Olá {nome}! 😊 Faz um tempinho que conversamos sobre {tratamento}. Temos condições especiais este mês! Posso te ajudar? 🦷", "days_threshold": 7}', true),
  ('value_change', 'notify_team', '{}', true),
  ('task_completed', 'move_stage', '{}', true)
ON CONFLICT DO NOTHING;

-- ==========================================================================
-- DADOS INICIAIS — Usuários de Demonstração
-- ==========================================================================
INSERT INTO users (email, name, role) VALUES
  ('admin@clinica.com', 'Dr. Admin', 'admin'),
  ('henrique@clinica.com', 'Dr. Henrique Almeida', 'dentist'),
  ('ana@clinica.com', 'Dra. Ana Beatriz', 'dentist'),
  ('recepcao@clinica.com', 'Maria Recepcionista', 'receptionist')
ON CONFLICT (email) DO NOTHING;
