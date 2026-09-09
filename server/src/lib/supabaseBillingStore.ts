import { supabase } from './supabase.js';
import { isSalonSubscriptionStatus } from './salonSubscription.js';
import type {
  BillingCheckoutRow,
  BillingPaymentRow,
  BillingStore,
  BillingSubscriptionRow,
  CheckoutSessionStatus,
  PaymentRecordStatus,
  UpsertSubscriptionActivation,
} from './billingStore.js';

const SUB_SELECT = `
  id,
  salon_id,
  plan,
  status,
  trial_ends_at,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  canceled_at,
  developer_suspended,
  provider,
  provider_customer_id,
  provider_subscription_id,
  last_payment_status,
  created_at,
  updated_at
`;

const CHECKOUT_SELECT = `
  id,
  salon_id,
  plan_id,
  provider,
  amount,
  currency,
  status,
  provider_session_id,
  created_at,
  expires_at,
  completed_at
`;

const PAYMENT_SELECT = `
  id,
  salon_id,
  checkout_id,
  provider,
  provider_payment_id,
  amount,
  currency,
  status,
  created_at,
  paid_at
`;

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '23505') return true;
  return typeof error.message === 'string' && /duplicate key/i.test(error.message);
}

function mapSubscription(row: Record<string, unknown>): BillingSubscriptionRow {
  const statusRaw = row.status;
  const status = isSalonSubscriptionStatus(statusRaw) ? statusRaw : 'active';
  return {
    id: String(row.id),
    salonId: String(row.salon_id),
    plan: typeof row.plan === 'string' && row.plan.trim() ? row.plan.trim() : 'standard',
    status,
    trialEndsAt: (row.trial_ends_at as string | null) ?? null,
    currentPeriodStart: (row.current_period_start as string | null) ?? null,
    currentPeriodEnd: (row.current_period_end as string | null) ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    canceledAt: (row.canceled_at as string | null) ?? null,
    developerSuspended: row.developer_suspended === true,
    provider: (row.provider as string | null) ?? null,
    providerCustomerId: (row.provider_customer_id as string | null) ?? null,
    providerSubscriptionId: (row.provider_subscription_id as string | null) ?? null,
    lastPaymentStatus: (row.last_payment_status as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCheckout(row: Record<string, unknown>): BillingCheckoutRow {
  return {
    id: String(row.id),
    salonId: String(row.salon_id),
    planId: String(row.plan_id),
    provider: String(row.provider),
    amount: Number(row.amount),
    currency: String(row.currency),
    status: row.status as CheckoutSessionStatus,
    providerSessionId: (row.provider_session_id as string | null) ?? null,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

function mapPayment(row: Record<string, unknown>): BillingPaymentRow {
  return {
    id: String(row.id),
    salonId: String(row.salon_id),
    checkoutId: (row.checkout_id as string | null) ?? null,
    provider: String(row.provider),
    providerPaymentId: String(row.provider_payment_id),
    amount: Number(row.amount),
    currency: String(row.currency),
    status: row.status as PaymentRecordStatus,
    createdAt: String(row.created_at),
    paidAt: (row.paid_at as string | null) ?? null,
  };
}

export function createSupabaseBillingStore(): BillingStore {
  const db = supabase as any;

  return {
    async loadSalonActive(salonId) {
      const { data, error } = await db.from('salons').select('id, active').eq('id', salonId).maybeSingle();
      if (error) {
        console.error('[billing] salon read failed', { operation: 'load_salon_active' });
        throw new Error('Could not load salon');
      }
      if (!data) return 'missing';
      return data.active === true ? 'active' : 'inactive';
    },

    async loadSubscription(salonId) {
      const { data, error } = await db
        .from('salon_subscriptions')
        .select(SUB_SELECT)
        .eq('salon_id', salonId)
        .maybeSingle();
      if (error) {
        console.error('[billing] subscription read failed', { operation: 'load_subscription' });
        throw new Error('Could not load subscription');
      }
      if (!data) return null;
      return mapSubscription(data);
    },

    async upsertActivatedSubscription(input: UpsertSubscriptionActivation) {
      const updates = {
        plan: input.plan,
        status: 'active',
        current_period_start: input.currentPeriodStart,
        current_period_end: input.currentPeriodEnd,
        cancel_at_period_end: false,
        canceled_at: null,
        provider: input.provider,
        provider_customer_id: input.providerCustomerId,
        provider_subscription_id: input.providerSubscriptionId,
        last_payment_status: input.lastPaymentStatus,
        updated_at: input.nowIso,
      };

      const { data: updated, error: updateError } = await db
        .from('salon_subscriptions')
        .update(updates)
        .eq('salon_id', input.salonId)
        .select(SUB_SELECT)
        .maybeSingle();

      if (updateError) {
        console.error('[billing] subscription update failed', { operation: 'activate_subscription' });
        throw new Error('Could not activate subscription');
      }
      if (updated) return mapSubscription(updated);

      const { data: inserted, error: insertError } = await db
        .from('salon_subscriptions')
        .insert({
          salon_id: input.salonId,
          ...updates,
          developer_suspended: false,
          trial_ends_at: null,
        })
        .select(SUB_SELECT)
        .maybeSingle();

      if (insertError || !inserted) {
        const { data: raced, error: raceError } = await db
          .from('salon_subscriptions')
          .select(SUB_SELECT)
          .eq('salon_id', input.salonId)
          .maybeSingle();
        if (raceError || !raced) {
          console.error('[billing] subscription insert failed', { operation: 'activate_subscription_insert' });
          throw new Error('Could not activate subscription');
        }
        const { data: retry } = await db
          .from('salon_subscriptions')
          .update(updates)
          .eq('salon_id', input.salonId)
          .select(SUB_SELECT)
          .maybeSingle();
        if (!retry) throw new Error('Could not activate subscription');
        return mapSubscription(retry);
      }

      return mapSubscription(inserted);
    },

    async markCancelAtPeriodEnd(salonId, nowIso) {
      const existing = await this.loadSubscription(salonId);
      if (!existing) return null;
      if (existing.cancelAtPeriodEnd) {
        if (existing.canceledAt) return existing;
        const { data } = await db
          .from('salon_subscriptions')
          .update({ canceled_at: existing.canceledAt ?? nowIso, updated_at: nowIso })
          .eq('salon_id', salonId)
          .select(SUB_SELECT)
          .maybeSingle();
        return data ? mapSubscription(data) : existing;
      }

      const { data, error } = await db
        .from('salon_subscriptions')
        .update({
          cancel_at_period_end: true,
          canceled_at: nowIso,
          updated_at: nowIso,
        })
        .eq('salon_id', salonId)
        .select(SUB_SELECT)
        .maybeSingle();
      if (error) {
        console.error('[billing] cancel update failed', { operation: 'cancel_at_period_end' });
        throw new Error('Could not cancel subscription');
      }
      return data ? mapSubscription(data) : null;
    },

    async setLastPaymentStatus(salonId, status, nowIso) {
      const { error } = await db
        .from('salon_subscriptions')
        .update({ last_payment_status: status, updated_at: nowIso })
        .eq('salon_id', salonId);
      if (error) {
        console.error('[billing] last payment status update failed', { operation: 'set_last_payment_status' });
      }
    },

    async insertCheckout(row) {
      const { data, error } = await db
        .from('billing_checkout_sessions')
        .insert({
          id: row.id,
          salon_id: row.salonId,
          plan_id: row.planId,
          provider: row.provider,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          provider_session_id: row.providerSessionId,
          created_at: row.createdAt,
          expires_at: row.expiresAt,
          completed_at: row.completedAt,
        })
        .select(CHECKOUT_SELECT)
        .maybeSingle();
      if (error || !data) {
        console.error('[billing] checkout insert failed', { operation: 'insert_checkout' });
        throw new Error('Could not create checkout');
      }
      return mapCheckout(data);
    },

    async loadCheckout(id) {
      const { data, error } = await db
        .from('billing_checkout_sessions')
        .select(CHECKOUT_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (error) {
        console.error('[billing] checkout read failed', { operation: 'load_checkout' });
        throw new Error('Could not load checkout');
      }
      return data ? mapCheckout(data) : null;
    },

    async findPendingCheckout(salonId, planId, nowIso) {
      const { data, error } = await db
        .from('billing_checkout_sessions')
        .select(CHECKOUT_SELECT)
        .eq('salon_id', salonId)
        .eq('plan_id', planId)
        .eq('status', 'pending')
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error('[billing] pending checkout read failed', { operation: 'find_pending_checkout' });
        throw new Error('Could not load checkout');
      }
      return data ? mapCheckout(data) : null;
    },

    async completeCheckout(id, status, completedAt) {
      const { data, error } = await db
        .from('billing_checkout_sessions')
        .update({ status, completed_at: completedAt })
        .eq('id', id)
        .select(CHECKOUT_SELECT)
        .maybeSingle();
      if (error) {
        console.error('[billing] checkout complete failed', { operation: 'complete_checkout' });
        throw new Error('Could not complete checkout');
      }
      return data ? mapCheckout(data) : null;
    },

    async insertPayment(row) {
      const { data, error } = await db
        .from('subscription_payments')
        .insert({
          id: row.id,
          salon_id: row.salonId,
          checkout_id: row.checkoutId,
          provider: row.provider,
          provider_payment_id: row.providerPaymentId,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          created_at: row.createdAt,
          paid_at: row.paidAt,
        })
        .select(PAYMENT_SELECT)
        .maybeSingle();

      if (error) {
        if (isUniqueViolation(error)) {
          const existing = await this.loadPaymentByProviderId(row.provider, row.providerPaymentId);
          if (existing) return { row: existing, inserted: false };
        }
        console.error('[billing] payment insert failed', { operation: 'insert_payment' });
        throw new Error('Could not record payment');
      }
      if (!data) throw new Error('Could not record payment');
      return { row: mapPayment(data), inserted: true };
    },

    async loadPaymentByProviderId(provider, providerPaymentId) {
      const { data, error } = await db
        .from('subscription_payments')
        .select(PAYMENT_SELECT)
        .eq('provider', provider)
        .eq('provider_payment_id', providerPaymentId)
        .maybeSingle();
      if (error) {
        console.error('[billing] payment lookup failed', { operation: 'load_payment_by_provider_id' });
        throw new Error('Could not load payment');
      }
      return data ? mapPayment(data) : null;
    },

    async listPayments(salonId) {
      const { data, error } = await db
        .from('subscription_payments')
        .select(PAYMENT_SELECT)
        .eq('salon_id', salonId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) {
        console.error('[billing] payment list failed', { operation: 'list_payments' });
        throw new Error('Could not load payments');
      }
      return (data ?? []).map((row: Record<string, unknown>) => mapPayment(row));
    },
  };
}
