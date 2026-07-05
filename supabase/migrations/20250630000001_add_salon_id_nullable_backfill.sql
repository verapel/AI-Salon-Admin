-- Stage B: nullable salon_id + backfill to pilot/default salon (TM_salon)
-- Pilot salon: slug 'default', id aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001
-- NOT NULL, unique constraints, RLS, and triggers are intentionally deferred.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ADD nullable salon_id + FK
-- ---------------------------------------------------------------------------

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS salon_id UUID NULL
  REFERENCES salons(id) ON DELETE RESTRICT;

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS salon_id UUID NULL
  REFERENCES salons(id) ON DELETE RESTRICT;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS salon_id UUID NULL
  REFERENCES salons(id) ON DELETE RESTRICT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS salon_id UUID NULL
  REFERENCES salons(id) ON DELETE RESTRICT;

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS salon_id UUID NULL
  REFERENCES salons(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. BACKFILL (all existing operational data → default/pilot salon)
-- ---------------------------------------------------------------------------

UPDATE clients
SET salon_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'
WHERE salon_id IS NULL;

UPDATE staff
SET salon_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'
WHERE salon_id IS NULL;

UPDATE services
SET salon_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'
WHERE salon_id IS NULL;

UPDATE appointments
SET salon_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'
WHERE salon_id IS NULL;

UPDATE reminders r
SET salon_id = a.salon_id
FROM appointments a
WHERE r.appointment_id = a.id
  AND r.salon_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. INDEXES
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_clients_salon_id ON clients (salon_id);
CREATE INDEX IF NOT EXISTS idx_staff_salon_id ON staff (salon_id);
CREATE INDEX IF NOT EXISTS idx_services_salon_id ON services (salon_id);
CREATE INDEX IF NOT EXISTS idx_appointments_salon_id ON appointments (salon_id);
CREATE INDEX IF NOT EXISTS idx_reminders_salon_id ON reminders (salon_id);

CREATE INDEX IF NOT EXISTS idx_appointments_salon_date
  ON appointments (salon_id, date);

CREATE INDEX IF NOT EXISTS idx_appointments_salon_staff_date_time
  ON appointments (salon_id, staff_id, date, start_time);

COMMIT;
