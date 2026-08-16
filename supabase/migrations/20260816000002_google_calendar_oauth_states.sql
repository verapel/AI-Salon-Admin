-- GOOGLE-CAL-A3: Single-use Google Calendar OAuth states (nonce).
-- Additive only. Does NOT execute Google OAuth or Calendar API.
-- Mirrors IG-ACTIVATE-1 security model: persist at auth-url, atomic consume at callback.
-- Never stores tokens / client secrets / authorization codes.
-- RLS enabled with no anon/authenticated policies (service_role bypasses RLS).

BEGIN;

CREATE TABLE IF NOT EXISTS public.google_calendar_oauth_states (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce               TEXT NOT NULL,
  salon_id            UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  initiator_user_id   UUID NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT google_calendar_oauth_states_nonce_nonblank_check
    CHECK (length(trim(nonce)) > 0),
  CONSTRAINT google_calendar_oauth_states_nonce_unique
    UNIQUE (nonce)
);

CREATE INDEX IF NOT EXISTS google_calendar_oauth_states_expires_at_idx
  ON public.google_calendar_oauth_states (expires_at);

CREATE INDEX IF NOT EXISTS google_calendar_oauth_states_salon_id_idx
  ON public.google_calendar_oauth_states (salon_id);

COMMENT ON TABLE public.google_calendar_oauth_states IS
  'GOOGLE-CAL-A3 single-use Google Calendar OAuth nonces. No tokens/secrets. Backend/service_role only.';

COMMENT ON COLUMN public.google_calendar_oauth_states.nonce IS
  'Opaque cryptographically random nonce embedded in signed OAuth state. Unique.';

COMMENT ON COLUMN public.google_calendar_oauth_states.initiator_user_id IS
  'Optional auth user id that started OAuth (audit). Soft reference — no FK across auth schema.';

COMMENT ON COLUMN public.google_calendar_oauth_states.consumed_at IS
  'Set atomically on first successful callback consume. NULL until used. Never cleared on Google failure.';

ALTER TABLE public.google_calendar_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.create_google_calendar_oauth_state(
  p_salon_id uuid,
  p_nonce text,
  p_expires_at timestamptz,
  p_initiator_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_nonce text := nullif(btrim(p_nonce), '');
  v_row public.google_calendar_oauth_states%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL OR v_nonce IS NULL OR p_expires_at IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_create');
  END IF;

  IF p_expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'already_expired');
  END IF;

  INSERT INTO public.google_calendar_oauth_states (
    nonce, salon_id, initiator_user_id, expires_at
  )
  VALUES (v_nonce, p_salon_id, p_initiator_user_id, p_expires_at)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'kind', 'created',
    'id', v_row.id,
    'nonce', v_row.nonce,
    'salon_id', v_row.salon_id,
    'expires_at', v_row.expires_at
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'nonce_conflict');
END;
$$;

REVOKE ALL ON FUNCTION public.create_google_calendar_oauth_state(uuid, text, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_google_calendar_oauth_state(uuid, text, timestamptz, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_google_calendar_oauth_state(uuid, text, timestamptz, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_google_calendar_oauth_state(uuid, text, timestamptz, uuid) TO service_role;

-- Atomic single-use consume. CAS on consumed_at IS NULL + salon + not expired.
CREATE OR REPLACE FUNCTION public.consume_google_calendar_oauth_state(
  p_salon_id uuid,
  p_nonce text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_nonce text := nullif(btrim(p_nonce), '');
  v_now timestamptz := COALESCE(p_now, clock_timestamp());
  v_row public.google_calendar_oauth_states%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL OR v_nonce IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_consume');
  END IF;

  UPDATE public.google_calendar_oauth_states s
  SET consumed_at = v_now
  WHERE s.nonce = v_nonce
    AND s.salon_id = p_salon_id
    AND s.consumed_at IS NULL
    AND s.expires_at > v_now
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'kind', 'consumed',
      'id', v_row.id,
      'nonce', v_row.nonce,
      'salon_id', v_row.salon_id,
      'consumed_at', v_row.consumed_at
    );
  END IF;

  SELECT * INTO v_row
  FROM public.google_calendar_oauth_states s
  WHERE s.nonce = v_nonce;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'rejected', 'code', 'unknown_nonce');
  END IF;

  IF v_row.salon_id IS DISTINCT FROM p_salon_id THEN
    RETURN jsonb_build_object('kind', 'rejected', 'code', 'salon_mismatch');
  END IF;

  IF v_row.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('kind', 'rejected', 'code', 'already_consumed');
  END IF;

  IF v_row.expires_at <= v_now THEN
    RETURN jsonb_build_object('kind', 'rejected', 'code', 'expired');
  END IF;

  RETURN jsonb_build_object('kind', 'rejected', 'code', 'not_consumable');
END;
$$;

REVOKE ALL ON FUNCTION public.consume_google_calendar_oauth_state(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_google_calendar_oauth_state(uuid, text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.consume_google_calendar_oauth_state(uuid, text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_google_calendar_oauth_state(uuid, text, timestamptz) TO service_role;

COMMIT;
