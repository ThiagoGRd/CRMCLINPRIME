set local lock_timeout = '5s';

-- Paciente criado há pouco, sem mensagem ainda (last_message_at nulo), também entra na lista de esquecidos.
-- Mesma lista e ordem de colunas da versão anterior.
CREATE OR REPLACE VIEW public.crm_forgotten_patients WITH (security_invoker = on) AS
SELECT p.id, p.org_id, p.name, p.phone, p.front, p.assigned_to, p.last_message_at
FROM public.crm_patients p
WHERE p.care_status = 'ativo'
  AND (p.last_message_at > now() - interval '90 days' OR p.created_at > now() - interval '90 days')
  AND NOT EXISTS (
    SELECT 1 FROM public.crm_tasks t
    WHERE t.patient_id = p.id AND t.status = 'aberta'
  );

-- Paciente encerrado que escreve de novo volta a ficar ativo
CREATE OR REPLACE FUNCTION public.reopen_patient_on_inbound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Nunca derrubar a entrada de uma mensagem: qualquer erro aqui (deadlock, lock) é engolido.
  BEGIN
    UPDATE public.crm_patients
      SET care_status = 'ativo', care_closed_reason = NULL
      WHERE id = NEW.patient_id AND care_status = 'encerrado';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reopen_patient_on_inbound() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'crm_messages_reopen_patient' AND tgrelid = 'public.crm_messages'::regclass
  ) THEN
    CREATE TRIGGER crm_messages_reopen_patient
      AFTER INSERT ON public.crm_messages
      -- Só mensagem recente: importação de histórico antigo não reabre paciente encerrado de propósito.
      FOR EACH ROW WHEN (NEW.direction = 'inbound' AND NEW.created_at > now() - interval '1 day')
      EXECUTE FUNCTION public.reopen_patient_on_inbound();
  END IF;
END
$$;
