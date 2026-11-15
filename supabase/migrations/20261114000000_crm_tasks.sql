set local lock_timeout = '5s';

-- Fase 1 "paciente nunca esquecido": fila de tarefas (crm_tasks), frentes e conclusão atômica.
-- Aditiva: sem drop nem alter type.

-- Frentes no paciente e no membro da equipe
ALTER TABLE public.crm_patients
  ADD COLUMN IF NOT EXISTS front text NOT NULL DEFAULT 'crc_leads'
    CHECK (front IN ('recepcao','crc_leads','comercial','pos_venda')),
  ADD COLUMN IF NOT EXISTS care_status text NOT NULL DEFAULT 'ativo'
    CHECK (care_status IN ('ativo','encerrado')),
  ADD COLUMN IF NOT EXISTS care_closed_reason text;

ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS front text
    CHECK (front IN ('recepcao','crc_leads','comercial','pos_venda')),
  ADD COLUMN IF NOT EXISTS is_manager boolean NOT NULL DEFAULT false;

-- Tarefas
CREATE TABLE IF NOT EXISTS public.crm_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL REFERENCES public.crm_patients(id) ON DELETE CASCADE,
  front             text NOT NULL CHECK (front IN ('recepcao','crc_leads','comercial','pos_venda')),
  kind              text NOT NULL DEFAULT 'proxima_acao' CHECK (kind IN ('demanda','proxima_acao','passo_cadencia')),
  title             text NOT NULL CHECK (length(trim(title)) > 0),
  owner_id          uuid,
  due_at            timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','feita','cancelada')),
  origin            text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','cadencia','passagem','sistema')),
  draft             text,
  outcome           text,
  source_message_id uuid,
  snooze_count      int NOT NULL DEFAULT 0,
  created_by        uuid DEFAULT auth.uid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  done_by           uuid,
  done_at           timestamptz
);

CREATE INDEX IF NOT EXISTS crm_tasks_org_status_due_idx ON public.crm_tasks (org_id, status, due_at);
CREATE INDEX IF NOT EXISTS crm_tasks_patient_status_idx ON public.crm_tasks (patient_id, status);

ALTER TABLE public.crm_tasks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'crm_tasks' AND policyname = 'tasks_all'
  ) THEN
    CREATE POLICY tasks_all ON public.crm_tasks
      FOR ALL
      USING (is_org_member(org_id))
      WITH CHECK (
        is_org_member(org_id)
        AND EXISTS (
          SELECT 1 FROM public.crm_patients p
          WHERE p.id = crm_tasks.patient_id AND p.org_id = crm_tasks.org_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crm_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.crm_tasks;
  END IF;
END $$;

-- View patients: colunas existentes na mesma ordem, novas ao final
CREATE OR REPLACE VIEW public.patients WITH (security_invoker = on) AS
SELECT
  id,
  name,
  phone,
  email,
  cpf,
  treatment_interest,
  treatment_value,
  source,
  assigned_dentist,
  notes,
  customer_id,
  created_at,
  updated_at,
  chat_session_id,
  org_id,
  assigned_to,
  tags,
  channel,
  last_message_at,
  clinicorp_status,
  clinicorp_amount,
  clinicorp_date,
  clinicorp_est_count,
  clinicorp_synced_at,
  front,
  care_status,
  care_closed_reason
FROM public.crm_patients;

CREATE OR REPLACE VIEW public.tasks WITH (security_invoker = on) AS
SELECT * FROM public.crm_tasks;

-- Pacientes com conversa recente (90 dias), em acompanhamento e sem tarefa aberta
CREATE OR REPLACE VIEW public.crm_forgotten_patients WITH (security_invoker = on) AS
SELECT p.id, p.org_id, p.name, p.phone, p.front, p.assigned_to, p.last_message_at
FROM public.crm_patients p
WHERE p.care_status = 'ativo'
  AND p.last_message_at > now() - interval '90 days'
  AND NOT EXISTS (
    SELECT 1 FROM public.crm_tasks t
    WHERE t.patient_id = p.id AND t.status = 'aberta'
  );

-- Conclusão atômica: conclui a tarefa e exige próximo passo ou encerramento, tudo na mesma transação
CREATE OR REPLACE FUNCTION public.complete_task(
  p_task uuid,
  p_outcome text,
  p_next_title text,
  p_next_due timestamptz,
  p_next_front text,
  p_close_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_patient uuid;
  v_org uuid;
  v_front text;
  v_next uuid;
BEGIN
  UPDATE public.crm_tasks
  SET status = 'feita', outcome = p_outcome, done_by = auth.uid(), done_at = now()
  WHERE id = p_task AND status = 'aberta'
  RETURNING patient_id, org_id, front INTO v_patient, v_org, v_front;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tarefa_ja_concluida';
  END IF;

  IF nullif(trim(p_next_title), '') IS NOT NULL THEN
    IF p_next_due IS NULL OR p_next_due <= now() THEN
      RAISE EXCEPTION 'prazo_invalido';
    END IF;
    INSERT INTO public.crm_tasks (org_id, patient_id, front, kind, title, owner_id, due_at, origin)
    VALUES (v_org, v_patient, coalesce(p_next_front, v_front), 'proxima_acao', trim(p_next_title), auth.uid(), p_next_due, 'manual')
    RETURNING id INTO v_next;
    RETURN v_next;
  ELSIF nullif(trim(p_close_reason), '') IS NOT NULL THEN
    UPDATE public.crm_patients
    SET care_status = 'encerrado', care_closed_reason = trim(p_close_reason)
    WHERE id = v_patient;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'paciente_nao_encerrado';
    END IF;
    RETURN NULL;
  ELSE
    RAISE EXCEPTION 'proximo_passo_obrigatorio';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_task(uuid, text, text, timestamptz, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.complete_task(uuid, text, text, timestamptz, text, text) TO authenticated;
