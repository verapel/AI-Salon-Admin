-- WA-1: Additive WhatsApp channel foundation (schema/types placeholders only).
-- No Meta API, webhooks, messages, booking, encryption runtime, or Telegram/Apple changes.
-- RLS is ENABLED on new tables with NO policies (server/service-role only; no anon/authenticated
-- client access). Service role bypasses RLS. updated_at is application-managed (no trustworthy
-- shared trigger in this project; the initial-schema update_updated_at_column() incorrectly
-- assigns created_at).
--
-- Cross-salon note:
-- Direct FKs do not prove salon_id consistency across clients / salon_integrations.
-- Composite FKs would require invasive uniqueness changes on existing tables — deferred.
-- Future writers must set salon_id from verified integration/webhook identity and
-- verify related rows belong to the same salon.
--
-- salon_integrations.provider = 'whatsapp' already exists (integration_provider enum).
-- WhatsApp secrets must NOT use salon_integrations.token_ciphertext (Telegram plaintext).

-- ---------------------------------------------------------------------------
-- A. whatsapp_business_connections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_business_connections (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                   UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  integration_id             UUID NOT NULL REFERENCES salon_integrations(id) ON DELETE CASCADE,
  -- Architecture fixed to Meta WhatsApp Cloud API for this product stage.
  provider                   TEXT NOT NULL DEFAULT 'meta_cloud',
  business_account_id        TEXT NULL,
  phone_number_id            TEXT NULL,
  display_phone_number       TEXT NULL,
  verified_name              TEXT NULL,
  -- Encryption placeholders only (WA-2). Never store plaintext secrets.
  access_token_ciphertext    TEXT NULL,
  access_token_iv            TEXT NULL,
  access_token_auth_tag      TEXT NULL,
  app_secret_ciphertext      TEXT NULL,
  app_secret_iv              TEXT NULL,
  app_secret_auth_tag        TEXT NULL,
  verify_token_ciphertext    TEXT NULL,
  verify_token_iv            TEXT NULL,
  verify_token_auth_tag      TEXT NULL,
  token_expires_at           TIMESTAMPTZ NULL,
  last_webhook_at            TIMESTAMPTZ NULL,
  last_inbound_at            TIMESTAMPTZ NULL,
  last_outbound_at           TIMESTAMPTZ NULL,
  quality_rating             TEXT NULL,
  messaging_limit_tier       TEXT NULL,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_business_connections_provider_check
    CHECK (provider = 'meta_cloud'),
  CONSTRAINT whatsapp_business_connections_phone_number_id_nonblank_check
    CHECK (phone_number_id IS NULL OR length(trim(phone_number_id)) > 0),
  CONSTRAINT whatsapp_business_connections_salon_id_unique
    UNIQUE (salon_id),
  CONSTRAINT whatsapp_business_connections_integration_id_unique
    UNIQUE (integration_id)
);

-- One WhatsApp Cloud phone_number_id may map to at most one salon connection.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_business_connections_phone_number_id_unique
  ON whatsapp_business_connections (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

-- salon_id / integration_id ordinary indexes omitted: UNIQUE (salon_id) and
-- UNIQUE (integration_id) already provide btree indexes on those columns.

COMMENT ON TABLE whatsapp_business_connections IS
  'Per-salon Meta WhatsApp Cloud API connection metadata. Secret *_ciphertext/iv/auth_tag columns are unused until WA-2 encryption. Pair with salon_integrations(provider=whatsapp); do not store WhatsApp tokens in salon_integrations.token_ciphertext.';

COMMENT ON COLUMN whatsapp_business_connections.access_token_ciphertext IS
  'AES-256-GCM ciphertext placeholder for Cloud API access token (WA-2). Never plaintext.';
COMMENT ON COLUMN whatsapp_business_connections.app_secret_ciphertext IS
  'AES-256-GCM ciphertext placeholder for Meta app secret used in webhook signature verify (WA-2). Never plaintext.';
COMMENT ON COLUMN whatsapp_business_connections.verify_token_ciphertext IS
  'AES-256-GCM ciphertext placeholder for webhook verify token (WA-2). Never plaintext.';
COMMENT ON COLUMN whatsapp_business_connections.phone_number_id IS
  'Meta phone_number_id used to resolve inbound webhooks to salon_id. Globally unique when set.';

-- ---------------------------------------------------------------------------
-- B. client_channel_identities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_channel_identities (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id             UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_id            UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL,
  external_user_id     TEXT NOT NULL,
  normalized_address   TEXT NULL,
  display_address      TEXT NULL,
  opt_in_at            TIMESTAMPTZ NULL,
  opt_out_at           TIMESTAMPTZ NULL,
  last_interaction_at  TIMESTAMPTZ NULL,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_channel_identities_provider_check
    CHECK (provider IN ('telegram', 'whatsapp')),
  CONSTRAINT client_channel_identities_external_user_id_nonblank_check
    CHECK (length(trim(external_user_id)) > 0),
  CONSTRAINT client_channel_identities_normalized_address_nonblank_check
    CHECK (normalized_address IS NULL OR length(trim(normalized_address)) > 0),
  CONSTRAINT client_channel_identities_salon_provider_external_unique
    UNIQUE (salon_id, provider, external_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_channel_identities_salon_provider_normalized_unique
  ON client_channel_identities (salon_id, provider, normalized_address)
  WHERE normalized_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS client_channel_identities_client_id_idx
  ON client_channel_identities (client_id);

CREATE INDEX IF NOT EXISTS client_channel_identities_salon_provider_idx
  ON client_channel_identities (salon_id, provider);

CREATE INDEX IF NOT EXISTS client_channel_identities_normalized_address_idx
  ON client_channel_identities (normalized_address)
  WHERE normalized_address IS NOT NULL;

COMMENT ON TABLE client_channel_identities IS
  'Additive channel identity map (Telegram/WhatsApp). Does not migrate or replace clients.telegram_chat_id in WA-1.';

-- ---------------------------------------------------------------------------
-- C. channel_event_receipts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_event_receipts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id             UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL,
  external_event_id    TEXT NOT NULL,
  external_message_id  TEXT NULL,
  event_type           TEXT NULL,
  payload_hash         TEXT NULL,
  processing_status    TEXT NOT NULL DEFAULT 'received',
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at         TIMESTAMPTZ NULL,
  last_error           TEXT NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_event_receipts_provider_check
    CHECK (provider IN ('whatsapp')),
  CONSTRAINT channel_event_receipts_processing_status_check
    CHECK (processing_status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  CONSTRAINT channel_event_receipts_external_event_id_nonblank_check
    CHECK (length(trim(external_event_id)) > 0),
  CONSTRAINT channel_event_receipts_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT channel_event_receipts_provider_external_event_unique
    UNIQUE (provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS channel_event_receipts_salon_id_idx
  ON channel_event_receipts (salon_id);

CREATE INDEX IF NOT EXISTS channel_event_receipts_provider_status_idx
  ON channel_event_receipts (provider, processing_status);

CREATE INDEX IF NOT EXISTS channel_event_receipts_received_at_idx
  ON channel_event_receipts (received_at);

CREATE INDEX IF NOT EXISTS channel_event_receipts_external_message_id_idx
  ON channel_event_receipts (provider, external_message_id)
  WHERE external_message_id IS NOT NULL;

COMMENT ON TABLE channel_event_receipts IS
  'Durable webhook/event idempotency receipts. Do not store full provider payloads in WA-1; metadata is for limited future diagnostics only.';

-- ---------------------------------------------------------------------------
-- D. channel_conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_conversations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                  UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  provider                  TEXT NOT NULL,
  external_user_id          TEXT NOT NULL,
  client_id                 UUID NULL REFERENCES clients(id) ON DELETE SET NULL,
  current_flow              TEXT NULL,
  current_step              TEXT NULL,
  state                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_message_id   TEXT NULL,
  last_outbound_message_id  TEXT NULL,
  last_interaction_at       TIMESTAMPTZ NULL,
  expires_at                TIMESTAMPTZ NULL,
  locked_at                 TIMESTAMPTZ NULL,
  lock_token                UUID NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_conversations_provider_check
    CHECK (provider IN ('whatsapp')),
  CONSTRAINT channel_conversations_external_user_id_nonblank_check
    CHECK (length(trim(external_user_id)) > 0),
  CONSTRAINT channel_conversations_salon_provider_external_unique
    UNIQUE (salon_id, provider, external_user_id)
);

CREATE INDEX IF NOT EXISTS channel_conversations_salon_provider_idx
  ON channel_conversations (salon_id, provider);

CREATE INDEX IF NOT EXISTS channel_conversations_expires_at_idx
  ON channel_conversations (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS channel_conversations_last_interaction_at_idx
  ON channel_conversations (last_interaction_at)
  WHERE last_interaction_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS channel_conversations_lock_token_idx
  ON channel_conversations (lock_token)
  WHERE lock_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS channel_conversations_client_id_idx
  ON channel_conversations (client_id)
  WHERE client_id IS NOT NULL;

COMMENT ON TABLE channel_conversations IS
  'Durable WhatsApp conversation/FSM placeholder independent of Telegram in-memory Maps. No runtime FSM in WA-1.';

-- ---------------------------------------------------------------------------
-- E. Row Level Security (server-side only)
-- ---------------------------------------------------------------------------
-- Enable RLS with zero policies: anon/authenticated clients cannot read or write
-- these tables via the Data API. The Express backend uses the Supabase service role,
-- which bypasses RLS. Do not add USING (true) / WITH CHECK (true) policies.

ALTER TABLE public.whatsapp_business_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_conversations ENABLE ROW LEVEL SECURITY;
