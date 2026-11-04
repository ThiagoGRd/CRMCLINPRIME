-- Apply only after the predecessor RLS/policies and the foundation were reviewed
-- in staging. No legacy table policy is guessed or replaced by this migration.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    RAISE EXCEPTION 'supabase_realtime publication missing; review staging Realtime setup before applying';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.crm_messages') AND relrowsecurity) THEN
    RAISE EXCEPTION 'crm_messages requires reviewed RLS before Realtime registration';
  END IF;
END $$;

-- GRANT alone does not narrow permissive Supabase default privileges. In
-- particular TRUNCATE bypasses row-level policies, so remove it explicitly.
REVOKE ALL ON public.crm_conversations,public.crm_pending_items FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.crm_conversations,public.crm_pending_items TO authenticated;
GRANT ALL ON public.crm_conversations,public.crm_pending_items TO service_role;
ALTER TABLE public.crm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_pending_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION public.crm_is_org_member(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.crm_is_org_member(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.crm_guard_conversation_identity(),public.crm_guard_pending_item(),
  public.crm_link_message_conversation(),public.crm_advance_conversation_activity()
  FROM PUBLIC,anon,authenticated,service_role;

-- The foundation already protects patient/conversation identity and resolved
-- records. Include the primary key without replacing that resolution guard.
CREATE OR REPLACE FUNCTION public.crm_guard_pending_id() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'identidade da pendencia imutavel';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_guard_pending_id() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS crm_guard_pending_id ON public.crm_pending_items;
CREATE TRIGGER crm_guard_pending_id BEFORE UPDATE OF id ON public.crm_pending_items
FOR EACH ROW EXECUTE FUNCTION public.crm_guard_pending_id();

-- Only the three tables consumed by the operational CRM subscriptions. Preserve
-- other members, row filters, column lists and publication options. Membership
-- through FOR ALL TABLES / schema publications is already covered by this view.
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['crm_conversations','crm_messages','crm_pending_items'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=target
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.%I',target);
    END IF;
  END LOOP;
END $$;
COMMIT;
