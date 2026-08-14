/**
 * SUB-1C: Developer subscription read/update helpers.
 * Uses SUB-1B getSalonEntitlements for derived AI entitlement.
 * Does NOT enforce messengers. No payment-provider fields.
 */

import { supabase } from './supabase.js';
import {
  getSalonEntitlements,
  isSalonEntitlementNotFoundError,
  SalonEntitlementNotFoundError,
} from './salonEntitlement.js';
import { isSalonSubscriptionStatus } from './salonSubscription.js';
import type {
  DeveloperSalonSubscriptionApiResponse,
  DeveloperSalonSubscriptionUpdateRequest,
  SalonEntitlements,
  SalonSubscriptionStatus,
} from '../types.js';
import {
  DEVELOPER_SALON_SUBSCRIPTION_PATCH_FIELDS,
  DEVELOPER_SALON_SUBSCRIPTION_PLANS,
} from '../types.js';

export class DeveloperSalonSubscriptionValidationError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeveloperSalonSubscriptionValidationError';
  }
}

export function isDeveloperSalonSubscriptionValidationError(
  value: unknown,
): value is DeveloperSalonSubscriptionValidationError {
  return value instanceof DeveloperSalonSubscriptionValidationError;
}

type SubscriptionRow = {
  salon_id: string;
  plan: string;
  status: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  developer_suspended: boolean;
  updated_at: string;
};

const SUBSCRIPTION_SELECT = `
  salon_id,
  plan,
  status,
  trial_ends_at,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  developer_suspended,
  updated_at
`;

export function toDeveloperSalonSubscriptionApiResponse(
  entitlements: SalonEntitlements,
  updatedAt: string | null,
): DeveloperSalonSubscriptionApiResponse {
  return {
    salonId: entitlements.salonId,
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
    usedSubscriptionReadFailureFallback: entitlements.usedSubscriptionReadFailureFallback,
    usedSalonReadFailureFallback: entitlements.usedSalonReadFailureFallback,
    updatedAt,
  };
}

/**
 * Accept null/empty → null; otherwise require a parseable ISO/timestamptz instant
 * and normalize to UTC ISO string (no silent local reinterpretation of free text).
 */
export function parseOptionalIsoTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new DeveloperSalonSubscriptionValidationError(`Invalid ${field}`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Require an explicit date-time form (ISO-8601-like), not bare locale dates.
  if (!/^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
    throw new DeveloperSalonSubscriptionValidationError(`Invalid ${field}`);
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new DeveloperSalonSubscriptionValidationError(`Invalid ${field}`);
  }
  return new Date(ms).toISOString();
}

export function parseDeveloperSalonSubscriptionPatch(
  body: unknown,
): DeveloperSalonSubscriptionUpdateRequest {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new DeveloperSalonSubscriptionValidationError('Invalid request body');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set<string>(DEVELOPER_SALON_SUBSCRIPTION_PATCH_FIELDS);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DeveloperSalonSubscriptionValidationError(`Unknown field: ${key}`);
    }
  }

  const patch: DeveloperSalonSubscriptionUpdateRequest = {};

  if (record.plan !== undefined) {
    if (typeof record.plan !== 'string' || !record.plan.trim()) {
      throw new DeveloperSalonSubscriptionValidationError('Invalid plan');
    }
    const plan = record.plan.trim();
    if (!(DEVELOPER_SALON_SUBSCRIPTION_PLANS as readonly string[]).includes(plan)) {
      throw new DeveloperSalonSubscriptionValidationError('Invalid plan');
    }
    patch.plan = plan;
  }

  if (record.status !== undefined) {
    if (!isSalonSubscriptionStatus(record.status)) {
      throw new DeveloperSalonSubscriptionValidationError('Invalid status');
    }
    patch.status = record.status;
  }

  if (record.trialEndsAt !== undefined) {
    patch.trialEndsAt = parseOptionalIsoTimestamp(record.trialEndsAt, 'trialEndsAt');
  }
  if (record.currentPeriodStart !== undefined) {
    patch.currentPeriodStart = parseOptionalIsoTimestamp(
      record.currentPeriodStart,
      'currentPeriodStart',
    );
  }
  if (record.currentPeriodEnd !== undefined) {
    patch.currentPeriodEnd = parseOptionalIsoTimestamp(
      record.currentPeriodEnd,
      'currentPeriodEnd',
    );
  }

  if (record.cancelAtPeriodEnd !== undefined) {
    if (typeof record.cancelAtPeriodEnd !== 'boolean') {
      throw new DeveloperSalonSubscriptionValidationError('Invalid cancelAtPeriodEnd');
    }
    patch.cancelAtPeriodEnd = record.cancelAtPeriodEnd;
  }

  if (record.developerSuspended !== undefined) {
    if (typeof record.developerSuspended !== 'boolean') {
      throw new DeveloperSalonSubscriptionValidationError('Invalid developerSuspended');
    }
    patch.developerSuspended = record.developerSuspended;
  }

  if (Object.keys(patch).length === 0) {
    throw new DeveloperSalonSubscriptionValidationError('No valid fields to update');
  }

  return patch;
}

async function assertSalonExists(salonId: string): Promise<void> {
  const { data, error } = await (supabase as any)
    .from('salons')
    .select('id')
    .eq('id', salonId)
    .maybeSingle();

  if (error) {
    console.error('[subscription] salon existence check failed', {
      salonId,
      operation: 'developer_subscription_salon_check',
    });
    throw new Error('Could not load salon subscription');
  }
  if (!data) {
    throw new SalonEntitlementNotFoundError(salonId);
  }
}

/**
 * Ensure a subscription row exists for an existing salon (SUB-1A repair).
 * Does not create subscriptions for nonexistent salons.
 */
export async function ensureSalonSubscriptionRowForExistingSalon(
  salonId: string,
): Promise<SubscriptionRow> {
  const { data, error } = await (supabase as any)
    .from('salon_subscriptions')
    .select(SUBSCRIPTION_SELECT)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    console.error('[subscription] ensure read failed', {
      salonId,
      operation: 'developer_subscription_ensure_read',
    });
    throw new Error('Could not load salon subscription');
  }

  if (data) {
    return data as SubscriptionRow;
  }

  const { data: inserted, error: insertError } = await (supabase as any)
    .from('salon_subscriptions')
    .insert({
      salon_id: salonId,
      plan: 'standard',
      status: 'active',
      developer_suspended: false,
      cancel_at_period_end: false,
      trial_ends_at: null,
      current_period_start: null,
      current_period_end: null,
    })
    .select(SUBSCRIPTION_SELECT)
    .maybeSingle();

  if (insertError || !inserted) {
    // Race with trigger: re-read
    const { data: raced, error: raceError } = await (supabase as any)
      .from('salon_subscriptions')
      .select(SUBSCRIPTION_SELECT)
      .eq('salon_id', salonId)
      .maybeSingle();
    if (raceError || !raced) {
      console.error('[subscription] ensure insert failed', {
        salonId,
        operation: 'developer_subscription_ensure_insert',
      });
      throw new Error('Could not create salon subscription');
    }
    return raced as SubscriptionRow;
  }

  return inserted as SubscriptionRow;
}

async function loadSubscriptionUpdatedAt(salonId: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from('salon_subscriptions')
    .select('updated_at')
    .eq('salon_id', salonId)
    .maybeSingle();
  if (error || !data) return null;
  return typeof data.updated_at === 'string' ? data.updated_at : null;
}

/** GET developer subscription + entitlement for an existing salon. */
export async function getDeveloperSalonSubscription(
  salonId: string,
): Promise<DeveloperSalonSubscriptionApiResponse> {
  const trimmed = salonId.trim();
  if (!trimmed) {
    throw new SalonEntitlementNotFoundError('');
  }

  await assertSalonExists(trimmed);
  // Repair missing row for existing salon before entitlement read (GET remains readable).
  const row = await ensureSalonSubscriptionRowForExistingSalon(trimmed);
  const entitlements = await getSalonEntitlements(trimmed);
  return toDeveloperSalonSubscriptionApiResponse(entitlements, row.updated_at ?? null);
}

/** PATCH developer subscription fields; recomputes entitlement via SUB-1B helper. */
export async function updateDeveloperSalonSubscription(
  salonId: string,
  body: unknown,
): Promise<DeveloperSalonSubscriptionApiResponse> {
  const trimmed = salonId.trim();
  if (!trimmed) {
    throw new SalonEntitlementNotFoundError('');
  }

  const patch = parseDeveloperSalonSubscriptionPatch(body);
  await assertSalonExists(trimmed);
  await ensureSalonSubscriptionRowForExistingSalon(trimmed);

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.plan !== undefined) updates.plan = patch.plan;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.trialEndsAt !== undefined) updates.trial_ends_at = patch.trialEndsAt;
  if (patch.currentPeriodStart !== undefined) {
    updates.current_period_start = patch.currentPeriodStart;
  }
  if (patch.currentPeriodEnd !== undefined) {
    updates.current_period_end = patch.currentPeriodEnd;
  }
  if (patch.cancelAtPeriodEnd !== undefined) {
    updates.cancel_at_period_end = patch.cancelAtPeriodEnd;
  }
  if (patch.developerSuspended !== undefined) {
    updates.developer_suspended = patch.developerSuspended;
  }

  const { data: updated, error } = await (supabase as any)
    .from('salon_subscriptions')
    .update(updates)
    .eq('salon_id', trimmed)
    .select(SUBSCRIPTION_SELECT)
    .maybeSingle();

  if (error) {
    console.error('[subscription] developer update failed', {
      salonId: trimmed,
      operation: 'developer_subscription_update',
    });
    throw new Error('Could not update salon subscription');
  }
  if (!updated) {
    throw new SalonEntitlementNotFoundError(trimmed);
  }

  // Never mutate salons.active here — subscription is independent.
  const entitlements = await getSalonEntitlements(trimmed);
  const updatedAt =
    typeof (updated as SubscriptionRow).updated_at === 'string'
      ? (updated as SubscriptionRow).updated_at
      : await loadSubscriptionUpdatedAt(trimmed);

  return toDeveloperSalonSubscriptionApiResponse(entitlements, updatedAt);
}

export type DeveloperSalonSubscriptionListItem = {
  salonId: string;
  salonName: string;
  salonActive: boolean;
  subscription: DeveloperSalonSubscriptionApiResponse | null;
  loadError: boolean;
};

/**
 * SUB-1C2: List all salons with safe subscription/entitlement snapshots.
 * Per-salon failures become row.loadError=true (do not fail the whole list).
 * Reuses getDeveloperSalonSubscription — no duplicated entitlement logic.
 */
export async function listDeveloperSalonSubscriptions(): Promise<
  DeveloperSalonSubscriptionListItem[]
> {
  const { data, error } = await (supabase as any)
    .from('salons')
    .select('id, name, active')
    .order('name');

  if (error) {
    console.error('[subscription] list salons failed', {
      operation: 'developer_subscriptions_list',
    });
    throw new Error('Could not load salon subscriptions');
  }

  const salons = (data ?? []) as { id: string; name: string; active: boolean }[];

  const rows = await Promise.all(
    salons.map(async (salon): Promise<DeveloperSalonSubscriptionListItem> => {
      try {
        const subscription = await getDeveloperSalonSubscription(salon.id);
        return {
          salonId: salon.id,
          salonName: salon.name,
          salonActive: salon.active === true,
          subscription,
          loadError: false,
        };
      } catch {
        return {
          salonId: salon.id,
          salonName: salon.name,
          salonActive: salon.active === true,
          subscription: null,
          loadError: true,
        };
      }
    }),
  );

  return rows;
}

export {
  isSalonEntitlementNotFoundError,
  SalonEntitlementNotFoundError,
  isSalonSubscriptionStatus,
};

export type { SalonSubscriptionStatus };
