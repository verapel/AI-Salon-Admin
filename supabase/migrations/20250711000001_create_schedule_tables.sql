-- Stage J2a: salon/staff weekly hours + schedule exceptions
-- No seed rows: code falls back to 08:00–18:00 when unconfigured.
-- No RLS (service role / API layer enforces salon_id).

CREATE TABLE salon_weekly_hours (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  weekday     INT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  is_closed   BOOLEAN NOT NULL DEFAULT false,
  open_time   TIME NULL,
  close_time  TIME NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salon_id, weekday)
);

CREATE TABLE staff_weekly_hours (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  staff_id    UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday     INT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  is_closed   BOOLEAN NOT NULL DEFAULT false,
  open_time   TIME NULL,
  close_time  TIME NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_id, weekday)
);

CREATE TABLE schedule_exceptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('salon', 'staff')),
  staff_id    UUID NULL REFERENCES staff(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('closed', 'vacation', 'holiday', 'custom_hours')),
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  open_time   TIME NULL,
  close_time  TIME NULL,
  note        TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date),
  CHECK (
    (scope = 'salon' AND staff_id IS NULL)
    OR
    (scope = 'staff' AND staff_id IS NOT NULL)
  )
);

CREATE INDEX salon_weekly_hours_salon_id_idx ON salon_weekly_hours (salon_id);
CREATE INDEX staff_weekly_hours_salon_id_idx ON staff_weekly_hours (salon_id);
CREATE INDEX staff_weekly_hours_staff_id_idx ON staff_weekly_hours (staff_id);
CREATE INDEX schedule_exceptions_salon_id_date_idx ON schedule_exceptions (salon_id, start_date, end_date);
CREATE INDEX schedule_exceptions_staff_id_date_idx ON schedule_exceptions (staff_id, start_date, end_date);
