-- Apply only in reviewed staging. Adds service-window enforcement and immutable
-- approved-template intent identity. It performs no Meta calls or dispatches.
BEGIN;
ALTER TABLE public.crm_outbound_requests
  ADD COLUMN message_kind text NOT NULL DEFAULT 'text' CHECK(message_kind IN ('text','template')),
  ADD COLUMN template_payload jsonb,
  ADD CONSTRAINT crm_outbound_payload_kind CHECK(
    (message_kind='text' AND template_payload IS NULL) OR
    (message_kind='template' AND template_payload IS NOT NULL AND jsonb_typeof(template_payload)='object'));
GRANT SELECT(message_kind,template_payload) ON public.crm_outbound_requests TO authenticated;
CREATE INDEX crm_messages_latest_inbound ON public.crm_messages(org_id,conversation_id,channel_id,created_at DESC)
  WHERE direction='inbound';

CREATE FUNCTION public.get_crm_whatsapp_window(p_conversation_id uuid,p_channel_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE conversation public.crm_conversations; v_last timestamptz; v_now timestamptz:=clock_timestamp();
  v_open boolean; v_reason text;
BEGIN
  SELECT c.* INTO conversation FROM public.crm_conversations c WHERE c.id=p_conversation_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=conversation.org_id AND m.user_id=p_user_id) THEN
    RAISE EXCEPTION 'outbound_access_denied';
  END IF;
  IF conversation.channel_id IS DISTINCT FROM p_channel_id THEN RAISE EXCEPTION 'outbound_route_unavailable'; END IF;
  SELECT max(m.created_at) INTO v_last FROM public.crm_messages m
    WHERE m.org_id=conversation.org_id AND m.conversation_id=p_conversation_id AND m.channel_id=p_channel_id
    AND m.patient_id=conversation.patient_id AND m.direction='inbound';
  v_open:=v_last IS NOT NULL AND isfinite(v_last) AND v_last<=v_now AND v_last>v_now-interval '24 hours';
  v_reason:=CASE WHEN v_last IS NULL THEN 'no_inbound' WHEN NOT isfinite(v_last) OR v_last>v_now THEN 'invalid_timestamp'
    WHEN v_open THEN 'open' ELSE 'expired' END;
  RETURN jsonb_build_object('open',v_open,'last_inbound_at',v_last,
    'expires_at',CASE WHEN isfinite(v_last) AND v_last<=v_now THEN v_last+interval '24 hours' ELSE NULL END,'reason',v_reason);
END $$;
REVOKE ALL ON FUNCTION public.get_crm_whatsapp_window(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_whatsapp_window(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.crm_guard_outbound_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.request_id,NEW.org_id,NEW.requested_by,NEW.conversation_id,NEW.channel_id,NEW.patient_id,NEW.content,NEW.created_at,NEW.message_kind,NEW.template_payload)
     IS DISTINCT FROM
     (OLD.request_id,OLD.org_id,OLD.requested_by,OLD.conversation_id,OLD.channel_id,OLD.patient_id,OLD.content,OLD.created_at,OLD.message_kind,OLD.template_payload) THEN
    RAISE EXCEPTION 'outbound_identity_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='pending' AND NEW.state IN ('in_flight','cancelled','failed')) OR
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

DROP FUNCTION public.claim_crm_outbound_request(uuid,uuid,uuid,uuid,text);
CREATE OR REPLACE FUNCTION public.claim_crm_outbound_request(
  p_request_id uuid,p_user_id uuid,p_conversation_id uuid,p_channel_id uuid,p_content text,
  p_message_kind text DEFAULT 'text',p_template_payload jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE conversation public.crm_conversations; item public.crm_outbound_requests;
  cancellation public.crm_outbound_cancellations; v_claimed boolean:=false;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_content IS NULL OR
     p_content !~ '[^[:space:]]' OR length(p_content)>4096 THEN RAISE EXCEPTION 'outbound_input_invalid'; END IF;
  IF p_message_kind IS NULL OR p_message_kind NOT IN ('text','template') OR
    (p_message_kind='text' AND p_template_payload IS NOT NULL) OR
    (p_message_kind='template' AND (p_template_payload IS NULL OR jsonb_typeof(p_template_payload)<>'object')) THEN
    RAISE EXCEPTION 'outbound_input_invalid';
  END IF;
  IF p_message_kind='template' THEN
    IF NOT (p_template_payload ?& ARRAY['id','name','language','header','body']) OR
      (p_template_payload - ARRAY['id','name','language','header','body'])<>'{}'::jsonb OR
      jsonb_typeof(p_template_payload->'id')<>'string' OR nullif(p_template_payload->>'id','') IS NULL OR
      jsonb_typeof(p_template_payload->'name')<>'string' OR ((p_template_payload->>'name') !~ '^[a-z0-9_]+$' OR length(p_template_payload->>'name')>512) OR
      jsonb_typeof(p_template_payload->'language')<>'string' OR (p_template_payload->>'language') !~ '^[a-z]{2,3}(_[A-Z]{2})?$' OR
      jsonb_typeof(p_template_payload->'header')<>'array' OR jsonb_typeof(p_template_payload->'body')<>'array' THEN
      RAISE EXCEPTION 'outbound_input_invalid';
    END IF;
    IF jsonb_array_length(p_template_payload->'header')>1 OR jsonb_array_length(p_template_payload->'body')>20 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements((p_template_payload->'header')||(p_template_payload->'body')) v
      WHERE jsonb_typeof(v)<>'string' OR (v#>>'{}') !~ '[^[:space:]]' OR length(v#>>'{}')>1024
    ) THEN RAISE EXCEPTION 'outbound_input_invalid'; END IF;
  END IF;
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
  INSERT INTO public.crm_outbound_requests(request_id,org_id,requested_by,conversation_id,channel_id,patient_id,content,message_kind,template_payload)
    VALUES(p_request_id,conversation.org_id,p_user_id,p_conversation_id,p_channel_id,conversation.patient_id,p_content,p_message_kind,p_template_payload)
    ON CONFLICT(request_id) DO NOTHING;
  SELECT * INTO item FROM public.crm_outbound_requests WHERE request_id=p_request_id FOR UPDATE;
  IF (item.org_id,item.requested_by,item.conversation_id,item.channel_id,item.content,item.message_kind,item.template_payload) IS DISTINCT FROM
     (conversation.org_id,p_user_id,p_conversation_id,p_channel_id,p_content,p_message_kind,p_template_payload) THEN
    RAISE EXCEPTION 'outbound_request_conflict';
  END IF;
  IF item.state='pending' THEN
    -- Only genuine inbound activity on this exact conversation/channel opens
    -- the window. Future, absent, legacy or stale timestamps fail closed.
    IF p_message_kind='text' AND NOT ((public.get_crm_whatsapp_window(p_conversation_id,p_channel_id,p_user_id)->>'open')::boolean) THEN
      -- A local rejection is terminal evidence for this exact bound intent,
      -- never permission to send it when the window later opens.
      UPDATE public.crm_outbound_requests SET state='failed',claim_token=gen_random_uuid(),
        claimed_at=clock_timestamp(),failure_code='outside_service_window'
        WHERE request_id=p_request_id RETURNING * INTO item;
      RETURN public.crm_outbound_result(item) || jsonb_build_object('claimed',false,'claim_token',NULL);
    END IF;
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

CREATE OR REPLACE FUNCTION public.complete_crm_outbound_request(p_request_id uuid,p_claim_token uuid,p_provider_message_id text)
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
    VALUES(item.org_id,item.patient_id,item.conversation_id,item.channel_id,'outbound',item.content,item.message_kind,'sent',p_provider_message_id,item.requested_by)
    RETURNING id INTO v_message;
  UPDATE public.crm_outbound_requests SET state='sent',message_id=v_message,provider_message_id=p_provider_message_id,failure_code=NULL
    WHERE request_id=p_request_id RETURNING * INTO item;
  RETURN public.crm_outbound_result(item);
END $$;
REVOKE ALL ON FUNCTION public.complete_crm_outbound_request(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_crm_outbound_request(uuid,uuid,text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_crm_outbound_request(uuid,uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_crm_outbound_request(uuid,uuid,uuid,uuid,text,text,jsonb) TO service_role;
COMMIT;
