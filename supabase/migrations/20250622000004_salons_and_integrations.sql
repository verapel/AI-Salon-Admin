-- AI Salon Admin: platform foundation — salons and integrations metadata
-- Stage 1: schema + seed only. Telegram token stays in .env (not stored here).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE integration_provider AS ENUM (
  'telegram',
  'whatsapp',
  'instagram',
  'facebook_messenger',
  'email',
  'push',
  'google_calendar',
  'stripe',
  'openai'
);

CREATE TYPE integration_status AS ENUM (
  'connected',
  'not_connected',
  'error',
  'disabled'
);

CREATE TYPE integration_health AS ENUM (
  'healthy',
  'error',
  'unknown'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE salons (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  timezone   TEXT NOT NULL DEFAULT 'Europe/Moscow',
  country    TEXT NOT NULL DEFAULT '',
  currency   TEXT NOT NULL DEFAULT 'RUB',
  language   TEXT NOT NULL DEFAULT 'ru',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE salon_integrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id         UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  provider         integration_provider NOT NULL,
  status           integration_status NOT NULL DEFAULT 'not_connected',
  health           integration_health NOT NULL DEFAULT 'unknown',
  bot_username     TEXT,
  bot_display_name TEXT,
  connected_at     TIMESTAMPTZ,
  last_checked_at  TIMESTAMPTZ,
  last_error       TEXT,
  token_ciphertext TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salon_id, provider)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_salons_slug ON salons (slug);
CREATE INDEX idx_salons_active ON salons (active);
CREATE INDEX idx_salon_integrations_provider_status ON salon_integrations (provider, status);
CREATE INDEX idx_salon_integrations_salon_id ON salon_integrations (salon_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE salons ENABLE ROW LEVEL SECURITY;
ALTER TABLE salon_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on salons"
  ON salons FOR SELECT USING (true);

CREATE POLICY "Allow public insert on salons"
  ON salons FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on salons"
  ON salons FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on salons"
  ON salons FOR DELETE USING (true);

CREATE POLICY "Allow public read on salon_integrations"
  ON salon_integrations FOR SELECT USING (true);

CREATE POLICY "Allow public insert on salon_integrations"
  ON salon_integrations FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on salon_integrations"
  ON salon_integrations FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on salon_integrations"
  ON salon_integrations FOR DELETE USING (true);

-- ---------------------------------------------------------------------------
-- Seed: platform salons (Default Salon = slug 'default')
-- Integration rows are created at runtime when the API checks Telegram status.
-- ---------------------------------------------------------------------------
INSERT INTO salons (id, name, slug, timezone, country, currency, language, active) VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001',
    'Beauty Studio',
    'default',
    'Europe/Moscow',
    'RU',
    'RUB',
    'ru',
    TRUE
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002',
    'Nail Studio',
    'nail-studio',
    'Europe/Moscow',
    'RU',
    'RUB',
    'ru',
    TRUE
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0003',
    'Hair Studio',
    'hair-studio',
    'Europe/Moscow',
    'RU',
    'RUB',
    'ru',
    TRUE
  )
ON CONFLICT (id) DO NOTHING;
