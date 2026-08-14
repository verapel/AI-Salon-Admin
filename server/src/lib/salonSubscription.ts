/**
 * SUB-1A: Neutral salon subscription read helper.
 * Does NOT enforce entitlements or gate messengers (that is SUB-1B / SUB-1D).
 */

import { supabase } from './supabase.js';
import type {
  DeveloperSalonSubscriptionPublic,
  SalonSubscriptionRecord,
  SalonSubscriptionStatus,
} from '../types.js';
import { SALON_SUBSCRIPTION_STATUSES } from '../types.js';

type SubscriptionDbRow = {
  salon_id: string;
  plan: string;
  status: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  developer_suspended: boolean;
  provider: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  last_payment_status: string | null;
  created_at: string;
  updated_at: string;
};

export function isSalonSubscriptionStatus(value: unknown): value is SalonSubscriptionStatus {
  return (
    typeof value === 'string' &&
    (SALON_SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Legacy-safe missing-row fallback for SUB-1A reads.
 * Matches migration backfill defaults: active / standard / no expiry / not suspended.
 * MUST NOT be interpreted as "disable salon" by callers in this stage.
 */
export function buildLegacyActiveSubscriptionFallback(
  salonId: string,
): SalonSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    salonId,
    plan: 'standard',
    status: 'active',
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    developerSuspended: false,
    provider: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    lastPaymentStatus: null,
    createdAt: now,
    updatedAt: now,
    usedMissingRowFallback: true,
  };
}

function mapSubscriptionRow(row: SubscriptionDbRow): SalonSubscriptionRecord {
  const status = isSalonSubscriptionStatus(row.status) ? row.status : 'active';
  return {
    salonId: row.salon_id,
    plan: typeof row.plan === 'string' && row.plan.trim() ? row.plan.trim() : 'standard',
    status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    developerSuspended: row.developer_suspended === true,
    provider: row.provider,
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    lastPaymentStatus: row.last_payment_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usedMissingRowFallback: false,
  };
}

/** Safe developer DTO — excludes provider customer/subscription linkage ids. */
export function toDeveloperSalonSubscriptionPublic(
  record: SalonSubscriptionRecord,
): DeveloperSalonSubscriptionPublic {
  return {
    salonId: record.salonId,
    plan: record.plan,
    status: record.status,
    trialEndsAt: record.trialEndsAt,
    currentPeriodStart: record.currentPeriodStart,
    currentPeriodEnd: record.currentPeriodEnd,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    developerSuspended: record.developerSuspended,
    provider: record.provider,
    lastPaymentStatus: record.lastPaymentStatus,
    usedMissingRowFallback: record.usedMissingRowFallback,
  };
}

/**
 * Load salon_subscriptions for a salon.
 * Missing row → legacy active fallback (does not disable the salon).
 * Never mutates DB. Never gates messengers.
 */
export async function getSalonSubscription(salonId: string): Promise<SalonSubscriptionRecord> {
  const trimmed = salonId.trim();
  if (!trimmed) {
    return buildLegacyActiveSubscriptionFallback('');
  }

  const { data, error } = await (supabase as any)
    .from('salon_subscriptions')
    .select(
      `
      salon_id,
      plan,
      status,
      trial_ends_at,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      developer_suspended,
      provider,
      provider_customer_id,
      provider_subscription_id,
      last_payment_status,
      created_at,
      updated_at
    `,
    )
    .eq('salon_id', trimmed)
    .maybeSingle();

  if (error) {
    // Fail-safe for SUB-1A: read errors must not become a production outage gate.
    console.error('[subscription] getSalonSubscription read failed; using legacy fallback', {
      salonId: trimmed,
      operation: 'get_salon_subscription',
    });
    return buildLegacyActiveSubscriptionFallback(trimmed);
  }

  if (!data) {
    return buildLegacyActiveSubscriptionFallback(trimmed);
  }

  return mapSubscriptionRow(data as SubscriptionDbRow);
}
