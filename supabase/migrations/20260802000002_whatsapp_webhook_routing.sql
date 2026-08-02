-- WA-3B/3C: Opaque public routing key for Meta WhatsApp Cloud webhooks
-- + salon-scoped receipt uniqueness hardening.
--
-- webhook_key is a routing identifier only (not an authentication secret).
-- Do not encode salon_id or credentials in the key.
--
-- Receipt uniqueness (from 20260727000002):
--   CONSTRAINT channel_event_receipts_provider_external_event_unique
--     UNIQUE (provider, external_event_id)  -- global across salons
-- Preferred multi-tenant shape:
--   UNIQUE (salon_id, provider, external_event_id)

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Opaque webhook routing key
-- ---------------------------------------------------------------------------
ALTER TABLE public.whatsapp_business_connections
  ADD COLUMN IF NOT EXISTS webhook_key uuid;

UPDATE public.whatsapp_business_connections
SET webhook_key = gen_random_uuid()
WHERE webhook_key IS NULL;

ALTER TABLE public.whatsapp_business_connections
  ALTER COLUMN webhook_key SET DEFAULT gen_random_uuid();

ALTER TABLE public.whatsapp_business_connections
  ALTER COLUMN webhook_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_business_connections_webhook_key_unique
  ON public.whatsapp_business_connections (webhook_key);

COMMENT ON COLUMN public.whatsapp_business_connections.webhook_key IS
  'Opaque public routing UUID for /api/webhooks/whatsapp/:webhookKey. Not an auth secret.';

-- ---------------------------------------------------------------------------
-- B. Salon-scoped channel_event_receipts uniqueness
-- Exact legacy constraint name from 20260727000002_whatsapp_channel_foundation.sql:
--   channel_event_receipts_provider_external_event_unique
-- Order: add composite unique first, then drop global unique.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'channel_event_receipts_salon_provider_external_event_unique'
      AND conrelid = 'public.channel_event_receipts'::regclass
  ) THEN
    ALTER TABLE public.channel_event_receipts
      ADD CONSTRAINT channel_event_receipts_salon_provider_external_event_unique
      UNIQUE (salon_id, provider, external_event_id);
  END IF;
END $$;

ALTER TABLE public.channel_event_receipts
  DROP CONSTRAINT IF EXISTS channel_event_receipts_provider_external_event_unique;

COMMENT ON CONSTRAINT channel_event_receipts_salon_provider_external_event_unique
  ON public.channel_event_receipts IS
  'Multi-tenant receipt idempotency: unique per salon + provider + external_event_id.';

COMMIT;
