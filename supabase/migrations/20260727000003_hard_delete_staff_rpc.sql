-- STAFF-CLEANUP-1 / 1A: atomic hard-delete for staff (+ optional appointments)
-- and primary-staff protection column.
-- Server/service-role only. Do not expose to anon/authenticated clients.
-- Relies on:
--   appointments.staff_id ON DELETE RESTRICT (must delete appointments first)
--   reminders.appointment_id ON DELETE CASCADE
--   staff_services / staff_weekly_hours / schedule_exceptions ON DELETE CASCADE
--   salon_members.staff_id / calendar_mapping_rules.staff_id ON DELETE SET NULL
--
-- is_primary defaults FALSE for all existing rows. Do NOT seed a primary master
-- by name or production UUID in this migration; assign manually after review.

BEGIN;

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS staff_one_primary_per_salon_unique
  ON public.staff (salon_id)
  WHERE is_primary = TRUE;

CREATE OR REPLACE FUNCTION public.hard_delete_staff_with_appointments(
  p_salon_id uuid,
  p_staff_id uuid,
  p_delete_appointments boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_is_primary boolean;
  v_total_appointments integer := 0;
  v_active_appointments integer := 0;
  v_deleted_appointments integer := 0;
  v_affected_memberships integer := 0;
  v_affected_mapping_rules integer := 0;
  v_deleted_staff integer := 0;
BEGIN
  IF p_salon_id IS NULL OR p_staff_id IS NULL THEN
    RAISE EXCEPTION 'STAFF_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  -- Lock and load staff row scoped to salon.
  SELECT s.is_primary
  INTO v_is_primary
  FROM public.staff s
  WHERE s.id = p_staff_id
    AND s.salon_id = p_salon_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'STAFF_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_is_primary, false) IS TRUE THEN
    RAISE EXCEPTION 'PRIMARY_STAFF_CANNOT_DELETE'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_total_appointments
  FROM public.appointments a
  WHERE a.salon_id = p_salon_id
    AND a.staff_id = p_staff_id;

  SELECT COUNT(*)::integer
  INTO v_active_appointments
  FROM public.appointments a
  WHERE a.salon_id = p_salon_id
    AND a.staff_id = p_staff_id
    AND a.status IN ('scheduled', 'confirmed');

  IF v_total_appointments > 0 AND COALESCE(p_delete_appointments, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'STAFF_HAS_APPOINTMENTS'
      USING ERRCODE = 'check_violation',
            DETAIL = format(
              'totalAppointments=%s;activeAppointments=%s',
              v_total_appointments,
              v_active_appointments
            );
  END IF;

  SELECT COUNT(*)::integer
  INTO v_affected_memberships
  FROM public.salon_members m
  WHERE m.staff_id = p_staff_id
    AND m.salon_id = p_salon_id;

  SELECT COUNT(*)::integer
  INTO v_affected_mapping_rules
  FROM public.calendar_mapping_rules r
  WHERE r.staff_id = p_staff_id
    AND r.salon_id = p_salon_id;

  IF v_total_appointments > 0 THEN
    DELETE FROM public.appointments a
    WHERE a.salon_id = p_salon_id
      AND a.staff_id = p_staff_id;
    GET DIAGNOSTICS v_deleted_appointments = ROW_COUNT;
  END IF;

  DELETE FROM public.staff s
  WHERE s.id = p_staff_id
    AND s.salon_id = p_salon_id;
  GET DIAGNOSTICS v_deleted_staff = ROW_COUNT;

  IF v_deleted_staff <> 1 THEN
    RAISE EXCEPTION 'STAFF_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'deletedStaffId', p_staff_id,
    'deletedAppointments', v_deleted_appointments,
    'affectedMemberships', v_affected_memberships,
    'affectedMappingRules', v_affected_mapping_rules
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hard_delete_staff_with_appointments(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hard_delete_staff_with_appointments(uuid, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.hard_delete_staff_with_appointments(uuid, uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.hard_delete_staff_with_appointments(uuid, uuid, boolean) TO service_role;

COMMIT;
