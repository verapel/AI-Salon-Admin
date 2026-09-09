import { randomUUID } from 'node:crypto';
import type {
  BillingCheckoutRow,
  BillingPaymentRow,
  BillingStore,
  BillingSubscriptionRow,
  UpsertSubscriptionActivation,
} from './billingStore.js';

export interface MemoryBillingSeed {
  salons?: Record<string, boolean>;
  subscriptions?: BillingSubscriptionRow[];
  checkouts?: BillingCheckoutRow[];
  payments?: BillingPaymentRow[];
}

function cloneSub(row: BillingSubscriptionRow): BillingSubscriptionRow {
  return { ...row };
}

export function createMemoryBillingStore(seed: MemoryBillingSeed = {}): BillingStore {
  const salons = new Map<string, boolean>(Object.entries(seed.salons ?? {}));
  const subscriptions = new Map<string, BillingSubscriptionRow>();
  const checkouts = new Map<string, BillingCheckoutRow>();
  const payments = new Map<string, BillingPaymentRow>();
  const paymentsByProvider = new Map<string, string>();

  for (const row of seed.subscriptions ?? []) {
    subscriptions.set(row.salonId, cloneSub(row));
  }
  for (const row of seed.checkouts ?? []) {
    checkouts.set(row.id, { ...row });
  }
  for (const row of seed.payments ?? []) {
    payments.set(row.id, { ...row });
    paymentsByProvider.set(`${row.provider}:${row.providerPaymentId}`, row.id);
  }

  return {
    async loadSalonActive(salonId) {
      if (!salons.has(salonId)) return 'missing';
      return salons.get(salonId) ? 'active' : 'inactive';
    },

    async loadSubscription(salonId) {
      const row = subscriptions.get(salonId);
      return row ? cloneSub(row) : null;
    },

    async upsertActivatedSubscription(input: UpsertSubscriptionActivation) {
      const existing = subscriptions.get(input.salonId);
      const next: BillingSubscriptionRow = {
        id: existing?.id ?? randomUUID(),
        salonId: input.salonId,
        plan: input.plan,
        status: 'active',
        trialEndsAt: existing?.trialEndsAt ?? null,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        developerSuspended: existing?.developerSuspended ?? false,
        provider: input.provider,
        providerCustomerId: input.providerCustomerId,
        providerSubscriptionId: input.providerSubscriptionId,
        lastPaymentStatus: input.lastPaymentStatus,
        createdAt: existing?.createdAt ?? input.nowIso,
        updatedAt: input.nowIso,
      };
      subscriptions.set(input.salonId, next);
      return cloneSub(next);
    },

    async markCancelAtPeriodEnd(salonId, nowIso) {
      const existing = subscriptions.get(salonId);
      if (!existing) return null;
      if (existing.cancelAtPeriodEnd) {
        return cloneSub({
          ...existing,
          canceledAt: existing.canceledAt ?? nowIso,
          updatedAt: existing.updatedAt,
        });
      }
      const next: BillingSubscriptionRow = {
        ...existing,
        cancelAtPeriodEnd: true,
        canceledAt: nowIso,
        updatedAt: nowIso,
      };
      subscriptions.set(salonId, next);
      return cloneSub(next);
    },

    async setLastPaymentStatus(salonId, status, nowIso) {
      const existing = subscriptions.get(salonId);
      if (!existing) return;
      subscriptions.set(salonId, {
        ...existing,
        lastPaymentStatus: status,
        updatedAt: nowIso,
      });
    },

    async insertCheckout(row) {
      checkouts.set(row.id, { ...row });
      return { ...row };
    },

    async loadCheckout(id) {
      const row = checkouts.get(id);
      return row ? { ...row } : null;
    },

    async findPendingCheckout(salonId, planId, nowIso) {
      const now = Date.parse(nowIso);
      for (const row of checkouts.values()) {
        if (
          row.salonId === salonId &&
          row.planId === planId &&
          row.status === 'pending' &&
          Date.parse(row.expiresAt) > now
        ) {
          return { ...row };
        }
      }
      return null;
    },

    async completeCheckout(id, status, completedAt) {
      const existing = checkouts.get(id);
      if (!existing) return null;
      const next: BillingCheckoutRow = {
        ...existing,
        status,
        completedAt,
      };
      checkouts.set(id, next);
      return { ...next };
    },

    async insertPayment(row) {
      const key = `${row.provider}:${row.providerPaymentId}`;
      const existingId = paymentsByProvider.get(key);
      if (existingId) {
        const existing = payments.get(existingId)!;
        return { row: { ...existing }, inserted: false };
      }
      payments.set(row.id, { ...row });
      paymentsByProvider.set(key, row.id);
      return { row: { ...row }, inserted: true };
    },

    async loadPaymentByProviderId(provider, providerPaymentId) {
      const id = paymentsByProvider.get(`${provider}:${providerPaymentId}`);
      if (!id) return null;
      const row = payments.get(id);
      return row ? { ...row } : null;
    },

    async listPayments(salonId) {
      return [...payments.values()]
        .filter((p) => p.salonId === salonId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((p) => ({ ...p }));
    },
  };
}
