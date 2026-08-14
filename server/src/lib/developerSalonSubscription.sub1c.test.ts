/**
 * SUB-1C: Developer subscription management — validation + static source contracts.
 * No DB mutation. No messenger enforcement. No payment provider.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseDeveloperSalonSubscriptionPatch,
  parseOptionalIsoTimestamp,
  toDeveloperSalonSubscriptionApiResponse,
  isDeveloperSalonSubscriptionValidationError,
  DeveloperSalonSubscriptionValidationError,
} from './developerSalonSubscription.js';
import { evaluateSalonEntitlement } from './salonEntitlement.js';
import {
  DEVELOPER_SALON_SUBSCRIPTION_PATCH_FIELDS,
  SALON_ENTITLEMENT_DENY_REASONS,
} from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('SUB-1C developer subscription validation (runtime)', () => {
  it('4/5. allowed status accepted; invalid status rejected', () => {
    const ok = parseDeveloperSalonSubscriptionPatch({ status: 'past_due' });
    assert.equal(ok.status, 'past_due');
    assert.throws(
      () => parseDeveloperSalonSubscriptionPatch({ status: 'suspended' }),
      (err: unknown) =>
        isDeveloperSalonSubscriptionValidationError(err) &&
        err.message.includes('Invalid status'),
    );
  });

  it('6. invalid timestamp rejected; valid ISO / null accepted', () => {
    assert.equal(parseOptionalIsoTimestamp(null, 'trialEndsAt'), null);
    assert.equal(parseOptionalIsoTimestamp('', 'trialEndsAt'), null);
    const iso = parseOptionalIsoTimestamp('2026-08-20T12:00:00.000Z', 'trialEndsAt');
    assert.equal(iso, '2026-08-20T12:00:00.000Z');
    assert.throws(
      () => parseOptionalIsoTimestamp('not-a-date', 'trialEndsAt'),
      DeveloperSalonSubscriptionValidationError,
    );
    assert.throws(
      () => parseOptionalIsoTimestamp('08/20/2026', 'trialEndsAt'),
      DeveloperSalonSubscriptionValidationError,
    );
  });

  it('7. provider linkage fields cannot be mutated (unknown fields rejected)', () => {
    assert.throws(
      () =>
        parseDeveloperSalonSubscriptionPatch({
          developerSuspended: true,
          providerCustomerId: 'cus_x',
        }),
      (err: unknown) =>
        isDeveloperSalonSubscriptionValidationError(err) &&
        String((err as Error).message).includes('Unknown field'),
    );
    assert.throws(
      () =>
        parseDeveloperSalonSubscriptionPatch({
          providerSubscriptionId: 'sub_x',
        }),
      DeveloperSalonSubscriptionValidationError,
    );
    assert.throws(
      () => parseDeveloperSalonSubscriptionPatch({ provider: 'stripe' }),
      DeveloperSalonSubscriptionValidationError,
    );
    assert.throws(
      () => parseDeveloperSalonSubscriptionPatch({ salonId: 'x' }),
      DeveloperSalonSubscriptionValidationError,
    );
  });

  it('8. developer_suspended can change; plan restricted to standard', () => {
    const patch = parseDeveloperSalonSubscriptionPatch({
      developerSuspended: true,
      plan: 'standard',
    });
    assert.equal(patch.developerSuspended, true);
    assert.equal(patch.plan, 'standard');
    assert.throws(
      () => parseDeveloperSalonSubscriptionPatch({ plan: 'premium' }),
      DeveloperSalonSubscriptionValidationError,
    );
  });

  it('10. response mapping reuses central entitlement (no duplicated decision)', () => {
    const entitlements = evaluateSalonEntitlement({
      salonId: 'salon-1',
      salonActive: true,
      plan: 'standard',
      subscriptionStatus: 'active',
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      developerSuspended: true,
    });
    assert.equal(entitlements.aiAutomationAllowed, false);
    assert.equal(entitlements.denyReason, 'developer_suspended');

    const api = toDeveloperSalonSubscriptionApiResponse(entitlements, '2026-08-14T12:00:00.000Z');
    assert.equal(api.aiAutomationAllowed, false);
    assert.equal(api.denyReason, 'developer_suspended');
    assert.equal(api.updatedAt, '2026-08-14T12:00:00.000Z');
    assert.equal('providerCustomerId' in api, false);
    assert.equal('providerSubscriptionId' in api, false);
  });

  it('patch fields allowlist matches product surface', () => {
    assert.deepEqual([...DEVELOPER_SALON_SUBSCRIPTION_PATCH_FIELDS].sort(), [
      'cancelAtPeriodEnd',
      'currentPeriodEnd',
      'currentPeriodStart',
      'developerSuspended',
      'plan',
      'status',
      'trialEndsAt',
    ].sort());
  });
});

describe('SUB-1C developer subscription (static source contracts)', () => {
  const developerRoutes = read('server/src/routes/developer.ts');
  const helper = read('server/src/lib/developerSalonSubscription.ts');
  const entitlement = read('server/src/lib/salonEntitlement.ts');
  const index = read('server/src/index.ts');
  const telegramBooking = read('server/src/lib/telegramBooking.ts');
  const telegramBotManager = read('server/src/lib/telegramBotManager.ts');
  const waWebhook = read('server/src/routes/whatsappWebhook.ts');
  const waFlow = read('server/src/lib/whatsappBookingFlow.ts');
  const waOutbound = read('server/src/lib/whatsappOutboundWorker.ts');
  const igProcess = read('server/src/lib/instagramWebhookProcess.ts');
  const calendar = read('server/src/routes/calendarConnections.ts');
  const reminders = read('server/src/lib/telegramReminderWorker.ts');
  const appointmentReminders = read('server/src/lib/appointmentReminders.ts');
  const appointments = read('server/src/routes/appointments.ts');
  const apiClient = read('client/src/lib/api.ts');
  const modal = read('client/src/components/developer/SalonDetailModal.tsx');
  const section = read('client/src/components/developer/SalonSubscriptionSection.tsx');
  const clientTypes = read('client/src/types/index.ts');
  const translations = read('client/src/i18n/translations.ts');
  const packageJson = read('server/package.json');
  const auth = read('server/src/middleware/auth.ts');
  const serverIndex = read('server/src/index.ts');

  it('1/2. GET and PATCH subscription routes exist under developer router', () => {
    assert.match(developerRoutes, /router\.get\('\/salons\/:salonId\/subscription'/);
    assert.match(developerRoutes, /router\.patch\('\/salons\/:salonId\/subscription'/);
    assert.match(developerRoutes, /getDeveloperSalonSubscription/);
    assert.match(developerRoutes, /updateDeveloperSalonSubscription/);
  });

  it('static: developer auth wraps /api/developer (owner/staff cannot use these routes)', () => {
    assert.match(serverIndex, /app\.use\('\/api\/developer',\s*developerAuth/);
    assert.match(auth, /export async function requireDeveloperAuth/);
    assert.doesNotMatch(developerRoutes, /requireSalonWriteAccess/);
    // No owner/staff subscription mutation routes on cabinet APIs
    const clients = read('server/src/routes/clients.ts');
    const staff = read('server/src/routes/staff.ts');
    assert.doesNotMatch(appointments, /\/subscription|salon_subscriptions/);
    assert.doesNotMatch(clients, /\/subscription|salon_subscriptions/);
    assert.doesNotMatch(staff, /\/subscription|salon_subscriptions/);
  });

  it('3. salonId path scoping (exact param, UUID check)', () => {
    assert.match(developerRoutes, /req\.params\.salonId/);
    assert.match(developerRoutes, /isSalonUuid\(salonId\)/);
    assert.match(apiClient, /getSalonSubscription:\s*\(salonId:\s*string\)/);
    assert.match(
      apiClient,
      /`\/developer\/salons\/\$\{salonId\}\/subscription`/,
    );
    assert.doesNotMatch(apiClient, /DEFAULT_SALON|defaultSalon.*subscription/i);
  });

  it('9. subscription update does not change salons.active', () => {
    assert.doesNotMatch(helper, /\.from\('salons'\)\s*\.update/);
    assert.match(helper, /Never mutate salons\.active/);
  });

  it('11. nonexistent salon cannot receive synthetic subscription (assert exists first)', () => {
    assert.match(helper, /assertSalonExists/);
    assert.match(helper, /SalonEntitlementNotFoundError/);
    assert.match(helper, /ensureSalonSubscriptionRowForExistingSalon/);
  });

  it('12. provider IDs / secrets absent from API response mapper', () => {
    assert.doesNotMatch(helper, /provider_customer_id|providerCustomerId/);
    assert.doesNotMatch(helper, /provider_subscription_id|providerSubscriptionId/);
    assert.doesNotMatch(clientTypes, /providerCustomerId|providerSubscriptionId/);
    assert.match(clientTypes, /interface DeveloperSalonSubscription/);
  });

  it('13. no owner/staff subscription endpoints; 15. no payment provider', () => {
    assert.doesNotMatch(helper, /stripe|paddle|paypal|sk_live/i);
    assert.doesNotMatch(developerRoutes, /stripe|paddle|paypal/i);
    assert.doesNotMatch(section, /stripe|paddle|paypal/i);
  });

  it('14. static: no runtime messenger / apple / reminder / appointment enforcement', () => {
    const patterns = /getSalonEntitlements|evaluateSalonEntitlement|developerSalonSubscription|aiAutomationAllowed|developer_suspended/;
    assert.doesNotMatch(telegramBooking, patterns);
    assert.doesNotMatch(telegramBotManager, patterns);
    assert.doesNotMatch(waWebhook, patterns);
    assert.doesNotMatch(waFlow, patterns);
    assert.doesNotMatch(waOutbound, patterns);
    assert.doesNotMatch(igProcess, patterns);
    assert.doesNotMatch(calendar, patterns);
    assert.doesNotMatch(reminders, patterns);
    assert.doesNotMatch(appointmentReminders, patterns);
    assert.doesNotMatch(appointments, /getSalonEntitlements|developerSalonSubscription/);
    // index may import developer router only — must not call entitlement for bootstrap enforcement
    assert.doesNotMatch(index, /getSalonEntitlements|evaluateSalonEntitlement/);
  });

  it('16. subscription UI exists in developer salon detail', () => {
    assert.match(modal, /SalonSubscriptionSection/);
    assert.match(section, /developer\.salons\.subscription\.title/);
    assert.match(section, /manualAiSuspension/);
    assert.match(section, /developerSuspended/);
  });

  it('17. all deny reasons localized RU/EN/HY', () => {
    for (const reason of SALON_ENTITLEMENT_DENY_REASONS) {
      const key = `'developer.salons.subscription.deny.${reason}'`;
      assert.equal(
        (translations.match(new RegExp(key.replace(/\./g, '\\.'), 'g')) || []).length,
        3,
        `expected 3 locales for ${key}`,
      );
    }
  });

  it('18. developer suspended UI distinct from salon active', () => {
    assert.match(section, /manualAiSuspension/);
    assert.match(translations, /Manual AI suspension/);
    assert.match(translations, /Ручная приостановка ИИ/);
    assert.match(translations, /Would allow|Would deny|Messengers are not blocked/);
    assert.doesNotMatch(section, /Delete salon|Deactivate salon/);
    // Salon active toggle remains on modal; subscription has its own suspension control
    assert.match(modal, /developer\.salons\.active/);
    assert.match(modal, /SalonSubscriptionSection/);
  });

  it('19/20. no provider IDs in client DTO; exact salonId used', () => {
    assert.match(section, /getSalonSubscription\(salonId\)/);
    assert.match(section, /updateSalonSubscription\(requestSalonId/);
    assert.doesNotMatch(section, /providerCustomerId|provider_subscription_id/);
  });

  it('central entitlement helper reused (not duplicated in routes)', () => {
    assert.match(helper, /getSalonEntitlements/);
    assert.doesNotMatch(developerRoutes, /evaluateSalonEntitlement/);
    assert.match(entitlement, /export async function getSalonEntitlements/);
  });

  it('package registers SUB-1C suite once', () => {
    const n = (packageJson.match(/developerSalonSubscription\.sub1c\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
