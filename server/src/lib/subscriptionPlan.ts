import { DEVELOPER_SALON_SUBSCRIPTION_PLANS } from '../types.js';
import { DEFAULT_SALON_CURRENCY, parseSalonCurrency } from './salonCurrency.js';

/** Single paid monthly plan. Price is centralized here (and env), never scattered. */
export const PAID_PLAN_ID = DEVELOPER_SALON_SUBSCRIPTION_PLANS[0];

/** Temporary configurable price — no product catalog price exists in the repo. */
export const DEFAULT_SUBSCRIPTION_PLAN_AMOUNT = 15000;
export const DEFAULT_SUBSCRIPTION_PLAN_CURRENCY = DEFAULT_SALON_CURRENCY;

export type SubscriptionPlanInterval = 'month';

export interface SubscriptionPlan {
  id: typeof PAID_PLAN_ID;
  amount: number;
  currency: string;
  interval: SubscriptionPlanInterval;
}

function parseAmount(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function getPaidSubscriptionPlan(env: NodeJS.ProcessEnv = process.env): SubscriptionPlan {
  return {
    id: PAID_PLAN_ID,
    amount: parseAmount(env.SUBSCRIPTION_PLAN_AMOUNT, DEFAULT_SUBSCRIPTION_PLAN_AMOUNT),
    currency: parseSalonCurrency(env.SUBSCRIPTION_PLAN_CURRENCY ?? DEFAULT_SUBSCRIPTION_PLAN_CURRENCY),
    interval: 'month',
  };
}

export function isPaidPlanId(value: unknown): value is typeof PAID_PLAN_ID {
  return value === PAID_PLAN_ID;
}
