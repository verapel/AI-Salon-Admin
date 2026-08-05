-- WA-4F2: Harden WhatsApp outbound claim against attempts beyond max total (5).
-- Additive REPLACE of claim_whatsapp_outbound_message only.
-- Does NOT execute Meta sends. Does NOT touch Telegram.
--
-- Aligns with app constant WHATSAPP_OUTBOUND_MAX_ATTEMPTS = 5 (total send claims).
-- Pending/stale-claimed rows with attempt_count >= 5 become terminal failed (exhausted).
-- Signature unchanged: (uuid, integer) — max is fixed at 5 inside the function.

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_whatsapp_outbound_message(
  p_message_id uuid,
  p_stale_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_stale interval := make_interval(secs => GREATEST(COALESCE(p_stale_seconds, 300), 30));
  v_token uuid := gen_random_uuid();
  v_row public.whatsapp_outbound_messages%ROWTYPE;
  v_max integer := 5; -- must match server WHATSAPP_OUTBOUND_MAX_ATTEMPTS
BEGIN
  IF p_message_id IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_id');
  END IF;

  -- Terminalize eligible rows that already reached max total attempts (no attempt 6).
  UPDATE public.whatsapp_outbound_messages m
  SET
    status = 'failed',
    claim_token = NULL,
    claimed_at = NULL,
    next_attempt_at = NULL,
    last_error = 'exhausted',
    updated_at = v_now
  WHERE m.id = p_message_id
    AND m.attempt_count >= v_max
    AND (
      (
        m.status = 'pending'
        AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= v_now)
      )
      OR (
        m.status = 'claimed'
        AND m.claimed_at IS NOT NULL
        AND m.claimed_at < (v_now - v_stale)
      )
    )
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'kind', 'exhausted',
      'id', v_row.id,
      'attempt_count', v_row.attempt_count,
      'status', v_row.status
    );
  END IF;

  UPDATE public.whatsapp_outbound_messages m
  SET
    status = 'claimed',
    claim_token = v_token,
    claimed_at = v_now,
    attempt_count = m.attempt_count + 1,
    updated_at = v_now,
    last_error = NULL
  WHERE m.id = p_message_id
    AND m.attempt_count < v_max
    AND (
      (
        m.status = 'pending'
        AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= v_now)
      )
      OR (
        m.status = 'claimed'
        AND m.claimed_at IS NOT NULL
        AND m.claimed_at < (v_now - v_stale)
      )
    )
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'not_claimable');
  END IF;

  RETURN jsonb_build_object(
    'kind', 'claimed',
    'id', v_row.id,
    'salon_id', v_row.salon_id,
    'conversation_id', v_row.conversation_id,
    'inbound_receipt_id', v_row.inbound_receipt_id,
    'recipient_external_user_id', v_row.recipient_external_user_id,
    'message_key', v_row.message_key,
    'payload', v_row.payload,
    'sequence', v_row.sequence,
    'attempt_count', v_row.attempt_count,
    'claim_token', v_row.claim_token
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) TO service_role;

COMMIT;
