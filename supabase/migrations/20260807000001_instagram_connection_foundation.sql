-- IG-1: Instagram connection foundation (Instagram API with Instagram Login).
-- Additive only. Developer/service_role backend patterns.
-- Does NOT call Meta, create webhooks, seed credentials, or touch Telegram/WhatsApp/Apple.
--
-- Pilot: ONE Instagram Professional Account per salon.
-- Routing identity (future): instagram_user_id (Professional Account ID), never username.
-- Secrets live here — never in salon_integrations.token_ciphertext.
--
-- provider='instagram' already exists on integration_provider enum (20250622000004).

BEGIN;

CREATE TABLE IF NOT EXISTS public.instagram_business_connections (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                    UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  -- Professional Account ID. NULL until Meta-verified connect (IG-2).
  -- PostgreSQL UNIQUE allows multiple NULLs; non-null values are globally unique.
  instagram_user_id           TEXT NULL,
  instagram_username          TEXT NULL,
  access_token_ciphertext     TEXT NULL,
  access_token_iv             TEXT NULL,
  access_token_auth_tag       TEXT NULL,
  status                      TEXT NOT NULL DEFAULT 'not_connected',
  connected_at                TIMESTAMPTZ NULL,
  last_webhook_at             TIMESTAMPTZ NULL,
  last_error                  TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instagram_business_connections_salon_id_unique
    UNIQUE (salon_id),
  CONSTRAINT instagram_business_connections_instagram_user_id_unique
    UNIQUE (instagram_user_id),
  CONSTRAINT instagram_business_connections_status_check
    CHECK (status IN ('not_connected', 'connected', 'error', 'disabled')),
  CONSTRAINT instagram_business_connections_user_id_nonblank_when_set_check
    CHECK (
      instagram_user_id IS NULL
      OR length(trim(instagram_user_id)) > 0
    ),
  CONSTRAINT instagram_business_connections_connected_requires_user_id_check
    CHECK (
      status <> 'connected'
      OR (
        instagram_user_id IS NOT NULL
        AND length(trim(instagram_user_id)) > 0
      )
    ),
  CONSTRAINT instagram_business_connections_token_triple_complete_check
    CHECK (
      (
        access_token_ciphertext IS NULL
        AND access_token_iv IS NULL
        AND access_token_auth_tag IS NULL
      )
      OR (
        access_token_ciphertext IS NOT NULL
        AND length(trim(access_token_ciphertext)) > 0
        AND access_token_iv IS NOT NULL
        AND length(trim(access_token_iv)) > 0
        AND access_token_auth_tag IS NOT NULL
        AND length(trim(access_token_auth_tag)) > 0
      )
    ),
  CONSTRAINT instagram_business_connections_connected_requires_token_check
    CHECK (
      status <> 'connected'
      OR (
        access_token_ciphertext IS NOT NULL
        AND access_token_iv IS NOT NULL
        AND access_token_auth_tag IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS instagram_business_connections_status_idx
  ON public.instagram_business_connections (status);

CREATE INDEX IF NOT EXISTS instagram_business_connections_instagram_user_id_idx
  ON public.instagram_business_connections (instagram_user_id)
  WHERE instagram_user_id IS NOT NULL;

COMMENT ON TABLE public.instagram_business_connections IS
  'IG-1 Instagram Professional Account connection per salon. Access token AES-GCM encrypted. Backend/service_role only; no anon/auth policies.';

COMMENT ON COLUMN public.instagram_business_connections.instagram_user_id IS
  'Instagram Professional Account ID (routing identity). Never use username for routing.';

ALTER TABLE public.instagram_business_connections ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies — service_role bypasses RLS for developer APIs.

COMMIT;
