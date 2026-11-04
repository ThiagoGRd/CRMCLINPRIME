-- Requires the existing CRM schema and the preceding WhatsApp migrations.
-- Run a schema/backup review before applying. Invalid legacy tenant links fail
-- validation instead of silently assigning a patient to another organization.
BEGIN;
ALTER TABLE public.channels ADD COLUMN inbox_key text
  CHECK (inbox_key IN ('reception','commercial','crc'));
CREATE UNIQUE INDEX crm_patients_org_identity ON public.crm_patients(org_id,id);
CREATE UNIQUE INDEX channels_org_identity ON public.channels(org_id,id);
CREATE UNIQUE INDEX org_members_org_user_identity ON public.org_members(org_id,user_id);

CREATE TABLE public.crm_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  patient_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  assigned_to uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,patient_id,channel_id),
  UNIQUE(org_id,patient_id,channel_id,id),
  UNIQUE(org_id,patient_id,id),
  FOREIGN KEY(org_id,patient_id) REFERENCES public.crm_patients(org_id,id),
  FOREIGN KEY(org_id,channel_id) REFERENCES public.channels(org_id,id),
  FOREIGN KEY(org_id,assigned_to) REFERENCES public.org_members(org_id,user_id)
);
CREATE FUNCTION public.crm_guard_conversation_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.org_id,NEW.patient_id,NEW.channel_id) IS DISTINCT FROM
     (OLD.id,OLD.org_id,OLD.patient_id,OLD.channel_id) THEN
    RAISE EXCEPTION 'identidade da conversa imutavel';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_guard_conversation_identity BEFORE UPDATE ON public.crm_conversations
FOR EACH ROW EXECUTE FUNCTION public.crm_guard_conversation_identity();
REVOKE ALL ON FUNCTION public.crm_guard_conversation_identity() FROM PUBLIC;
CREATE INDEX crm_conversations_inbox ON public.crm_conversations(org_id,channel_id,last_message_at DESC);
ALTER TABLE public.crm_messages ADD COLUMN conversation_id uuid;
-- Keep the patient tenant boundary even for historical messages without a channel.
ALTER TABLE public.crm_messages ADD CONSTRAINT crm_messages_patient_tenant
  FOREIGN KEY(org_id,patient_id) REFERENCES public.crm_patients(org_id,id);
ALTER TABLE public.crm_messages ADD CONSTRAINT crm_messages_conversation_identity
  FOREIGN KEY(org_id,patient_id,channel_id,conversation_id)
  REFERENCES public.crm_conversations(org_id,patient_id,channel_id,id);
ALTER TABLE public.crm_messages ADD CONSTRAINT crm_messages_conversation_requires_channel
  CHECK (conversation_id IS NULL OR (channel_id IS NOT NULL AND patient_id IS NOT NULL));
CREATE INDEX crm_messages_conversation_history ON public.crm_messages(conversation_id,created_at);

-- A known channel is the only permitted source of conversation identity.
-- Unclassified historical messages retain NULL conversation_id/channel_id.
CREATE FUNCTION public.crm_link_message_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NEW.channel_id IS NULL THEN
    IF NEW.conversation_id IS NOT NULL THEN RAISE EXCEPTION 'conversation requires channel'; END IF;
    RETURN NEW;
  END IF;
  INSERT INTO public.crm_conversations(org_id,patient_id,channel_id)
    VALUES(NEW.org_id,NEW.patient_id,NEW.channel_id)
    ON CONFLICT(org_id,patient_id,channel_id) DO UPDATE SET channel_id=EXCLUDED.channel_id
    RETURNING id INTO v_id;
  IF NEW.conversation_id IS NOT NULL AND NEW.conversation_id <> v_id THEN
    RAISE EXCEPTION 'message conversation mismatch';
  END IF;
  NEW.conversation_id := v_id;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_link_message_conversation BEFORE INSERT OR UPDATE OF org_id,patient_id,channel_id,conversation_id
ON public.crm_messages FOR EACH ROW EXECUTE FUNCTION public.crm_link_message_conversation();

CREATE FUNCTION public.crm_advance_conversation_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.crm_conversations SET last_message_at=GREATEST(last_message_at,NEW.created_at)
    WHERE id=NEW.conversation_id AND org_id=NEW.org_id;
  UPDATE public.crm_patients SET last_message_at=GREATEST(last_message_at,NEW.created_at)
    WHERE id=NEW.patient_id AND org_id=NEW.org_id;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_advance_conversation_activity AFTER INSERT ON public.crm_messages
FOR EACH ROW EXECUTE FUNCTION public.crm_advance_conversation_activity();

-- Trigger-based backfill enforces the same tenant validation as future messages.
UPDATE public.crm_messages SET channel_id=channel_id WHERE channel_id IS NOT NULL;
UPDATE public.crm_conversations c SET last_message_at=m.last_at
FROM (SELECT conversation_id,max(created_at) last_at FROM public.crm_messages
      WHERE conversation_id IS NOT NULL GROUP BY conversation_id) m
WHERE c.id=m.conversation_id;

CREATE TABLE public.crm_pending_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  patient_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  assigned_to uuid NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved')),
  resolution_evidence text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,patient_id) REFERENCES public.crm_patients(org_id,id),
  FOREIGN KEY(org_id,patient_id,conversation_id) REFERENCES public.crm_conversations(org_id,patient_id,id),
  FOREIGN KEY(org_id,assigned_to) REFERENCES public.org_members(org_id,user_id),
  CHECK ((status='resolved' AND resolution_evidence ~ '[^[:space:]]' AND resolution_evidence IS NOT NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status<>'resolved' AND resolution_evidence IS NULL AND resolved_by IS NULL AND resolved_at IS NULL))
);
CREATE INDEX crm_pending_work_queue ON public.crm_pending_items(org_id,status,due_at);
CREATE INDEX crm_pending_conversation ON public.crm_pending_items(conversation_id,status);

CREATE FUNCTION public.crm_is_org_member(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=auth.uid());
$$;
REVOKE ALL ON FUNCTION public.crm_is_org_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_is_org_member(uuid) TO authenticated;

ALTER TABLE public.crm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_pending_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_conversations_member_read ON public.crm_conversations FOR SELECT TO authenticated
  USING(public.crm_is_org_member(org_id));
CREATE POLICY crm_conversations_member_insert ON public.crm_conversations FOR INSERT TO authenticated
  WITH CHECK(public.crm_is_org_member(org_id));
CREATE POLICY crm_conversations_member_update ON public.crm_conversations FOR UPDATE TO authenticated
  USING(public.crm_is_org_member(org_id)) WITH CHECK(public.crm_is_org_member(org_id));
CREATE POLICY crm_pending_member_read ON public.crm_pending_items FOR SELECT TO authenticated
  USING(public.crm_is_org_member(org_id));
CREATE POLICY crm_pending_member_insert ON public.crm_pending_items FOR INSERT TO authenticated
  WITH CHECK(public.crm_is_org_member(org_id));
CREATE POLICY crm_pending_member_update ON public.crm_pending_items FOR UPDATE TO authenticated
  USING(public.crm_is_org_member(org_id)) WITH CHECK(public.crm_is_org_member(org_id));
GRANT SELECT,INSERT,UPDATE ON public.crm_conversations,public.crm_pending_items TO authenticated;
GRANT ALL ON public.crm_conversations,public.crm_pending_items TO service_role;

-- Only the explicit RPC runs with its owner's role. A custom session setting
-- would be spoofable, so resolution authorization does not use a GUC flag.
CREATE FUNCTION public.resolve_pending_item(p_id uuid,p_evidence text)
RETURNS public.crm_pending_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE item public.crm_pending_items;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'sem acesso'; END IF;
  IF p_evidence IS NULL OR p_evidence !~ '[^[:space:]]' THEN RAISE EXCEPTION 'evidencia obrigatoria'; END IF;
  SELECT * INTO item FROM public.crm_pending_items WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.crm_is_org_member(item.org_id) THEN RAISE EXCEPTION 'sem acesso'; END IF;
  IF item.status='resolved' THEN RAISE EXCEPTION 'pendencia ja resolvida'; END IF;
  UPDATE public.crm_pending_items SET status='resolved',resolution_evidence=btrim(p_evidence),
    resolved_by=auth.uid(),resolved_at=clock_timestamp() WHERE id=p_id RETURNING * INTO item;
  RETURN item;
END $$;
REVOKE ALL ON FUNCTION public.resolve_pending_item(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.resolve_pending_item(uuid,text) TO authenticated;

CREATE FUNCTION public.crm_guard_pending_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.org_id,NEW.patient_id,NEW.conversation_id,NEW.created_at) IS DISTINCT FROM
       (OLD.org_id,OLD.patient_id,OLD.conversation_id,OLD.created_at) THEN
      RAISE EXCEPTION 'identidade da pendencia imutavel';
    END IF;
    IF OLD.status='resolved' THEN RAISE EXCEPTION 'pendencia resolvida imutavel'; END IF;
  END IF;
  IF NEW.status='resolved' THEN
    IF TG_OP='INSERT' OR current_user <> (
      SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.resolve_pending_item(uuid,text)'::regprocedure
    ) THEN RAISE EXCEPTION 'use resolve_pending_item para resolver'; END IF;
    IF auth.uid() IS NULL OR NEW.resolved_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ator de resolucao invalido'; END IF;
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER crm_guard_pending_item BEFORE INSERT OR UPDATE ON public.crm_pending_items
FOR EACH ROW EXECUTE FUNCTION public.crm_guard_pending_item();
REVOKE ALL ON FUNCTION public.crm_guard_pending_item(),public.crm_link_message_conversation(),public.crm_advance_conversation_activity() FROM PUBLIC;
-- Serialize first-contact creation per organization/canonical phone. Duplicate
-- webhook deliveries cannot create a second patient or an extra initial deal.
CREATE FUNCTION public.ensure_whatsapp_patient(p_org uuid,p_phone text,p_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_canon text; v_patient uuid; v_stage uuid;
BEGIN
  v_canon := public.phone_canon(p_phone);
  IF v_canon IS NULL OR length(v_canon)<10 THEN RAISE EXCEPTION 'telefone invalido'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || v_canon,0));
  SELECT id INTO v_patient FROM public.crm_patients
    WHERE org_id=p_org AND public.phone_canon(phone)=v_canon ORDER BY created_at,id LIMIT 1;
  IF v_patient IS NOT NULL THEN RETURN v_patient; END IF;
  INSERT INTO public.crm_patients(org_id,name,phone,source,channel)
    VALUES(p_org,COALESCE(NULLIF(btrim(p_name),''),p_phone),p_phone,'Whatsapp','whatsapp') RETURNING id INTO v_patient;
  SELECT id INTO v_stage FROM public.crm_pipeline_stages WHERE org_id=p_org ORDER BY position,id LIMIT 1;
  IF v_stage IS NOT NULL THEN
    INSERT INTO public.crm_deals(org_id,patient_id,stage_id) VALUES(p_org,v_patient,v_stage);
  END IF;
  RETURN v_patient;
END $$;
REVOKE ALL ON FUNCTION public.ensure_whatsapp_patient(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_whatsapp_patient(uuid,text,text) TO service_role;
COMMIT;
