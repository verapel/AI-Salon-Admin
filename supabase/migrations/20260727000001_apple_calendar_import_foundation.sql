-- APPLE-A2: Additive Apple Calendar import source/link foundation.
-- Schema placeholders only: no CalDAV, credentials, sync, or import behavior.
-- No RLS (service role / API layer enforces salon_id), matching schedule/birthday tables.
-- updated_at is application-managed (no trustworthy shared trigger in this project;
-- the initial-schema update_updated_at_column() incorrectly assigns created_at).
--
-- Cross-salon note:
-- FK targets do not prove salon_id consistency across appointments/staff/services/
-- calendar_connections. Future writers must set salon_id from the authenticated
-- salon context and verify related rows belong to the same salon.

-- ---------------------------------------------------------------------------
-- A. appointments.source (nullable; no database default)
-- ---------------------------------------------------------------------------
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS source TEXT NULL;

COMMENT ON COLUMN appointments.source IS
  'Appointment origin: telegram | owner | apple. NULL = unset/legacy or a creation path that has not yet assigned a source. API currently uses a backward-compatible mapper fallback (source ?? owner). Creation paths will assign explicit values in a later isolated stage. No database DEFAULT — omitted inserts remain NULL.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'appointments_source_check'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_source_check
      CHECK (source IS NULL OR source IN ('telegram', 'owner', 'apple'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_appointments_source
  ON appointments (source)
  WHERE source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_salon_source
  ON appointments (salon_id, source)
  WHERE source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B. calendar_connections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_connections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id               UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL,
  account_email          TEXT NULL,
  -- Encryption placeholders only (APPLE-A3). Never store plaintext secrets.
  credential_ciphertext  TEXT NULL,
  credential_iv          TEXT NULL,
  credential_auth_tag    TEXT NULL,
  selected_calendar_id   TEXT NULL,
  selected_calendar_url  TEXT NULL,
  selected_calendar_name TEXT NULL,
  provider_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                 TEXT NOT NULL DEFAULT 'disconnected',
  import_enabled         BOOLEAN NOT NULL DEFAULT false,
  last_sync_at           TIMESTAMPTZ NULL,
  last_sync_started_at   TIMESTAMPTZ NULL,
  sync_lock_token        UUID NULL,
  last_error             TEXT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_connections_provider_check
    CHECK (provider IN ('apple', 'google')),
  CONSTRAINT calendar_connections_status_check
    CHECK (status IN ('disconnected', 'connected', 'error', 'disabled')),
  CONSTRAINT calendar_connections_salon_provider_unique
    UNIQUE (salon_id, provider)
);

CREATE INDEX IF NOT EXISTS calendar_connections_salon_id_idx
  ON calendar_connections (salon_id);

CREATE INDEX IF NOT EXISTS calendar_connections_provider_idx
  ON calendar_connections (provider);

CREATE INDEX IF NOT EXISTS calendar_connections_import_status_idx
  ON calendar_connections (import_enabled, status);

COMMENT ON TABLE calendar_connections IS
  'Provider-neutral calendar connection metadata. credential_* columns are unused until APPLE-A3 encryption.';

-- ---------------------------------------------------------------------------
-- C. appointment_external_links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_external_links (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                 UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  appointment_id           UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  calendar_connection_id   UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL,
  external_calendar_id     TEXT NULL,
  external_uid             TEXT NOT NULL,
  recurrence_id            TEXT NOT NULL DEFAULT '',
  external_etag            TEXT NULL,
  external_sequence        INTEGER NULL,
  external_last_modified   TIMESTAMPTZ NULL,
  last_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT appointment_external_links_provider_check
    CHECK (provider IN ('apple', 'google')),
  CONSTRAINT appointment_external_links_uid_recurrence_unique
    UNIQUE (calendar_connection_id, external_uid, recurrence_id),
  CONSTRAINT appointment_external_links_appointment_connection_unique
    UNIQUE (calendar_connection_id, appointment_id)
);

CREATE INDEX IF NOT EXISTS appointment_external_links_salon_id_idx
  ON appointment_external_links (salon_id);

CREATE INDEX IF NOT EXISTS appointment_external_links_appointment_id_idx
  ON appointment_external_links (appointment_id);

CREATE INDEX IF NOT EXISTS appointment_external_links_connection_id_idx
  ON appointment_external_links (calendar_connection_id);

COMMENT ON TABLE appointment_external_links IS
  'Stable linkage between local appointments and external calendar events (dedupe / sync).';

-- ---------------------------------------------------------------------------
-- D. calendar_mapping_rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_mapping_rules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                 UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  calendar_connection_id   UUID NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  keyword                  TEXT NOT NULL,
  normalized_keyword       TEXT NOT NULL,
  staff_id                 UUID NULL REFERENCES staff(id) ON DELETE SET NULL,
  service_id               UUID NULL REFERENCES services(id) ON DELETE SET NULL,
  default_duration_minutes INTEGER NULL,
  active                   BOOLEAN NOT NULL DEFAULT true,
  priority                 INTEGER NOT NULL DEFAULT 100,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_mapping_rules_duration_positive_check
    CHECK (
      default_duration_minutes IS NULL
      OR default_duration_minutes > 0
    )
);

-- NULL connection_id means salon-wide rule; partial uniques avoid NULL-collision.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_mapping_rules_salon_keyword_unique
  ON calendar_mapping_rules (salon_id, normalized_keyword)
  WHERE calendar_connection_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_mapping_rules_connection_keyword_unique
  ON calendar_mapping_rules (calendar_connection_id, normalized_keyword)
  WHERE calendar_connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS calendar_mapping_rules_salon_id_idx
  ON calendar_mapping_rules (salon_id);

CREATE INDEX IF NOT EXISTS calendar_mapping_rules_active_priority_idx
  ON calendar_mapping_rules (salon_id, active, priority);

COMMENT ON TABLE calendar_mapping_rules IS
  'Keyword → staff/service mapping for Apple (and future) calendar import. No hardcoded names in app logic.';

-- ---------------------------------------------------------------------------
-- E. calendar_import_issues
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_import_issues (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id                 UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  calendar_connection_id   UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  external_uid             TEXT NOT NULL,
  recurrence_id            TEXT NOT NULL DEFAULT '',
  external_etag            TEXT NULL,
  raw_event                JSONB NOT NULL DEFAULT '{}'::jsonb,
  parsed_event             JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason_code              TEXT NOT NULL,
  reason_message           TEXT NULL,
  status                   TEXT NOT NULL DEFAULT 'open',
  resolved_appointment_id  UUID NULL REFERENCES appointments(id) ON DELETE SET NULL,
  resolved_at              TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_import_issues_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_import_issues_open_event_unique
  ON calendar_import_issues (calendar_connection_id, external_uid, recurrence_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS calendar_import_issues_salon_id_idx
  ON calendar_import_issues (salon_id);

CREATE INDEX IF NOT EXISTS calendar_import_issues_connection_id_idx
  ON calendar_import_issues (calendar_connection_id);

CREATE INDEX IF NOT EXISTS calendar_import_issues_status_idx
  ON calendar_import_issues (status);

CREATE INDEX IF NOT EXISTS calendar_import_issues_created_at_idx
  ON calendar_import_issues (created_at);

COMMENT ON TABLE calendar_import_issues IS
  'Import-review queue for ambiguous or incomplete external calendar events.';
