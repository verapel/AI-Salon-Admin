ALTER TABLE salon_integrations
  ADD COLUMN IF NOT EXISTS admin_chat_id BIGINT NULL;
