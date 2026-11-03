-- Durable at-most-once dispatch, not exactly-once delivery. Never reclaim an
-- in-flight request: a worker crash may occur after WhatsApp accepted its send.
-- This migration does not dispatch, retry or reconcile any external messages.
BEGIN;
CREATE TABLE public.crm_outbound_requests (
  request_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  requested_by uuid NOT NULL,
  conversation_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  content text NOT NULL CHECK (content ~ '[^[:space:]]' AND length(content)<=4096),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_flight','sent','failed','uncertain')),
  claim_token uuid,
  claimed_at timestamptz,
  failure_code text,
  provider_message_id text,
  message_id uuid UNIQUE REFERENCES public.crm_messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,patient_id,channel_id,conversation_id)
    REFERENCES public.crm_conversations(org_id,patient_id,channel_id,id),
  CHECK ((state='pending' AND claim_token IS NULL AND claimed_at IS NULL)
      OR (state<>'pending' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((state='sent' AND message_id IS NOT NULL AND provider_message_id IS NOT NULL)
      OR (state<>'sent' AND message_id IS NULL))
);
CREATE INDEX crm_outbound_conversation_state ON public.crm_outbound_requests(org_id,conversation_id,state,created_at);
ALTER TABLE public.crm_outbound_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_outbound_member_read ON public.crm_outbound_requests FOR SELECT TO authenticated
  USING(public.crm_is_org_member(org_id));
-- Claim tokens never reach browser clients. Explicit column grants are intentional.
REVOKE ALL ON public.crm_outbound_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT(request_id,org_id,requested_by,conversation_id,channel_id,patient_id,content,state,
  failure_code,provider_message_id,message_id,created_at,updated_at,claimed_at)
  ON public.crm_outbound_requests TO authenticated;

CREATE FUNCTION public.crm_guard_outbound_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.request_id,NEW.org_id,NEW.requested_by,NEW.conversation_id,NEW.channel_id,NEW.patient_id,NEW.content,NEW.created_at)
     IS DISTINCT FROM
     (OLD.request_id,OLD.org_id,OLD.requested_by,OLD.conversation_id,OLD.channel_id,OLD.patient_id,OLD.content,OLD.created_at) THEN
    RAISE EXCEPTION 'outbound_identity_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='pending' AND NEW.state='in_flight') OR
    (OLD.state='in_flight' AND NEW.state IN ('sent','failed','uncertain')) OR
    (OLD.state='uncertain' AND NEW.state='sent')
  ) THEN RAISE EXCEPTION 'outbound_state_transition_invalid'; END IF;
  IF OLD.claim_token IS NOT NULL AND NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
    RAISE EXCEPTION 'outbound_claim_immutable';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER crm_guard_outbound_request BEFORE UPDATE ON public.crm_outbound_requests
  FOR EACH ROW EXECUTE FUNCTION public.crm_guard_outbound_request();
REVOKE ALL ON FUNCTION public.crm_guard_outbound_request() FROM PUBLIC;

CREATE FUNCTION public.crm_outbound_result(p_request public.crm_outbound_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('request_id',p_request.request_id,'state',p_request.state,
    'failure_code',p_request.failure_code,'provider_message_id',p_request.provider_message_id,
    'message',CASE WHEN p_request.state='sent' THEN (
      SELECT jsonb_build_object('id',m.id,'patient_id',m.patient_id,'conversation_id',m.conversation_id,
        'channel_id',m.channel_id,'direction',m.direction,'content',m.content,'created_at',m.created_at)
      FROM public.crm_messages m WHERE m.id=p_request.message_id AND m.org_id=p_request.org_id
    ) ELSE NULL END);
$$;
REVOKE ALL ON FUNCTION public.crm_outbound_result(public.crm_outbound_requests) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.get_crm_outbound_request(p_request_id uuid,p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item public.crm_outbound_requests;
BEGIN
  SELECT r.* INTO item FROM public.crm_outbound_requests r
    WHERE r.request_id=p_request_id AND EXISTS(
      SELECT 1 FROM public.org_members m WHERE m.org_id=r.org_id AND m.user_id=p_user_id);
  IF NOT FOUND THEN RETURN jsonb_build_object('request_id',p_request_id,'state','not_found'); END IF;
  -- Read-only status reporting. Old claims are uncertain, never eligible to resend.
  IF item.state='in_flight' AND item.claimed_at < clock_timestamp()-interval '2 minutes' THEN
    item.state:='uncertain'; item.failure_code:='outcome_unknown';
  END IF;
  RETURN public.crm_outbound_result(item);
END $$;
REVOKE ALL ON FUNCTION public.get_crm_outbound_request(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_outbound_request(uuid,uuid) TO service_role;

CREATE FUNCTION public.claim_crm_outbound_request(
  p_request_id uuid,p_user_id uuid,p_conversation_id uuid,p_channel_id uuid,p_content text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE conversation public.crm_conversations; item public.crm_outbound_requests; v_claimed boolean:=false;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_content IS NULL OR
     p_content !~ '[^[:space:]]' OR length(p_content)>4096 THEN RAISE EXCEPTION 'outbound_input_invalid'; END IF;
  SELECT c.* INTO conversation FROM public.crm_conversations c WHERE c.id=p_conversation_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.org_members m
     WHERE m.org_id=conversation.org_id AND m.user_id=p_user_id) THEN
    RAISE EXCEPTION 'outbound_access_denied';
  END IF;
  IF conversation.channel_id IS DISTINCT FROM p_channel_id OR NOT EXISTS(
    SELECT 1 FROM public.channels c WHERE c.id=p_channel_id AND c.org_id=conversation.org_id
    AND c.type='whatsapp_cloud' AND c.status='connected' AND nullif(btrim(c.phone_number_id),'') IS NOT NULL
    AND c.inbox_key IN ('reception','commercial','crc')
  ) THEN RAISE EXCEPTION 'outbound_route_unavailable'; END IF;
  INSERT INTO public.crm_outbound_requests(request_id,org_id,requested_by,conversation_id,channel_id,patient_id,content)
    VALUES(p_request_id,conversation.org_id,p_user_id,p_conversation_id,p_channel_id,conversation.patient_id,p_content)
    ON CONFLICT(request_id) DO NOTHING;
  -- The conflicting INSERT waits for its winner, then this row lock serializes all
  -- claim decisions across workers. No leased locks or timeout-based re-dispatch.
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
REVOKE ALL ON FUNCTION public.claim_crm_outbound_request(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_crm_outbound_request(uuid,uuid,uuid,uuid,text) TO service_role;

CREATE FUNCTION public.complete_crm_outbound_request(p_request_id uuid,p_claim_token uuid,p_provider_message_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item public.crm_outbound_requests; v_message uuid;
BEGIN
  IF p_provider_message_id IS NULL OR length(btrim(p_provider_message_id))=0 THEN
    RAISE EXCEPTION 'outbound_provider_id_required';
  END IF;
  SELECT * INTO item FROM public.crm_outbound_requests WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR p_claim_token IS NULL OR item.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'outbound_claim_invalid';
  END IF;
  IF item.state='sent' AND item.provider_message_id=p_provider_message_id THEN
    RETURN public.crm_outbound_result(item);
  END IF;
  IF item.state NOT IN ('in_flight','uncertain') OR
     (item.provider_message_id IS NOT NULL AND item.provider_message_id<>p_provider_message_id) THEN
    RAISE EXCEPTION 'outbound_claim_invalid';
  END IF;
  INSERT INTO public.crm_messages(org_id,patient_id,conversation_id,channel_id,direction,content,message_type,status,whatsapp_message_id,sent_by)
    VALUES(item.org_id,item.patient_id,item.conversation_id,item.channel_id,'outbound',item.content,'text','sent',p_provider_message_id,item.requested_by)
    RETURNING id INTO v_message;
  UPDATE public.crm_outbound_requests SET state='sent',message_id=v_message,provider_message_id=p_provider_message_id,failure_code=NULL
    WHERE request_id=p_request_id RETURNING * INTO item;
  RETURN public.crm_outbound_result(item);
END $$;
REVOKE ALL ON FUNCTION public.complete_crm_outbound_request(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_crm_outbound_request(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.finish_crm_outbound_request(p_request_id uuid,p_claim_token uuid,p_state text,p_failure_code text,p_provider_message_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item public.crm_outbound_requests;
BEGIN
  IF p_state NOT IN ('failed','uncertain') OR p_state IS NULL THEN RAISE EXCEPTION 'outbound_state_transition_invalid'; END IF;
  SELECT * INTO item FROM public.crm_outbound_requests WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR p_claim_token IS NULL OR item.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'outbound_claim_invalid';
  END IF;
  -- A delayed accepted response may arrive after a replay marked this claim
  -- uncertain. Preserve that evidence without dispatching or changing its ID.
  IF item.provider_message_id IS NOT NULL AND p_provider_message_id IS NOT NULL
     AND item.provider_message_id<>p_provider_message_id THEN
    RAISE EXCEPTION 'outbound_provider_id_conflict';
  END IF;
  -- A lost successful completion response must not downgrade a committed send.
  IF item.state='in_flight' THEN
    UPDATE public.crm_outbound_requests SET state=p_state,failure_code=p_failure_code,
      provider_message_id=p_provider_message_id WHERE request_id=p_request_id RETURNING * INTO item;
  ELSIF item.state='uncertain' AND p_state='uncertain' AND p_provider_message_id IS NOT NULL THEN
    UPDATE public.crm_outbound_requests SET provider_message_id=p_provider_message_id,failure_code=p_failure_code
      WHERE request_id=p_request_id RETURNING * INTO item;
  END IF;
  RETURN public.crm_outbound_result(item);
END $$;
REVOKE ALL ON FUNCTION public.finish_crm_outbound_request(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_crm_outbound_request(uuid,uuid,text,text,text) TO service_role;
COMMIT;
