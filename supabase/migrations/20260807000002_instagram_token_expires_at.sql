-- IG-2: track Instagram long-lived access token expiry (60-day tokens).
-- Additive only. Does not execute seed/data mutation. Does not touch WhatsApp/Telegram/Apple.

BEGIN;

ALTER TABLE public.instagram_business_connections
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.instagram_business_connections.token_expires_at IS
  'Expiry of the stored long-lived Instagram User access token (UTC). NULL when unknown/not connected.';

COMMIT;
