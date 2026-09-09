/**
 * SUB-1B: Central salon entitlement helper — pure evaluator + loader contracts.
 * No messenger enforcement. No DB mutation. No payment provider.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  evaluateSalonEntitlement,
  getSalonEntitlements,
  isSalonEntitlementNotFoundError,
  parseEntitlementInstant,
  SalonEntitlementNotFoundError,
  toDeveloperSalonEntitlementPublic,
  type EvaluateSalonEntitlementInput,
  type SalonEntitlementStore,
} from './salonEntitlement.js';
import { SALON_ENTITLEMENT_DENY_REASONS } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const NOW = new Date('2026-08-14T12:00:00.000Z');
const FUTURE = '2026-08-20T12:00:00.000Z';
const PAST = '2026-08-01T12:00:00.000Z';
const EXACT = '2026-08-14T12:00:00.000Z';

function base(
  overrides: Partial<EvaluateSalonEntitlementInput> = {},
): EvaluateSalonEntitlementInput {
  return {
    salonId: 'salon-1',
    salonActive: true,
    plan: 'standard',
    subscriptionStatus: 'active',
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    developerSuspended: false,
    usedMissingSubscriptionFallback: false,
    usedSubscriptionReadFailureFallback: false,
    usedSalonReadFailureFallback: false,
    ...overrides,
  };
}

describe('SUB-1B evaluateSalonEntitlement (pure)', () => {
  it('1. active salon + active subscription + no expiry → allowed', () => {
    const r = evaluateSalonEntitlement(base(), NOW);
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.denyReason, null);
  });

  it('2. active subscription future current_period_end → allowed', () => {
    const r = evaluateSalonEntitlement(base({ currentPeriodEnd: FUTURE }), NOW);
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.denyReason, null);
  });

  it('3. active subscription exact/past period end → denied subscription_expired', () => {
    const exact = evaluateSalonEntitlement(base({ currentPeriodEnd: EXACT }), NOW);
    assert.equal(exact.aiAutomationAllowed, false);
    assert.equal(exact.denyReason, 'subscription_expired');

    const past = evaluateSalonEntitlement(base({ currentPeriodEnd: PAST }), NOW);
    assert.equal(past.aiAutomationAllowed, false);
    assert.equal(past.denyReason, 'subscription_expired');
  });

  it('4. trial with no trial end → allowed', () => {
    const r = evaluateSalonEntitlement(
      base({ subscriptionStatus: 'trial', trialEndsAt: null }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.denyReason, null);
  });

  it('5. trial future end → allowed', () => {
    const r = evaluateSalonEntitlement(
      base({ subscriptionStatus: 'trial', trialEndsAt: FUTURE }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.denyReason, null);
  });

  it('6. trial expired → denied trial_expired', () => {
    const r = evaluateSalonEntitlement(
      base({ subscriptionStatus: 'trial', trialEndsAt: PAST }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, false);
    assert.equal(r.denyReason, 'trial_expired');
  });

  it('7. past_due → denied subscription_past_due', () => {
    const r = evaluateSalonEntitlement(base({ subscriptionStatus: 'past_due' }), NOW);
    assert.equal(r.aiAutomationAllowed, false);
    assert.equal(r.denyReason, 'subscription_past_due');
  });

  it('8. expired → denied subscription_expired', () => {
    const r = evaluateSalonEntitlement(base({ subscriptionStatus: 'expired' }), NOW);
    assert.equal(r.aiAutomationAllowed, false);
    assert.equal(r.denyReason, 'subscription_expired');
  });

  it('9. cancelled → denied subscription_cancelled', () => {
    const r = evaluateSalonEntitlement(base({ subscriptionStatus: 'cancelled' }), NOW);
    assert.equal(r.aiAutomationAllowed, false);
    assert.equal(r.denyReason, 'subscription_cancelled');
  });

  it('10. developer_suspended overrides active subscription → developer_suspended', () => {
    const r = evaluateSalonEntitlement(
      base({ developerSuspended: true, currentPeriodEnd: FUTURE }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, false);
    assert.equal(r.denyReason, 'developer_suspended');
  });

  it('11. salon inactive overrides everything → salon_inactive', () => {
    const r = evaluateSalonEntitlement(
      base({
        salonActive: false,
        developerSuspended: true,
        subscriptionStatus: 'expired',
      }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, false);
    assert.equal(r.denyReason, 'salon_inactive');
  });

  it('12. cancel_at_period_end=true + future period end → still allowed', () => {
    const r = evaluateSalonEntitlement(
      base({ cancelAtPeriodEnd: true, currentPeriodEnd: FUTURE }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.denyReason, null);
  });

  it('13. missing subscription fallback + active salon → allowed + fallback flag', () => {
    const r = evaluateSalonEntitlement(
      base({ usedMissingSubscriptionFallback: true }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.denyReason, null);
    assert.equal(r.usedMissingSubscriptionFallback, true);
  });

  it('14. missing subscription fallback + inactive salon → salon_inactive', () => {
    const r = evaluateSalonEntitlement(
      base({ salonActive: false, usedMissingSubscriptionFallback: true }),
      NOW,
    );
    assert.equal(r.aiAutomationAllowed, false);
    assert.equal(r.denyReason, 'salon_inactive');
    assert.equal(r.usedMissingSubscriptionFallback, true);
  });

  it('17. precedence: salon inactive + developer suspended + expired → salon_inactive', () => {
    const r = evaluateSalonEntitlement(
      base({
        salonActive: false,
        developerSuspended: true,
        subscriptionStatus: 'expired',
      }),
      NOW,
    );
    assert.equal(r.denyReason, 'salon_inactive');
  });

  it('18. precedence: developer suspended + expired → developer_suspended', () => {
    const r = evaluateSalonEntitlement(
      base({
        salonActive: true,
        developerSuspended: true,
        subscriptionStatus: 'expired',
      }),
      NOW,
    );
    assert.equal(r.denyReason, 'developer_suspended');
  });

  it('date semantics: timestamptz compared as UTC instants; injectable now', () => {
    const end = parseEntitlementInstant('2026-08-14T15:00:00+03:00');
    assert.ok(end);
    assert.equal(end!.toISOString(), '2026-08-14T12:00:00.000Z');
    // exact now → expired
    const r = evaluateSalonEntitlement(
      base({ currentPeriodEnd: '2026-08-14T15:00:00+03:00' }),
      new Date('2026-08-14T12:00:00.000Z'),
    );
    assert.equal(r.denyReason, 'subscription_expired');
  });
});

describe('SUB-1B getSalonEntitlements (loader)', () => {
  it('15. salon not found → explicit SalonEntitlementNotFoundError (not active synthesis)', async () => {
    const store: SalonEntitlementStore = {
      async loadSalonActive() {
        return { kind: 'not_found' };
      },
      async loadSubscriptionSnapshot() {
        throw new Error('subscription should not be loaded when salon missing');
      },
    };

    await assert.rejects(
      () => getSalonEntitlements('missing-salon', { store, now: NOW }),
      (err: unknown) => {
        assert.equal(isSalonEntitlementNotFoundError(err), true);
        assert.ok(err instanceof SalonEntitlementNotFoundError);
        assert.equal(err.code, 'SALON_NOT_FOUND');
        assert.equal(err.salonId, 'missing-salon');
        return true;
      },
    );
  });

  it('16. DB subscription read failure → fail-safe allowed (active salon), diagnostic flag', async () => {
    const store: SalonEntitlementStore = {
      async loadSalonActive() {
        return { kind: 'ok', active: true };
      },
      async loadSubscriptionSnapshot(salonId) {
        return {
          plan: 'standard',
          subscriptionStatus: 'active',
          trialEndsAt: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          developerSuspended: false,
          usedMissingSubscriptionFallback: false,
          usedSubscriptionReadFailureFallback: true,
        };
      },
    };

    const r = await getSalonEntitlements('salon-1', { store, now: NOW });
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.denyReason, null);
    assert.equal(r.usedSubscriptionReadFailureFallback, true);
    assert.equal(r.usedMissingSubscriptionFallback, false);
  });

  it('salon read failure → fail-safe assume active; still respects subscription denial', async () => {
    const store: SalonEntitlementStore = {
      async loadSalonActive() {
        return { kind: 'read_error' };
      },
      async loadSubscriptionSnapshot() {
        return {
          plan: 'standard',
          subscriptionStatus: 'cancelled',
          trialEndsAt: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          developerSuspended: false,
          usedMissingSubscriptionFallback: false,
          usedSubscriptionReadFailureFallback: false,
        };
      },
    };
    const r = await getSalonEntitlements('salon-1', { store, now: NOW });
    assert.equal(r.usedSalonReadFailureFallback, true);
    assert.equal(r.salonActive, true);
    assert.equal(r.denyReason, 'subscription_cancelled');
  });

  it('missing subscription row + active salon via loader → allowed + fallback', async () => {
    const store: SalonEntitlementStore = {
      async loadSalonActive() {
        return { kind: 'ok', active: true };
      },
      async loadSubscriptionSnapshot() {
        return {
          plan: 'standard',
          subscriptionStatus: 'active',
          trialEndsAt: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          developerSuspended: false,
          usedMissingSubscriptionFallback: true,
          usedSubscriptionReadFailureFallback: false,
        };
      },
    };
    const r = await getSalonEntitlements('salon-1', { store, now: NOW });
    assert.equal(r.aiAutomationAllowed, true);
    assert.equal(r.usedMissingSubscriptionFallback, true);
  });
});

describe('SUB-1B safe DTO + static non-enforcement contracts', () => {
  const entitlement = read('server/src/lib/salonEntitlement.ts');
  const types = read('server/src/types.ts');
  const index = read('server/src/index.ts');
  const telegramBooking = read('server/src/lib/telegramBooking.ts');
  const telegramBotManager = read('server/src/lib/telegramBotManager.ts');
  const telegramPolling = read('server/src/lib/telegramPollingControl.ts');
  const waWebhook = read('server/src/routes/whatsappWebhook.ts');
  const waFlow = read('server/src/lib/whatsappBookingFlow.ts');
  const waOutbound = read('server/src/lib/whatsappOutboundWorker.ts');
  const igProcess = read('server/src/lib/instagramWebhookProcess.ts');
  const igRoutes = read('server/src/routes/instagramIntegrations.ts');
  const calendar = read('server/src/routes/calendarConnections.ts');
  const reminders = read('server/src/lib/telegramReminderWorker.ts');
  const appointmentReminders = read('server/src/lib/appointmentReminders.ts');
  const packageJson = read('server/package.json');

  it('central helper exists; deny reasons typed; no payment secrets in DTO', () => {
    assert.match(entitlement, /export function evaluateSalonEntitlement/);
    assert.match(entitlement, /export async function getSalonEntitlements/);
    assert.match(types, /SalonEntitlementDenyReason/);
    assert.match(types, /aiAutomationAllowed/);
    for (const reason of SALON_ENTITLEMENT_DENY_REASONS) {
      assert.match(types, new RegExp(`'${reason}'`));
    }

    const dto = toDeveloperSalonEntitlementPublic(
      evaluateSalonEntitlement(base(), NOW),
    );
    assert.equal(dto.aiAutomationAllowed, true);
    assert.equal(dto.denyReason, null);
    assert.equal('providerCustomerId' in dto, false);
    assert.equal('providerSubscriptionId' in dto, false);
    assert.deepEqual(
      Object.keys(dto).sort(),
      [
        'aiAutomationAllowed',
        'cancelAtPeriodEnd',
        'currentPeriodEnd',
        'currentPeriodStart',
        'denyReason',
        'developerSuspended',
        'plan',
        'salonActive',
        'salonId',
        'status',
        'trialEndsAt',
        'usedMissingSubscriptionFallback',
      ].sort(),
    );
    assert.match(types, /interface DeveloperSalonEntitlementPublic/);
    assert.doesNotMatch(
      types.slice(types.indexOf('interface DeveloperSalonEntitlementPublic')),
      /providerCustomerId|providerSubscriptionId|provider_customer_id|provider_subscription_id/,
    );
    assert.doesNotMatch(
      entitlement,
      /stripe|paddle|paypal|cloudpayments|sk_live/i,
    );
  });

  it('runtime: messengers use shared AI gate; Apple / reminders / poller stay ungated', () => {
    const patterns = /getSalonEntitlements|evaluateSalonEntitlement|salonEntitlement/;
    assert.match(index, /enforceTelegramAiAutomationGate|telegramSubscriptionGate/);
    assert.match(waWebhook, /enforceMessengerAiAutomationGate|messengerAiAutomationGate/);
    assert.match(igProcess, /enforceMessengerAiAutomationGate|messengerAiAutomationGate/);
    assert.doesNotMatch(telegramBooking, patterns);
    assert.doesNotMatch(telegramBotManager, patterns);
    assert.doesNotMatch(telegramPolling, patterns);
    assert.doesNotMatch(waFlow, patterns);
    assert.doesNotMatch(waOutbound, patterns);
    assert.doesNotMatch(igRoutes, patterns);
    assert.doesNotMatch(calendar, patterns);
    assert.doesNotMatch(reminders, patterns);
    assert.doesNotMatch(appointmentReminders, patterns);
  });

  it('salons.active semantics unchanged in entitlement module (ops kill-switch, not rewritten)', () => {
    assert.match(entitlement, /salonActive === false/);
    assert.match(entitlement, /salon_inactive/);
    assert.doesNotMatch(entitlement, /\.update\(/);
    assert.doesNotMatch(entitlement, /UPDATE\s+public\.salons/i);
  });

  it('package registers SUB-1B suite once', () => {
    const n = (packageJson.match(/salonEntitlement\.sub1b\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
