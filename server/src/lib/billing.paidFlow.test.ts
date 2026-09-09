/**
 * Paid subscription flow: plan, test provider, checkout, entitlement, cancel, HTTP auth.
 * No DB mutation. Does not touch messenger/calendar runtimes.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { addCalendarMonthUtc, computeMonthlyPeriod } from './billingPeriod.js';
import { createBillingService, isBillingError } from './billingService.js';
import { createMemoryBillingStore, type MemoryBillingSeed } from './memoryBillingStore.js';
import { createRequireSalonAppAccess, SUBSCRIPTION_REQUIRED_CODE } from '../middleware/requireSalonAppAccess.js';
import { createBillingRouter } from '../routes/billing.js';
import { evaluateSalonEntitlement } from './salonEntitlement.js';
import { getPaidSubscriptionPlan, PAID_PLAN_ID } from './subscriptionPlan.js';
import { getPaymentProvider, paynetPaymentProvider, testPaymentProvider } from './payment/index.js';
import { PILOT_SALON_ID } from './pilotSalon.js';
import type { BillingSubscriptionRow } from './billingStore.js';
import type { RequestAuth } from '../types/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const NOW = new Date('2026-09-09T12:00:00.000Z');
const FUTURE = '2026-10-09T12:00:00.000Z';
const PAST = '2026-08-01T12:00:00.000Z';
const SALON_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';
const SALON_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0002';

function subRow(
  salonId: string,
  overrides: Partial<BillingSubscriptionRow> = {},
): BillingSubscriptionRow {
  return {
    id: `sub-${salonId}`,
    salonId,
    plan: 'standard',
    status: 'unpaid',
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    developerSuspended: false,
    provider: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    lastPaymentStatus: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function serviceFor(seed: MemoryBillingSeed, now: Date = NOW) {
  return createBillingService({
    store: createMemoryBillingStore(seed),
    provider: testPaymentProvider,
    plan: getPaidSubscriptionPlan({
      SUBSCRIPTION_PLAN_AMOUNT: '15000',
      SUBSCRIPTION_PLAN_CURRENCY: 'AMD',
    }),
    now: () => now,
  });
}

async function withServer(
  setup: (app: express.Express) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  setup(app);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('billing period (calendar month UTC)', () => {
  it('adds one civil month and clamps month-end days', () => {
    const jan31 = addCalendarMonthUtc(new Date('2026-01-31T15:04:00.000Z'));
    assert.equal(jan31.toISOString(), '2026-02-28T15:04:00.000Z');
    const mar31 = addCalendarMonthUtc(new Date('2024-01-31T00:00:00.000Z'));
    assert.equal(mar31.toISOString(), '2024-02-29T00:00:00.000Z');
    const period = computeMonthlyPeriod(new Date('2026-09-09T12:00:00.000Z'));
    assert.equal(period.currentPeriodStart, '2026-09-09T12:00:00.000Z');
    assert.equal(period.currentPeriodEnd, '2026-10-09T12:00:00.000Z');
  });
});

describe('plan + provider boundary', () => {
  it('centralizes the single paid plan and keeps Paynet isolated', async () => {
    const plan = getPaidSubscriptionPlan({
      SUBSCRIPTION_PLAN_AMOUNT: '15000',
      SUBSCRIPTION_PLAN_CURRENCY: 'AMD',
    });
    assert.equal(plan.id, PAID_PLAN_ID);
    assert.equal(plan.amount, 15000);
    assert.equal(plan.currency, 'AMD');
    assert.equal(plan.interval, 'month');
    assert.equal(testPaymentProvider.supportsAutomaticRecurring, false);
    await assert.rejects(
      paynetPaymentProvider.createCheckout({
        salonId: SALON_A,
        checkoutId: 'x',
        planId: 'standard',
        amount: 1,
        currency: 'AMD',
      }),
      /verified API credentials/,
    );
    assert.equal(getPaymentProvider({ BILLING_PROVIDER: 'test' }).id, 'test');
  });
});

describe('paid subscription service', () => {
  it('unauthenticated callers cannot use salon-scoped billing without salon id', async () => {
    const svc = serviceFor({ salons: { [SALON_A]: true }, subscriptions: [subRow(SALON_A)] });
    await assert.rejects(() => svc.getOwnerSubscription('missing-salon'), (err: unknown) => {
      return isBillingError(err) && err.code === 'SALON_NOT_FOUND' && err.httpStatus === 404;
    });
  });

  it('ownership isolation: salon B cannot complete salon A checkout', async () => {
    const store = createMemoryBillingStore({
      salons: { [SALON_A]: true, [SALON_B]: true },
      subscriptions: [subRow(SALON_A), subRow(SALON_B)],
    });
    const svc = createBillingService({
      store,
      provider: testPaymentProvider,
      now: () => NOW,
    });
    const checkout = await svc.createCheckout(SALON_A, 'standard');
    await assert.rejects(
      () => svc.completeTestCheckout(SALON_B, checkout.checkoutId, 'success'),
      (err: unknown) => isBillingError(err) && err.httpStatus === 404,
    );
    const a = await svc.getOwnerSubscription(SALON_A);
    assert.equal(a.entitled, false);
    assert.equal(a.payments.length, 0);
  });

  it('creates a test checkout from the server', async () => {
    const svc = serviceFor({ salons: { [SALON_A]: true }, subscriptions: [subRow(SALON_A)] });
    const checkout = await svc.createCheckout(SALON_A, 'standard');
    assert.equal(checkout.amount, 15000);
    assert.equal(checkout.currency, 'AMD');
    assert.equal(checkout.isTest, true);
    assert.equal(checkout.hostedPaymentPath, `/subscription/checkout/${checkout.checkoutId}`);
    const again = await svc.createCheckout(SALON_A, 'standard');
    assert.equal(again.checkoutId, checkout.checkoutId);
  });

  it('successful test payment activates a monthly period', async () => {
    const svc = serviceFor({ salons: { [SALON_A]: true }, subscriptions: [subRow(SALON_A)] });
    const checkout = await svc.createCheckout(SALON_A, 'standard');
    const paid = await svc.completeTestCheckout(SALON_A, checkout.checkoutId, 'success');
    assert.equal(paid.entitled, true);
    assert.equal(paid.hasManagedPaidPeriod, true);
    assert.equal(paid.status, 'active');
    assert.equal(paid.displayStatus, 'active');
    assert.equal(paid.currentPeriodStart, NOW.toISOString());
    assert.equal(paid.currentPeriodEnd, FUTURE);
    assert.equal(paid.payments.length, 1);
    assert.equal(paid.payments[0].status, 'succeeded');
    assert.equal(paid.provider.supportsAutomaticRecurring, false);
  });

  it('failed test payment does not grant access', async () => {
    const svc = serviceFor({ salons: { [SALON_A]: true }, subscriptions: [subRow(SALON_A)] });
    const checkout = await svc.createCheckout(SALON_A, 'standard');
    const failed = await svc.completeTestCheckout(SALON_A, checkout.checkoutId, 'failure');
    assert.equal(failed.entitled, false);
    assert.equal(failed.hasManagedPaidPeriod, false);
    assert.equal(failed.payments.length, 1);
    assert.equal(failed.payments[0].status, 'failed');
    await assert.rejects(
      () => svc.completeTestCheckout(SALON_A, checkout.checkoutId, 'success'),
      (err: unknown) => isBillingError(err) && err.code === 'CHECKOUT_NOT_PENDING',
    );
  });

  it('duplicate success is idempotent and does not duplicate payment rows', async () => {
    const svc = serviceFor({ salons: { [SALON_A]: true }, subscriptions: [subRow(SALON_A)] });
    const checkout = await svc.createCheckout(SALON_A, 'standard');
    const first = await svc.completeTestCheckout(SALON_A, checkout.checkoutId, 'success');
    const second = await svc.completeTestCheckout(SALON_A, checkout.checkoutId, 'success');
    assert.equal(second.payments.length, 1);
    assert.equal(second.currentPeriodEnd, first.currentPeriodEnd);
    assert.equal(second.entitled, true);
    await assert.rejects(
      () => svc.createCheckout(SALON_A, 'standard'),
      (err: unknown) => isBillingError(err) && err.code === 'ALREADY_SUBSCRIBED',
    );
  });

  it('active entitlement, cancel at period end, access remains, then expires', async () => {
    const svc = serviceFor({ salons: { [SALON_A]: true }, subscriptions: [subRow(SALON_A)] });
    const checkout = await svc.createCheckout(SALON_A, 'standard');
    await svc.completeTestCheckout(SALON_A, checkout.checkoutId, 'success');
    assert.equal(await svc.isEntitled(SALON_A), true);

    const canceled = await svc.cancelAtPeriodEnd(SALON_A);
    assert.equal(canceled.cancelAtPeriodEnd, true);
    assert.ok(canceled.canceledAt);
    assert.equal(canceled.entitled, true);
    assert.equal(canceled.displayStatus, 'cancel_at_period_end');
    assert.equal(await svc.isEntitled(SALON_A), true);

    const again = await svc.cancelAtPeriodEnd(SALON_A);
    assert.equal(again.cancelAtPeriodEnd, true);
    assert.equal(again.canceledAt, canceled.canceledAt);

    const expiredNow = new Date('2026-10-09T12:00:00.000Z');
    const expiredSvc = createBillingService({
      store: createMemoryBillingStore({
        salons: { [SALON_A]: true },
        subscriptions: [
          subRow(SALON_A, {
            status: 'active',
            currentPeriodStart: NOW.toISOString(),
            currentPeriodEnd: FUTURE,
            cancelAtPeriodEnd: true,
            canceledAt: NOW.toISOString(),
            provider: 'test',
          }),
        ],
      }),
      provider: testPaymentProvider,
      now: () => expiredNow,
    });
    const after = await expiredSvc.getOwnerSubscription(SALON_A);
    assert.equal(after.entitled, false);
    assert.equal(after.hasManagedPaidPeriod, false);
    const renewed = await expiredSvc.createCheckout(SALON_A, 'standard');
    assert.ok(renewed.checkoutId);
  });

  it('existing/pilot salon compatibility: missing row and null period stay entitled', async () => {
    const missing = serviceFor({ salons: { [PILOT_SALON_ID]: true } });
    const pilot = await missing.getOwnerSubscription(PILOT_SALON_ID);
    assert.equal(pilot.entitled, true);
    assert.equal(pilot.isComplimentary, true);

    const grandfathered = serviceFor({
      salons: { [SALON_A]: true },
      subscriptions: [subRow(SALON_A, { status: 'active' })],
    });
    const snap = await grandfathered.getOwnerSubscription(SALON_A);
    assert.equal(snap.entitled, true);
    assert.equal(snap.isComplimentary, true);
    assert.equal(await grandfathered.isEntitled(SALON_A), true);
  });

  it('unpaid entitlement is denied while management APIs remain usable', async () => {
    const denied = evaluateSalonEntitlement({
      salonId: SALON_A,
      salonActive: true,
      plan: 'standard',
      subscriptionStatus: 'unpaid',
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      developerSuspended: false,
    });
    assert.equal(denied.aiAutomationAllowed, false);
    assert.equal(denied.denyReason, 'subscription_unpaid');

    const svc = serviceFor({ salons: { [SALON_A]: true }, subscriptions: [subRow(SALON_A)] });
    const view = await svc.getOwnerSubscription(SALON_A);
    assert.equal(view.entitled, false);
    const checkout = await svc.createCheckout(SALON_A, 'standard');
    assert.ok(checkout.checkoutId);
  });
});

describe('HTTP billing routes + access middleware', () => {
  it('unauthenticated access is rejected; ownership is enforced', async () => {
    const svc = serviceFor({
      salons: { [SALON_A]: true, [SALON_B]: true },
      subscriptions: [subRow(SALON_A), subRow(SALON_B)],
    });

    await withServer(
      (app) => {
        app.use('/api/billing', (req, res, next) => {
          const header = req.headers.authorization;
          if (!header?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
          const salonId = header.slice('Bearer '.length).trim();
          req.auth = {
            userId: 'user-1',
            email: 'owner@example.com',
            isDeveloper: false,
            salonId,
            role: 'owner',
          } satisfies RequestAuth;
          next();
        }, createBillingRouter(svc));
      },
      async (base) => {
        const unauth = await fetch(`${base}/api/billing/subscription`);
        assert.equal(unauth.status, 401);

        const checkoutRes = await fetch(`${base}/api/billing/checkout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SALON_A}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'standard' }),
        });
        assert.equal(checkoutRes.status, 201);
        const checkout = (await checkoutRes.json()) as { checkoutId: string };

        const stolen = await fetch(`${base}/api/billing/checkout/${checkout.checkoutId}/complete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SALON_B}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: 'success' }),
        });
        assert.equal(stolen.status, 404);

        const ok = await fetch(`${base}/api/billing/checkout/${checkout.checkoutId}/complete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SALON_A}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: 'success' }),
        });
        assert.equal(ok.status, 200);
        const body = (await ok.json()) as { entitled: boolean };
        assert.equal(body.entitled, true);

        const queryActivate = await fetch(
          `${base}/api/billing/subscription?paid=1&status=success`,
          { headers: { Authorization: `Bearer ${SALON_B}` } },
        );
        assert.equal(queryActivate.status, 200);
        const b = (await queryActivate.json()) as { entitled: boolean };
        assert.equal(b.entitled, false);
      },
    );
  });

  it('application access middleware denies expired salons and skips when auth is off', async () => {
    const previous = process.env.API_AUTH_REQUIRED;
    process.env.API_AUTH_REQUIRED = 'true';
    try {
      const deny = createRequireSalonAppAccess(async () => false);
      const allow = createRequireSalonAppAccess(async () => true);
      await withServer(
        (app) => {
          app.get('/gated', (req, _res, next) => {
            req.auth = {
              userId: 'u',
              email: 'a@b.c',
              isDeveloper: false,
              salonId: SALON_A,
              role: 'owner',
            };
            next();
          }, deny, (_req, res) => res.json({ ok: true }));
          app.get('/open', (req, _res, next) => {
            req.auth = {
              userId: 'u',
              email: 'a@b.c',
              isDeveloper: false,
              salonId: SALON_A,
              role: 'owner',
            };
            next();
          }, allow, (_req, res) => res.json({ ok: true }));
        },
        async (base) => {
          const denied = await fetch(`${base}/gated`);
          assert.equal(denied.status, 402);
          const payload = (await denied.json()) as { code: string };
          assert.equal(payload.code, SUBSCRIPTION_REQUIRED_CODE);
          const opened = await fetch(`${base}/open`);
          assert.equal(opened.status, 200);
        },
      );
    } finally {
      if (previous == null) delete process.env.API_AUTH_REQUIRED;
      else process.env.API_AUTH_REQUIRED = previous;
    }

    delete process.env.API_AUTH_REQUIRED;
    const skipped = createRequireSalonAppAccess(async () => {
      throw new Error('should not run when auth is not required');
    });
    await withServer(
      (app) => {
        app.get('/pilot', skipped, (_req, res) => res.json({ ok: true }));
      },
      async (base) => {
        const res = await fetch(`${base}/pilot`);
        assert.equal(res.status, 200);
      },
    );
  });
});

describe('paid flow source contracts', () => {
  const index = read('server/src/index.ts');
  const app = read('client/src/App.tsx');
  const sidebar = read('client/src/components/layout/Sidebar.tsx');
  const translations = read('client/src/i18n/translations.ts');
  const billingRoutes = read('server/src/routes/billing.ts');
  const paynet = read('server/src/lib/payment/paynetProvider.ts');
  const telegramBooking = read('server/src/lib/telegramBooking.ts');
  const waWebhook = read('server/src/routes/whatsappWebhook.ts');
  const igProcess = read('server/src/lib/instagramWebhookProcess.ts');
  const calendar = read('server/src/routes/calendarConnections.ts');
  const packageJson = read('server/package.json');

  it('wires owner Subscription page and does not activate via query params', () => {
    assert.match(app, /path="\/subscription"/);
    assert.match(app, /path="\/subscription\/checkout\/:checkoutId"/);
    assert.match(sidebar, /nav\.subscription/);
    assert.match(sidebar, /['"]\/subscription['"]/);
    assert.match(translations, /'nav\.subscription': 'Подписка'/);
    assert.match(translations, /Оформить подписку/);
    assert.match(translations, /Отменить подписку/);
    assert.doesNotMatch(billingRoutes, /req\.query\.(paid|status|success)/);
    assert.doesNotMatch(billingRoutes, /router\.get\('\/checkout\/:id\/complete'/);
  });

  it('keeps billing reachable and gates only application APIs', () => {
    assert.match(index, /app\.use\('\/api\/billing',\s*salonAuth,\s*billingRouter\)/);
    assert.match(index, /app\.use\('\/api\/auth', authRouter\)/);
    assert.match(index, /app\.use\('\/api\/developer',\s*developerAuth/);
    assert.match(index, /salonAppAccess/);
    assert.doesNotMatch(index, /evaluateSalonEntitlement/);
    assert.doesNotMatch(index, /getSalonSubscription|salonSubscription/);
    const n = (packageJson.match(/billing\.paidFlow\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });

  it('does not invent Paynet APIs and leaves messengers/calendars untouched', () => {
    assert.match(paynet, /Paynet sandbox is not implemented/);
    assert.doesNotMatch(paynet, /https?:\/\/api\.paynet/i);
    assert.doesNotMatch(telegramBooking, /createBillingService|billing_checkout_sessions/);
    assert.doesNotMatch(waWebhook, /createBillingService|billing_checkout_sessions/);
    assert.doesNotMatch(igProcess, /createBillingService|billing_checkout_sessions/);
    assert.doesNotMatch(calendar, /createBillingService|billing_checkout_sessions/);
  });
});
