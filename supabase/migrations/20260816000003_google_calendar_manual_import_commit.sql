-- GOOGLE-CAL-FAST-5B: Atomic manual one-event Google Calendar import commit.
-- Additive RPC only. Does NOT enable import_enabled. Does NOT write to Google.
-- Does NOT send reminders (caller may syncAppointmentReminder after success).
--
-- DO NOT APPLY TO PRODUCTION until reviewed.
--
-- Guarantees:
--   1) Salon-scoped service/staff/client checks
--   2) Digit-normalized phone find-or-create (new client mode)
--   3) Blocked client refusal
--   4) Staff/date advisory lock + duration-aware overlap
--   5) Unique external occurrence via appointment_external_links
--   6) Unique (salon_id, source, source_external_event_id) when set
--   7) All-or-nothing: client + appointment + external link

BEGIN;

CREATE OR REPLACE FUNCTION public.commit_google_calendar_manual_import(
  p_salon_id uuid,
  p_calendar_connection_id uuid,
  p_external_calendar_id text,
  p_external_uid text,
  p_recurrence_id text,
  p_source_external_event_id text,
  p_service_id uuid,
  p_staff_id uuid,
  p_date text,
  p_start_time text,
  p_end_time text,
  p_client_mode text,
  p_client_id uuid,
  p_client_name text,
  p_client_phone text,
  p_notes text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ext_cal text := nullif(btrim(p_external_calendar_id), '');
  v_ext_uid text := nullif(btrim(p_external_uid), '');
  v_recurrence text := coalesce(nullif(btrim(p_recurrence_id), ''), '');
  v_source_ext text := nullif(btrim(p_source_external_event_id), '');
  v_date text := nullif(btrim(p_date), '');
  v_start text := nullif(btrim(p_start_time), '');
  v_end text := nullif(btrim(p_end_time), '');
  v_mode text := lower(nullif(btrim(p_client_mode), ''));
  v_name text := nullif(btrim(p_client_name), '');
  v_phone_raw text := nullif(btrim(p_client_phone), '');
  v_phone_digits text;
  v_phone_store text;
  v_notes text := coalesce(p_notes, '');
  v_conn public.calendar_connections%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_staff public.staff%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_client_id uuid;
  v_client_created boolean := false;
  v_phone_count integer := 0;
  v_phone_client uuid;
  v_existing_link public.appointment_external_links%ROWTYPE;
  v_appointment_id uuid;
  v_existing_appt_id uuid;
  v_start_min integer;
  v_end_min integer;
  v_hh integer;
  v_mm integer;
  v_eh integer;
  v_em integer;
  v_overlap boolean := false;
  v_lock_k1 integer;
  v_lock_k2 integer;
  v_phone_lock_k1 integer;
  v_phone_lock_k2 integer;
  v_start_time time;
  v_end_time time;
BEGIN
  IF p_salon_id IS NULL
     OR p_calendar_connection_id IS NULL
     OR v_ext_cal IS NULL
     OR v_ext_uid IS NULL
     OR p_service_id IS NULL
     OR p_staff_id IS NULL
     OR v_date IS NULL
     OR v_start IS NULL
     OR v_end IS NULL
     OR v_mode IS NULL
     OR v_source_ext IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'google_import_failed');
  END IF;

  IF v_mode NOT IN ('existing', 'new') THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'client_review_required');
  END IF;

  IF v_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'google_event_not_importable');
  END IF;

  IF v_start !~ '^\d{2}:\d{2}$' OR v_end !~ '^\d{2}:\d{2}$' THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'google_event_not_importable');
  END IF;

  -- Connection must belong to salon + google + selected calendar match.
  SELECT *
  INTO v_conn
  FROM public.calendar_connections c
  WHERE c.id = p_calendar_connection_id
    AND c.salon_id = p_salon_id
    AND c.provider = 'google'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'google_not_connected');
  END IF;

  IF coalesce(nullif(btrim(v_conn.selected_calendar_id), ''), '') <> v_ext_cal THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'google_calendar_not_selected');
  END IF;

  -- Idempotent: existing external occurrence link.
  SELECT *
  INTO v_existing_link
  FROM public.appointment_external_links l
  WHERE l.calendar_connection_id = p_calendar_connection_id
    AND l.external_uid = v_ext_uid
    AND l.recurrence_id = v_recurrence
    AND l.salon_id = p_salon_id
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'kind', 'already_imported',
      'code', 'google_event_already_imported',
      'appointmentId', v_existing_link.appointment_id,
      'clientId', NULL,
      'clientCreated', false
    );
  END IF;

  -- Also honor appointments unique external key if present.
  SELECT a.id
  INTO v_existing_appt_id
  FROM public.appointments a
  WHERE a.salon_id = p_salon_id
    AND a.source = 'google'
    AND a.source_external_event_id = v_source_ext
  LIMIT 1;

  IF v_existing_appt_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'kind', 'already_imported',
      'code', 'google_event_already_imported',
      'appointmentId', v_existing_appt_id,
      'clientId', NULL,
      'clientCreated', false
    );
  END IF;

  -- Service: salon + active.
  SELECT *
  INTO v_service
  FROM public.services s
  WHERE s.id = p_service_id
    AND s.salon_id = p_salon_id
    AND s.active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'service_invalid');
  END IF;

  -- Staff: salon + active.
  SELECT *
  INTO v_staff
  FROM public.staff st
  WHERE st.id = p_staff_id
    AND st.salon_id = p_salon_id
    AND st.active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'staff_invalid');
  END IF;

  -- Parse times (HH:MM). Reject overnight / end <= start for pilot.
  v_hh := split_part(v_start, ':', 1)::integer;
  v_mm := split_part(v_start, ':', 2)::integer;
  v_eh := split_part(v_end, ':', 1)::integer;
  v_em := split_part(v_end, ':', 2)::integer;
  IF v_hh < 0 OR v_hh > 23 OR v_mm < 0 OR v_mm > 59
     OR v_eh < 0 OR v_eh > 23 OR v_em < 0 OR v_em > 59 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'google_event_not_importable');
  END IF;
  v_start_min := v_hh * 60 + v_mm;
  v_end_min := v_eh * 60 + v_em;
  IF v_end_min <= v_start_min THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'google_event_not_importable');
  END IF;
  v_start_time := (v_start || ':00')::time;
  v_end_time := (v_end || ':00')::time;

  -- Client resolution.
  IF v_mode = 'existing' THEN
    IF p_client_id IS NULL THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'client_review_required');
    END IF;
    SELECT *
    INTO v_client
    FROM public.clients c
    WHERE c.id = p_client_id
      AND c.salon_id = p_salon_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'client_review_required');
    END IF;
    IF coalesce(v_client.is_blocked, false) THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'client_blocked');
    END IF;
    v_client_id := v_client.id;
  ELSE
    -- new client mode: require name + phone digits
    IF v_name IS NULL OR v_phone_raw IS NULL THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'client_review_required');
    END IF;
    v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
    IF length(v_phone_digits) < 8 OR length(v_phone_digits) > 15 THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'client_review_required');
    END IF;
    v_phone_store := '+' || v_phone_digits;

    v_phone_lock_k1 := hashtext('google-client|' || p_salon_id::text);
    v_phone_lock_k2 := hashtext(v_phone_digits);
    PERFORM pg_advisory_xact_lock(v_phone_lock_k1, v_phone_lock_k2);

    SELECT COUNT(*)::integer, (array_agg(c.id ORDER BY c.id::text))[1]
    INTO v_phone_count, v_phone_client
    FROM public.clients c
    WHERE c.salon_id = p_salon_id
      AND regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g') = v_phone_digits;

    IF v_phone_count > 1 THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'client_ambiguous');
    END IF;

    IF v_phone_count = 1 THEN
      SELECT *
      INTO v_client
      FROM public.clients c
      WHERE c.id = v_phone_client
        AND c.salon_id = p_salon_id
      FOR UPDATE;
      IF coalesce(v_client.is_blocked, false) THEN
        RETURN jsonb_build_object('kind', 'error', 'code', 'client_blocked');
      END IF;
      v_client_id := v_client.id;
      v_client_created := false;
    ELSE
      INSERT INTO public.clients (
        salon_id,
        name,
        phone,
        email
      ) VALUES (
        p_salon_id,
        v_name,
        v_phone_store,
        ''
      )
      RETURNING id INTO v_client_id;
      v_client_created := true;
    END IF;
  END IF;

  -- Staff/date booking lock + overlap (Google duration via start/end minutes).
  v_lock_k1 := hashtext(p_salon_id::text || '|' || p_staff_id::text);
  v_lock_k2 := hashtext(v_date);
  PERFORM pg_advisory_xact_lock(v_lock_k1, v_lock_k2);

  SELECT EXISTS (
    SELECT 1
    FROM public.appointments a
    WHERE a.salon_id = p_salon_id
      AND a.staff_id = p_staff_id
      AND a.date = v_date::date
      AND a.status IN ('scheduled', 'confirmed')
      AND (v_start_min < (EXTRACT(HOUR FROM a.end_time)::integer * 60
                          + EXTRACT(MINUTE FROM a.end_time)::integer))
      AND (v_end_min > (EXTRACT(HOUR FROM a.start_time)::integer * 60
                        + EXTRACT(MINUTE FROM a.start_time)::integer))
  ) INTO v_overlap;

  IF v_overlap THEN
    IF v_client_created THEN
      DELETE FROM public.clients WHERE id = v_client_id AND salon_id = p_salon_id;
    END IF;
    RETURN jsonb_build_object('kind', 'error', 'code', 'appointment_conflict');
  END IF;

  BEGIN
    INSERT INTO public.appointments (
      salon_id,
      client_id,
      staff_id,
      service_id,
      date,
      start_time,
      end_time,
      status,
      notes,
      reminder_sent,
      source,
      source_external_event_id
    ) VALUES (
      p_salon_id,
      v_client_id,
      p_staff_id,
      p_service_id,
      v_date::date,
      v_start_time,
      v_end_time,
      'scheduled',
      v_notes,
      false,
      'google',
      v_source_ext
    )
    RETURNING id INTO v_appointment_id;
  EXCEPTION
    WHEN unique_violation THEN
      IF v_client_created THEN
        DELETE FROM public.clients WHERE id = v_client_id AND salon_id = p_salon_id;
      END IF;
      SELECT a.id
      INTO v_existing_appt_id
      FROM public.appointments a
      WHERE a.salon_id = p_salon_id
        AND a.source = 'google'
        AND a.source_external_event_id = v_source_ext
      LIMIT 1;
      RETURN jsonb_build_object(
        'kind', 'already_imported',
        'code', 'google_event_already_imported',
        'appointmentId', v_existing_appt_id,
        'clientId', v_client_id,
        'clientCreated', false
      );
  END;

  BEGIN
    INSERT INTO public.appointment_external_links (
      salon_id,
      appointment_id,
      calendar_connection_id,
      provider,
      external_calendar_id,
      external_uid,
      recurrence_id
    ) VALUES (
      p_salon_id,
      v_appointment_id,
      p_calendar_connection_id,
      'google',
      v_ext_cal,
      v_ext_uid,
      v_recurrence
    );
  EXCEPTION
    WHEN unique_violation THEN
      -- Another writer won the race: roll back appointment (+ orphan client).
      DELETE FROM public.appointments
      WHERE id = v_appointment_id AND salon_id = p_salon_id;
      IF v_client_created THEN
        DELETE FROM public.clients WHERE id = v_client_id AND salon_id = p_salon_id;
      END IF;
      SELECT l.appointment_id
      INTO v_existing_appt_id
      FROM public.appointment_external_links l
      WHERE l.calendar_connection_id = p_calendar_connection_id
        AND l.external_uid = v_ext_uid
        AND l.recurrence_id = v_recurrence
        AND l.salon_id = p_salon_id
      LIMIT 1;
      RETURN jsonb_build_object(
        'kind', 'already_imported',
        'code', 'google_event_already_imported',
        'appointmentId', v_existing_appt_id,
        'clientId', NULL,
        'clientCreated', false
      );
  END;

  RETURN jsonb_build_object(
    'kind', 'ok',
    'appointmentId', v_appointment_id,
    'clientId', v_client_id,
    'clientCreated', v_client_created,
    'alreadyImported', false
  );
END;
$$;

COMMENT ON FUNCTION public.commit_google_calendar_manual_import IS
  'GOOGLE-CAL-FAST-5B: Atomic manual one-event Google import (client optional create + appointment + external link). No Google writes. No reminders.';

REVOKE ALL ON FUNCTION public.commit_google_calendar_manual_import(
  uuid, uuid, text, text, text, text, uuid, uuid, text, text, text, text, uuid, text, text, text
) FROM PUBLIC;

-- Backend uses service role / authenticated server client. Keep INVOKER; grant to service_role if present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.commit_google_calendar_manual_import(
      uuid, uuid, text, text, text, text, uuid, uuid, text, text, text, text, uuid, text, text, text
    ) TO service_role;
  END IF;
END $$;

COMMIT;
