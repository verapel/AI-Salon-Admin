-- Staff-2a: link salon_members to an optional staff record for staff_readonly.
-- Simple FK only — does NOT enforce salon_members.salon_id = staff.salon_id.
-- Same-salon validation must be applied in Staff-2b / account provisioning.
-- Does NOT modify existing rows. Does NOT add RLS.

BEGIN;

ALTER TABLE salon_members
  ADD COLUMN staff_id UUID NULL
  REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE salon_members
  ADD CONSTRAINT salon_members_staff_id_role_check
  CHECK (
    (role IN ('owner', 'admin') AND staff_id IS NULL)
    OR
    (role = 'staff_readonly')
  );

CREATE INDEX idx_salon_members_staff_id
  ON salon_members (staff_id)
  WHERE staff_id IS NOT NULL;

COMMIT;
