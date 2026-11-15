-- Última mensagem de cada conversa, para a lista de Conversas (prévia e "aguardando resposta").
-- Antes a tela lia as 1.500 mensagens mais recentes e deduzia; conversas mais antigas ficavam sem prévia.
-- SECURITY INVOKER: o RLS de crm_messages continua decidindo o que cada pessoa vê.
CREATE OR REPLACE FUNCTION public.inbox_last_messages()
RETURNS TABLE (patient_id uuid, direction text, content text, message_type text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT ON (m.patient_id) m.patient_id, m.direction, m.content, m.message_type, m.created_at
  FROM public.crm_messages m
  WHERE m.created_at > now() - interval '180 days'
  ORDER BY m.patient_id, m.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.inbox_last_messages() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_last_messages() TO authenticated;

CREATE INDEX IF NOT EXISTS crm_messages_patient_created_idx ON public.crm_messages (patient_id, created_at DESC);
