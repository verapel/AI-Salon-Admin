-- Stage J1a: staff <-> service assignments (many-to-many)
-- No automatic backfill: specialty/service-name matching is locale-fragile
-- and could create wrong assignments for Tatev / multi-language catalogs.

CREATE TABLE staff_services (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id   UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  staff_id   UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_id, service_id)
);

CREATE INDEX staff_services_salon_id_idx ON staff_services (salon_id);
CREATE INDEX staff_services_staff_id_idx ON staff_services (staff_id);
CREATE INDEX staff_services_service_id_idx ON staff_services (service_id);
