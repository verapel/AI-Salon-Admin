-- IG-3: Allow Instagram provider on durable channel_event_receipts.
-- Additive only. Does not alter WhatsApp rows/semantics.
-- Does NOT widen channel_conversations or client_channel_identities (IG-4).
-- Does NOT execute subscription or seed data.

BEGIN;

ALTER TABLE public.channel_event_receipts
  DROP CONSTRAINT IF EXISTS channel_event_receipts_provider_check;

ALTER TABLE public.channel_event_receipts
  ADD CONSTRAINT channel_event_receipts_provider_check
    CHECK (provider IN ('whatsapp', 'instagram'));

COMMENT ON CONSTRAINT channel_event_receipts_provider_check ON public.channel_event_receipts IS
  'Messaging webhook receipt providers: whatsapp (WA-1+) and instagram (IG-3+).';

COMMIT;
