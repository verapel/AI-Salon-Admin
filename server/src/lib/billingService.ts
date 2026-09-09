import { randomUUID } from 'node:crypto';
import { computeMonthlyPeriod } from './billingPeriod.js';
import type { BillingCheckoutRow, BillingPaymentRow, BillingStore, BillingSubscriptionRow } from './billingStore.js';
import { parseEntitlementInstant, evaluateSalonEntitlement } from './salonEntitlement.js';
import { buildLegacyActiveSubscriptionFallback, isSalonSubscriptionStatus } from './salonSubscription.js';
import { getPaidSubscriptionPlan, isPaidPlanId, PAID_PLAN_ID, type SubscriptionPlan } from './subscriptionPlan.js';
import {
  getPaymentProvider,
  isPaymentProviderNotReadyError,
  type CheckoutOutcome,
  type PaymentProvider,
} from './payment/index.js';
import type { SalonEntitlements, SalonSubscriptionStatus } from '../types.js';

export class BillingError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isBillingError(value: unknown): value is BillingError {
  return value instanceof BillingError;
}

const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export interface PublicPlanDto {
  id: string;
  amount: number;
  currency: string;
  interval: 'month';
}

export interface PublicProviderDto {
  id: string;
  displayName: string;
  supportsAutomaticRecurring: boolean;
}

export interface PublicPaymentDto {
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  createdAt: string;
  paidAt: string | null;
  provider: string;
}

export interface OwnerSubscriptionDto {
  plan: PublicPlanDto;
  provider: PublicProviderDto;
  entitled: boolean;
  denyReason: string | null;
  hasManagedPaidPeriod: boolean;
  isComplimentary: boolean;
  status: SalonSubscriptionStatus;
  displayStatus: 'unpaid' | 'active' | 'cancel_at_period_end' | 'expired' | 'past_due' | 'failed';
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  payments: PublicPaymentDto[];
}

export interface CreateCheckoutResult {
  checkoutId: string;
  hostedPaymentPath: string;
  plan: PublicPlanDto;
  amount: number;
  currency: string;
  provider: PublicProviderDto;
  isTest: boolean;
  expiresAt: string;
}

export interface CheckoutView {
  checkoutId: string;
  salonId: string;
  status: string;
  plan: PublicPlanDto;
  amount: number;
  currency: string;
  provider: PublicProviderDto;
  isTest: boolean;
  expiresAt: string;
}

export interface BillingServiceDeps {
  store: BillingStore;
  provider?: PaymentProvider;
  plan?: SubscriptionPlan;
  now?: () => Date;
}

function toPublicPayment(row: BillingPaymentRow): PublicPaymentDto {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    provider: row.provider,
  };
}

function subscriptionToEvaluateInput(
  salonId: string,
  salonActive: boolean,
  sub: BillingSubscriptionRow | null,
) {
  if (!sub) {
    const fb = buildLegacyActiveSubscriptionFallback(salonId);
    return {
      salonId,
      salonActive,
      plan: fb.plan,
      subscriptionStatus: fb.status,
      trialEndsAt: fb.trialEndsAt,
      currentPeriodStart: fb.currentPeriodStart,
      currentPeriodEnd: fb.currentPeriodEnd,
      cancelAtPeriodEnd: fb.cancelAtPeriodEnd,
      developerSuspended: fb.developerSuspended,
      usedMissingSubscriptionFallback: true,
      usedSubscriptionReadFailureFallback: false,
      usedSalonReadFailureFallback: false,
    };
  }
  return {
    salonId,
    salonActive,
    plan: sub.plan,
    subscriptionStatus: isSalonSubscriptionStatus(sub.status) ? sub.status : 'active',
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    developerSuspended: sub.developerSuspended,
    usedMissingSubscriptionFallback: false,
    usedSubscriptionReadFailureFallback: false,
    usedSalonReadFailureFallback: false,
  };
}

export function hasManagedPaidPeriod(
  sub: Pick<BillingSubscriptionRow, 'status' | 'currentPeriodEnd'> | null,
  now: Date,
): boolean {
  if (!sub) return false;
  if (sub.status !== 'active' && sub.status !== 'trial') return false;
  const end = parseEntitlementInstant(sub.currentPeriodEnd);
  return end != null && end.getTime() > now.getTime();
}

function displayStatus(
  entitlements: SalonEntitlements,
  sub: BillingSubscriptionRow | null,
  now: Date,
): OwnerSubscriptionDto['displayStatus'] {
  if (entitlements.aiAutomationAllowed) {
    if (sub?.cancelAtPeriodEnd) return 'cancel_at_period_end';
    return 'active';
  }
  if (entitlements.denyReason === 'subscription_past_due') return 'past_due';
  if (entitlements.denyReason === 'subscription_unpaid') return 'unpaid';
  if (sub?.lastPaymentStatus === 'failed' && !hasManagedPaidPeriod(sub, now)) return 'failed';
  return 'expired';
}

export function createBillingService(deps: BillingServiceDeps) {
  const store = deps.store;
  const provider = deps.provider ?? getPaymentProvider();
  const plan = deps.plan ?? getPaidSubscriptionPlan();
  const nowFn = deps.now ?? (() => new Date());

  function publicPlan(): PublicPlanDto {
    return {
      id: plan.id,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
    };
  }

  function publicProvider(): PublicProviderDto {
    return {
      id: provider.id,
      displayName: provider.displayName,
      supportsAutomaticRecurring: provider.supportsAutomaticRecurring,
    };
  }

  async function loadEntitledSnapshot(salonId: string, now: Date) {
    const salonState = await store.loadSalonActive(salonId);
    if (salonState === 'missing') {
      throw new BillingError('SALON_NOT_FOUND', 'Salon not found', 404);
    }
    const sub = await store.loadSubscription(salonId);
    const entitlements = evaluateSalonEntitlement(
      subscriptionToEvaluateInput(salonId, salonState === 'active', sub),
      now,
    );
    return { sub, entitlements, salonActive: salonState === 'active' };
  }

  async function getOwnerSubscription(salonId: string): Promise<OwnerSubscriptionDto> {
    const now = nowFn();
    const { sub, entitlements } = await loadEntitledSnapshot(salonId, now);
    const payments = await store.listPayments(salonId);
    const complimentary =
      entitlements.aiAutomationAllowed && !hasManagedPaidPeriod(sub, now) && !sub?.cancelAtPeriodEnd;

    return {
      plan: publicPlan(),
      provider: publicProvider(),
      entitled: entitlements.aiAutomationAllowed,
      denyReason: entitlements.denyReason,
      hasManagedPaidPeriod: hasManagedPaidPeriod(sub, now),
      isComplimentary: complimentary,
      status: entitlements.subscriptionStatus,
      displayStatus: displayStatus(entitlements, sub, now),
      currentPeriodStart: sub?.currentPeriodStart ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd === true,
      canceledAt: sub?.canceledAt ?? null,
      payments: payments.map(toPublicPayment),
    };
  }

  async function isEntitled(salonId: string): Promise<boolean> {
    const now = nowFn();
    const { entitlements } = await loadEntitledSnapshot(salonId, now);
    return entitlements.aiAutomationAllowed;
  }

  async function createCheckout(salonId: string, requestedPlanId: unknown): Promise<CreateCheckoutResult> {
    const now = nowFn();
    if (requestedPlanId != null && !isPaidPlanId(requestedPlanId)) {
      throw new BillingError('INVALID_PLAN', 'Unknown plan', 400);
    }
    const { sub } = await loadEntitledSnapshot(salonId, now);
    if (hasManagedPaidPeriod(sub, now)) {
      throw new BillingError('ALREADY_SUBSCRIBED', 'An active paid period already exists', 409);
    }

    const pending = await store.findPendingCheckout(salonId, PAID_PLAN_ID, now.toISOString());
    if (pending) {
      return {
        checkoutId: pending.id,
        hostedPaymentPath: `/subscription/checkout/${pending.id}`,
        plan: publicPlan(),
        amount: pending.amount,
        currency: pending.currency,
        provider: publicProvider(),
        isTest: provider.id === 'test',
        expiresAt: pending.expiresAt,
      };
    }

    const checkoutId = randomUUID();
    let created;
    try {
      created = await provider.createCheckout({
        salonId,
        checkoutId,
        planId: plan.id,
        amount: plan.amount,
        currency: plan.currency,
      });
    } catch (err) {
      if (isPaymentProviderNotReadyError(err)) {
        throw new BillingError('PROVIDER_NOT_READY', err.message, 503);
      }
      throw err;
    }

    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS).toISOString();
    const row: BillingCheckoutRow = {
      id: checkoutId,
      salonId,
      planId: plan.id,
      provider: created.provider,
      amount: plan.amount,
      currency: plan.currency,
      status: 'pending',
      providerSessionId: created.providerSessionId,
      createdAt,
      expiresAt,
      completedAt: null,
    };
    await store.insertCheckout(row);

    return {
      checkoutId,
      hostedPaymentPath: created.hostedPaymentPath,
      plan: publicPlan(),
      amount: plan.amount,
      currency: plan.currency,
      provider: publicProvider(),
      isTest: provider.id === 'test',
      expiresAt,
    };
  }

  async function getCheckout(salonId: string, checkoutId: string): Promise<CheckoutView> {
    const checkout = await store.loadCheckout(checkoutId);
    if (!checkout || checkout.salonId !== salonId) {
      throw new BillingError('CHECKOUT_NOT_FOUND', 'Checkout not found', 404);
    }
    return {
      checkoutId: checkout.id,
      salonId: checkout.salonId,
      status: checkout.status,
      plan: publicPlan(),
      amount: checkout.amount,
      currency: checkout.currency,
      provider: publicProvider(),
      isTest: checkout.provider === 'test',
      expiresAt: checkout.expiresAt,
    };
  }

  async function applyProviderEvent(event: {
    salonId: string;
    checkoutId: string;
    provider: string;
    providerPaymentId: string;
    amount: number;
    currency: string;
    status: 'succeeded' | 'failed';
    paidAt: string | null;
  }): Promise<OwnerSubscriptionDto> {
    const now = nowFn();
    const checkout = await store.loadCheckout(event.checkoutId);
    if (!checkout || checkout.salonId !== event.salonId) {
      throw new BillingError('CHECKOUT_NOT_FOUND', 'Checkout not found', 404);
    }

    if (checkout.status === 'succeeded') {
      return getOwnerSubscription(event.salonId);
    }

    const paymentId = randomUUID();
    const { row: payment, inserted } = await store.insertPayment({
      id: paymentId,
      salonId: event.salonId,
      checkoutId: checkout.id,
      provider: event.provider,
      providerPaymentId: event.providerPaymentId,
      amount: event.amount,
      currency: event.currency,
      status: event.status,
      createdAt: now.toISOString(),
      paidAt: event.status === 'succeeded' ? event.paidAt ?? now.toISOString() : null,
    });

    if (event.status === 'failed') {
      if (inserted && checkout.status === 'pending') {
        await store.completeCheckout(checkout.id, 'failed', now.toISOString());
        await store.setLastPaymentStatus(event.salonId, 'failed', now.toISOString());
      }
      return getOwnerSubscription(event.salonId);
    }

    if (checkout.status === 'pending' || inserted) {
      const period = computeMonthlyPeriod(now);
      await store.upsertActivatedSubscription({
        salonId: event.salonId,
        plan: checkout.planId,
        provider: event.provider,
        providerCustomerId: `${event.provider}_cus_${event.salonId}`,
        providerSubscriptionId: `${event.provider}_sub_${event.salonId}`,
        currentPeriodStart: period.currentPeriodStart,
        currentPeriodEnd: period.currentPeriodEnd,
        lastPaymentStatus: 'succeeded',
        nowIso: now.toISOString(),
      });
      if (checkout.status === 'pending') {
        await store.completeCheckout(checkout.id, 'succeeded', payment.paidAt ?? now.toISOString());
      }
    }

    return getOwnerSubscription(event.salonId);
  }

  async function completeTestCheckout(
    salonId: string,
    checkoutId: string,
    outcome: CheckoutOutcome,
  ): Promise<OwnerSubscriptionDto> {
    if (provider.id !== 'test') {
      throw new BillingError(
        'TEST_COMPLETE_DISABLED',
        'Test completion is only available for the test payment provider',
        409,
      );
    }
    if (outcome !== 'success' && outcome !== 'failure') {
      throw new BillingError('INVALID_OUTCOME', 'Invalid test outcome', 400);
    }

    const now = nowFn();
    const checkout = await store.loadCheckout(checkoutId);
    if (!checkout || checkout.salonId !== salonId) {
      throw new BillingError('CHECKOUT_NOT_FOUND', 'Checkout not found', 404);
    }
    if (checkout.provider !== 'test') {
      throw new BillingError('CHECKOUT_NOT_FOUND', 'Checkout not found', 404);
    }

    if (checkout.status === 'expired' || Date.parse(checkout.expiresAt) <= now.getTime()) {
      if (checkout.status === 'pending') {
        await store.completeCheckout(checkout.id, 'failed', now.toISOString());
      }
      throw new BillingError('CHECKOUT_EXPIRED', 'Checkout expired', 409);
    }

    if (checkout.status === 'failed' && outcome === 'success') {
      throw new BillingError('CHECKOUT_NOT_PENDING', 'Checkout is no longer pending', 409);
    }

    return applyProviderEvent({
      salonId,
      checkoutId: checkout.id,
      provider: 'test',
      providerPaymentId: `test_pay_${checkout.id}`,
      amount: checkout.amount,
      currency: checkout.currency,
      status: outcome === 'success' ? 'succeeded' : 'failed',
      paidAt: outcome === 'success' ? now.toISOString() : null,
    });
  }

  async function cancelAtPeriodEnd(salonId: string): Promise<OwnerSubscriptionDto> {
    const now = nowFn();
    const { sub, entitlements } = await loadEntitledSnapshot(salonId, now);
    if (!hasManagedPaidPeriod(sub, now)) {
      throw new BillingError('CANCEL_NOT_ALLOWED', 'No paid period to cancel', 409);
    }
    if (!entitlements.aiAutomationAllowed) {
      throw new BillingError('CANCEL_NOT_ALLOWED', 'No paid period to cancel', 409);
    }
    const updated = await store.markCancelAtPeriodEnd(salonId, now.toISOString());
    if (!updated) {
      throw new BillingError('SALON_NOT_FOUND', 'Salon not found', 404);
    }
    return getOwnerSubscription(salonId);
  }

  return {
    getOwnerSubscription,
    isEntitled,
    createCheckout,
    getCheckout,
    completeTestCheckout,
    cancelAtPeriodEnd,
    applyProviderEvent,
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
