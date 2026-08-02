-- SALON-CLEANUP-2: deletion_protected flag + atomic hard_delete_salon RPC.
-- Server/service-role only. Do not expose to anon/authenticated clients.
--
-- RESTRICT children of salons.id (must delete before salon row):
--   reminders, appointments, clients, staff, services, salon_members
--
-- Child FK order among those tables:
--   appointments.client_id / staff_id / service_id → RESTRICT
--   reminders.appointment_id → CASCADE (still deleted explicitly first)
--
-- Explicit RESTRICT delete order:
--   1) reminders
--   2) appointments
--   3) salon_members
--   4) clients
--   5) staff
--   6) services
--   7) salons (last)
--
-- Remaining CASCADE-from-salon tables (cleared by deleting salons row):
--   salon_integrations, staff_services, salon_weekly_hours, staff_weekly_hours,
--   schedule_exceptions, birthday_owner_notifications, calendar_connections,
--   appointment_external_links, calendar_mapping_rules, calendar_import_issues,
--   whatsapp_business_connections, client_channel_identities,
--   channel_event_receipts, channel_conversations
--
-- Does NOT delete auth.users (orphaned memberships deferred).

BEGIN;

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS deletion_protected boolean NOT NULL DEFAULT false;

UPDATE public.salons
SET deletion_protected = true
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';

CREATE OR REPLACE FUNCTION public.hard_delete_salon(p_salon_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_salon_id uuid;
  v_slug text;
  v_deletion_protected boolean;
  v_clients integer := 0;
  v_staff integer := 0;
  v_services integer := 0;
  v_appointments integer := 0;
  v_reminders integer := 0;
  v_salon_members integer := 0;
  v_deleted_salon integer := 0;
BEGIN
  IF p_salon_id IS NULL THEN
    RAISE EXCEPTION 'SALON_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  -- A. Lock salon row first.
  SELECT s.id, s.slug, s.deletion_protected
  INTO v_salon_id, v_slug, v_deletion_protected
  FROM public.salons s
  WHERE s.id = p_salon_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALON_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  -- B. Protection check BEFORE any deletion.
  IF COALESCE(v_deletion_protected, false) IS TRUE
     OR v_salon_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid
     OR v_slug = 'default'
  THEN
    RAISE EXCEPTION 'SALON_PROTECTED'
      USING ERRCODE = 'check_violation';
  END IF;

  -- C. Counts for summary (before deletes).
  SELECT COUNT(*)::integer INTO v_clients
  FROM public.clients c WHERE c.salon_id = v_salon_id;

  SELECT COUNT(*)::integer INTO v_staff
  FROM public.staff st WHERE st.salon_id = v_salon_id;

  SELECT COUNT(*)::integer INTO v_services
  FROM public.services sv WHERE sv.salon_id = v_salon_id;

  SELECT COUNT(*)::integer INTO v_appointments
  FROM public.appointments a WHERE a.salon_id = v_salon_id;

  SELECT COUNT(*)::integer INTO v_reminders
  FROM public.reminders r WHERE r.salon_id = v_salon_id;

  SELECT COUNT(*)::integer INTO v_salon_members
  FROM public.salon_members m WHERE m.salon_id = v_salon_id;

  -- D. Delete RESTRICT dependencies in FK-safe order.
  DELETE FROM public.reminders r
  WHERE r.salon_id = v_salon_id;

  DELETE FROM public.appointments a
  WHERE a.salon_id = v_salon_id;

  DELETE FROM public.salon_members m
  WHERE m.salon_id = v_salon_id;

  DELETE FROM public.clients c
  WHERE c.salon_id = v_salon_id;

  DELETE FROM public.staff st
  WHERE st.salon_id = v_salon_id;

  DELETE FROM public.services sv
  WHERE sv.salon_id = v_salon_id;

  -- E. Delete salon last (CASCADE cleans remaining salon-scoped tables).
  DELETE FROM public.salons s
  WHERE s.id = v_salon_id;
  GET DIAGNOSTICS v_deleted_salon = ROW_COUNT;

  IF v_deleted_salon <> 1 THEN
    RAISE EXCEPTION 'SALON_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  -- F. Summary (pre-delete counts).
  RETURN jsonb_build_object(
    'salonId', v_salon_id,
    'deleted', true,
    'counts', jsonb_build_object(
      'clients', v_clients,
      'staff', v_staff,
      'services', v_services,
      'appointments', v_appointments,
      'reminders', v_reminders,
      'salonMembers', v_salon_members
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hard_delete_salon(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hard_delete_salon(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.hard_delete_salon(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.hard_delete_salon(uuid) TO service_role;

COMMIT;
