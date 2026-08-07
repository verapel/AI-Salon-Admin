-- IG-6 / IG-6A / IG-6B: Idempotent Instagram booking commit + client/identity link.
-- Additive only. SERVICE ROLE / backend only.
-- Mirrors WA-4D/WA-4E1 commit_whatsapp_booking_owned with provider='instagram'.
-- Does NOT send Meta messages, create Telegram reminders, or notify admin.
--
-- Guarantees:
--   1) Receipt ownership (instagram_lock_owned_receipt) before business mutations
--   2) Conversation CAS: booking + ready_to_book + sourceMessageId
--   3) Ready state read from conversation with JSON string-typed fields
--   4) Appointment unique (salon_id, source='instagram', source_external_event_id)
--   5) Schedule namespace locks + staff/date lock + schedule revalidation + overlap
--   6) Salon+phone advisory lock before client SELECT/create
--   7) Client + identity link + appointment + conversation completion atomic
--   8) Identity client_id: NULL→set only; never flip/clear
--   9) Blocked clients refuse before appointment insert
--  10) IG-6B: schedule mutation RPCs share the same advisory lock contract
--
-- IG-6A schedule parity with computeAvailableSlots (TS):
--   staff weekly hours inherit salon when staff unconfigured;
--   exceptions closed/vacation/holiday close scope; custom_hours replace;
--   duration must fit working window (start >= open AND end <= close);
--   legacy 08:00–18:00 when both weekly tables empty and no exceptions.
--
-- IG-6B shared advisory lock contract (transaction-scoped, canonical order):
--   1) salon schedule namespace:
--        hashtext('ig6b-salon-sched|' || salon_id), 917001
--      covers: salon_weekly_hours upsert, salon-scope exceptions
--   2) staff schedule namespace:
--        hashtext('ig6b-staff-sched|' || salon_id || '|' || staff_id), 917002
--      covers: staff_weekly_hours upsert, staff-scope exceptions
--   3) staff/date (appointment overlap, unchanged):
--        hashtext(salon_id || '|' || staff_id), hashtext(date)
--   Commit acquires 1 → 2 → 3 before schedule reads.
--   Writers acquire matching namespace lock(s) in the SAME RPC as the DML.

BEGIN;

-- ---------------------------------------------------------------------------
-- IG-6B: shared schedule advisory lock helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ig6b_lock_salon_schedule(p_salon_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_salon_id IS NULL THEN
    RAISE EXCEPTION 'IG6B_LOCK_SALON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext('ig6b-salon-sched|' || p_salon_id::text),
    917001
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ig6b_lock_staff_schedule(
  p_salon_id uuid,
  p_staff_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_salon_id IS NULL OR p_staff_id IS NULL THEN
    RAISE EXCEPTION 'IG6B_LOCK_STAFF_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext('ig6b-staff-sched|' || p_salon_id::text || '|' || p_staff_id::text),
    917002
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ig6b_lock_staff_date(
  p_salon_id uuid,
  p_staff_id uuid,
  p_date text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_salon_id IS NULL OR p_staff_id IS NULL OR nullif(btrim(p_date), '') IS NULL THEN
    RAISE EXCEPTION 'IG6B_LOCK_STAFF_DATE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext(p_salon_id::text || '|' || p_staff_id::text),
    hashtext(btrim(p_date))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ig6b_lock_salon_schedule(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ig6b_lock_staff_schedule(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ig6b_lock_staff_date(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ig6b_lock_salon_schedule(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ig6b_lock_staff_schedule(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ig6b_lock_staff_date(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- A. appointments.source: allow 'instagram' (preserve existing values)
-- ---------------------------------------------------------------------------
ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_source_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_source_check
  CHECK (
    source IS NULL
    OR source IN ('telegram', 'owner', 'apple', 'whatsapp', 'instagram')
  );

COMMENT ON CONSTRAINT appointments_source_check ON public.appointments IS
  'Appointment origin channels: telegram, owner, apple, whatsapp, instagram (IG-6).';

-- Instagram rows must carry a durable external event id (idempotency).
ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_instagram_source_event_id_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_instagram_source_event_id_check
  CHECK (
    source IS DISTINCT FROM 'instagram'
    OR source_external_event_id IS NOT NULL
  );

COMMENT ON CONSTRAINT appointments_instagram_source_event_id_check ON public.appointments IS
  'IG-6A: source=instagram requires non-null source_external_event_id.';

-- Idempotency index already exists from WA-4D (salon_id, source, source_external_event_id).
CREATE UNIQUE INDEX IF NOT EXISTS appointments_salon_source_external_event_uidx
  ON public.appointments (salon_id, source, source_external_event_id)
  WHERE source IS NOT NULL
    AND source_external_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B. commit_instagram_booking_owned
-- Loads booking fields from locked conversation.state (not trusted app payload).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commit_instagram_booking_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_external_user_id text,
  p_expected_source_message_id text,
  p_external_event_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_own text;
  v_now timestamptz := clock_timestamp();
  v_ext text := nullif(btrim(p_external_user_id), '');
  v_msg text := nullif(btrim(p_expected_source_message_id), '');
  v_event_in text := nullif(btrim(p_external_event_id), '');
  v_event text;
  v_state jsonb;
  v_service_id_txt text;
  v_staff_id_txt text;
  v_date text;
  v_time text;
  v_name text;
  v_phone_raw text;
  v_phone_digits text;
  v_phone_store text;
  v_service_id uuid;
  v_staff_id uuid;
  v_conv public.channel_conversations%ROWTYPE;
  v_receipt public.channel_event_receipts%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_staff public.staff%ROWTYPE;
  v_duration integer;
  v_start_min integer;
  v_end_min integer;
  v_start_time text;
  v_end_time text;
  v_hh integer;
  v_mm integer;
  v_client_id uuid;
  v_conv_client uuid;
  v_ident public.client_channel_identities%ROWTYPE;
  v_phone_client uuid;
  v_phone_count integer;
  v_appt public.appointments%ROWTYPE;
  v_existing public.appointments%ROWTYPE;
  v_assign_count integer;
  v_staff_ok boolean;
  v_spec text;
  v_service_l text;
  v_phone_lock_k1 integer;
  v_phone_lock_k2 integer;
  v_overlap boolean;
  v_notes text;
  v_created_client boolean := false;
  v_created_identity boolean := false;
  v_has_identity boolean := false;
  v_client_blocked boolean;
  -- Schedule (computeAvailableSlots parity)
  v_weekday integer;
  v_salon_cnt integer;
  v_staff_cnt integer;
  v_ex_cnt integer;
  v_legacy boolean;
  v_salon_open integer;
  v_salon_close integer;
  v_staff_open integer;
  v_staff_close integer;
  v_work_open integer;
  v_work_close integer;
  v_has_close_kind boolean;
  v_custom_open time;
  v_custom_close time;
  v_tz text;
  v_today date;
  v_now_min integer;
  v_existing_start_txt text;
BEGIN
  IF v_ext IS NULL OR v_msg IS NULL OR v_event_in IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_booking_input');
  END IF;

  -- Receipt ownership FIRST (hardcoded Instagram).
  v_own := public.instagram_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  SELECT r.*
  INTO v_receipt
  FROM public.channel_event_receipts r
  WHERE r.id = p_receipt_id
    AND r.salon_id = p_salon_id
    AND r.provider = 'instagram';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  v_event := nullif(btrim(v_receipt.external_event_id), '');
  IF v_event IS NULL OR v_event IS DISTINCT FROM v_event_in THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'external_event_mismatch');
  END IF;

  -- Conversation lock.
  SELECT c.*
  INTO v_conv
  FROM public.channel_conversations c
  WHERE c.salon_id = p_salon_id
    AND c.provider = 'instagram'
    AND c.external_user_id = v_ext
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'conversation_missing');
  END IF;

  -- Idempotency: existing appointment for this Meta event.
  SELECT a.*
  INTO v_existing
  FROM public.appointments a
  WHERE a.salon_id = p_salon_id
    AND a.source = 'instagram'
    AND a.source_external_event_id = v_event
  LIMIT 1;

  IF FOUND THEN
    -- Harden: when still ready, existing must match intended booking context.
    IF v_conv.current_flow = 'booking'
       AND v_conv.current_step = 'ready_to_book' THEN
      v_state := COALESCE(v_conv.state, '{}'::jsonb);
      v_existing_start_txt := to_char(v_existing.start_time, 'HH24:MI');
      IF lower(v_existing.service_id::text)
           IS DISTINCT FROM lower(nullif(btrim(COALESCE(v_state->>'serviceId', '')), ''))
         OR lower(v_existing.staff_id::text)
           IS DISTINCT FROM lower(nullif(btrim(COALESCE(v_state->>'staffId', '')), ''))
         OR v_existing.date::text
           IS DISTINCT FROM nullif(btrim(COALESCE(v_state->>'date', '')), '')
         OR v_existing_start_txt
           IS DISTINCT FROM nullif(btrim(COALESCE(v_state->>'time', '')), '')
         OR (
           v_conv.client_id IS NOT NULL
           AND v_conv.client_id IS DISTINCT FROM v_existing.client_id
         ) THEN
        RETURN jsonb_build_object('kind', 'error', 'code', 'idempotency_conflict');
      END IF;
    ELSIF v_conv.client_id IS NOT NULL
          AND v_conv.client_id IS DISTINCT FROM v_existing.client_id THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'idempotency_conflict');
    END IF;

    IF v_conv.client_id IS NULL OR v_conv.client_id = v_existing.client_id THEN
      UPDATE public.channel_conversations c
      SET
        client_id = COALESCE(c.client_id, v_existing.client_id),
        current_flow = NULL,
        current_step = NULL,
        state = jsonb_build_object(
          'appointmentId', v_existing.id::text,
          'sourceMessageId', v_msg
        ),
        last_interaction_at = v_now,
        updated_at = v_now
      WHERE c.id = v_conv.id;
    END IF;

    RETURN jsonb_build_object(
      'kind', 'already_booked',
      'appointment_id', v_existing.id,
      'client_id', v_existing.client_id
    );
  END IF;

  -- Conversation already completed for this source message with appointmentId.
  IF (v_conv.state->>'appointmentId') IS NOT NULL
     AND nullif(btrim(v_conv.state->>'sourceMessageId'), '') IS NOT DISTINCT FROM v_msg THEN
    BEGIN
      SELECT a.*
      INTO v_existing
      FROM public.appointments a
      WHERE a.id = (v_conv.state->>'appointmentId')::uuid
        AND a.salon_id = p_salon_id;
    EXCEPTION WHEN invalid_text_representation THEN
      v_existing := NULL;
    END;
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'kind', 'already_booked',
        'appointment_id', v_existing.id,
        'client_id', v_existing.client_id
      );
    END IF;
  END IF;

  IF v_conv.current_flow IS DISTINCT FROM 'booking'
     OR v_conv.current_step IS DISTINCT FROM 'ready_to_book' THEN
    RETURN jsonb_build_object(
      'kind', 'stale_state',
      'current_flow', v_conv.current_flow,
      'current_step', v_conv.current_step
    );
  END IF;

  v_state := COALESCE(v_conv.state, '{}'::jsonb);

  IF nullif(btrim(COALESCE(v_state->>'sourceMessageId', '')), '') IS DISTINCT FROM v_msg THEN
    RETURN jsonb_build_object('kind', 'stale_state', 'code', 'source_message_mismatch');
  END IF;

  -- Ready contract: JSON string + trimmed non-empty (parity with isCompleteInstagramReadyState).
  IF jsonb_typeof(v_state->'serviceId') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'serviceId') = ''
     OR jsonb_typeof(v_state->'serviceName') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'serviceName') = ''
     OR jsonb_typeof(v_state->'staffId') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'staffId') = ''
     OR jsonb_typeof(v_state->'staffName') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'staffName') = ''
     OR jsonb_typeof(v_state->'date') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'date') = ''
     OR jsonb_typeof(v_state->'time') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'time') = ''
     OR jsonb_typeof(v_state->'name') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'name') = ''
     OR jsonb_typeof(v_state->'phone') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'phone') = ''
     OR jsonb_typeof(v_state->'sourceMessageId') IS DISTINCT FROM 'string'
     OR btrim(v_state->>'sourceMessageId') = '' THEN
    RETURN jsonb_build_object('kind', 'stale_state', 'code', 'ready_to_book_incomplete');
  END IF;

  v_service_id_txt := btrim(v_state->>'serviceId');
  v_staff_id_txt := btrim(v_state->>'staffId');
  v_date := btrim(v_state->>'date');
  v_time := btrim(v_state->>'time');
  v_name := btrim(v_state->>'name');
  v_phone_raw := btrim(v_state->>'phone');

  IF length(v_name) < 2 OR length(v_name) > 80 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_name');
  END IF;

  v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
  IF v_phone_digits IS NULL OR length(v_phone_digits) < 8 OR length(v_phone_digits) > 15 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_phone');
  END IF;
  v_phone_store := '+' || v_phone_digits;

  IF v_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_date');
  END IF;

  IF v_time !~ '^\d{2}:\d{2}$' THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_time');
  END IF;

  v_hh := split_part(v_time, ':', 1)::integer;
  v_mm := split_part(v_time, ':', 2)::integer;
  IF v_hh < 0 OR v_hh > 23 OR v_mm < 0 OR v_mm > 59 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_time');
  END IF;

  BEGIN
    v_service_id := v_service_id_txt::uuid;
    v_staff_id := v_staff_id_txt::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('kind', 'stale_state', 'code', 'invalid_ids');
  END;

  -- Service revalidation (current duration is source of truth).
  SELECT s.*
  INTO v_service
  FROM public.services s
  WHERE s.id = v_service_id
    AND s.salon_id = p_salon_id
    AND s.active = true
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'service_unavailable');
  END IF;

  v_duration := COALESCE(NULLIF(v_service.duration, 0), 60);
  IF v_duration IS NULL OR v_duration <= 0 THEN
    RETURN jsonb_build_object('kind', 'service_unavailable');
  END IF;

  SELECT st.*
  INTO v_staff
  FROM public.staff st
  WHERE st.id = v_staff_id
    AND st.salon_id = p_salon_id
    AND st.active = true
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'staff_unavailable');
  END IF;

  SELECT COUNT(*)::integer
  INTO v_assign_count
  FROM public.staff_services ss
  WHERE ss.salon_id = p_salon_id
    AND ss.service_id = v_service_id;

  IF v_assign_count > 0 THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.staff_services ss
      WHERE ss.salon_id = p_salon_id
        AND ss.service_id = v_service_id
        AND ss.staff_id = v_staff_id
    ) INTO v_staff_ok;
  ELSE
    v_service_l := lower(btrim(v_service.name));
    v_staff_ok := false;
    IF v_staff.specialties IS NOT NULL THEN
      FOREACH v_spec IN ARRAY v_staff.specialties
      LOOP
        v_spec := lower(btrim(v_spec));
        IF v_spec <> '' AND (strpos(v_service_l, v_spec) > 0 OR strpos(v_spec, v_service_l) > 0) THEN
          v_staff_ok := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_staff_ok THEN
    RETURN jsonb_build_object('kind', 'staff_unavailable');
  END IF;

  v_start_min := v_hh * 60 + v_mm;
  v_end_min := v_start_min + v_duration;
  IF v_end_min > 24 * 60 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_end_time');
  END IF;
  v_start_time := v_time || ':00';
  v_end_time := lpad((v_end_min / 60)::text, 2, '0') || ':' ||
                lpad((v_end_min % 60)::text, 2, '0') || ':00';

  -- IG-6B canonical schedule lock order (must match mutation RPCs):
  --   1) salon schedule namespace
  --   2) staff schedule namespace
  --   3) staff/date (appointment overlap)
  PERFORM public.ig6b_lock_salon_schedule(p_salon_id);
  PERFORM public.ig6b_lock_staff_schedule(p_salon_id, v_staff_id);
  PERFORM public.ig6b_lock_staff_date(p_salon_id, v_staff_id, v_date);

  -- -----------------------------------------------------------------
  -- IG-6A/B: current schedule / exceptions after shared advisory locks.
  -- Namespace locks serialize INSERT of new weekly/exception rows.
  -- FOR SHARE still serializes UPDATE/DELETE of existing rows.
  -- -----------------------------------------------------------------
  PERFORM 1
  FROM public.salon_weekly_hours swh
  WHERE swh.salon_id = p_salon_id
  FOR SHARE;

  PERFORM 1
  FROM public.staff_weekly_hours stwh
  WHERE stwh.salon_id = p_salon_id
    AND stwh.staff_id = v_staff_id
  FOR SHARE;

  PERFORM 1
  FROM public.schedule_exceptions se
  WHERE se.salon_id = p_salon_id
    AND se.start_date <= v_date::date
    AND se.end_date >= v_date::date
  FOR SHARE;

  v_weekday := EXTRACT(ISODOW FROM v_date::date)::integer;

  SELECT COUNT(*)::integer
  INTO v_salon_cnt
  FROM public.salon_weekly_hours
  WHERE salon_id = p_salon_id;

  SELECT COUNT(*)::integer
  INTO v_staff_cnt
  FROM public.staff_weekly_hours
  WHERE salon_id = p_salon_id
    AND staff_id = v_staff_id;

  SELECT COUNT(*)::integer
  INTO v_ex_cnt
  FROM public.schedule_exceptions
  WHERE salon_id = p_salon_id
    AND start_date <= v_date::date
    AND end_date >= v_date::date;

  v_legacy := (v_salon_cnt = 0 AND v_staff_cnt = 0 AND v_ex_cnt = 0);

  IF v_legacy THEN
    -- FALLBACK_SLOT_STARTS 08:00–18:00 hourly; duration>60 uses soft 19:00 limit.
    IF (v_start_min % 60) <> 0
       OR v_start_min < (8 * 60)
       OR v_start_min > (18 * 60) THEN
      RETURN jsonb_build_object('kind', 'slot_unavailable');
    END IF;
    IF v_duration > 60 AND v_end_min > (19 * 60) THEN
      RETURN jsonb_build_object('kind', 'slot_unavailable');
    END IF;
  ELSE
    -- Salon weekly base.
    IF v_salon_cnt = 0 THEN
      v_salon_open := 8 * 60;
      v_salon_close := 18 * 60;
    ELSE
      SELECT
        CASE
          WHEN swh.is_closed OR swh.open_time IS NULL OR swh.close_time IS NULL
               OR swh.open_time >= swh.close_time THEN NULL
          ELSE EXTRACT(HOUR FROM swh.open_time)::integer * 60
               + EXTRACT(MINUTE FROM swh.open_time)::integer
        END,
        CASE
          WHEN swh.is_closed OR swh.open_time IS NULL OR swh.close_time IS NULL
               OR swh.open_time >= swh.close_time THEN NULL
          ELSE EXTRACT(HOUR FROM swh.close_time)::integer * 60
               + EXTRACT(MINUTE FROM swh.close_time)::integer
        END
      INTO v_salon_open, v_salon_close
      FROM public.salon_weekly_hours swh
      WHERE swh.salon_id = p_salon_id
        AND swh.weekday = v_weekday;
      -- no weekday row → both NULL (closed)
    END IF;

    -- Staff weekly base (inherit pre-exception salon window when unconfigured).
    IF v_staff_cnt = 0 THEN
      v_staff_open := v_salon_open;
      v_staff_close := v_salon_close;
    ELSE
      SELECT
        CASE
          WHEN stwh.is_closed OR stwh.open_time IS NULL OR stwh.close_time IS NULL
               OR stwh.open_time >= stwh.close_time THEN NULL
          ELSE EXTRACT(HOUR FROM stwh.open_time)::integer * 60
               + EXTRACT(MINUTE FROM stwh.open_time)::integer
        END,
        CASE
          WHEN stwh.is_closed OR stwh.open_time IS NULL OR stwh.close_time IS NULL
               OR stwh.open_time >= stwh.close_time THEN NULL
          ELSE EXTRACT(HOUR FROM stwh.close_time)::integer * 60
               + EXTRACT(MINUTE FROM stwh.close_time)::integer
        END
      INTO v_staff_open, v_staff_close
      FROM public.staff_weekly_hours stwh
      WHERE stwh.salon_id = p_salon_id
        AND stwh.staff_id = v_staff_id
        AND stwh.weekday = v_weekday;
    END IF;

    -- Salon exceptions.
    SELECT EXISTS (
      SELECT 1
      FROM public.schedule_exceptions se
      WHERE se.salon_id = p_salon_id
        AND se.scope = 'salon'
        AND se.start_date <= v_date::date
        AND se.end_date >= v_date::date
        AND se.kind IN ('closed', 'vacation', 'holiday')
    ) INTO v_has_close_kind;

    IF v_has_close_kind THEN
      v_salon_open := NULL;
      v_salon_close := NULL;
    ELSE
      -- Deterministic stand-in for TS unordered "last custom_hours".
      SELECT se.open_time, se.close_time
      INTO v_custom_open, v_custom_close
      FROM public.schedule_exceptions se
      WHERE se.salon_id = p_salon_id
        AND se.scope = 'salon'
        AND se.start_date <= v_date::date
        AND se.end_date >= v_date::date
        AND se.kind = 'custom_hours'
      ORDER BY se.created_at DESC NULLS LAST, se.id DESC
      LIMIT 1;

      IF FOUND THEN
        IF v_custom_open IS NULL OR v_custom_close IS NULL
           OR v_custom_open >= v_custom_close THEN
          v_salon_open := NULL;
          v_salon_close := NULL;
        ELSE
          v_salon_open := EXTRACT(HOUR FROM v_custom_open)::integer * 60
                          + EXTRACT(MINUTE FROM v_custom_open)::integer;
          v_salon_close := EXTRACT(HOUR FROM v_custom_close)::integer * 60
                           + EXTRACT(MINUTE FROM v_custom_close)::integer;
        END IF;
      END IF;
    END IF;

    -- Staff exceptions.
    SELECT EXISTS (
      SELECT 1
      FROM public.schedule_exceptions se
      WHERE se.salon_id = p_salon_id
        AND se.scope = 'staff'
        AND se.staff_id = v_staff_id
        AND se.start_date <= v_date::date
        AND se.end_date >= v_date::date
        AND se.kind IN ('closed', 'vacation', 'holiday')
    ) INTO v_has_close_kind;

    IF v_has_close_kind THEN
      v_staff_open := NULL;
      v_staff_close := NULL;
    ELSE
      SELECT se.open_time, se.close_time
      INTO v_custom_open, v_custom_close
      FROM public.schedule_exceptions se
      WHERE se.salon_id = p_salon_id
        AND se.scope = 'staff'
        AND se.staff_id = v_staff_id
        AND se.start_date <= v_date::date
        AND se.end_date >= v_date::date
        AND se.kind = 'custom_hours'
      ORDER BY se.created_at DESC NULLS LAST, se.id DESC
      LIMIT 1;

      IF FOUND THEN
        IF v_custom_open IS NULL OR v_custom_close IS NULL
           OR v_custom_open >= v_custom_close THEN
          v_staff_open := NULL;
          v_staff_close := NULL;
        ELSE
          v_staff_open := EXTRACT(HOUR FROM v_custom_open)::integer * 60
                          + EXTRACT(MINUTE FROM v_custom_open)::integer;
          v_staff_close := EXTRACT(HOUR FROM v_custom_close)::integer * 60
                           + EXTRACT(MINUTE FROM v_custom_close)::integer;
        END IF;
      END IF;
    END IF;

    IF v_salon_open IS NULL OR v_staff_open IS NULL
       OR v_salon_close IS NULL OR v_staff_close IS NULL THEN
      RETURN jsonb_build_object('kind', 'slot_unavailable');
    END IF;

    v_work_open := GREATEST(v_salon_open, v_staff_open);
    v_work_close := LEAST(v_salon_close, v_staff_close);
    IF v_work_open >= v_work_close THEN
      RETURN jsonb_build_object('kind', 'slot_unavailable');
    END IF;

    -- Duration fit + hourly alignment from open (generateStarts parity).
    IF v_start_min < v_work_open
       OR v_end_min > v_work_close
       OR ((v_start_min - v_work_open) % 60) <> 0 THEN
      RETURN jsonb_build_object('kind', 'slot_unavailable');
    END IF;
  END IF;

  -- Past starts on "today" in salon timezone (computeAvailableSlots filter).
  BEGIN
    SELECT COALESCE(NULLIF(btrim(s.timezone), ''), 'Europe/Moscow')
    INTO v_tz
    FROM public.salons s
    WHERE s.id = p_salon_id;

    IF v_tz IS NULL THEN
      v_tz := 'Europe/Moscow';
    END IF;

    v_today := (v_now AT TIME ZONE v_tz)::date;
    v_now_min := EXTRACT(HOUR FROM (v_now AT TIME ZONE v_tz))::integer * 60
                 + EXTRACT(MINUTE FROM (v_now AT TIME ZONE v_tz))::integer;
  EXCEPTION WHEN others THEN
    v_tz := 'Europe/Moscow';
    v_today := (v_now AT TIME ZONE v_tz)::date;
    v_now_min := EXTRACT(HOUR FROM (v_now AT TIME ZONE v_tz))::integer * 60
                 + EXTRACT(MINUTE FROM (v_now AT TIME ZONE v_tz))::integer;
  END;

  IF v_date::date = v_today AND v_start_min <= v_now_min THEN
    RETURN jsonb_build_object('kind', 'slot_unavailable');
  END IF;

  -- Duration-aware appointment overlap (half-open: end==start allowed).
  SELECT EXISTS (
    SELECT 1
    FROM public.appointments a
    WHERE a.salon_id = p_salon_id
      AND a.staff_id = v_staff_id
      AND a.date = v_date::date
      AND a.status IN ('scheduled', 'confirmed')
      AND (v_start_min < (EXTRACT(HOUR FROM a.end_time)::integer * 60
                          + EXTRACT(MINUTE FROM a.end_time)::integer))
      AND (v_end_min > (EXTRACT(HOUR FROM a.start_time)::integer * 60
                        + EXTRACT(MINUTE FROM a.start_time)::integer))
  ) INTO v_overlap;

  IF v_overlap THEN
    RETURN jsonb_build_object('kind', 'slot_unavailable');
  END IF;

  -- -----------------------------------------------------------------
  -- IG-6A: serialize same-salon normalized-phone client resolve/create.
  -- After schedule + overlap; before client SELECT/INSERT + identity link.
  -- -----------------------------------------------------------------
  v_phone_lock_k1 := hashtext('instagram-client|' || p_salon_id::text);
  v_phone_lock_k2 := hashtext(v_phone_digits);
  PERFORM pg_advisory_xact_lock(v_phone_lock_k1, v_phone_lock_k2);

  -- Client + identity resolution (re-SELECT phone clients AFTER phone lock).
  v_conv_client := v_conv.client_id;

  SELECT i.*
  INTO v_ident
  FROM public.client_channel_identities i
  WHERE i.salon_id = p_salon_id
    AND i.provider = 'instagram'
    AND i.external_user_id = v_ext
  FOR UPDATE;

  v_has_identity := FOUND;

  IF v_conv_client IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = v_conv_client AND c.salon_id = p_salon_id
    ) THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'conversation_client_missing');
    END IF;
  END IF;

  SELECT COUNT(*)::integer, MIN(c.id)
  INTO v_phone_count, v_phone_client
  FROM public.clients c
  WHERE c.salon_id = p_salon_id
    AND regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g') = v_phone_digits;

  IF v_phone_count > 1 THEN
    RETURN jsonb_build_object('kind', 'ambiguous_client');
  END IF;

  -- Identity non-null client conflicts.
  IF v_has_identity AND v_ident.client_id IS NOT NULL THEN
    IF v_conv_client IS NOT NULL AND v_ident.client_id IS DISTINCT FROM v_conv_client THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
    IF v_phone_count = 1 AND v_phone_client IS NOT NULL
       AND v_ident.client_id IS DISTINCT FROM v_phone_client THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
  ELSIF NOT v_has_identity
        AND v_conv_client IS NOT NULL
        AND v_phone_count = 1
        AND v_phone_client IS NOT NULL
        AND v_phone_client IS DISTINCT FROM v_conv_client THEN
    RETURN jsonb_build_object('kind', 'client_resolution_conflict');
  ELSIF v_has_identity
        AND v_ident.client_id IS NULL
        AND v_conv_client IS NOT NULL
        AND v_phone_count = 1
        AND v_phone_client IS NOT NULL
        AND v_phone_client IS DISTINCT FROM v_conv_client THEN
    RETURN jsonb_build_object('kind', 'client_resolution_conflict');
  END IF;

  IF v_has_identity AND v_ident.client_id IS NOT NULL THEN
    v_client_id := v_ident.client_id;
  ELSIF v_conv_client IS NOT NULL THEN
    v_client_id := v_conv_client;
  ELSIF v_phone_count = 1 THEN
    v_client_id := v_phone_client;
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
    v_created_client := true;
  END IF;

  IF NOT v_created_client THEN
    SELECT c.is_blocked
    INTO v_client_blocked
    FROM public.clients c
    WHERE c.id = v_client_id
      AND c.salon_id = p_salon_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('kind', 'error', 'code', 'resolved_client_missing');
    END IF;

    IF v_client_blocked IS TRUE THEN
      RETURN jsonb_build_object('kind', 'client_blocked');
    END IF;
  END IF;

  -- Attach or link identity (never flip non-null client_id).
  IF NOT v_has_identity THEN
    BEGIN
      INSERT INTO public.client_channel_identities (
        salon_id,
        client_id,
        provider,
        external_user_id,
        normalized_address,
        display_address,
        last_interaction_at,
        metadata,
        updated_at
      ) VALUES (
        p_salon_id,
        v_client_id,
        'instagram',
        v_ext,
        v_phone_digits,
        v_phone_store,
        v_now,
        '{}'::jsonb,
        v_now
      );
      v_created_identity := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT i.*
      INTO v_ident
      FROM public.client_channel_identities i
      WHERE i.salon_id = p_salon_id
        AND i.provider = 'instagram'
        AND i.external_user_id = v_ext;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'IG_IDENTITY_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      IF v_ident.client_id IS NULL THEN
        UPDATE public.client_channel_identities i
        SET
          client_id = v_client_id,
          last_interaction_at = v_now,
          updated_at = v_now,
          normalized_address = COALESCE(i.normalized_address, v_phone_digits),
          display_address = COALESCE(i.display_address, v_phone_store)
        WHERE i.id = v_ident.id
          AND i.client_id IS NULL;
      ELSIF v_ident.client_id IS DISTINCT FROM v_client_id THEN
        RAISE EXCEPTION 'IG_IDENTITY_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      v_has_identity := true;
      v_created_identity := false;
    END;
  ELSIF v_ident.client_id IS NULL THEN
    UPDATE public.client_channel_identities i
    SET
      client_id = v_client_id,
      last_interaction_at = v_now,
      updated_at = v_now,
      normalized_address = COALESCE(i.normalized_address, v_phone_digits),
      display_address = COALESCE(i.display_address, v_phone_store)
    WHERE i.id = v_ident.id
      AND i.client_id IS NULL;
  ELSIF v_ident.client_id IS DISTINCT FROM v_client_id THEN
    RETURN jsonb_build_object('kind', 'identity_conflict');
  ELSE
    UPDATE public.client_channel_identities i
    SET
      last_interaction_at = v_now,
      updated_at = v_now,
      normalized_address = COALESCE(i.normalized_address, v_phone_digits),
      display_address = COALESCE(i.display_address, v_phone_store)
    WHERE i.id = v_ident.id
      AND i.client_id = v_client_id;
  END IF;

  -- Notes: structured source only — never store inbound message bodies.
  v_notes := 'Источник: Instagram'
    || E'\nКлиент: ' || v_name
    || E'\nТелефон: ' || v_phone_store
    || E'\nУслуга: ' || v_service.name
    || E'\nДата: ' || v_date
    || E'\nВремя: ' || v_time;

  BEGIN
    INSERT INTO public.appointments (
      salon_id,
      client_id,
      service_id,
      staff_id,
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
      v_service_id,
      v_staff_id,
      v_date::date,
      v_start_time::time,
      v_end_time::time,
      'scheduled',
      v_notes,
      false,
      'instagram',
      v_event
    )
    RETURNING * INTO v_appt;
  EXCEPTION WHEN unique_violation THEN
    -- Never clear identity.client_id. Only drop provisional identity INSERT from this TX.
    IF v_created_identity THEN
      DELETE FROM public.client_channel_identities i
      WHERE i.salon_id = p_salon_id
        AND i.provider = 'instagram'
        AND i.external_user_id = v_ext
        AND i.client_id = v_client_id;
    END IF;
    IF v_created_client THEN
      DELETE FROM public.clients c
      WHERE c.id = v_client_id
        AND c.salon_id = p_salon_id
        AND NOT EXISTS (
          SELECT 1 FROM public.appointments a WHERE a.client_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.client_channel_identities i WHERE i.client_id = c.id
        );
    END IF;

    SELECT a.*
    INTO v_appt
    FROM public.appointments a
    WHERE a.salon_id = p_salon_id
      AND a.source = 'instagram'
      AND a.source_external_event_id = v_event
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE;
    END IF;

    IF v_conv.client_id IS NULL OR v_conv.client_id = v_appt.client_id THEN
      UPDATE public.channel_conversations c
      SET
        client_id = COALESCE(c.client_id, v_appt.client_id),
        current_flow = NULL,
        current_step = NULL,
        state = jsonb_build_object(
          'appointmentId', v_appt.id::text,
          'sourceMessageId', v_msg
        ),
        last_interaction_at = v_now,
        updated_at = v_now
      WHERE c.id = v_conv.id;
    END IF;

    RETURN jsonb_build_object(
      'kind', 'already_booked',
      'appointment_id', v_appt.id,
      'client_id', v_appt.client_id
    );
  END;

  IF v_conv.client_id IS NOT NULL AND v_conv.client_id IS DISTINCT FROM v_client_id THEN
    RAISE EXCEPTION 'IG_CONVERSATION_CLIENT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.channel_conversations c
  SET
    client_id = COALESCE(c.client_id, v_client_id),
    current_flow = NULL,
    current_step = NULL,
    state = jsonb_build_object(
      'appointmentId', v_appt.id::text,
      'sourceMessageId', v_msg
    ),
    last_interaction_at = v_now,
    updated_at = v_now,
    expires_at = v_now + interval '24 hours'
  WHERE c.id = v_conv.id
    AND c.salon_id = p_salon_id
    AND c.provider = 'instagram'
    AND c.external_user_id = v_ext
    AND c.current_flow = 'booking'
    AND c.current_step = 'ready_to_book';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'IG_CONVERSATION_CAS_MISS' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'kind', 'booking_created',
    'appointment_id', v_appt.id,
    'client_id', v_client_id
  );
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'IG_IDENTITY_CONFLICT%' THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
    IF SQLERRM LIKE 'IG_CONVERSATION_CLIENT_MISMATCH%' THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
    IF SQLERRM LIKE 'IG_CONVERSATION_CAS_MISS%' THEN
      RETURN jsonb_build_object('kind', 'stale_state', 'code', 'conversation_cas_miss');
    END IF;
    RETURN jsonb_build_object('kind', 'error', 'code', 'db_error');
END;
$$;

REVOKE ALL ON FUNCTION public.commit_instagram_booking_owned(
  uuid, uuid, integer, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_instagram_booking_owned(
  uuid, uuid, integer, text, text, text
) FROM anon;
REVOKE ALL ON FUNCTION public.commit_instagram_booking_owned(
  uuid, uuid, integer, text, text, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commit_instagram_booking_owned(
  uuid, uuid, integer, text, text, text
) TO service_role;

-- ---------------------------------------------------------------------------
-- IG-6B: coordinated schedule mutation RPCs (lock + DML same transaction)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_salon_weekly_hours_coordinated(
  p_salon_id uuid,
  p_hours jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_now timestamptz := clock_timestamp();
  v_rows jsonb := '[]'::jsonb;
  v_row public.salon_weekly_hours%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL OR p_hours IS NULL OR jsonb_typeof(p_hours) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'IG6B_INVALID_HOURS' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.ig6b_lock_salon_schedule(p_salon_id);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_hours)
  LOOP
    INSERT INTO public.salon_weekly_hours (
      salon_id, weekday, is_closed, open_time, close_time, updated_at
    ) VALUES (
      p_salon_id,
      (v_item->>'weekday')::integer,
      COALESCE((v_item->>'is_closed')::boolean, false),
      NULLIF(v_item->>'open_time', '')::time,
      NULLIF(v_item->>'close_time', '')::time,
      v_now
    )
    ON CONFLICT (salon_id, weekday) DO UPDATE SET
      is_closed = EXCLUDED.is_closed,
      open_time = EXCLUDED.open_time,
      close_time = EXCLUDED.close_time,
      updated_at = EXCLUDED.updated_at
    RETURNING * INTO v_row;

    v_rows := v_rows || jsonb_build_array(to_jsonb(v_row));
  END LOOP;

  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_staff_weekly_hours_coordinated(
  p_salon_id uuid,
  p_staff_id uuid,
  p_hours jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_now timestamptz := clock_timestamp();
  v_rows jsonb := '[]'::jsonb;
  v_row public.staff_weekly_hours%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL OR p_staff_id IS NULL
     OR p_hours IS NULL OR jsonb_typeof(p_hours) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'IG6B_INVALID_HOURS' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff st
    WHERE st.id = p_staff_id AND st.salon_id = p_salon_id
  ) THEN
    RAISE EXCEPTION 'IG6B_STAFF_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Canonical order: salon namespace then staff namespace (matches commit).
  PERFORM public.ig6b_lock_salon_schedule(p_salon_id);
  PERFORM public.ig6b_lock_staff_schedule(p_salon_id, p_staff_id);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_hours)
  LOOP
    INSERT INTO public.staff_weekly_hours (
      salon_id, staff_id, weekday, is_closed, open_time, close_time, updated_at
    ) VALUES (
      p_salon_id,
      p_staff_id,
      (v_item->>'weekday')::integer,
      COALESCE((v_item->>'is_closed')::boolean, false),
      NULLIF(v_item->>'open_time', '')::time,
      NULLIF(v_item->>'close_time', '')::time,
      v_now
    )
    ON CONFLICT (staff_id, weekday) DO UPDATE SET
      is_closed = EXCLUDED.is_closed,
      open_time = EXCLUDED.open_time,
      close_time = EXCLUDED.close_time,
      updated_at = EXCLUDED.updated_at
    RETURNING * INTO v_row;

    v_rows := v_rows || jsonb_build_array(to_jsonb(v_row));
  END LOOP;

  RETURN v_rows;
END;
$$;

-- Exception locks (IG-6C):
--   salon scope: salon namespace (covers all dates; commit always takes salon ns)
--   staff scope short (span<=366): salon → staff → each staff/date
--   staff scope long  (span>366): salon → staff namespace only
--     Safe: every IG commit for that staff acquires salon→staff→date, so
--     staff namespace alone serializes long-range mutations vs all relevant commits.
-- Never reject solely because span > 366 (preserves prior API semantics).
CREATE OR REPLACE FUNCTION public.create_schedule_exception_coordinated(
  p_salon_id uuid,
  p_scope text,
  p_staff_id uuid,
  p_kind text,
  p_start_date date,
  p_end_date date,
  p_open_time time,
  p_close_time time,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row public.schedule_exceptions%ROWTYPE;
  v_d date;
  v_span integer;
BEGIN
  IF p_salon_id IS NULL OR p_scope IS NULL OR p_kind IS NULL
     OR p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'IG6B_INVALID_EXCEPTION' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date < p_start_date THEN
    RAISE EXCEPTION 'IG6B_INVALID_EXCEPTION_RANGE' USING ERRCODE = 'P0001';
  END IF;
  IF p_scope NOT IN ('salon', 'staff') THEN
    RAISE EXCEPTION 'IG6B_INVALID_EXCEPTION_SCOPE' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind NOT IN ('closed', 'vacation', 'holiday', 'custom_hours') THEN
    RAISE EXCEPTION 'IG6B_INVALID_EXCEPTION_KIND' USING ERRCODE = 'P0001';
  END IF;

  v_span := (p_end_date - p_start_date) + 1;

  IF p_scope = 'salon' THEN
    IF p_staff_id IS NOT NULL THEN
      RAISE EXCEPTION 'IG6B_INVALID_EXCEPTION_STAFF' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.ig6b_lock_salon_schedule(p_salon_id);
  ELSE
    IF p_staff_id IS NULL THEN
      RAISE EXCEPTION 'IG6B_INVALID_EXCEPTION_STAFF' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = p_staff_id AND st.salon_id = p_salon_id
    ) THEN
      RAISE EXCEPTION 'IG6B_STAFF_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    -- Canonical order: salon → staff; per-date only for short ranges.
    PERFORM public.ig6b_lock_salon_schedule(p_salon_id);
    PERFORM public.ig6b_lock_staff_schedule(p_salon_id, p_staff_id);
    IF v_span <= 366 THEN
      v_d := p_start_date;
      WHILE v_d <= p_end_date LOOP
        PERFORM public.ig6b_lock_staff_date(
          p_salon_id, p_staff_id, to_char(v_d, 'YYYY-MM-DD')
        );
        v_d := v_d + 1;
      END LOOP;
    END IF;
  END IF;

  INSERT INTO public.schedule_exceptions (
    salon_id, scope, staff_id, kind,
    start_date, end_date, open_time, close_time, note
  ) VALUES (
    p_salon_id, p_scope, p_staff_id, p_kind,
    p_start_date, p_end_date, p_open_time, p_close_time, p_note
  )
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_schedule_exception_coordinated(
  p_salon_id uuid,
  p_exception_id uuid,
  p_require_staff_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ex public.schedule_exceptions%ROWTYPE;
  v_d date;
  v_span integer;
  v_deleted uuid;
BEGIN
  IF p_salon_id IS NULL OR p_exception_id IS NULL THEN
    RAISE EXCEPTION 'IG6B_INVALID_EXCEPTION' USING ERRCODE = 'P0001';
  END IF;

  -- Lookup without row lock first so advisory locks precede DML (deadlock-safe).
  SELECT e.*
  INTO v_ex
  FROM public.schedule_exceptions e
  WHERE e.id = p_exception_id
    AND e.salon_id = p_salon_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF p_require_staff_id IS NOT NULL THEN
    IF v_ex.scope IS DISTINCT FROM 'staff'
       OR v_ex.staff_id IS DISTINCT FROM p_require_staff_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'not_found');
    END IF;
  END IF;

  -- Same short/long policy as create: never reject long ranges.
  v_span := (v_ex.end_date - v_ex.start_date) + 1;

  IF v_ex.scope = 'salon' THEN
    PERFORM public.ig6b_lock_salon_schedule(p_salon_id);
  ELSE
    PERFORM public.ig6b_lock_salon_schedule(p_salon_id);
    PERFORM public.ig6b_lock_staff_schedule(p_salon_id, v_ex.staff_id);
    IF v_span <= 366 THEN
      v_d := v_ex.start_date;
      WHILE v_d <= v_ex.end_date LOOP
        PERFORM public.ig6b_lock_staff_date(
          p_salon_id, v_ex.staff_id, to_char(v_d, 'YYYY-MM-DD')
        );
        v_d := v_d + 1;
      END LOOP;
    END IF;
  END IF;

  DELETE FROM public.schedule_exceptions e
  WHERE e.id = v_ex.id
    AND e.salon_id = p_salon_id
  RETURNING e.id INTO v_deleted;

  IF v_deleted IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_salon_weekly_hours_coordinated(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_staff_weekly_hours_coordinated(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_schedule_exception_coordinated(uuid, text, uuid, text, date, date, time, time, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_schedule_exception_coordinated(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_salon_weekly_hours_coordinated(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_staff_weekly_hours_coordinated(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_schedule_exception_coordinated(uuid, text, uuid, text, date, date, time, time, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_schedule_exception_coordinated(uuid, uuid, uuid) TO service_role;

COMMIT;
