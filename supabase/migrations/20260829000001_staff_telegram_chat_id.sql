-- Optional Telegram chat id on staff for master-specific booking notifications.
-- Additive only: nullable, no backfill, existing staff rows remain valid.

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT NULL;

COMMENT ON COLUMN staff.telegram_chat_id IS
  'Optional Telegram chat id for this staff member. Used to send the internal new-booking notification to the assigned master only. Nullable; existing staff remain valid.';

CREATE INDEX IF NOT EXISTS idx_staff_telegram_chat_id
  ON staff (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;
