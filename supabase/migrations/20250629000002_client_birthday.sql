-- Optional client birthday for loyalty / Telegram onboarding
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS birthday DATE NULL;
