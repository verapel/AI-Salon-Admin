-- IG-UI-2A: Atomic Instagram integration remove (registry + credential clear).
-- One transaction. No Meta. No salon/business-data mutation.
-- Does NOT touch Telegram / WhatsApp / Apple.

BEGIN;

CREATE OR REPLACE FUNCTION public.remove_instagram_integration_owned(
  p_salon_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_connection_cleared integer := 0;
  v_registry_deleted integer := 0;
BEGIN
  IF p_salon_id IS NULL THEN
    RAISE EXCEPTION 'p_salon_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- Soft-clear Instagram credentials for this salon only.
  -- Matches developer disconnect semantics (no Meta revoke).
  UPDATE public.instagram_business_connections
  SET
    access_token_ciphertext = NULL,
    access_token_iv = NULL,
    access_token_auth_tag = NULL,
    instagram_user_id = NULL,
    instagram_username = NULL,
    status = 'not_connected',
    connected_at = NULL,
    last_error = NULL,
    token_expires_at = NULL,
    updated_at = v_now
  WHERE salon_id = p_salon_id;

  GET DIAGNOSTICS v_connection_cleared = ROW_COUNT;

  -- Remove Instagram visibility registry row only.
  DELETE FROM public.salon_integrations
  WHERE salon_id = p_salon_id
    AND provider = 'instagram';

  GET DIAGNOSTICS v_registry_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'salonId', p_salon_id,
    'connectionCleared', v_connection_cleared > 0,
    'registryRemoved', v_registry_deleted > 0
  );
END;
$$;

COMMENT ON FUNCTION public.remove_instagram_integration_owned(uuid) IS
  'IG-UI-2A atomic Instagram remove: soft-clear instagram_business_connections for p_salon_id and delete salon_integrations where salon_id=p_salon_id AND provider=instagram. Idempotent. No Meta. No salon/business-data mutation.';

REVOKE ALL ON FUNCTION public.remove_instagram_integration_owned(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_instagram_integration_owned(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.remove_instagram_integration_owned(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.remove_instagram_integration_owned(uuid) TO service_role;

COMMIT;
