-- WA-4C: Owned expected-step booking FSM transition for channel_conversations.
-- SERVICE ROLE / backend only. Does NOT create appointments/clients or send messages.
-- Preserves WA-4B1 receipt ownership + out-of-order last_inbound_at guards.
--
-- Duplicate semantics:
--   apply_whatsapp_conversation_event_owned (touch) advances last_inbound_message_id
--   before FSM runs. Therefore "same message id" alone is NOT a duplicate FSM apply.
--   Idempotent duplicate = state.sourceMessageId already equals this inbound message id
--   (FSM transition for this message already committed).

BEGIN;

CREATE OR REPLACE FUNCTION public.transition_whatsapp_booking_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_external_user_id text,
  p_external_message_id text,
  p_message_at timestamptz,
  p_expected_flow text,
  p_expected_step text,
  p_next_flow text,
  p_next_step text,
  p_next_state jsonb,
  p_inactivity_seconds integer DEFAULT 86400
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_own text;
  v_now timestamptz := clock_timestamp();
  v_expires timestamptz;
  v_inactivity integer := COALESCE(NULLIF(p_inactivity_seconds, 0), 86400);
  v_ext text := nullif(btrim(p_external_user_id), '');
  v_msg_id text := nullif(btrim(p_external_message_id), '');
  v_conv public.channel_conversations%ROWTYPE;
  v_exp_flow text := nullif(btrim(p_expected_flow), '');
  v_exp_step text := nullif(btrim(p_expected_step), '');
  v_next_flow text := nullif(btrim(p_next_flow), '');
  v_next_step text := nullif(btrim(p_next_step), '');
  v_state jsonb := COALESCE(p_next_state, '{}'::jsonb);
  v_applied_msg text;
  v_expired boolean := false;
BEGIN
  IF v_ext IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_sender');
  END IF;

  v_own := public.whatsapp_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  v_expires := v_now + make_interval(secs => v_inactivity);

  SELECT c.*
  INTO v_conv
  FROM public.channel_conversations c
  WHERE c.salon_id = p_salon_id
    AND c.provider = 'whatsapp'
    AND c.external_user_id = v_ext
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'conversation_missing');
  END IF;

  -- Out-of-order: older Meta message must not change FSM.
  IF p_message_at IS NOT NULL
     AND v_conv.last_inbound_at IS NOT NULL
     AND p_message_at < v_conv.last_inbound_at THEN
    RETURN jsonb_build_object(
      'kind', 'outdated',
      'conversation_id', v_conv.id,
      'current_flow', v_conv.current_flow,
      'current_step', v_conv.current_step,
      'state', COALESCE(v_conv.state, '{}'::jsonb)
    );
  END IF;

  -- FSM already applied for this inbound message (idempotent).
  v_applied_msg := nullif(btrim(COALESCE(v_conv.state->>'sourceMessageId', '')), '');
  IF v_msg_id IS NOT NULL AND v_applied_msg IS NOT NULL AND v_applied_msg = v_msg_id THEN
    RETURN jsonb_build_object(
      'kind', 'ok',
      'duplicate', true,
      'conversation_id', v_conv.id,
      'current_flow', v_conv.current_flow,
      'current_step', v_conv.current_step,
      'state', COALESCE(v_conv.state, '{}'::jsonb),
      'client_id', v_conv.client_id
    );
  END IF;

  -- Expired conversation: treat as idle before expected-step CAS (identity/client preserved).
  v_expired := (v_conv.expires_at IS NOT NULL AND v_conv.expires_at <= v_now);
  IF v_expired THEN
    v_conv.current_flow := NULL;
    v_conv.current_step := NULL;
    v_conv.state := '{}'::jsonb;
  END IF;

  -- Expected-step CAS (NULL-safe). Concurrent A/B: loser gets stale_step.
  IF v_conv.current_flow IS DISTINCT FROM v_exp_flow
     OR v_conv.current_step IS DISTINCT FROM v_exp_step THEN
    RETURN jsonb_build_object(
      'kind', 'stale_step',
      'conversation_id', v_conv.id,
      'current_flow', v_conv.current_flow,
      'current_step', v_conv.current_step,
      'state', COALESCE(v_conv.state, '{}'::jsonb)
    );
  END IF;

  UPDATE public.channel_conversations c
  SET
    current_flow = v_next_flow,
    current_step = v_next_step,
    state = v_state,
    last_inbound_message_id = COALESCE(v_msg_id, c.last_inbound_message_id),
    last_inbound_at = COALESCE(p_message_at, c.last_inbound_at, v_now),
    last_interaction_at = v_now,
    expires_at = v_expires,
    updated_at = v_now
  WHERE c.id = v_conv.id
    AND c.salon_id = p_salon_id
    AND c.provider = 'whatsapp'
    AND c.external_user_id = v_ext
    AND (
      -- Expiry already validated under FOR UPDATE; allow idle→next without matching stale columns.
      v_expired
      OR (
        c.current_flow IS NOT DISTINCT FROM v_exp_flow
        AND c.current_step IS NOT DISTINCT FROM v_exp_step
      )
    )
  RETURNING * INTO v_conv;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'stale_step', 'code', 'conversation_cas_miss');
  END IF;

  RETURN jsonb_build_object(
    'kind', 'ok',
    'duplicate', false,
    'conversation_id', v_conv.id,
    'current_flow', v_conv.current_flow,
    'current_step', v_conv.current_step,
    'state', COALESCE(v_conv.state, '{}'::jsonb),
    'client_id', v_conv.client_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transition_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.transition_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) TO service_role;

COMMIT;
