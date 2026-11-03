-- WhatsApp Cloud API (oficial Meta): cada número conectado é uma linha em channels,
-- identificada pelo phone_number_id que vem em todo evento do webhook.
ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS phone_number_id text,
  ADD COLUMN IF NOT EXISTS waba_id text;
CREATE UNIQUE INDEX IF NOT EXISTS channels_phone_number_id_key ON public.channels (phone_number_id);

-- Por qual número a mensagem entrou/saiu; wamid único = idempotência nos reenvios da Meta.
ALTER TABLE public.crm_messages
  ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_messages_wamid_key ON public.crm_messages (whatsapp_message_id);

-- Busca do paciente pelo telefone canônico (DDD + 8 últimos dígitos) dentro da org.
CREATE INDEX IF NOT EXISTS idx_crm_patients_org_phone_canon ON public.crm_patients (org_id, phone_canon(phone));

-- Usado só pelas edge functions (service role): paciente mais antigo com esse telefone na org.
CREATE OR REPLACE FUNCTION public.find_patient_by_phone(p_org uuid, p_canon text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path = public
AS $function$
  SELECT id FROM crm_patients
  WHERE org_id = p_org AND p_canon IS NOT NULL AND phone_canon(phone) = p_canon
  ORDER BY created_at LIMIT 1;
$function$;
REVOKE EXECUTE ON FUNCTION public.find_patient_by_phone(uuid, text) FROM PUBLIC, anon, authenticated;

-- Novo tipo de canal: número na API oficial (separado do 'whatsapp' da Evolution, que o health-monitor e as automações antigas usam).
ALTER TABLE public.channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE public.channels ADD CONSTRAINT channels_type_check CHECK (type = ANY (ARRAY['whatsapp', 'whatsapp_cloud', 'instagram']));
