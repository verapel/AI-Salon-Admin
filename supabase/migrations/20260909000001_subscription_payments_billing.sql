-- Paid subscription billing (owner checkout + payments).
-- Extends SUB-1A salon_subscriptions. Does not rewrite historical migrations.
-- Does NOT touch Telegram / WhatsApp / Instagram / Google Calendar / Apple Calendar.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. salon_subscriptions: id, canceled_at, unpaid status
-- ---------------------------------------------------------------------------
ALTER TABLE public.salon_subscriptions
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE public.salon_subscriptions
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE public.salon_subscriptions
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE public.salon_subscriptions
  ALTER COLUMN id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS salon_subscriptions_id_unique
  ON public.salon_subscriptions (id);

ALTER TABLE public.salon_subscriptions
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz NULL;

COMMENT ON COLUMN public.salon_subscriptions.id IS
  'Stable subscription row id. salon_id remains the 1:1 primary key (ownership).';

COMMENT ON COLUMN public.salon_subscriptions.canceled_at IS
  'Set when the owner requests cancel-at-period-end. Access stays valid until current_period_end.';

ALTER TABLE public.salon_subscriptions
  DROP CONSTRAINT IF EXISTS salon_subscriptions_status_check;

ALTER TABLE public.salon_subscriptions
  ADD CONSTRAINT salon_subscriptions_status_check
  CHECK (status IN ('trial', 'active', 'past_due', 'expired', 'cancelled', 'unpaid'));

-- Existing rows stay active/standard with null period (complimentary/pilot access).
-- Missing-row application fallback remains active. This migration does not lock out
-- production salons.

-- ---------------------------------------------------------------------------
-- B. billing_checkout_sessions — provider-agnostic payment attempts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_checkout_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id        uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  plan_id         text NOT NULL,
  provider        text NOT NULL,
  amount          numeric(12, 2) NOT NULL CHECK (amount >= 0),
  currency        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'succeeded', 'failed', 'expired')),
  provider_session_id text NULL,
  created_at      timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at      timestamptz NOT NULL,
  completed_at    timestamptz NULL,
  CONSTRAINT billing_checkout_sessions_plan_nonblank_check
    CHECK (length(trim(plan_id)) > 0),
  CONSTRAINT billing_checkout_sessions_provider_nonblank_check
    CHECK (length(trim(provider)) > 0),
  CONSTRAINT billing_checkout_sessions_currency_nonblank_check
    CHECK (length(trim(currency)) > 0),
  CONSTRAINT billing_checkout_sessions_provider_session_id_nonblank_check
    CHECK (provider_session_id IS NULL OR length(trim(provider_session_id)) > 0)
);

COMMENT ON TABLE public.billing_checkout_sessions IS
  'Provider-agnostic checkout attempts. Success is recorded only via authenticated server completion or a future verified provider webhook — never via a client query parameter.';

CREATE INDEX IF NOT EXISTS billing_checkout_sessions_salon_id_created_idx
  ON public.billing_checkout_sessions (salon_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_checkout_sessions_salon_pending_idx
  ON public.billing_checkout_sessions (salon_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS billing_checkout_sessions_provider_session_unique
  ON public.billing_checkout_sessions (provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

ALTER TABLE public.billing_checkout_sessions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- C. subscription_payments — idempotent provider payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscription_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id              uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  checkout_id           uuid NULL REFERENCES public.billing_checkout_sessions(id) ON DELETE SET NULL,
  provider              text NOT NULL,
  provider_payment_id   text NOT NULL,
  amount                numeric(12, 2) NOT NULL CHECK (amount >= 0),
  currency              text NOT NULL,
  status                text NOT NULL
                          CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  paid_at               timestamptz NULL,
  CONSTRAINT subscription_payments_provider_nonblank_check
    CHECK (length(trim(provider)) > 0),
  CONSTRAINT subscription_payments_provider_payment_id_nonblank_check
    CHECK (length(trim(provider_payment_id)) > 0),
  CONSTRAINT subscription_payments_currency_nonblank_check
    CHECK (length(trim(currency)) > 0)
);

COMMENT ON TABLE public.subscription_payments IS
  'Provider-agnostic payment records. Unique (provider, provider_payment_id) prevents duplicate processing.';

CREATE UNIQUE INDEX IF NOT EXISTS subscription_payments_provider_payment_unique
  ON public.subscription_payments (provider, provider_payment_id);

CREATE INDEX IF NOT EXISTS subscription_payments_salon_id_created_idx
  ON public.subscription_payments (salon_id, created_at DESC);

ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;

COMMIT;
