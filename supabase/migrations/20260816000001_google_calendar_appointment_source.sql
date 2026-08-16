-- GOOGLE-CAL-A2: Allow appointments.source = 'google' for future Google Calendar imports.
-- Additive CHECK only. No row updates, backfills, or external-id columns on appointments.
-- appointment_external_links already supports provider = 'google'.

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_source_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_source_check
  CHECK (
    source IS NULL
    OR source IN (
      'telegram',
      'owner',
      'apple',
      'whatsapp',
      'instagram',
      'google'
    )
  );

COMMENT ON CONSTRAINT appointments_source_check ON public.appointments IS
  'Appointment origin channels: telegram, owner, apple, whatsapp, instagram, google (GOOGLE-CAL-A2).';
