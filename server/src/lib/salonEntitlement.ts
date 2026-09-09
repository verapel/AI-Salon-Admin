/**
 * SUB-1B: Central salon subscription / AI entitlement helper.
 *
 * Pure evaluator + DB loader.
 * SUB-1D1: Telegram inbound uses getSalonEntitlements via telegramSubscriptionGate.
 * Still NOT wired into WhatsApp / Instagram / Apple / reminders / appointment routes.
 */

import { supabase } from './supabase.js';
import { buildLegacyActiveSubscriptionFallback, isSalonSubscriptionStatus } from './salonSubscription.js';
import type {
  DeveloperSalonEntitlementPublic,
  SalonEntitlementDenyReason,
  SalonEntitlements,
  SalonSubscriptionStatus,
} from '../types.js';

/** Thrown when the salon row does not exist (distinct from missing subscription). */
export class SalonEntitlementNotFoundError extends Error {
  readonly code = 'SALON_NOT_FOUND' as const;

  constructor(readonly salonId: string) {
    super('Salon not found');
    this.name = 'SalonEntitlementNotFoundError';
  }
}

export function isSalonEntitlementNotFoundError(
  value: unknown,
): value is SalonEntitlementNotFoundError {
  return value instanceof SalonEntitlementNotFoundError;
}

/** Input for the pure entitlement decision (injectable `now` for tests). */
export interface EvaluateSalonEntitlementInput {
  salonId: string;
  salonActive: boolean;
  plan: string;
  subscriptionStatus: SalonSubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  developerSuspended: boolean;
  usedMissingSubscriptionFallback?: boolean;
  usedSubscriptionReadFailureFallback?: boolean;
  usedSalonReadFailureFallback?: boolean;
}

export type SalonActiveLoadResult =
  | { kind: 'ok'; active: boolean }
  | { kind: 'not_found' }
  | { kind: 'read_error' };

export type SubscriptionEntitlementSnapshot = {
  plan: string;
  subscriptionStatus: SalonSubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  developerSuspended: boolean;
  usedMissingSubscriptionFallback: boolean;
  usedSubscriptionReadFailureFallback: boolean;
};

export type SalonEntitlementStore = {
  loadSalonActive: (salonId: string) => Promise<SalonActiveLoadResult>;
  loadSubscriptionSnapshot: (salonId: string) => Promise<SubscriptionEntitlementSnapshot>;
};

type SubscriptionDbRow = {
  plan: string;
  status: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  developer_suspended: boolean;
};

/**
 * Parse timestamptz / ISO instant for comparison. Invalid → treat as null (no expiry).
 */
export function parseEntitlementInstant(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** True when expiry instant is still strictly after `now` (exact equality = expired). */
function isInstantStillValid(endsAt: string | null, now: Date): boolean {
  const end = parseEntitlementInstant(endsAt);
  if (!end) return true;
  return end.getTime() > now.getTime();
}

function allow(
  input: EvaluateSalonEntitlementInput,
  extras: Pick<
    SalonEntitlements,
    | 'usedMissingSubscriptionFallback'
    | 'usedSubscriptionReadFailureFallback'
    | 'usedSalonReadFailureFallback'
  >,
): SalonEntitlements {
  return {
    salonId: input.salonId,
    salonActive: input.salonActive,
    plan: input.plan,
    subscriptionStatus: input.subscriptionStatus,
    trialEndsAt: input.trialEndsAt,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    developerSuspended: input.developerSuspended,
    aiAutomationAllowed: true,
    denyReason: null,
    ...extras,
  };
}

function deny(
  input: EvaluateSalonEntitlementInput,
  reason: SalonEntitlementDenyReason,
  extras: Pick<
    SalonEntitlements,
    | 'usedMissingSubscriptionFallback'
    | 'usedSubscriptionReadFailureFallback'
    | 'usedSalonReadFailureFallback'
  >,
): SalonEntitlements {
  return {
    salonId: input.salonId,
    salonActive: input.salonActive,
    plan: input.plan,
    subscriptionStatus: input.subscriptionStatus,
    trialEndsAt: input.trialEndsAt,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    developerSuspended: input.developerSuspended,
    aiAutomationAllowed: false,
    denyReason: reason,
    ...extras,
  };
}

/**
 * Pure entitlement decision. Deterministic given `input` + `now`.
 *
 * Precedence:
 * A. salon inactive → salon_inactive
 * B. developer_suspended → developer_suspended
 * C. trial (+ trial_ends_at)
 * D. active (+ current_period_end)
 * E. past_due / expired / cancelled
 *
 * cancel_at_period_end does NOT deny while the current period is still valid.
 */
export function evaluateSalonEntitlement(
  input: EvaluateSalonEntitlementInput,
  now: Date = new Date(),
): SalonEntitlements {
  const extras = {
    usedMissingSubscriptionFallback: input.usedMissingSubscriptionFallback === true,
    usedSubscriptionReadFailureFallback: input.usedSubscriptionReadFailureFallback === true,
    usedSalonReadFailureFallback: input.usedSalonReadFailureFallback === true,
  };

  // A. Ops kill-switch (distinct from subscription status)
  if (input.salonActive === false) {
    return deny(input, 'salon_inactive', extras);
  }

  // B. Developer suspension
  if (input.developerSuspended === true) {
    return deny(input, 'developer_suspended', extras);
  }

  const status = input.subscriptionStatus;

  // C. Trial
  if (status === 'trial') {
    if (!isInstantStillValid(input.trialEndsAt, now)) {
      return deny(input, 'trial_expired', extras);
    }
    return allow(input, extras);
  }

  // D. Active (null period end = no billing expiry yet; cancel_at_period_end ignored here)
  if (status === 'active') {
    if (!isInstantStillValid(input.currentPeriodEnd, now)) {
      return deny(input, 'subscription_expired', extras);
    }
    return allow(input, extras);
  }

  // E–G. Terminal / blocked statuses
  if (status === 'unpaid') {
    return deny(input, 'subscription_unpaid', extras);
  }
  if (status === 'past_due') {
    return deny(input, 'subscription_past_due', extras);
  }
  if (status === 'expired') {
    return deny(input, 'subscription_expired', extras);
  }
  if (status === 'cancelled') {
    return deny(input, 'subscription_cancelled', extras);
  }

  // Unknown status should not appear after CHECK; fail closed on entitlement.
  return deny(input, 'subscription_expired', extras);
}

async function defaultLoadSalonActive(salonId: string): Promise<SalonActiveLoadResult> {
  const { data, error } = await (supabase as any)
    .from('salons')
    .select('id, active')
    .eq('id', salonId)
    .maybeSingle();

  if (error) {
    console.error('[entitlement] salon read failed; fail-safe assuming active', {
      salonId,
      operation: 'get_salon_entitlements_salon',
    });
    return { kind: 'read_error' };
  }
  if (!data) {
    return { kind: 'not_found' };
  }
  return { kind: 'ok', active: data.active === true };
}

async function defaultLoadSubscriptionSnapshot(
  salonId: string,
): Promise<SubscriptionEntitlementSnapshot> {
  const { data, error } = await (supabase as any)
    .from('salon_subscriptions')
    .select(
      `
      plan,
      status,
      trial_ends_at,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      developer_suspended
    `,
    )
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    console.error('[entitlement] subscription read failed; using legacy active fallback', {
      salonId,
      operation: 'get_salon_entitlements_subscription',
    });
    const fb = buildLegacyActiveSubscriptionFallback(salonId);
    return {
      plan: fb.plan,
      subscriptionStatus: fb.status,
      trialEndsAt: fb.trialEndsAt,
      currentPeriodStart: fb.currentPeriodStart,
      currentPeriodEnd: fb.currentPeriodEnd,
      cancelAtPeriodEnd: fb.cancelAtPeriodEnd,
      developerSuspended: fb.developerSuspended,
      usedMissingSubscriptionFallback: false,
      usedSubscriptionReadFailureFallback: true,
    };
  }

  if (!data) {
    const fb = buildLegacyActiveSubscriptionFallback(salonId);
    return {
      plan: fb.plan,
      subscriptionStatus: fb.status,
      trialEndsAt: fb.trialEndsAt,
      currentPeriodStart: fb.currentPeriodStart,
      currentPeriodEnd: fb.currentPeriodEnd,
      cancelAtPeriodEnd: fb.cancelAtPeriodEnd,
      developerSuspended: fb.developerSuspended,
      usedMissingSubscriptionFallback: true,
      usedSubscriptionReadFailureFallback: false,
    };
  }

  const row = data as SubscriptionDbRow;
  const status = isSalonSubscriptionStatus(row.status) ? row.status : 'active';
  return {
    plan: typeof row.plan === 'string' && row.plan.trim() ? row.plan.trim() : 'standard',
    subscriptionStatus: status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    developerSuspended: row.developer_suspended === true,
    usedMissingSubscriptionFallback: false,
    usedSubscriptionReadFailureFallback: false,
  };
}

const defaultStore: SalonEntitlementStore = {
  loadSalonActive: defaultLoadSalonActive,
  loadSubscriptionSnapshot: defaultLoadSubscriptionSnapshot,
};

/**
 * Load salon + subscription and evaluate entitlements.
 * Salon-not-found → throws SalonEntitlementNotFoundError.
 * Read failures → fail-safe (do not silently deny production salons).
 * Never mutates DB. Not used by messenger runtimes in SUB-1B.
 */
export async function getSalonEntitlements(
  salonId: string,
  options?: {
    now?: Date;
    store?: SalonEntitlementStore;
  },
): Promise<SalonEntitlements> {
  const trimmed = salonId.trim();
  const now = options?.now ?? new Date();
  const store = options?.store ?? defaultStore;

  if (!trimmed) {
    throw new SalonEntitlementNotFoundError('');
  }

  const salonResult = await store.loadSalonActive(trimmed);
  if (salonResult.kind === 'not_found') {
    throw new SalonEntitlementNotFoundError(trimmed);
  }

  const usedSalonReadFailureFallback = salonResult.kind === 'read_error';
  const salonActive = salonResult.kind === 'ok' ? salonResult.active : true;

  const sub = await store.loadSubscriptionSnapshot(trimmed);

  return evaluateSalonEntitlement(
    {
      salonId: trimmed,
      salonActive,
      plan: sub.plan,
      subscriptionStatus: sub.subscriptionStatus,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      developerSuspended: sub.developerSuspended,
      usedMissingSubscriptionFallback: sub.usedMissingSubscriptionFallback,
      usedSubscriptionReadFailureFallback: sub.usedSubscriptionReadFailureFallback,
      usedSalonReadFailureFallback,
    },
    now,
  );
}

/** Safe developer DTO — omits payment-provider customer/subscription linkage ids. */
export function toDeveloperSalonEntitlementPublic(
  entitlements: SalonEntitlements,
): DeveloperSalonEntitlementPublic {
  return {
    salonId: entitlements.salonId,
    salonActive: entitlements.salonActive,
    plan: entitlements.plan,
    status: entitlements.subscriptionStatus,
    trialEndsAt: entitlements.trialEndsAt,
    currentPeriodStart: entitlements.currentPeriodStart,
    currentPeriodEnd: entitlements.currentPeriodEnd,
    cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
    developerSuspended: entitlements.developerSuspended,
    aiAutomationAllowed: entitlements.aiAutomationAllowed,
    denyReason: entitlements.denyReason,
    usedMissingSubscriptionFallback: entitlements.usedMissingSubscriptionFallback,
  };
}
