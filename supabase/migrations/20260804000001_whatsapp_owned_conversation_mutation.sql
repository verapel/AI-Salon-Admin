-- WA-4B1: Atomic WhatsApp conversation/identity mutations under receipt ownership.
-- SERVICE ROLE / backend only. Do not expose to anon/authenticated.
-- Does NOT execute appointment/FSM/outbound logic.
--
-- Guarantees:
--   1) Receipt row is locked FOR UPDATE and verified
--      (salon_id, provider=whatsapp, processing_status=processing, attempt_count)
--      before any durable conversation/identity mutation in the same transaction.
--   2) Stale reclaim cannot change attempt_count while this RPC holds the receipt lock.
--   3) Out-of-order inbound messages do not regress last_inbound_message_id / last_inbound_at.
--
-- Migration is create-only / IF NOT EXISTS; CREATE OR REPLACE for functions.

BEGIN;

-- Comparable inbound message time for ordering (Meta messages[].timestamp).
-- Do NOT misuse updated_at for message chronology.
ALTER TABLE public.channel_conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.channel_conversations.last_inbound_at IS
  'Timestamp of the newest applied inbound WhatsApp message (from Meta messages[].timestamp). Used to prevent out-of-order last_inbound_message_id regression.';

-- ---------------------------------------------------------------------------
-- Internal: lock + verify receipt ownership (FOR UPDATE).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_lock_owned_receipt(
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
    AND r.provider = 'whatsapp'
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

REVOKE ALL ON FUNCTION public.whatsapp_lock_owned_receipt(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_lock_owned_receipt(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.whatsapp_lock_owned_receipt(uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_lock_owned_receipt(uuid, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 1) Conversation create/touch under owned receipt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_whatsapp_conversation_event_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_external_user_id text,
  p_external_message_id text,
  p_message_at timestamptz,
  p_profile_name_hint text,
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
  v_hint text := nullif(btrim(p_profile_name_hint), '');
  v_conv public.channel_conversations%ROWTYPE;
  v_expired boolean := false;
  v_advanced boolean := false;
  v_next_state jsonb;
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
        'whatsapp',
        v_ext,
        NULL,
        NULL,
        NULL,
        CASE WHEN v_hint IS NULL THEN '{}'::jsonb
             ELSE jsonb_build_object('profileNameHint', left(v_hint, 120))
        END,
        v_msg_id,
        p_message_at,
        v_now,
        v_expires,
        v_now
      )
      RETURNING * INTO v_conv;
      v_advanced := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT c.*
      INTO v_conv
      FROM public.channel_conversations c
      WHERE c.salon_id = p_salon_id
        AND c.provider = 'whatsapp'
        AND c.external_user_id = v_ext
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('kind', 'error', 'code', 'conversation_insert_race');
      END IF;
    END;
  END IF;

  -- Existing row path (including unique-violation recovery).
  IF NOT v_advanced THEN
    -- Out-of-order guard: only advance inbound pointers when message_at is newer/equal,
    -- or when no prior last_inbound_at exists. Never regress last_inbound_message_id.
    IF p_message_at IS NOT NULL THEN
      IF v_conv.last_inbound_at IS NULL OR p_message_at >= v_conv.last_inbound_at THEN
        v_advanced := true;
      ELSE
        v_advanced := false;
      END IF;
    ELSE
      -- No comparable timestamp: advance only if unset or same message id (idempotent).
      IF v_conv.last_inbound_at IS NULL
         OR v_conv.last_inbound_message_id IS NULL
         OR (v_msg_id IS NOT NULL AND v_conv.last_inbound_message_id = v_msg_id) THEN
        v_advanced := true;
      ELSE
        v_advanced := false;
      END IF;
    END IF;

    IF NOT v_advanced THEN
      -- Older/out-of-order delivery under valid ownership: no regression.
      RETURN jsonb_build_object(
        'kind', 'ok',
        'conversation_id', v_conv.id,
        'client_id', v_conv.client_id,
        'expired_reset', false,
        'advanced', false,
        'external_user_id', v_conv.external_user_id
      );
    END IF;

    v_expired := (v_conv.expires_at IS NOT NULL AND v_conv.expires_at <= v_now);

    IF v_expired THEN
      v_next_state := CASE
        WHEN v_hint IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('profileNameHint', left(v_hint, 120))
      END;
    ELSE
      v_next_state := COALESCE(v_conv.state, '{}'::jsonb);
      IF v_hint IS NOT NULL AND (v_next_state->>'profileNameHint') IS NULL THEN
        v_next_state := v_next_state || jsonb_build_object('profileNameHint', left(v_hint, 120));
      END IF;
    END IF;

    UPDATE public.channel_conversations c
    SET
      last_inbound_message_id = COALESCE(v_msg_id, c.last_inbound_message_id),
      last_inbound_at = COALESCE(p_message_at, c.last_inbound_at, v_now),
      last_interaction_at = v_now,
      expires_at = v_expires,
      updated_at = v_now,
      state = v_next_state,
      current_flow = CASE WHEN v_expired THEN NULL ELSE c.current_flow END,
      current_step = CASE WHEN v_expired THEN NULL ELSE c.current_step END
      -- client_id intentionally untouched
    WHERE c.id = v_conv.id
      AND c.salon_id = p_salon_id
      AND c.provider = 'whatsapp'
      AND c.external_user_id = v_ext
    RETURNING * INTO v_conv;
  END IF;

  RETURN jsonb_build_object(
    'kind', 'ok',
    'conversation_id', v_conv.id,
    'client_id', v_conv.client_id,
    'expired_reset', v_expired,
    'advanced', true,
    'external_user_id', v_conv.external_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_whatsapp_conversation_event_owned(uuid, uuid, integer, text, text, timestamptz, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_whatsapp_conversation_event_owned(uuid, uuid, integer, text, text, timestamptz, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.apply_whatsapp_conversation_event_owned(uuid, uuid, integer, text, text, timestamptz, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_whatsapp_conversation_event_owned(uuid, uuid, integer, text, text, timestamptz, text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2) Identity attach / same-client refresh under owned receipt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attach_whatsapp_identity_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_client_id uuid,
  p_external_user_id text,
  p_normalized_address text,
  p_display_address text,
  p_profile_name_hint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_own text;
  v_now timestamptz := clock_timestamp();
  v_ext text := nullif(btrim(p_external_user_id), '');
  v_norm text := nullif(btrim(p_normalized_address), '');
  v_display text := nullif(btrim(p_display_address), '');
  v_hint text := nullif(btrim(p_profile_name_hint), '');
  v_ident public.client_channel_identities%ROWTYPE;
  v_client_salon uuid;
  v_norm_other public.client_channel_identities%ROWTYPE;
BEGIN
  IF v_ext IS NULL OR p_client_id IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_identity_input');
  END IF;

  v_own := public.whatsapp_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  -- Client must exist in the same salon (fail closed).
  SELECT c.salon_id
  INTO v_client_salon
  FROM public.clients c
  WHERE c.id = p_client_id
    AND c.salon_id = p_salon_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'conflict', 'code', 'identity_client_missing');
  END IF;

  SELECT i.*
  INTO v_ident
  FROM public.client_channel_identities i
  WHERE i.salon_id = p_salon_id
    AND i.provider = 'whatsapp'
    AND i.external_user_id = v_ext
  FOR UPDATE;

  IF FOUND THEN
    IF v_ident.client_id IS DISTINCT FROM p_client_id THEN
      RETURN jsonb_build_object('kind', 'conflict', 'code', 'identity_client_mismatch');
    END IF;

    -- Same-client refresh only — never flip client_id.
    BEGIN
      UPDATE public.client_channel_identities i
      SET
        last_interaction_at = v_now,
        updated_at = v_now,
        normalized_address = COALESCE(v_norm, i.normalized_address),
        display_address = COALESCE(v_display, i.display_address),
        metadata = CASE
          WHEN v_hint IS NULL THEN i.metadata
          ELSE jsonb_build_object('profileNameHint', left(v_hint, 120))
        END
      WHERE i.id = v_ident.id
        AND i.salon_id = p_salon_id
        AND i.provider = 'whatsapp'
        AND i.client_id = p_client_id;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('kind', 'conflict', 'code', 'normalized_address_conflict');
    END;

    RETURN jsonb_build_object('kind', 'ok', 'identity_id', v_ident.id, 'client_id', p_client_id);
  END IF;

  -- Insert new identity.
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
      p_client_id,
      'whatsapp',
      v_ext,
      v_norm,
      v_display,
      v_now,
      CASE WHEN v_hint IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('profileNameHint', left(v_hint, 120))
      END,
      v_now
    )
    RETURNING * INTO v_ident;

    RETURN jsonb_build_object('kind', 'ok', 'identity_id', v_ident.id, 'client_id', p_client_id);
  EXCEPTION WHEN unique_violation THEN
    -- Re-read by external_user_id.
    SELECT i.*
    INTO v_ident
    FROM public.client_channel_identities i
    WHERE i.salon_id = p_salon_id
      AND i.provider = 'whatsapp'
      AND i.external_user_id = v_ext;

    IF FOUND THEN
      IF v_ident.client_id IS DISTINCT FROM p_client_id THEN
        RETURN jsonb_build_object('kind', 'conflict', 'code', 'identity_client_mismatch');
      END IF;
      -- Same client won the race — treat as idempotent success.
      RETURN jsonb_build_object('kind', 'ok', 'identity_id', v_ident.id, 'client_id', p_client_id);
    END IF;

    IF v_norm IS NOT NULL THEN
      SELECT i.*
      INTO v_norm_other
      FROM public.client_channel_identities i
      WHERE i.salon_id = p_salon_id
        AND i.provider = 'whatsapp'
        AND i.normalized_address = v_norm;

      IF FOUND THEN
        RETURN jsonb_build_object('kind', 'conflict', 'code', 'normalized_address_conflict');
      END IF;
    END IF;

    RETURN jsonb_build_object('kind', 'conflict', 'code', 'identity_client_mismatch');
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_whatsapp_identity_owned(uuid, uuid, integer, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attach_whatsapp_identity_owned(uuid, uuid, integer, uuid, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.attach_whatsapp_identity_owned(uuid, uuid, integer, uuid, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attach_whatsapp_identity_owned(uuid, uuid, integer, uuid, text, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3) Conversation client_id link under owned receipt (null CAS).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_whatsapp_conversation_client_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_external_user_id text,
  p_client_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_own text;
  v_now timestamptz := clock_timestamp();
  v_ext text := nullif(btrim(p_external_user_id), '');
  v_conv public.channel_conversations%ROWTYPE;
  v_client_salon uuid;
BEGIN
  IF v_ext IS NULL OR p_client_id IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_link_input');
  END IF;

  v_own := public.whatsapp_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  SELECT c.salon_id
  INTO v_client_salon
  FROM public.clients c
  WHERE c.id = p_client_id
    AND c.salon_id = p_salon_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'conflict', 'code', 'identity_client_missing');
  END IF;

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

  IF v_conv.client_id IS NOT NULL AND v_conv.client_id IS DISTINCT FROM p_client_id THEN
    RETURN jsonb_build_object('kind', 'conflict', 'code', 'conversation_client_mismatch');
  END IF;

  IF v_conv.client_id IS NOT DISTINCT FROM p_client_id THEN
    RETURN jsonb_build_object(
      'kind', 'ok',
      'conversation_id', v_conv.id,
      'client_id', v_conv.client_id
    );
  END IF;

  UPDATE public.channel_conversations c
  SET client_id = p_client_id,
      updated_at = v_now
  WHERE c.id = v_conv.id
    AND c.salon_id = p_salon_id
    AND c.provider = 'whatsapp'
    AND c.external_user_id = v_ext
    AND c.client_id IS NULL
  RETURNING * INTO v_conv;

  IF NOT FOUND THEN
    -- Race: another owned writer set client_id.
    SELECT c.*
    INTO v_conv
    FROM public.channel_conversations c
    WHERE c.salon_id = p_salon_id
      AND c.provider = 'whatsapp'
      AND c.external_user_id = v_ext;

    IF v_conv.client_id IS NOT DISTINCT FROM p_client_id THEN
      RETURN jsonb_build_object(
        'kind', 'ok',
        'conversation_id', v_conv.id,
        'client_id', v_conv.client_id
      );
    END IF;

    RETURN jsonb_build_object('kind', 'conflict', 'code', 'conversation_client_mismatch');
  END IF;

  RETURN jsonb_build_object(
    'kind', 'ok',
    'conversation_id', v_conv.id,
    'client_id', v_conv.client_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.link_whatsapp_conversation_client_owned(uuid, uuid, integer, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_whatsapp_conversation_client_owned(uuid, uuid, integer, text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.link_whatsapp_conversation_client_owned(uuid, uuid, integer, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.link_whatsapp_conversation_client_owned(uuid, uuid, integer, text, uuid) TO service_role;

COMMIT;
