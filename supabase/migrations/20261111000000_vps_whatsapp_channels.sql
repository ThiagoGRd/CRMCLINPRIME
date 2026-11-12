-- Registra as instâncias WhatsApp conectadas na VPS (Esquadrão Baileys) e expõe channel_id na view messages
CREATE OR REPLACE VIEW public.messages WITH (security_invoker = on) AS
SELECT
  id,
  patient_id,
  direction,
  content,
  message_type,
  status,
  whatsapp_message_id,
  sent_by,
  created_at,
  org_id,
  media_url,
  media_mime,
  channel_id
FROM public.crm_messages;

INSERT INTO public.platform_settings (key, value, updated_at) VALUES
  ('evolution_url', 'https://evolution.clinprime.shop', now()),
  ('vps_bridge_url', 'https://evolution.clinprime.shop/crm-bridge', now())
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = now();

DELETE FROM public.channels
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND (instance_name = 'Thiago Cruz' OR phone_number_id = '1322159014324326');

INSERT INTO public.channels (org_id, type, instance_name, display_name, status, config, updated_at)
VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    'whatsapp',
    'recepcao',
    'Recepção (Carla e Renata)',
    'connected',
    '{"provider": "vps_esquadrao", "display_phone": "+55 82 9328-9057", "phone": "558293289057", "port": 3102, "sector": "reception", "sector_label": "Recepção", "supervisor": "everton"}'::jsonb,
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    'whatsapp',
    'layla',
    'Layla (CRC Agendamento)',
    'connected',
    '{"provider": "vps_esquadrao", "display_phone": "+55 82 9130-2615", "phone": "558291302615", "port": 3103, "sector": "crc", "sector_label": "CRC / Agendamento", "supervisor": "luiza"}'::jsonb,
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    'whatsapp',
    'diana',
    'Diana (CRC Comercial)',
    'connected',
    '{"provider": "vps_esquadrao", "display_phone": "+55 82 9156-3929", "phone": "558291563929", "port": 3104, "sector": "commercial", "sector_label": "Comercial", "supervisor": "zari"}'::jsonb,
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    'whatsapp',
    'thiago',
    'Dr. Thiago (Pessoal / Grupos)',
    'disconnected',
    '{"provider": "vps_esquadrao", "display_phone": "+55 82 99602-6436", "phone": "5582996026436", "port": 3111, "sector": "management", "sector_label": "Diretoria", "supervisor": "chefe"}'::jsonb,
    now()
  )
ON CONFLICT (instance_name) DO UPDATE SET
  type = EXCLUDED.type,
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status,
  config = EXCLUDED.config,
  updated_at = now();

