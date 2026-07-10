-- Birthday-2a: idempotency foundation for automatic owner birthday notifications.
-- No RLS (service role / API layer enforces salon_id), matching schedule tables.
-- updated_at is application-managed (no shared trigger pattern in this project).

CREATE TABLE birthday_owner_notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id            UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  occurrence_year     INTEGER NOT NULL,
  notify_offset_days  INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'pending',
  sent_at             TIMESTAMPTZ NULL,
  last_error          TEXT NULL,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT birthday_owner_notifications_occurrence_year_check
    CHECK (occurrence_year BETWEEN 2000 AND 2100),
  CONSTRAINT birthday_owner_notifications_notify_offset_days_check
    CHECK (notify_offset_days >= 0),
  CONSTRAINT birthday_owner_notifications_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  CONSTRAINT birthday_owner_notifications_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT birthday_owner_notifications_unique_occurrence
    UNIQUE (salon_id, client_id, occurrence_year, notify_offset_days)
);

CREATE INDEX birthday_owner_notifications_salon_id_idx
  ON birthday_owner_notifications (salon_id);

CREATE INDEX birthday_owner_notifications_status_idx
  ON birthday_owner_notifications (status);

CREATE INDEX birthday_owner_notifications_occurrence_year_idx
  ON birthday_owner_notifications (occurrence_year);

CREATE INDEX birthday_owner_notifications_salon_status_idx
  ON birthday_owner_notifications (salon_id, status);
