-- Stage F: Auth membership schema (salon_members + platform_users)
-- Creates enums and tables only.
-- Does NOT seed auth.users — create users in Supabase Auth Dashboard first,
-- then insert membership rows manually with real auth.users UUIDs.
-- RLS policies intentionally deferred (Stage K).
-- Does NOT touch Telegram, operational tables, or existing RLS.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE salon_member_role AS ENUM (
  'owner',
  'admin',
  'staff_readonly'
);

CREATE TYPE platform_user_role AS ENUM (
  'developer'
);

-- ---------------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------------

CREATE TABLE salon_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  salon_id   UUID NOT NULL REFERENCES salons(id) ON DELETE RESTRICT,
  role       salon_member_role NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, salon_id)
);

CREATE TABLE platform_users (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       platform_user_role NOT NULL DEFAULT 'developer',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3. INDEXES
-- ---------------------------------------------------------------------------

CREATE INDEX idx_salon_members_user_id
  ON salon_members (user_id);

CREATE INDEX idx_salon_members_salon_id
  ON salon_members (salon_id);

CREATE INDEX idx_salon_members_salon_active
  ON salon_members (salon_id, active)
  WHERE active = TRUE;

CREATE INDEX idx_platform_users_active
  ON platform_users (active)
  WHERE active = TRUE;

COMMIT;
