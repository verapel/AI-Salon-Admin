import type { SalonSubscriptionStatus } from '../types.js';

export type CheckoutSessionStatus = 'pending' | 'succeeded' | 'failed' | 'expired';
export type PaymentRecordStatus = 'pending' | 'succeeded' | 'failed';

export interface BillingSubscriptionRow {
  id: string;
  salonId: string;
  plan: string;
  status: SalonSubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  developerSuspended: boolean;
  provider: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  lastPaymentStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingCheckoutRow {
  id: string;
  salonId: string;
  planId: string;
  provider: string;
  amount: number;
  currency: string;
  status: CheckoutSessionStatus;
  providerSessionId: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}

export interface BillingPaymentRow {
  id: string;
  salonId: string;
  checkoutId: string | null;
  provider: string;
  providerPaymentId: string;
  amount: number;
  currency: string;
  status: PaymentRecordStatus;
  createdAt: string;
  paidAt: string | null;
}

export interface UpsertSubscriptionActivation {
  salonId: string;
  plan: string;
  provider: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  lastPaymentStatus: string;
  nowIso: string;
}

export interface BillingStore {
  loadSalonActive(salonId: string): Promise<'active' | 'inactive' | 'missing'>;
  loadSubscription(salonId: string): Promise<BillingSubscriptionRow | null>;
  upsertActivatedSubscription(input: UpsertSubscriptionActivation): Promise<BillingSubscriptionRow>;
  markCancelAtPeriodEnd(salonId: string, nowIso: string): Promise<BillingSubscriptionRow | null>;
  setLastPaymentStatus(salonId: string, status: string, nowIso: string): Promise<void>;
  insertCheckout(row: BillingCheckoutRow): Promise<BillingCheckoutRow>;
  loadCheckout(id: string): Promise<BillingCheckoutRow | null>;
  findPendingCheckout(salonId: string, planId: string, nowIso: string): Promise<BillingCheckoutRow | null>;
  completeCheckout(
    id: string,
    status: 'succeeded' | 'failed',
    completedAt: string,
  ): Promise<BillingCheckoutRow | null>;
  insertPayment(row: BillingPaymentRow): Promise<{ row: BillingPaymentRow; inserted: boolean }>;
  loadPaymentByProviderId(provider: string, providerPaymentId: string): Promise<BillingPaymentRow | null>;
  listPayments(salonId: string): Promise<BillingPaymentRow[]>;
}
