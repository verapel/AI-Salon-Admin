-- R1B: Telegram reminder schema foundation (additive only).
-- Does NOT backfill telegram_chat_id, send reminders, or change existing rows' type/status.
-- Existing inserts with type=email / status=pending remain valid.
--
-- Enum notes:
--   reminder_type and reminder_status are PostgreSQL ENUMs.
--   New values are added with IF NOT EXISTS.
--   Partial indexes below intentionally use only pre-existing enum literals
--   (status = 'pending') so this file can run in a single transaction on PG 12+
--   where a newly added enum value cannot be referenced until after commit.

-- ---------------------------------------------------------------------------
-- A. Durable Telegram recipient on clients (nullable; no backfill; no global UNIQUE)
-- ---------------------------------------------------------------------------
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT NULL;

COMMENT ON COLUMN clients.telegram_chat_id IS
  'Durable Telegram chat id for appointment reminders. Nullable until the client books via the salon bot. Not globally unique (multi-salon).';

CREATE INDEX IF NOT EXISTS idx_clients_telegram_chat_id
  ON clients (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B / C. Extend reminder enums (preserve email|sms and pending|sent|failed)
-- ---------------------------------------------------------------------------
ALTER TYPE reminder_type ADD VALUE IF NOT EXISTS 'telegram';
ALTER TYPE reminder_status ADD VALUE IF NOT EXISTS 'skipped';

-- ---------------------------------------------------------------------------
-- D. Delivery / claim metadata (birthday-style attempt fields + claim token)
-- ---------------------------------------------------------------------------
ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_error TEXT NULL,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS claim_token UUID NULL,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN reminders.sent_at IS
  'When the reminder was successfully delivered.';
COMMENT ON COLUMN reminders.last_error IS
  'Last delivery/claim error (truncated); null on success.';
COMMENT ON COLUMN reminders.claimed_at IS
  'Worker claim timestamp; used with claim_token for optimistic exclusive send.';
COMMENT ON COLUMN reminders.claim_token IS
  'Worker-generated UUID proving ownership of an in-flight claim.';
COMMENT ON COLUMN reminders.attempt_count IS
  'Number of send/claim attempts.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reminders_attempt_count_check'
  ) THEN
    ALTER TABLE reminders
      ADD CONSTRAINT reminders_attempt_count_check
      CHECK (attempt_count >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- E. Duplicate protection: at most one pending reminder per appointment
-- ---------------------------------------------------------------------------
-- Chosen over (type=telegram AND status=pending) so the unique predicate only
-- uses the pre-existing 'pending' enum value (safe in one transaction).
-- Semantics: one active pending reminder of any channel per appointment.
-- Allows: historical sent/failed/skipped + a later pending after reschedule
-- (when the previous pending is updated or no longer pending).
-- Does NOT block email/sms history rows.

CREATE UNIQUE INDEX IF NOT EXISTS reminders_one_pending_per_appointment_idx
  ON reminders (appointment_id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- F. Worker pickup index (type + status + scheduled_for)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS reminders_type_status_scheduled_for_idx
  ON reminders (type, status, scheduled_for);
