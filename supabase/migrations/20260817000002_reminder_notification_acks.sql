-- In-app notification read/dismiss for the header bell.
-- Does NOT change reminders.status (outbound reminder jobs keep sending).

CREATE TABLE IF NOT EXISTS public.reminder_notification_acks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id       UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reminder_id    UUID NOT NULL REFERENCES public.reminders(id) ON DELETE CASCADE,
  read_at        TIMESTAMPTZ,
  dismissed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT reminder_notification_acks_unique UNIQUE (salon_id, user_id, reminder_id)
);

CREATE INDEX IF NOT EXISTS reminder_notification_acks_salon_user_idx
  ON public.reminder_notification_acks (salon_id, user_id);

ALTER TABLE public.reminder_notification_acks ENABLE ROW LEVEL SECURITY;
