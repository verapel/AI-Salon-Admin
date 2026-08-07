-- IG-5: Owned Instagram booking FSM transition for channel_conversations.
-- Additive only. SERVICE ROLE / backend only.
-- Does NOT create appointments/clients, send messages, or link identity.client_id.
--
-- Mirrors WA-4C transition_whatsapp_booking_owned with provider='instagram'
-- and instagram_lock_owned_receipt (from IG-4).
--
-- Duplicate semantics:
--   IG-4 transport touch may advance last_inbound_message_id before FSM.
--   Idempotent FSM duplicate = state.sourceMessageId already equals this inbound mid.

BEGIN;

CREATE OR REPLACE FUNCTION public.transition_instagram_booking_owned(
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

  -- Hardcoded Instagram receipt ownership (attempt generation CAS).
  v_own := public.instagram_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  v_expires := v_now + make_interval(secs => v_inactivity);

  SELECT c.*
  INTO v_conv
  FROM public.channel_conversations c
  WHERE c.salon_id = p_salon_id
    AND c.provider = 'instagram'
    AND c.external_user_id = v_ext
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'conversation_missing');
  END IF;

  -- Reject hijacking unknown/non-booking future flows (unless currently idle after expiry reset).
  -- Expected-step CAS below also enforces this for non-expired rows.

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

  -- FSM already applied for this inbound message (idempotent crash/retry).
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

  -- Expected-step CAS (NULL-safe). Concurrent loser → stale_step (no overwrite).
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

  -- IG-5A/B: ready_to_book requires complete normalized booking state (defense in depth).
  -- Intermediate steps may persist partial state; only ready_to_book is fully gated.
  -- Type contract matches isCompleteInstagramReadyState: JSON string + trimmed non-empty.
  -- jsonb_typeof rejects number/boolean/object/array/null (->> alone would coerce them).
  IF v_next_step = 'ready_to_book' THEN
    IF jsonb_typeof(v_state->'serviceId') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'serviceId') = ''
       OR jsonb_typeof(v_state->'serviceName') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'serviceName') = ''
       OR jsonb_typeof(v_state->'staffId') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'staffId') = ''
       OR jsonb_typeof(v_state->'staffName') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'staffName') = ''
       OR jsonb_typeof(v_state->'date') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'date') = ''
       OR jsonb_typeof(v_state->'time') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'time') = ''
       OR jsonb_typeof(v_state->'name') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'name') = ''
       OR jsonb_typeof(v_state->'phone') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'phone') = ''
       OR jsonb_typeof(v_state->'sourceMessageId') IS DISTINCT FROM 'string'
       OR btrim(v_state->>'sourceMessageId') = '' THEN
      RETURN jsonb_build_object(
        'kind', 'invalid_state',
        'code', 'ready_to_book_incomplete',
        'conversation_id', v_conv.id,
        'current_flow', v_conv.current_flow,
        'current_step', v_conv.current_step,
        'state', COALESCE(v_conv.state, '{}'::jsonb)
      );
    END IF;
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
    -- client_id intentionally untouched (IG-6 may link later)
  WHERE c.id = v_conv.id
    AND c.salon_id = p_salon_id
    AND c.provider = 'instagram'
    AND c.external_user_id = v_ext
    AND (
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

REVOKE ALL ON FUNCTION public.transition_instagram_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_instagram_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.transition_instagram_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_instagram_booking_owned(
  uuid, uuid, integer, text, text, timestamptz, text, text, text, text, jsonb, integer
) TO service_role;

COMMIT;
