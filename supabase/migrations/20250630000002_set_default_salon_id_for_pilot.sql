-- Stage C: DEFAULT salon_id for pilot/default salon (TM_salon)
-- Pilot salon: slug 'default', id aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001
-- Ensures new INSERTs (e.g. Telegram before Stage E API scoping) get pilot salon_id automatically.
-- Backfill already done in 20250630000001 — no UPDATE here.
-- NOT NULL, unique constraints, RLS, and triggers are intentionally deferred.

ALTER TABLE clients
  ALTER COLUMN salon_id SET DEFAULT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';

ALTER TABLE staff
  ALTER COLUMN salon_id SET DEFAULT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';

ALTER TABLE services
  ALTER COLUMN salon_id SET DEFAULT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';

ALTER TABLE appointments
  ALTER COLUMN salon_id SET DEFAULT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';

ALTER TABLE reminders
  ALTER COLUMN salon_id SET DEFAULT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';
