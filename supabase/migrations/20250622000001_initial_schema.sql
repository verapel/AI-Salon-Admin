-- AI Salon Admin: initial schema
-- Run in Supabase SQL Editor or via Supabase CLI

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE appointment_status AS ENUM (
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no-show'
);

CREATE TYPE reminder_type AS ENUM ('email', 'sms');

CREATE TYPE reminder_status AS ENUM ('pending', 'sent', 'failed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  total_visits  INTEGER NOT NULL DEFAULT 0 CHECK (total_visits >= 0),
  last_visit    DATE,
  created_at    DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  duration     INTEGER NOT NULL CHECK (duration > 0),
  price        NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  category     TEXT NOT NULL DEFAULT 'General',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE staff (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'Stylist',
  specialties  TEXT[] NOT NULL DEFAULT '{}',
  avatar       TEXT NOT NULL DEFAULT '',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE appointments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  staff_id       UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  service_id     UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  date           DATE NOT NULL,
  start_time     TIME NOT NULL,
  end_time       TIME NOT NULL,
  status         appointment_status NOT NULL DEFAULT 'scheduled',
  notes          TEXT NOT NULL DEFAULT '',
  reminder_sent  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE reminders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  type            reminder_type NOT NULL DEFAULT 'email',
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          reminder_status NOT NULL DEFAULT 'pending',
  message         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_clients_email ON clients (email);
CREATE INDEX idx_appointments_date ON appointments (date);
CREATE INDEX idx_appointments_status ON appointments (status);
CREATE INDEX idx_appointments_client_id ON appointments (client_id);
CREATE INDEX idx_appointments_staff_id ON appointments (staff_id);
CREATE INDEX idx_appointments_service_id ON appointments (service_id);
CREATE INDEX idx_reminders_status ON reminders (status);
CREATE INDEX idx_reminders_appointment_id ON reminders (appointment_id);

-- ---------------------------------------------------------------------------
-- Updated-at helper (optional future use)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.created_at = COALESCE(NEW.created_at, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
