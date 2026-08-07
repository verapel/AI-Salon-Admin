-- IG-4: Instagram identity + durable conversation foundation.
-- Additive only. Does NOT execute. Does NOT alter WhatsApp/Telegram runtime semantics.
--
-- Changes:
--   1) Widen channel_conversations.provider CHECK → whatsapp | instagram
--   2) Widen client_channel_identities.provider CHECK → telegram | whatsapp | instagram
--   3) Allow client_channel_identities.client_id NULL
--      (Instagram IG-4 creates durable sender identity without creating clients)
--   4) Instagram receipt-owned RPC:
--      apply_instagram_inbound_identity_conversation_owned
--
-- Guarantees (mirror WA-4B ownership model, Instagram-specific):
--   - Receipt FOR UPDATE lock: salon_id + provider=instagram + processing + attempt_count
--   - Stale reclaim cannot mutate under held lock
--   - Identity insert allows client_id NULL; never flip/clear existing client_id
--   - Conversation insert starts idle (current_flow/step NULL, state={})
--   - Conversation update never resets future FSM flow/step/state
--   - Out-of-order events do not regress last_inbound_* / expires_at / last_interaction_at
--
-- TTL note: expires_at uses application inactivity (default 86400s).
-- This is NOT the Meta Send API messaging window.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Provider CHECK widening
-- ---------------------------------------------------------------------------
ALTER TABLE public.channel_conversations
  DROP CONSTRAINT IF EXISTS channel_conversations_provider_check;

ALTER TABLE public.channel_conversations
  ADD CONSTRAINT channel_conversations_provider_check
    CHECK (provider IN ('whatsapp', 'instagram'));

COMMENT ON CONSTRAINT channel_conversations_provider_check ON public.channel_conversations IS
  'Messaging conversation providers: whatsapp (WA-1+) and instagram (IG-4+).';

ALTER TABLE public.client_channel_identities
  DROP CONSTRAINT IF EXISTS client_channel_identities_provider_check;

ALTER TABLE public.client_channel_identities
  ADD CONSTRAINT client_channel_identities_provider_check
    CHECK (provider IN ('telegram', 'whatsapp', 'instagram'));

COMMENT ON CONSTRAINT client_channel_identities_provider_check ON public.client_channel_identities IS
  'Channel identity providers: telegram, whatsapp, instagram (IG-4+).';

-- Instagram sender identities may exist without a linked salon client.
-- WhatsApp/Telegram writers continue to supply client_id; null is IG-4-safe.
ALTER TABLE public.client_channel_identities
  ALTER COLUMN client_id DROP NOT NULL;

COMMENT ON COLUMN public.client_channel_identities.client_id IS
  'Linked salon client when known. Nullable for Instagram IG-4 identities without phone/name matching. Never flipped by Instagram inbound transport.';

-- Ensure last_inbound_at exists (added by WA-4B1; IF NOT EXISTS for order safety).
ALTER TABLE public.channel_conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ NULL;

-- ---------------------------------------------------------------------------
-- B. Internal: lock + verify Instagram receipt ownership (FOR UPDATE).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.instagram_lock_owned_receipt(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_attempt integer;
BEGIN
  IF p_salon_id IS NULL OR p_receipt_id IS NULL OR p_attempt_count IS NULL THEN
    RETURN 'lost_ownership';
  END IF;

  SELECT r.processing_status, r.attempt_count
  INTO v_status, v_attempt
  FROM public.channel_event_receipts r
  WHERE r.id = p_receipt_id
    AND r.salon_id = p_salon_id
    AND r.provider = 'instagram'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'lost_ownership';
  END IF;

  IF v_status IS DISTINCT FROM 'processing' OR v_attempt IS DISTINCT FROM p_attempt_count THEN
    RETURN 'lost_ownership';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.instagram_lock_owned_receipt(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.instagram_lock_owned_receipt(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.instagram_lock_owned_receipt(uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.instagram_lock_owned_receipt(uuid, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- C. Owned identity + conversation create/touch (single transaction).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_instagram_inbound_identity_conversation_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_external_user_id text,
  p_external_message_id text,
  p_message_at timestamptz,
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
  v_ident public.client_channel_identities%ROWTYPE;
  v_conv public.channel_conversations%ROWTYPE;
  v_advanced boolean := false;
  v_identity_created boolean := false;
  v_conversation_created boolean := false;
BEGIN
  IF v_ext IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_sender');
  END IF;

  -- Provider is hardcoded to instagram inside lock + all mutations.
  v_own := public.instagram_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  v_expires := v_now + make_interval(secs => v_inactivity);

  -- ------------------------------------------------------------------
  -- Identity: create with client_id NULL, or refresh without flipping.
  -- ------------------------------------------------------------------
  SELECT i.*
  INTO v_ident
  FROM public.client_channel_identities i
  WHERE i.salon_id = p_salon_id
    AND i.provider = 'instagram'
    AND i.external_user_id = v_ext
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.client_channel_identities (
        salon_id,
        client_id,
        provider,
        external_user_id,
        normalized_address,
        display_address,
        last_interaction_at,
        metadata,
        updated_at
      ) VALUES (
        p_salon_id,
        NULL,
        'instagram',
        v_ext,
        NULL,
        NULL,
        v_now,
        '{}'::jsonb,
        v_now
      )
      RETURNING * INTO v_ident;
      v_identity_created := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT i.*
      INTO v_ident
      FROM public.client_channel_identities i
      WHERE i.salon_id = p_salon_id
        AND i.provider = 'instagram'
        AND i.external_user_id = v_ext
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('kind', 'error', 'code', 'identity_insert_race');
      END IF;
    END;
  END IF;

  -- ------------------------------------------------------------------
  -- Conversation: insert idle, or transport-touch without FSM reset.
  -- ------------------------------------------------------------------
  SELECT c.*
  INTO v_conv
  FROM public.channel_conversations c
  WHERE c.salon_id = p_salon_id
    AND c.provider = 'instagram'
    AND c.external_user_id = v_ext
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.channel_conversations (
        salon_id,
        provider,
        external_user_id,
        client_id,
        current_flow,
        current_step,
        state,
        last_inbound_message_id,
        last_inbound_at,
        last_interaction_at,
        expires_at,
        updated_at
      ) VALUES (
        p_salon_id,
        'instagram',
        v_ext,
        v_ident.client_id, -- may be NULL; inherit only, never invent clients
        NULL,              -- idle
        NULL,              -- idle
        '{}'::jsonb,
        v_msg_id,
        p_message_at,
        v_now,
        v_expires,
        v_now
      )
      RETURNING * INTO v_conv;
      v_conversation_created := true;
      v_advanced := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT c.*
      INTO v_conv
      FROM public.channel_conversations c
      WHERE c.salon_id = p_salon_id
        AND c.provider = 'instagram'
        AND c.external_user_id = v_ext
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('kind', 'error', 'code', 'conversation_insert_race');
      END IF;
    END;
  END IF;

  IF NOT v_advanced THEN
    -- Out-of-order guard (timestamp primary; mid equality for null timestamp idempotency).
    IF p_message_at IS NOT NULL THEN
      IF v_conv.last_inbound_at IS NULL OR p_message_at >= v_conv.last_inbound_at THEN
        v_advanced := true;
      ELSE
        v_advanced := false;
      END IF;
    ELSE
      IF v_conv.last_inbound_at IS NULL
         OR v_conv.last_inbound_message_id IS NULL
         OR (v_msg_id IS NOT NULL AND v_conv.last_inbound_message_id = v_msg_id) THEN
        v_advanced := true;
      ELSE
        v_advanced := false;
      END IF;
    END IF;

    IF NOT v_advanced THEN
      -- Older delivery under valid ownership: no regression of latest fields.
      RETURN jsonb_build_object(
        'kind', 'ok',
        'identity_id', v_ident.id,
        'conversation_id', v_conv.id,
        'client_id', v_ident.client_id,
        'advanced', false,
        'identity_created', v_identity_created,
        'conversation_created', v_conversation_created,
        'external_user_id', v_ext
      );
    END IF;

    -- Transport refresh only — NEVER reset current_flow / current_step / state.
    UPDATE public.channel_conversations c
    SET
      last_inbound_message_id = COALESCE(v_msg_id, c.last_inbound_message_id),
      last_inbound_at = COALESCE(p_message_at, c.last_inbound_at, v_now),
      last_interaction_at = v_now,
      expires_at = CASE
        -- Do not move expires_at backwards if somehow already later.
        WHEN c.expires_at IS NOT NULL AND c.expires_at > v_expires THEN c.expires_at
        ELSE v_expires
      END,
      updated_at = v_now,
      -- Null-CAS inherit from identity only; never flip existing conversation client.
      client_id = CASE
        WHEN c.client_id IS NULL THEN v_ident.client_id
        ELSE c.client_id
      END
    WHERE c.id = v_conv.id
      AND c.salon_id = p_salon_id
      AND c.provider = 'instagram'
      AND c.external_user_id = v_ext
    RETURNING * INTO v_conv;
    -- Pre-existing conversation/identity client mismatch is left untouched (no flip).
  END IF;

  -- Refresh identity interaction only when inbound advanced (and not on insert-only race path already set).
  IF v_advanced AND NOT v_identity_created THEN
    UPDATE public.client_channel_identities i
    SET
      last_interaction_at = CASE
        WHEN i.last_interaction_at IS NULL OR i.last_interaction_at < v_now THEN v_now
        ELSE i.last_interaction_at
      END,
      updated_at = v_now
      -- client_id intentionally never cleared or flipped
    WHERE i.id = v_ident.id
      AND i.salon_id = p_salon_id
      AND i.provider = 'instagram'
      AND i.external_user_id = v_ext
    RETURNING * INTO v_ident;
  END IF;

  RETURN jsonb_build_object(
    'kind', 'ok',
    'identity_id', v_ident.id,
    'conversation_id', v_conv.id,
    'client_id', COALESCE(v_conv.client_id, v_ident.client_id),
    'advanced', true,
    'identity_created', v_identity_created,
    'conversation_created', v_conversation_created,
    'external_user_id', v_ext
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_instagram_inbound_identity_conversation_owned(uuid, uuid, integer, text, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_instagram_inbound_identity_conversation_owned(uuid, uuid, integer, text, text, timestamptz, integer) FROM anon;
REVOKE ALL ON FUNCTION public.apply_instagram_inbound_identity_conversation_owned(uuid, uuid, integer, text, text, timestamptz, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_instagram_inbound_identity_conversation_owned(uuid, uuid, integer, text, text, timestamptz, integer) TO service_role;

COMMIT;
