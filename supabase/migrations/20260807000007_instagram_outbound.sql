-- IG-7: Durable Instagram outbound outbox + owned enqueue + claim/finalize CAS.
-- Additive only. SERVICE ROLE / backend only.
-- Does NOT send Meta messages, execute webhooks, or touch Telegram/Apple/WhatsApp.
--
-- Idempotency: UNIQUE (salon_id, source_event_id, intent_key)
-- One logical reply per inbound Meta event + intent (pilot: one message per event).
-- Access tokens NEVER stored in outbox rows.
-- Generated outbound text MAY be persisted (system content, not inbound DM history).
-- RLS enabled with no anon/authenticated policies (service_role bypasses RLS).

BEGIN;

CREATE TABLE IF NOT EXISTS public.instagram_outbound_messages (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                    UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider                    TEXT NOT NULL DEFAULT 'instagram',
  professional_account_id     TEXT NOT NULL,
  external_user_id            TEXT NOT NULL,
  source_event_id             TEXT NOT NULL,
  inbound_receipt_id          UUID NOT NULL REFERENCES public.channel_event_receipts(id) ON DELETE CASCADE,
  intent_key                  TEXT NOT NULL,
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                      TEXT NOT NULL DEFAULT 'pending',
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  next_attempt_at             TIMESTAMPTZ NULL,
  claim_token                 UUID NULL,
  claimed_at                  TIMESTAMPTZ NULL,
  provider_message_id         TEXT NULL,
  last_error                  TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                     TIMESTAMPTZ NULL,
  CONSTRAINT instagram_outbound_messages_provider_check
    CHECK (provider = 'instagram'),
  CONSTRAINT instagram_outbound_messages_status_check
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
  CONSTRAINT instagram_outbound_messages_professional_account_nonblank_check
    CHECK (length(trim(professional_account_id)) > 0),
  CONSTRAINT instagram_outbound_messages_external_user_nonblank_check
    CHECK (length(trim(external_user_id)) > 0),
  CONSTRAINT instagram_outbound_messages_source_event_nonblank_check
    CHECK (length(trim(source_event_id)) > 0),
  CONSTRAINT instagram_outbound_messages_intent_key_nonblank_check
    CHECK (length(trim(intent_key)) > 0),
  CONSTRAINT instagram_outbound_messages_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT instagram_outbound_messages_salon_source_intent_unique
    UNIQUE (salon_id, source_event_id, intent_key)
);

CREATE INDEX IF NOT EXISTS instagram_outbound_messages_status_next_attempt_idx
  ON public.instagram_outbound_messages (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS instagram_outbound_messages_salon_status_idx
  ON public.instagram_outbound_messages (salon_id, status);

CREATE INDEX IF NOT EXISTS instagram_outbound_messages_receipt_idx
  ON public.instagram_outbound_messages (inbound_receipt_id);

COMMENT ON TABLE public.instagram_outbound_messages IS
  'IG-7 durable Instagram session-reply outbox. Idempotent by (salon_id, source_event_id, intent_key). Backend/service_role only. No access tokens.';

COMMENT ON COLUMN public.instagram_outbound_messages.payload IS
  'Generated system outbound content (e.g. {text}). Must NOT store raw inbound DM, postback payload, tokens, or signatures.';

COMMENT ON COLUMN public.instagram_outbound_messages.source_event_id IS
  'Stable Meta inbound event mid. Required for automated replies. No synthetic IDs.';

ALTER TABLE public.instagram_outbound_messages ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Owned enqueue: verify Instagram receipt ownership, then insert/dedupe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_instagram_outbound_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_professional_account_id text,
  p_external_user_id text,
  p_source_event_id text,
  p_intent_key text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_own text;
  v_now timestamptz := clock_timestamp();
  v_prof text := nullif(btrim(p_professional_account_id), '');
  v_user text := nullif(btrim(p_external_user_id), '');
  v_event text := nullif(btrim(p_source_event_id), '');
  v_intent text := nullif(btrim(p_intent_key), '');
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_row public.instagram_outbound_messages%ROWTYPE;
  v_text text;
BEGIN
  IF p_salon_id IS NULL OR p_receipt_id IS NULL OR p_attempt_count IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_enqueue');
  END IF;

  IF v_prof IS NULL OR v_user IS NULL OR v_event IS NULL OR v_intent IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_enqueue');
  END IF;

  -- Payload must carry non-empty generated text; reject token-like keys.
  IF v_payload ? 'access_token'
     OR v_payload ? 'token'
     OR v_payload ? 'inbound_text'
     OR v_payload ? 'raw_postback' THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'forbidden_payload');
  END IF;

  v_text := nullif(btrim(COALESCE(v_payload->>'text', '')), '');
  IF v_text IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'empty_text');
  END IF;

  v_own := public.instagram_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  INSERT INTO public.instagram_outbound_messages (
    salon_id,
    provider,
    professional_account_id,
    external_user_id,
    source_event_id,
    inbound_receipt_id,
    intent_key,
    payload,
    status,
    attempt_count,
    created_at,
    updated_at
  ) VALUES (
    p_salon_id,
    'instagram',
    v_prof,
    v_user,
    v_event,
    p_receipt_id,
    v_intent,
    jsonb_build_object('text', v_text),
    'pending',
    0,
    v_now,
    v_now
  )
  ON CONFLICT (salon_id, source_event_id, intent_key) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'kind', 'enqueued',
      'id', v_row.id,
      'created', true,
      'status', v_row.status,
      'intent_key', v_row.intent_key,
      'source_event_id', v_row.source_event_id
    );
  END IF;

  SELECT * INTO v_row
  FROM public.instagram_outbound_messages m
  WHERE m.salon_id = p_salon_id
    AND m.source_event_id = v_event
    AND m.intent_key = v_intent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'enqueue_reread_error');
  END IF;

  RETURN jsonb_build_object(
    'kind', 'enqueued',
    'id', v_row.id,
    'created', false,
    'status', v_row.status,
    'intent_key', v_row.intent_key,
    'source_event_id', v_row.source_event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_instagram_outbound_owned(uuid, uuid, integer, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_instagram_outbound_owned(uuid, uuid, integer, text, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_instagram_outbound_owned(uuid, uuid, integer, text, text, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_instagram_outbound_owned(uuid, uuid, integer, text, text, text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Claim with stale reclaim + max-attempt exhaustion (mirrors WA-4F2 hardening).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_instagram_outbound_message(
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
  v_row public.instagram_outbound_messages%ROWTYPE;
  v_max integer := 5; -- must match server INSTAGRAM_OUTBOUND_MAX_ATTEMPTS
BEGIN
  IF p_message_id IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_id');
  END IF;

  UPDATE public.instagram_outbound_messages m
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

  UPDATE public.instagram_outbound_messages m
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
    'provider', v_row.provider,
    'professional_account_id', v_row.professional_account_id,
    'external_user_id', v_row.external_user_id,
    'source_event_id', v_row.source_event_id,
    'inbound_receipt_id', v_row.inbound_receipt_id,
    'intent_key', v_row.intent_key,
    'payload', v_row.payload,
    'attempt_count', v_row.attempt_count,
    'claim_token', v_row.claim_token
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_instagram_outbound_message(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_instagram_outbound_message(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_instagram_outbound_message(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_instagram_outbound_message(uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Finalize sent (claim_token CAS).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_instagram_outbound_sent(
  p_message_id uuid,
  p_claim_token uuid,
  p_provider_message_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.instagram_outbound_messages%ROWTYPE;
  v_mid text := nullif(btrim(p_provider_message_id), '');
BEGIN
  IF p_message_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_finalize');
  END IF;

  IF v_mid IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'missing_provider_message_id');
  END IF;

  UPDATE public.instagram_outbound_messages m
  SET
    status = 'sent',
    provider_message_id = v_mid,
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

  -- Best-effort connection health marker (non-fatal if missing).
  UPDATE public.instagram_business_connections c
  SET last_error = NULL, updated_at = v_now
  WHERE c.salon_id = v_row.salon_id
    AND c.instagram_user_id = v_row.professional_account_id;

  RETURN jsonb_build_object(
    'kind', 'sent',
    'id', v_row.id,
    'provider_message_id', v_mid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_instagram_outbound_sent(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_instagram_outbound_sent(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_instagram_outbound_sent(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_instagram_outbound_sent(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Finalize failure / retry (claim_token CAS).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_instagram_outbound_failure(
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
  v_row public.instagram_outbound_messages%ROWTYPE;
  v_err text := left(nullif(btrim(p_error_code), ''), 500);
  v_max integer := GREATEST(COALESCE(p_max_attempts, 5), 1);
BEGIN
  IF p_message_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_finalize');
  END IF;

  SELECT * INTO v_row
  FROM public.instagram_outbound_messages m
  WHERE m.id = p_message_id
    AND m.status = 'claimed'
    AND m.claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'lost_claim');
  END IF;

  IF COALESCE(p_retryable, false)
     AND v_row.attempt_count < v_max THEN
    UPDATE public.instagram_outbound_messages m
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

  UPDATE public.instagram_outbound_messages m
  SET
    status = 'failed',
    claim_token = NULL,
    claimed_at = NULL,
    next_attempt_at = NULL,
    last_error = v_err,
    updated_at = v_now
  WHERE m.id = p_message_id
    AND m.claim_token = p_claim_token;

  -- Auth/permanent connection markers: set last_error safely (never token).
  IF v_err IN ('invalid_credentials', 'account_disconnected', 'token_missing', 'not_connected') THEN
    UPDATE public.instagram_business_connections c
    SET last_error = v_err, updated_at = v_now
    WHERE c.salon_id = v_row.salon_id
      AND c.instagram_user_id = v_row.professional_account_id;
  END IF;

  RETURN jsonb_build_object('kind', 'failed', 'id', p_message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_instagram_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_instagram_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_instagram_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_instagram_outbound_failure(uuid, uuid, text, boolean, timestamptz, integer) TO service_role;

COMMIT;
