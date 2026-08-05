-- WA-4E1: Safe already_booked conversation repair (function replace only).
-- Does NOT change appointment idempotency, overlap, advisory locks, blocked-client,
-- client resolution, or identity rules.
-- Does NOT send messages, create reminders, or call Meta.
--
-- Repair allowed only when:
--   state.sourceMessageId matches this event message
--   AND conversation is still booking/ready_to_book OR already idle
-- Different client → already_booked_repair_conflict (no flip)
-- Newer active booking / mismatched sourceMessageId → already_booked_no_repair

BEGIN;

CREATE OR REPLACE FUNCTION public.commit_whatsapp_booking_owned(
  p_salon_id uuid,
  p_receipt_id uuid,
  p_attempt_count integer,
  p_external_user_id text,
  p_expected_source_message_id text,
  p_external_event_id text,
  p_service_id uuid,
  p_staff_id uuid,
  p_date text,
  p_time text,
  p_name text,
  p_phone text
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
  v_name text := nullif(btrim(p_name), '');
  v_phone_raw text := nullif(btrim(p_phone), '');
  v_phone_digits text;
  v_phone_store text;
  v_date text := nullif(btrim(p_date), '');
  v_time text := nullif(btrim(p_time), '');
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
  v_lock_k1 integer;
  v_lock_k2 integer;
  v_overlap boolean;
  v_notes text;
  v_created_client boolean := false;
  v_created_identity boolean := false;
  v_has_identity boolean := false;
  v_client_blocked boolean;
BEGIN
  IF v_ext IS NULL OR v_msg IS NULL OR v_event_in IS NULL
     OR p_service_id IS NULL OR p_staff_id IS NULL
     OR v_date IS NULL OR v_time IS NULL
     OR v_name IS NULL OR v_phone_raw IS NULL THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'malformed_booking_input');
  END IF;

  IF length(v_name) < 2 OR length(v_name) > 80 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_name');
  END IF;

  -- Digits-only phone (same policy as normalizeWhatsAppAddress).
  v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
  IF v_phone_digits IS NULL OR length(v_phone_digits) < 8 OR length(v_phone_digits) > 15 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_phone');
  END IF;
  v_phone_store := CASE
    WHEN left(v_phone_raw, 1) = '+' THEN '+' || v_phone_digits
    ELSE '+' || v_phone_digits
  END;

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

  -- D) Receipt ownership FIRST.
  v_own := public.whatsapp_lock_owned_receipt(p_salon_id, p_receipt_id, p_attempt_count);
  IF v_own IS DISTINCT FROM 'ok' THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  SELECT r.*
  INTO v_receipt
  FROM public.channel_event_receipts r
  WHERE r.id = p_receipt_id
    AND r.salon_id = p_salon_id
    AND r.provider = 'whatsapp';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'lost_ownership');
  END IF;

  v_event := nullif(btrim(v_receipt.external_event_id), '');
  IF v_event IS NULL OR v_event IS DISTINCT FROM v_event_in THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'external_event_mismatch');
  END IF;

  -- E) Conversation lock + CAS.
  SELECT c.*
  INTO v_conv
  FROM public.channel_conversations c
  WHERE c.salon_id = p_salon_id
    AND c.provider = 'whatsapp'
    AND c.external_user_id = v_ext
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'conversation_missing');
  END IF;

  -- F) Idempotency: existing appointment for this event.
  SELECT a.*
  INTO v_existing
  FROM public.appointments a
  WHERE a.salon_id = p_salon_id
    AND a.source = 'whatsapp'
    AND a.source_external_event_id = v_event
  LIMIT 1;

  IF FOUND THEN
    -- WA-4E1: repair only when conversation still belongs to this booking event.
    -- Appointment is authoritative; never INSERT another.
    IF nullif(btrim(COALESCE(v_conv.state->>'sourceMessageId', '')), '')
         IS DISTINCT FROM v_msg THEN
      RETURN jsonb_build_object(
        'kind', 'already_booked_no_repair',
        'appointment_id', v_existing.id,
        'client_id', v_existing.client_id
      );
    END IF;

    IF v_conv.client_id IS NOT NULL
       AND v_conv.client_id IS DISTINCT FROM v_existing.client_id THEN
      RETURN jsonb_build_object(
        'kind', 'already_booked_repair_conflict',
        'appointment_id', v_existing.id,
        'client_id', v_existing.client_id
      );
    END IF;

    -- Repair only at original ready_to_book or already-idle completed shape.
    IF NOT (
         (v_conv.current_flow IS NOT DISTINCT FROM 'booking'
          AND v_conv.current_step IS NOT DISTINCT FROM 'ready_to_book')
         OR (v_conv.current_flow IS NULL AND v_conv.current_step IS NULL)
       ) THEN
      RETURN jsonb_build_object(
        'kind', 'already_booked_no_repair',
        'appointment_id', v_existing.id,
        'client_id', v_existing.client_id
      );
    END IF;

    IF v_conv.client_id IS NULL THEN
      UPDATE public.channel_conversations c
      SET
        client_id = v_existing.client_id,
        current_flow = NULL,
        current_step = NULL,
        state = jsonb_build_object(
          'appointmentId', v_existing.id::text,
          'sourceMessageId', v_msg
        ),
        last_interaction_at = v_now,
        updated_at = v_now
      WHERE c.id = v_conv.id;
    ELSE
      UPDATE public.channel_conversations c
      SET
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

  IF nullif(btrim(COALESCE(v_conv.state->>'sourceMessageId', '')), '') IS DISTINCT FROM v_msg THEN
    RETURN jsonb_build_object('kind', 'stale_state', 'code', 'source_message_mismatch');
  END IF;

  -- G) Service revalidation.
  SELECT s.*
  INTO v_service
  FROM public.services s
  WHERE s.id = p_service_id
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

  -- H) Staff revalidation + service compatibility.
  SELECT st.*
  INTO v_staff
  FROM public.staff st
  WHERE st.id = p_staff_id
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
    AND ss.service_id = p_service_id;

  IF v_assign_count > 0 THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.staff_services ss
      WHERE ss.salon_id = p_salon_id
        AND ss.service_id = p_service_id
        AND ss.staff_id = p_staff_id
    ) INTO v_staff_ok;
  ELSE
    -- Legacy specialties text match (same idea as findStaffForServiceSpecialization).
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

  -- I) Compute start/end minutes.
  v_start_min := v_hh * 60 + v_mm;
  v_end_min := v_start_min + v_duration;
  IF v_end_min > 24 * 60 THEN
    RETURN jsonb_build_object('kind', 'error', 'code', 'invalid_end_time');
  END IF;
  v_start_time := v_time || ':00';
  v_end_time := lpad((v_end_min / 60)::text, 2, '0') || ':' ||
                lpad((v_end_min % 60)::text, 2, '0') || ':00';

  -- J) Serialize staff/date bookings + overlap recheck.
  -- Lock key: hashtext(salon|staff) + hashtext(date). Transaction-scoped.
  -- Collisions only serialize unrelated pairs; overlap query still filters exact keys.
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
    RETURN jsonb_build_object('kind', 'slot_unavailable');
  END IF;

  -- K/L) Client + identity resolution BEFORE any client INSERT.
  v_conv_client := v_conv.client_id;

  SELECT i.*
  INTO v_ident
  FROM public.client_channel_identities i
  WHERE i.salon_id = p_salon_id
    AND i.provider = 'whatsapp'
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

  IF v_has_identity THEN
    IF v_conv_client IS NOT NULL AND v_ident.client_id IS DISTINCT FROM v_conv_client THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
    IF v_phone_count = 1 AND v_phone_client IS NOT NULL
       AND v_ident.client_id IS DISTINCT FROM v_phone_client THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
  ELSIF v_conv_client IS NOT NULL
        AND v_phone_count = 1
        AND v_phone_client IS NOT NULL
        AND v_phone_client IS DISTINCT FROM v_conv_client THEN
    -- Conversation client A + phone matches unrelated client B: fail closed.
    -- Do not attach B's normalized phone identity onto A.
    RETURN jsonb_build_object('kind', 'client_resolution_conflict');
  END IF;

  IF v_has_identity THEN
    v_client_id := v_ident.client_id;
  ELSIF v_conv_client IS NOT NULL THEN
    v_client_id := v_conv_client;
  ELSIF v_phone_count = 1 THEN
    v_client_id := v_phone_client;
  ELSE
    -- Create client only after all validations / overlap / conflict / blocked checks.
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

  -- WA-4D2: refuse blocked existing clients (identity / conversation / phone).
  -- Checked before identity attach and appointment insert; never fall through to a new client.
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

  -- Attach identity if missing (never flip).
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
        'whatsapp',
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
        AND i.provider = 'whatsapp'
        AND i.external_user_id = v_ext;
      IF NOT FOUND OR v_ident.client_id IS DISTINCT FROM v_client_id THEN
        RAISE EXCEPTION 'WA_IDENTITY_CONFLICT'
          USING ERRCODE = 'P0001';
      END IF;
      v_has_identity := true;
      v_created_identity := false;
    END;
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

  -- M) Appointment insert with idempotency key.
  v_notes := 'Источник: WhatsApp'
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
      p_service_id,
      p_staff_id,
      v_date::date,
      v_start_time::time,
      v_end_time::time,
      'scheduled',
      v_notes,
      false,
      'whatsapp',
      v_event
    )
    RETURNING * INTO v_appt;
  EXCEPTION WHEN unique_violation THEN
    -- Drop this TX's provisional client/identity if we created them and lost the insert race.
    IF v_created_identity THEN
      DELETE FROM public.client_channel_identities i
      WHERE i.salon_id = p_salon_id
        AND i.provider = 'whatsapp'
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
      AND a.source = 'whatsapp'
      AND a.source_external_event_id = v_event
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE;
    END IF;

    -- N) WA-4E1: unique race already_booked — same safe repair rules.
    IF nullif(btrim(COALESCE(v_conv.state->>'sourceMessageId', '')), '')
         IS DISTINCT FROM v_msg THEN
      RETURN jsonb_build_object(
        'kind', 'already_booked_no_repair',
        'appointment_id', v_appt.id,
        'client_id', v_appt.client_id
      );
    END IF;

    IF v_conv.client_id IS NOT NULL
       AND v_conv.client_id IS DISTINCT FROM v_appt.client_id THEN
      RETURN jsonb_build_object(
        'kind', 'already_booked_repair_conflict',
        'appointment_id', v_appt.id,
        'client_id', v_appt.client_id
      );
    END IF;

    IF NOT (
         (v_conv.current_flow IS NOT DISTINCT FROM 'booking'
          AND v_conv.current_step IS NOT DISTINCT FROM 'ready_to_book')
         OR (v_conv.current_flow IS NULL AND v_conv.current_step IS NULL)
       ) THEN
      RETURN jsonb_build_object(
        'kind', 'already_booked_no_repair',
        'appointment_id', v_appt.id,
        'client_id', v_appt.client_id
      );
    END IF;

    IF v_conv.client_id IS NULL THEN
      UPDATE public.channel_conversations c
      SET
        client_id = v_appt.client_id,
        current_flow = NULL,
        current_step = NULL,
        state = jsonb_build_object(
          'appointmentId', v_appt.id::text,
          'sourceMessageId', v_msg
        ),
        last_interaction_at = v_now,
        updated_at = v_now
      WHERE c.id = v_conv.id;
    ELSE
      UPDATE public.channel_conversations c
      SET
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

  -- N) Conversation completion + client link (null → set only).
  IF v_conv.client_id IS NOT NULL AND v_conv.client_id IS DISTINCT FROM v_client_id THEN
    RAISE EXCEPTION 'WA_CONVERSATION_CLIENT_MISMATCH'
      USING ERRCODE = 'P0001';
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
    AND c.provider = 'whatsapp'
    AND c.external_user_id = v_ext
    AND c.current_flow = 'booking'
    AND c.current_step = 'ready_to_book';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WA_CONVERSATION_CAS_MISS'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'kind', 'booking_created',
    'appointment_id', v_appt.id,
    'client_id', v_client_id
  );
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'WA_IDENTITY_CONFLICT%' THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
    IF SQLERRM LIKE 'WA_CONVERSATION_CLIENT_MISMATCH%' THEN
      RETURN jsonb_build_object('kind', 'identity_conflict');
    END IF;
    IF SQLERRM LIKE 'WA_CONVERSATION_CAS_MISS%' THEN
      RETURN jsonb_build_object('kind', 'stale_state', 'code', 'conversation_cas_miss');
    END IF;
    RETURN jsonb_build_object('kind', 'error', 'code', 'db_error', 'message', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, text, uuid, uuid, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, text, uuid, uuid, text, text, text, text
) FROM anon;
REVOKE ALL ON FUNCTION public.commit_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, text, uuid, uuid, text, text, text, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commit_whatsapp_booking_owned(
  uuid, uuid, integer, text, text, text, uuid, uuid, text, text, text, text
) TO service_role;

COMMIT;
