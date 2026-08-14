-- SUB-1A: Internal salon subscription foundation (schema + backfill + provisioning).
-- No messenger enforcement. No payment provider. No salons.active semantics change.
-- Does NOT touch Telegram / WhatsApp / Instagram / Apple / reminders.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. salon_subscriptions (1:1 with salons)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salon_subscriptions (
  salon_id uuid PRIMARY KEY
    REFERENCES public.salons(id)
    ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'standard',
  status text NOT NULL DEFAULT 'active',
  trial_ends_at timestamptz NULL,
  current_period_start timestamptz NULL,
  current_period_end timestamptz NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  developer_suspended boolean NOT NULL DEFAULT false,
  provider text NULL,
  provider_customer_id text NULL,
  provider_subscription_id text NULL,
  last_payment_status text NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT salon_subscriptions_status_check
    CHECK (status IN ('trial', 'active', 'past_due', 'expired', 'cancelled')),
  CONSTRAINT salon_subscriptions_plan_nonblank_check
    CHECK (length(trim(plan)) > 0),
  CONSTRAINT salon_subscriptions_provider_nonblank_check
    CHECK (provider IS NULL OR length(trim(provider)) > 0),
  CONSTRAINT salon_subscriptions_provider_customer_id_nonblank_check
    CHECK (provider_customer_id IS NULL OR length(trim(provider_customer_id)) > 0),
  CONSTRAINT salon_subscriptions_provider_subscription_id_nonblank_check
    CHECK (provider_subscription_id IS NULL OR length(trim(provider_subscription_id)) > 0)
);

COMMENT ON TABLE public.salon_subscriptions IS
  'SUB-1A: Per-salon internal subscription lifecycle. Distinct from salons.active (ops kill-switch) and from developer_suspended. AI automation entitlement is derived in application code (SUB-1B), not stored here. No payment secrets.';

COMMENT ON COLUMN public.salon_subscriptions.status IS
  'Subscription lifecycle: trial|active|past_due|expired|cancelled. Not an ops kill-switch; not developer_suspended.';

COMMENT ON COLUMN public.salon_subscriptions.developer_suspended IS
  'Developer-level automation/subscription suspension. Independent of salons.active and status.';

COMMENT ON COLUMN public.salon_subscriptions.current_period_end IS
  'Paid/period end. NULL on active legacy rows means no billing expiry imposed yet.';

-- ---------------------------------------------------------------------------
-- B. Indexes (salon_id is PK — no redundant index)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS salon_subscriptions_status_idx
  ON public.salon_subscriptions (status);

CREATE INDEX IF NOT EXISTS salon_subscriptions_current_period_end_idx
  ON public.salon_subscriptions (current_period_end)
  WHERE current_period_end IS NOT NULL;

-- Future external subscription identity (provider-agnostic).
CREATE UNIQUE INDEX IF NOT EXISTS salon_subscriptions_provider_subscription_id_unique
  ON public.salon_subscriptions (provider, provider_subscription_id)
  WHERE provider IS NOT NULL
    AND provider_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- C. RLS — enabled with NO policies (service-role / server only; matches channel tables)
-- ---------------------------------------------------------------------------
ALTER TABLE public.salon_subscriptions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- D. Backfill existing salons (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO public.salon_subscriptions (
  salon_id,
  plan,
  status,
  developer_suspended,
  current_period_start,
  current_period_end,
  cancel_at_period_end
)
SELECT
  s.id,
  'standard',
  'active',
  false,
  NULL,
  NULL,
  false
FROM public.salons s
ON CONFLICT (salon_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- E. Future salon provisioning (DB trigger — covers all insert paths)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_salon_subscription_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.salon_subscriptions (
    salon_id,
    plan,
    status,
    developer_suspended,
    current_period_start,
    current_period_end,
    cancel_at_period_end
  )
  VALUES (
    NEW.id,
    'standard',
    'active',
    false,
    NULL,
    NULL,
    false
  )
  ON CONFLICT (salon_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ensure_salon_subscription_row() IS
  'SUB-1A: After INSERT on salons, ensure 1:1 salon_subscriptions row (active/standard, no expiry). Idempotent.';

DROP TRIGGER IF EXISTS trg_salons_ensure_subscription ON public.salons;
CREATE TRIGGER trg_salons_ensure_subscription
  AFTER INSERT ON public.salons
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_salon_subscription_row();

REVOKE ALL ON FUNCTION public.ensure_salon_subscription_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_salon_subscription_row() FROM anon;
REVOKE ALL ON FUNCTION public.ensure_salon_subscription_row() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_salon_subscription_row() TO service_role;

COMMIT;
