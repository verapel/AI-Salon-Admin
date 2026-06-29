-- AI Salon Admin: complete database setup
-- Paste this entire file into Supabase Dashboard → SQL Editor → Run

-- =============================================================================
-- 1. Schema
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE appointment_status AS ENUM (
  'scheduled', 'confirmed', 'completed', 'cancelled', 'no-show'
);
CREATE TYPE reminder_type AS ENUM ('email', 'sms');
CREATE TYPE reminder_status AS ENUM ('pending', 'sent', 'failed');

CREATE TYPE integration_provider AS ENUM (
  'telegram', 'whatsapp', 'instagram', 'facebook_messenger',
  'email', 'push', 'google_calendar', 'stripe', 'openai'
);
CREATE TYPE integration_status AS ENUM ('connected', 'not_connected', 'error', 'disabled');
CREATE TYPE integration_health AS ENUM ('healthy', 'error', 'unknown');

CREATE TABLE IF NOT EXISTS salons (
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

CREATE TABLE IF NOT EXISTS salon_integrations (
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

CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  total_visits  INTEGER NOT NULL DEFAULT 0 CHECK (total_visits >= 0),
  last_visit    DATE,
  created_at    DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  duration     INTEGER NOT NULL CHECK (duration > 0),
  price        NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  category     TEXT NOT NULL DEFAULT 'General',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff (
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

CREATE TABLE IF NOT EXISTS appointments (
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

CREATE TABLE IF NOT EXISTS reminders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  type            reminder_type NOT NULL DEFAULT 'email',
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          reminder_status NOT NULL DEFAULT 'pending',
  message         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_email ON clients (email);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments (date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders (status);
CREATE INDEX IF NOT EXISTS idx_salons_slug ON salons (slug);
CREATE INDEX IF NOT EXISTS idx_salons_active ON salons (active);
CREATE INDEX IF NOT EXISTS idx_salon_integrations_provider_status ON salon_integrations (provider, status);
CREATE INDEX IF NOT EXISTS idx_salon_integrations_salon_id ON salon_integrations (salon_id);

-- =============================================================================
-- 2. Row Level Security
-- =============================================================================
ALTER TABLE salons ENABLE ROW LEVEL SECURITY;
ALTER TABLE salon_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN CREATE POLICY "Allow public read on salons" ON salons FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public insert on salons" ON salons FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public update on salons" ON salons FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public delete on salons" ON salons FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "Allow public read on salon_integrations" ON salon_integrations FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public insert on salon_integrations" ON salon_integrations FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public update on salon_integrations" ON salon_integrations FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public delete on salon_integrations" ON salon_integrations FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow public read on clients" ON clients FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public insert on clients" ON clients FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public update on clients" ON clients FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public delete on clients" ON clients FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "Allow public read on services" ON services FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public insert on services" ON services FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public update on services" ON services FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public delete on services" ON services FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "Allow public read on staff" ON staff FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public insert on staff" ON staff FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public update on staff" ON staff FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public delete on staff" ON staff FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "Allow public read on appointments" ON appointments FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public insert on appointments" ON appointments FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public update on appointments" ON appointments FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public delete on appointments" ON appointments FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "Allow public read on reminders" ON reminders FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public insert on reminders" ON reminders FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public update on reminders" ON reminders FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Allow public delete on reminders" ON reminders FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- 3. Seed data (safe to re-run — uses ON CONFLICT DO NOTHING)
-- =============================================================================
INSERT INTO salons (id, name, slug, timezone, country, currency, language, active) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001', 'Beauty Studio', 'default',      'Europe/Moscow', 'RU', 'RUB', 'ru', TRUE),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002', 'Nail Studio',   'nail-studio',  'Europe/Moscow', 'RU', 'RUB', 'ru', TRUE),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0003', 'Hair Studio',   'hair-studio',  'Europe/Moscow', 'RU', 'RUB', 'ru', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, name, email, phone, notes, total_visits, last_visit, created_at) VALUES
  ('11111111-1111-1111-1111-111111111001', 'Emma Wilson',      'emma.wilson@email.com',   '+1 (555) 123-4567', 'Prefers morning appointments',       12, CURRENT_DATE - 3,  '2024-01-15'),
  ('11111111-1111-1111-1111-111111111002', 'Sophia Martinez',  'sophia.m@email.com',      '+1 (555) 234-5678', 'Allergic to certain hair dyes',       8, CURRENT_DATE - 7,  '2024-03-22'),
  ('11111111-1111-1111-1111-111111111003', 'Olivia Chen',      'olivia.chen@email.com',   '+1 (555) 345-6789', 'VIP client - monthly package',       24, CURRENT_DATE - 1,  '2023-11-08'),
  ('11111111-1111-1111-1111-111111111004', 'Isabella Brown',   'isabella.b@email.com',    '+1 (555) 456-7890', '',                                    3, CURRENT_DATE - 14, '2025-01-10'),
  ('11111111-1111-1111-1111-111111111005', 'Ava Thompson',     'ava.t@email.com',         '+1 (555) 567-8901', 'Referred by Emma Wilson',             5, CURRENT_DATE - 5,  '2024-08-30')
ON CONFLICT (id) DO NOTHING;

INSERT INTO services (id, name, description, duration, price, category, active) VALUES
  ('22222222-2222-2222-2222-222222222001', 'Haircut & Style',   'Professional cut with blow-dry styling',        60,  65.00,  'Hair',     TRUE),
  ('22222222-2222-2222-2222-222222222002', 'Balayage',          'Hand-painted highlights for natural look',     180, 220.00,  'Color',    TRUE),
  ('22222222-2222-2222-2222-222222222003', 'Manicure',          'Classic manicure with polish',                  45,  35.00,  'Nails',    TRUE),
  ('22222222-2222-2222-2222-222222222004', 'Pedicure',          'Relaxing spa pedicure treatment',               60,  50.00,  'Nails',    TRUE),
  ('22222222-2222-2222-2222-222222222005', 'Facial Treatment',  'Deep cleansing and hydrating facial',             75,  90.00,  'Skincare', TRUE),
  ('22222222-2222-2222-2222-222222222006', 'Blowout',           'Professional blow-dry and styling',             45,  45.00,  'Hair',     TRUE),
  ('22222222-2222-2222-2222-222222222007', 'Full Color',        'Complete hair color transformation',           120, 150.00,  'Color',    TRUE),
  ('22222222-2222-2222-2222-222222222008', 'Eyebrow Shaping',   'Precision brow shaping and tinting',            30,  25.00,  'Beauty',   TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO staff (id, name, email, phone, role, specialties, avatar, active) VALUES
  ('33333333-3333-3333-3333-333333333001', 'Sarah Johnson',  'sarah@salon.com',     '+1 (555) 111-2222', 'Senior Stylist',    ARRAY['Hair', 'Color'],           'SJ', TRUE),
  ('33333333-3333-3333-3333-333333333002', 'Maria Garcia',   'maria@salon.com',     '+1 (555) 222-3333', 'Color Specialist',  ARRAY['Color', 'Balayage'],       'MG', TRUE),
  ('33333333-3333-3333-3333-333333333003', 'Lisa Park',      'lisa@salon.com',      '+1 (555) 333-4444', 'Nail Technician',   ARRAY['Nails'],                   'LP', TRUE),
  ('33333333-3333-3333-3333-333333333004', 'Jennifer Lee',   'jennifer@salon.com',  '+1 (555) 444-5555', 'Esthetician',       ARRAY['Skincare', 'Beauty'],      'JL', TRUE),
  ('33333333-3333-3333-3333-333333333005', 'Amanda White',   'amanda@salon.com',    '+1 (555) 555-6666', 'Junior Stylist',    ARRAY['Hair'],                    'AW', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO appointments (id, client_id, staff_id, service_id, date, start_time, end_time, status, notes, reminder_sent, created_at) VALUES
  ('44444444-4444-4444-4444-444444444001', '11111111-1111-1111-1111-111111111001', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222001', CURRENT_DATE,     '09:00', '10:00', 'confirmed',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444002', '11111111-1111-1111-1111-111111111003', '33333333-3333-3333-3333-333333333002', '22222222-2222-2222-2222-222222222002', CURRENT_DATE,     '10:30', '13:30', 'scheduled',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444003', '11111111-1111-1111-1111-111111111005', '33333333-3333-3333-3333-333333333003', '22222222-2222-2222-2222-222222222003', CURRENT_DATE,     '11:00', '11:45', 'confirmed',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444004', '11111111-1111-1111-1111-111111111002', '33333333-3333-3333-3333-333333333004', '22222222-2222-2222-2222-222222222005', CURRENT_DATE,     '14:00', '15:15', 'scheduled',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444005', '11111111-1111-1111-1111-111111111004', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222006', CURRENT_DATE + 1, '09:30', '10:15', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444006', '11111111-1111-1111-1111-111111111001', '33333333-3333-3333-3333-333333333002', '22222222-2222-2222-2222-222222222007', CURRENT_DATE + 1, '13:00', '15:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444007', '11111111-1111-1111-1111-111111111003', '33333333-3333-3333-3333-333333333005', '22222222-2222-2222-2222-222222222001', CURRENT_DATE + 2, '10:00', '11:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444008', '11111111-1111-1111-1111-111111111005', '33333333-3333-3333-3333-333333333003', '22222222-2222-2222-2222-222222222004', CURRENT_DATE + 2, '15:00', '16:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444009', '11111111-1111-1111-1111-111111111002', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222001', CURRENT_DATE - 1, '11:00', '12:00', 'completed',  '', TRUE,  CURRENT_DATE - 5),
  ('44444444-4444-4444-4444-444444444010', '11111111-1111-1111-1111-111111111004', '33333333-3333-3333-3333-333333333004', '22222222-2222-2222-2222-222222222008', CURRENT_DATE - 2, '16:00', '16:30', 'completed',  '', TRUE,  CURRENT_DATE - 5),
  ('44444444-4444-4444-4444-444444444011', '11111111-1111-1111-1111-111111111001', '33333333-3333-3333-3333-333333333002', '22222222-2222-2222-2222-222222222002', CURRENT_DATE - 3, '09:00', '12:00', 'completed',  '', TRUE,  CURRENT_DATE - 5),
  ('44444444-4444-4444-4444-444444444012', '11111111-1111-1111-1111-111111111003', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222006', CURRENT_DATE - 5, '14:30', '15:15', 'completed',  '', TRUE,  CURRENT_DATE - 7),
  ('44444444-4444-4444-4444-444444444013', '11111111-1111-1111-1111-111111111005', '33333333-3333-3333-3333-333333333003', '22222222-2222-2222-2222-222222222003', CURRENT_DATE - 7, '10:00', '10:45', 'cancelled',  '', TRUE,  CURRENT_DATE - 10),
  ('44444444-4444-4444-4444-444444444014', '11111111-1111-1111-1111-111111111002', '33333333-3333-3333-3333-333333333004', '22222222-2222-2222-2222-222222222005', CURRENT_DATE + 3, '11:30', '12:45', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444015', '11111111-1111-1111-1111-111111111004', '33333333-3333-3333-3333-333333333005', '22222222-2222-2222-2222-222222222001', CURRENT_DATE + 4, '09:00', '10:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reminders (id, appointment_id, type, scheduled_for, status, message) VALUES
  ('55555555-5555-5555-5555-555555555001', '44444444-4444-4444-4444-444444444005', 'email', (CURRENT_DATE + 1)::timestamptz + TIME '08:00', 'pending', 'Reminder: Your appointment tomorrow at 9:30 AM'),
  ('55555555-5555-5555-5555-555555555002', '44444444-4444-4444-4444-444444444006', 'sms',   (CURRENT_DATE + 1)::timestamptz + TIME '08:00', 'pending', 'Hi! Reminder for your color appointment tomorrow at 1:00 PM'),
  ('55555555-5555-5555-5555-555555555003', '44444444-4444-4444-4444-444444444007', 'email', (CURRENT_DATE + 2)::timestamptz + TIME '08:00', 'pending', 'Your haircut is scheduled for 10:00 AM'),
  ('55555555-5555-5555-5555-555555555004', '44444444-4444-4444-4444-444444444001', 'sms',   CURRENT_DATE::timestamptz + TIME '07:00',         'sent',    'See you today at 9:00 AM!'),
  ('55555555-5555-5555-5555-555555555005', '44444444-4444-4444-4444-444444444009', 'email', (CURRENT_DATE - 1)::timestamptz + TIME '08:00', 'sent',    'Appointment reminder sent')
ON CONFLICT (id) DO NOTHING;
