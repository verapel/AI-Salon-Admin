-- Stage I3b-4c-1: temporary admin chat candidate (developer must confirm into admin_chat_id)
ALTER TABLE salon_integrations
  ADD COLUMN IF NOT EXISTS admin_chat_candidate_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS admin_chat_candidate_at TIMESTAMPTZ NULL;
