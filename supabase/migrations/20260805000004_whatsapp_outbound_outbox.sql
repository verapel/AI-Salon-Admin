-- WA-4F1: Durable WhatsApp outbound outbox (session replies).
-- Additive only. SERVICE ROLE / backend only.
-- Does NOT send Meta messages, create appointments, or touch Telegram.
--
-- Idempotency: UNIQUE (salon_id, inbound_receipt_id, sequence)
-- Pilot: one reply per inbound receipt (sequence = 0).
-- RLS enabled with no anon/authenticated policies (service_role bypasses RLS).

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_outbound_messages (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                    UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  conversation_id             UUID NULL REFERENCES public.channel_conversations(id) ON DELETE SET NULL,
  inbound_receipt_id          UUID NOT NULL REFERENCES public.channel_event_receipts(id) ON DELETE CASCADE,
  recipient_external_user_id  TEXT NOT NULL,
  message_key                 TEXT NOT NULL,
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  sequence                    INTEGER NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL DEFAULT 'pending',
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  next_attempt_at             TIMESTAMPTZ NULL,
  claim_token                 UUID NULL,
  claimed_at                  TIMESTAMPTZ NULL,
  meta_message_id             TEXT NULL,
  last_error                  TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                     TIMESTAMPTZ NULL,
  CONSTRAINT whatsapp_outbound_messages_status_check
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
  CONSTRAINT whatsapp_outbound_messages_recipient_nonblank_check
    CHECK (length(trim(recipient_external_user_id)) > 0),
  CONSTRAINT whatsapp_outbound_messages_message_key_nonblank_check
    CHECK (length(trim(message_key)) > 0),
  CONSTRAINT whatsapp_outbound_messages_sequence_check
    CHECK (sequence >= 0),
  CONSTRAINT whatsapp_outbound_messages_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT whatsapp_outbound_messages_salon_receipt_sequence_unique
    UNIQUE (salon_id, inbound_receipt_id, sequence)
);

CREATE INDEX IF NOT EXISTS whatsapp_outbound_messages_status_next_attempt_idx
  ON public.whatsapp_outbound_messages (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS whatsapp_outbound_messages_salon_status_idx
  ON public.whatsapp_outbound_messages (salon_id, status);

COMMENT ON TABLE public.whatsapp_outbound_messages IS
  'WA-4F1 durable WhatsApp session-reply outbox. One logical reply per inbound receipt+sequence. Backend/service_role only.';

ALTER TABLE public.whatsapp_outbound_messages ENABLE ROW LEVEL SECURITY;

-- Claim one eligible row (pending due, or stale claimed) with CAS token.
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
BEGIN
  IF p_message_id IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_id');
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

CREATE OR REPLACE FUNCTION public.finalize_whatsapp_outbound_sent(
  p_message_id uuid,
  p_claim_token uuid,
  p_meta_message_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.whatsapp_outbound_messages%ROWTYPE;
  v_meta text := nullif(btrim(p_meta_message_id), '');
BEGIN
  IF p_message_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_finalize');
  END IF;

  UPDATE public.whatsapp_outbound_messages m
  SET
    status = 'sent',
    meta_message_id = v_meta,
    sent_at = v_now,
    claim_token = NULL,
    claimed_at = NULL,
    next_attempt_at = NULL,
    last_error = NULL,
    updated_at = v_now
  WHERE m.id = p_message_id
    AND m.status = 'claimed'
    AND m.claim_token = p_claim_token
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'lost_claim');
  END IF;

  -- Best-effort connection / conversation timestamps (non-fatal if missing).
  UPDATE public.whatsapp_business_connections c
  SET last_outbound_at = v_now, updated_at = v_now
  WHERE c.salon_id = v_row.salon_id;

  IF v_row.conversation_id IS NOT NULL AND v_meta IS NOT NULL THEN
    UPDATE public.channel_conversations c
    SET
      last_outbound_message_id = v_meta,
      last_interaction_at = v_now,
      updated_at = v_now
    WHERE c.id = v_row.conversation_id
      AND c.salon_id = v_row.salon_id;
  END IF;

  RETURN jsonb_build_object('kind', 'sent', 'id', v_row.id, 'meta_message_id', v_meta);
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_whatsapp_outbound_failure(
  p_message_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_retryable boolean,
  p_next_attempt_at timestamptz DEFAULT NULL,
  p_max_attempts integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.whatsapp_outbound_messages%ROWTYPE;
  v_err text := left(nullif(btrim(p_error_code), ''), 500);
  v_max integer := GREATEST(COALESCE(p_max_attempts, 5), 1);
BEGIN
  IF p_message_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_finalize');
  END IF;

  SELECT * INTO v_row
  FROM public.whatsapp_outbound_messages m
  WHERE m.id = p_message_id
    AND m.status = 'claimed'
    AND m.claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'lost_claim');
  END IF;

  IF COALESCE(p_retryable, false)
     AND v_row.attempt_count < v_max THEN
    UPDATE public.whatsapp_outbound_messages m
    SET
      status = 'pending',
      claim_token = NULL,
      claimed_at = NULL,
      next_attempt_at = COALESCE(p_next_attempt_at, v_now + interval '1 minute'),
      last_error = v_err,
      updated_at = v_now
    WHERE m.id = p_message_id
      AND m.claim_token = p_claim_token;

    RETURN jsonb_build_object('kind', 'retry_scheduled', 'id', p_message_id);
  END IF;

  UPDATE public.whatsapp_outbound_messages m
  SET
    status = 'failed',
    claim_token = NULL,
    claimed_at = NULL,
    next_attempt_at = NULL,
    last_error = v_err,
    updated_at = v_now
  WHERE m.id = p_message_id
    AND m.claim_token = p_claim_token;

  RETURN jsonb_build_object('kind', 'failed', 'id', p_message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_outbound_message(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_whatsapp_outbound_sent(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_whatsapp_outbound_sent(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_whatsapp_outbound_sent(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_whatsapp_outbound_sent(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_whatsapp_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_whatsapp_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_whatsapp_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_whatsapp_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) TO service_role;

COMMIT;
