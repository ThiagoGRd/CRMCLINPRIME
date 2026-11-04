-- Audited local recovery only. No operation in this migration dispatches a
-- provider request, invents acceptance, reclaims a claim, or reuses an intent.
BEGIN;
ALTER TABLE public.crm_outbound_requests DROP CONSTRAINT crm_outbound_requests_state_check;
ALTER TABLE public.crm_outbound_requests ADD CONSTRAINT crm_outbound_requests_state_check
  CHECK (state IN ('pending','in_flight','sent','failed','uncertain','cancelled'));
ALTER TABLE public.crm_outbound_requests DROP CONSTRAINT crm_outbound_requests_check;
ALTER TABLE public.crm_outbound_requests ADD CONSTRAINT crm_outbound_requests_claim_check
  CHECK ((state IN ('pending','cancelled') AND claim_token IS NULL AND claimed_at IS NULL)
    OR (state NOT IN ('pending','cancelled') AND claim_token IS NOT NULL AND claimed_at IS NOT NULL));
CREATE UNIQUE INDEX crm_conversations_org_id_identity ON public.crm_conversations(org_id,id);

-- An absent request needs its own durable tombstone: no fabricated message
-- payload or sender identity is inserted into the immutable dispatch ledger.
CREATE TABLE public.crm_outbound_cancellations (
  request_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  cancelled_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(org_id,conversation_id) REFERENCES public.crm_conversations(org_id,id)
);
CREATE TABLE public.crm_outbound_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('finalize','cancel','observe')),
  evidence text NOT NULL CHECK(evidence ~ '[^[:space:]]' AND length(evidence)<=2000),
  previous_state text NOT NULL,
  resulting_state text NOT NULL,
  provider_message_id text,
  message_id uuid REFERENCES public.crm_messages(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(org_id,conversation_id) REFERENCES public.crm_conversations(org_id,id)
);
CREATE INDEX crm_outbound_reconciliation_history ON public.crm_outbound_reconciliations(org_id,conversation_id,request_id,created_at);
ALTER TABLE public.crm_outbound_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_outbound_reconciliations ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_outbound_cancellation_member_read ON public.crm_outbound_cancellations FOR SELECT TO authenticated
  USING(public.crm_is_org_member(org_id));
CREATE POLICY crm_outbound_reconciliation_member_read ON public.crm_outbound_reconciliations FOR SELECT TO authenticated
  USING(public.crm_is_org_member(org_id));
REVOKE ALL ON public.crm_outbound_cancellations,public.crm_outbound_reconciliations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.crm_outbound_cancellations,public.crm_outbound_reconciliations TO authenticated;

CREATE FUNCTION public.crm_guard_outbound_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'outbound_history_immutable'; END $$;
CREATE TRIGGER crm_guard_outbound_history BEFORE UPDATE OR DELETE ON public.crm_outbound_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.crm_guard_outbound_history();
CREATE TRIGGER crm_guard_outbound_history BEFORE UPDATE OR DELETE ON public.crm_outbound_cancellations
  FOR EACH ROW EXECUTE FUNCTION public.crm_guard_outbound_history();
REVOKE ALL ON FUNCTION public.crm_guard_outbound_history() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.crm_guard_outbound_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.request_id,NEW.org_id,NEW.requested_by,NEW.conversation_id,NEW.channel_id,NEW.patient_id,NEW.content,NEW.created_at)
     IS DISTINCT FROM
     (OLD.request_id,OLD.org_id,OLD.requested_by,OLD.conversation_id,OLD.channel_id,OLD.patient_id,OLD.content,OLD.created_at) THEN
    RAISE EXCEPTION 'outbound_identity_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='pending' AND NEW.state IN ('in_flight','cancelled')) OR
    (OLD.state='in_flight' AND NEW.state IN ('sent','failed','uncertain')) OR
    (OLD.state='uncertain' AND NEW.state='sent')
  ) THEN RAISE EXCEPTION 'outbound_state_transition_invalid'; END IF;
  IF OLD.claim_token IS NOT NULL AND NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
    RAISE EXCEPTION 'outbound_claim_immutable';
  END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'outbound_provider_id_conflict';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.get_crm_outbound_request(p_request_id uuid,p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item public.crm_outbound_requests;
BEGIN
  IF EXISTS(SELECT 1 FROM public.crm_outbound_cancellations c WHERE c.request_id=p_request_id
    AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=c.org_id AND m.user_id=p_user_id)) THEN
    RETURN jsonb_build_object('request_id',p_request_id,'state','cancelled');
  END IF;
  SELECT r.* INTO item FROM public.crm_outbound_requests r
    WHERE r.request_id=p_request_id AND EXISTS(
      SELECT 1 FROM public.org_members m WHERE m.org_id=r.org_id AND m.user_id=p_user_id);
  IF NOT FOUND THEN RETURN jsonb_build_object('request_id',p_request_id,'state','not_found'); END IF;
  IF item.state='in_flight' AND item.claimed_at < clock_timestamp()-interval '2 minutes' THEN
    item.state:='uncertain'; item.failure_code:='outcome_unknown';
  END IF;
  RETURN public.crm_outbound_result(item);
END $$;

CREATE OR REPLACE FUNCTION public.claim_crm_outbound_request(
  p_request_id uuid,p_user_id uuid,p_conversation_id uuid,p_channel_id uuid,p_content text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE conversation public.crm_conversations; item public.crm_outbound_requests;
  cancellation public.crm_outbound_cancellations; v_claimed boolean:=false;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_content IS NULL OR
     p_content !~ '[^[:space:]]' OR length(p_content)>4096 THEN RAISE EXCEPTION 'outbound_input_invalid'; END IF;
  SELECT c.* INTO conversation FROM public.crm_conversations c WHERE c.id=p_conversation_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.org_members m
     WHERE m.org_id=conversation.org_id AND m.user_id=p_user_id) THEN
    RAISE EXCEPTION 'outbound_access_denied';
  END IF;
  -- Same lock and ordering as cancellation, including when no row exists yet.
  -- Hash collisions only serialize unrelated UUIDs; they cannot permit dispatch.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm_outbound:'||p_request_id::text,0));
  SELECT * INTO cancellation FROM public.crm_outbound_cancellations WHERE request_id=p_request_id;
  IF FOUND THEN
    IF (cancellation.org_id,cancellation.conversation_id) IS DISTINCT FROM (conversation.org_id,p_conversation_id)
      OR conversation.channel_id IS DISTINCT FROM p_channel_id THEN RAISE EXCEPTION 'outbound_request_conflict'; END IF;
    RETURN jsonb_build_object('request_id',p_request_id,'state','cancelled','claimed',false,'claim_token',NULL);
  END IF;
  IF conversation.channel_id IS DISTINCT FROM p_channel_id OR NOT EXISTS(
    SELECT 1 FROM public.channels c WHERE c.id=p_channel_id AND c.org_id=conversation.org_id
    AND c.type='whatsapp_cloud' AND c.status='connected' AND nullif(btrim(c.phone_number_id),'') IS NOT NULL
    AND c.inbox_key IN ('reception','commercial','crc')
  ) THEN RAISE EXCEPTION 'outbound_route_unavailable'; END IF;
  INSERT INTO public.crm_outbound_requests(request_id,org_id,requested_by,conversation_id,channel_id,patient_id,content)
    VALUES(p_request_id,conversation.org_id,p_user_id,p_conversation_id,p_channel_id,conversation.patient_id,p_content)
    ON CONFLICT(request_id) DO NOTHING;
  SELECT * INTO item FROM public.crm_outbound_requests WHERE request_id=p_request_id FOR UPDATE;
  IF (item.org_id,item.requested_by,item.conversation_id,item.channel_id,item.content) IS DISTINCT FROM
     (conversation.org_id,p_user_id,p_conversation_id,p_channel_id,p_content) THEN
    RAISE EXCEPTION 'outbound_request_conflict';
  END IF;
  IF item.state='pending' THEN
    UPDATE public.crm_outbound_requests SET state='in_flight',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
      WHERE request_id=p_request_id RETURNING * INTO item;
    v_claimed:=true;
  ELSIF item.state='in_flight' AND item.claimed_at<clock_timestamp()-interval '2 minutes' THEN
    UPDATE public.crm_outbound_requests SET state='uncertain',failure_code='outcome_unknown'
      WHERE request_id=p_request_id RETURNING * INTO item;
  END IF;
  RETURN public.crm_outbound_result(item) || jsonb_build_object('claimed',v_claimed,
    'claim_token',CASE WHEN v_claimed THEN item.claim_token ELSE NULL END);
END $$;

CREATE FUNCTION public.reconcile_crm_outbound_request(
  p_request_id uuid,p_user_id uuid,p_conversation_id uuid,p_operation text,p_evidence text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE conversation public.crm_conversations; item public.crm_outbound_requests;
  cancellation public.crm_outbound_cancellations; audit public.crm_outbound_reconciliations;
  v_exists boolean; v_previous text; v_result jsonb;
BEGIN
  SELECT c.* INTO conversation FROM public.crm_conversations c WHERE c.id=p_conversation_id;
  -- 'admin' is the privileged membership value used by the existing settings UI.
  -- Do not infer new owner roles or accept a client-provided role/actor.
  IF NOT FOUND OR p_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members m
    WHERE m.org_id=conversation.org_id AND m.user_id=p_user_id AND m.role='admin') THEN
    RAISE EXCEPTION 'outbound_access_denied';
  END IF;
  IF p_request_id IS NULL OR p_operation IS NULL OR p_operation NOT IN ('finalize','cancel','observe') THEN
    RAISE EXCEPTION 'outbound_input_invalid';
  END IF;
  IF p_evidence IS NULL OR p_evidence !~ '[^[:space:]]' OR length(p_evidence)>2000 THEN
    RAISE EXCEPTION 'outbound_evidence_required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crm_outbound:'||p_request_id::text,0));
  SELECT * INTO item FROM public.crm_outbound_requests WHERE request_id=p_request_id FOR UPDATE;
  v_exists:=FOUND;
  IF v_exists AND (item.org_id,item.conversation_id) IS DISTINCT FROM (conversation.org_id,p_conversation_id) THEN
    RAISE EXCEPTION 'outbound_request_conflict';
  END IF;
  SELECT * INTO cancellation FROM public.crm_outbound_cancellations WHERE request_id=p_request_id;
  IF FOUND AND (cancellation.org_id,cancellation.conversation_id) IS DISTINCT FROM (conversation.org_id,p_conversation_id) THEN
    RAISE EXCEPTION 'outbound_request_conflict';
  END IF;
  v_previous:=CASE WHEN cancellation.request_id IS NOT NULL THEN 'cancelled' WHEN v_exists THEN item.state ELSE 'not_found' END;
  IF p_operation='cancel' THEN
    IF v_exists AND (item.state NOT IN ('pending','cancelled') OR item.claim_token IS NOT NULL OR item.claimed_at IS NOT NULL OR item.provider_message_id IS NOT NULL) THEN
      RAISE EXCEPTION 'outbound_cancel_unsafe';
    END IF;
    INSERT INTO public.crm_outbound_cancellations(request_id,org_id,conversation_id,cancelled_by)
      VALUES(p_request_id,conversation.org_id,p_conversation_id,p_user_id) ON CONFLICT(request_id) DO NOTHING;
    IF v_exists AND item.state='pending' THEN
      UPDATE public.crm_outbound_requests SET state='cancelled',failure_code='operator_cancelled'
        WHERE request_id=p_request_id RETURNING * INTO item;
    END IF;
    v_result:=jsonb_build_object('request_id',p_request_id,'state','cancelled');
  ELSE
    IF NOT v_exists THEN RAISE EXCEPTION 'outbound_request_not_found'; END IF;
    IF p_operation='finalize' THEN
      IF item.state NOT IN ('in_flight','uncertain','sent') OR nullif(btrim(item.provider_message_id),'') IS NULL THEN
        RAISE EXCEPTION 'outbound_acceptance_required';
      END IF;
      -- This pre-existing function is a local atomic insert, never a provider send.
      -- A retry of a committed finalization returns the original message.
      v_result:=public.complete_crm_outbound_request(item.request_id,item.claim_token,item.provider_message_id);
      SELECT * INTO item FROM public.crm_outbound_requests WHERE request_id=p_request_id;
    ELSE
      IF item.state NOT IN ('in_flight','uncertain') THEN RAISE EXCEPTION 'outbound_observation_unavailable'; END IF;
      -- A human note is evidence for review, not provider acceptance or delivery.
      v_result:=public.get_crm_outbound_request(p_request_id,p_user_id);
    END IF;
  END IF;
  INSERT INTO public.crm_outbound_reconciliations(request_id,org_id,conversation_id,actor_id,operation,evidence,
      previous_state,resulting_state,provider_message_id,message_id)
    VALUES(p_request_id,conversation.org_id,p_conversation_id,p_user_id,p_operation,btrim(p_evidence),
      v_previous,v_result->>'state',item.provider_message_id,item.message_id) RETURNING * INTO audit;
  RETURN v_result || jsonb_build_object('reconciliation',to_jsonb(audit));
END $$;
REVOKE ALL ON FUNCTION public.reconcile_crm_outbound_request(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_crm_outbound_request(uuid,uuid,uuid,text,text) TO service_role;
COMMIT;
