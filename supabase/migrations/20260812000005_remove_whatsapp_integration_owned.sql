-- WA-UI-1 / WA-UI-1A: Atomic WhatsApp integration remove with connection-shell preservation.
-- One transaction. No Meta. No salon/business-data mutation.
-- Does NOT touch Telegram / Instagram / Apple.
-- Does NOT delete identities / conversations / receipts / outbound history.
-- Preserves whatsapp_business_connections shell + stable webhook_key.
--
-- WA-UI-1A: whatsapp_business_connections.integration_id was NOT NULL + ON DELETE CASCADE,
-- so deleting salon_integrations would destroy the connection shell. Fix:
--   1) allow NULL integration_id (detached shell)
--   2) FK ON DELETE SET NULL (belt-and-suspenders)
--   3) remove RPC: soft-clear → detach → delete registry only

BEGIN;

-- A. Allow detached connection shells (registry removed, webhook_key preserved).
ALTER TABLE public.whatsapp_business_connections
  ALTER COLUMN integration_id DROP NOT NULL;

ALTER TABLE public.whatsapp_business_connections
  DROP CONSTRAINT IF EXISTS whatsapp_business_connections_integration_id_fkey;

ALTER TABLE public.whatsapp_business_connections
  ADD CONSTRAINT whatsapp_business_connections_integration_id_fkey
  FOREIGN KEY (integration_id)
  REFERENCES public.salon_integrations(id)
  ON DELETE SET NULL;

COMMENT ON COLUMN public.whatsapp_business_connections.integration_id IS
  'Optional link to salon_integrations(provider=whatsapp). NULL = detached shell after remove (webhook_key kept). Reattached by prepare/connect.';

-- B. Atomic remove RPC
CREATE OR REPLACE FUNCTION public.remove_whatsapp_integration_owned(
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
  v_shell_detached integer := 0;
  v_registry_deleted integer := 0;
BEGIN
  IF p_salon_id IS NULL THEN
    RAISE EXCEPTION 'p_salon_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- Soft-clear WhatsApp credentials for this salon only.
  -- Matches developer disconnect field clearing (no Meta revoke).
  -- Preserves webhook_key / id / salon_id / last_* timestamps.
  -- Detaches shell from registry so DELETE cannot CASCADE-remove the row.
  UPDATE public.whatsapp_business_connections
  SET
    access_token_ciphertext = NULL,
    access_token_iv = NULL,
    access_token_auth_tag = NULL,
    app_secret_ciphertext = NULL,
    app_secret_iv = NULL,
    app_secret_auth_tag = NULL,
    verify_token_ciphertext = NULL,
    verify_token_iv = NULL,
    verify_token_auth_tag = NULL,
    phone_number_id = NULL,
    display_phone_number = NULL,
    verified_name = NULL,
    business_account_id = NULL,
    token_expires_at = NULL,
    quality_rating = NULL,
    messaging_limit_tier = NULL,
    integration_id = NULL,
    updated_at = v_now
  WHERE salon_id = p_salon_id;

  GET DIAGNOSTICS v_connection_cleared = ROW_COUNT;
  v_shell_detached := v_connection_cleared;

  -- Remove WhatsApp visibility registry row only.
  -- Connection shell already detached (integration_id NULL); FK is ON DELETE SET NULL.
  DELETE FROM public.salon_integrations
  WHERE salon_id = p_salon_id
    AND provider = 'whatsapp';

  GET DIAGNOSTICS v_registry_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'salonId', p_salon_id,
    'connectionCleared', v_connection_cleared > 0,
    'shellDetached', v_shell_detached > 0,
    'registryRemoved', v_registry_deleted > 0
  );
END;
$$;

COMMENT ON FUNCTION public.remove_whatsapp_integration_owned(uuid) IS
  'WA-UI-1A atomic WhatsApp remove: soft-clear whatsapp_business_connections for p_salon_id (disconnect-equivalent), detach integration_id (preserve webhook_key shell), delete salon_integrations where salon_id=p_salon_id AND provider=whatsapp. Idempotent. No Meta. No salon/business-data / messaging-history mutation. No CASCADE shell delete.';

REVOKE ALL ON FUNCTION public.remove_whatsapp_integration_owned(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_whatsapp_integration_owned(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.remove_whatsapp_integration_owned(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.remove_whatsapp_integration_owned(uuid) TO service_role;

COMMIT;
