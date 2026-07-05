-- Client blacklist: safe defaults for existing rows
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ NULL;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_is_blocked ON clients (is_blocked);
