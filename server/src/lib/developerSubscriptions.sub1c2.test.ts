/**
 * SUB-1C2: Developer subscriptions page / sidebar — static source contracts + helper list checks.
 * No DB mutation. No messenger enforcement. No payment provider.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toDeveloperSalonSubscriptionApiResponse } from './developerSalonSubscription.js';
import { evaluateSalonEntitlement } from './salonEntitlement.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('SUB-1C2 developer subscriptions page (static source contracts)', () => {
  const layout = read('client/src/layouts/DeveloperLayout.tsx');
  const app = read('client/src/App.tsx');
  const page = read('client/src/pages/developer/DeveloperSubscriptions.tsx');
  const modal = read('client/src/components/developer/ConfigureSalonSubscriptionModal.tsx');
  const section = read('client/src/components/developer/SalonSubscriptionSection.tsx');
  const detail = read('client/src/components/developer/SalonDetailModal.tsx');
  const apiClient = read('client/src/lib/api.ts');
  const clientTypes = read('client/src/types/index.ts');
  const translations = read('client/src/i18n/translations.ts');
  const developerRoutes = read('server/src/routes/developer.ts');
  const helper = read('server/src/lib/developerSalonSubscription.ts');
  const index = read('server/src/index.ts');
  const telegramBooking = read('server/src/lib/telegramBooking.ts');
  const waWebhook = read('server/src/routes/whatsappWebhook.ts');
  const waFlow = read('server/src/lib/whatsappBookingFlow.ts');
  const igProcess = read('server/src/lib/instagramWebhookProcess.ts');
  const calendar = read('server/src/routes/calendarConnections.ts');
  const reminders = read('server/src/lib/telegramReminderWorker.ts');
  const appointments = read('server/src/routes/appointments.ts');
  const packageJson = read('server/package.json');
  const protectedDev = read('client/src/components/auth/ProtectedDeveloperRoute.tsx');

  it('1/2. Sidebar contains Subscriptions; /developer/subscriptions route exists', () => {
    assert.match(layout, /developer\.nav\.subscriptions/);
    assert.match(layout, /\/developer\/subscriptions/);
    assert.match(app, /path="subscriptions"/);
    assert.match(app, /DeveloperSubscriptions/);
    assert.match(translations, /'developer\.nav\.subscriptions': 'Subscriptions'/);
    assert.match(translations, /'developer\.nav\.subscriptions': 'Подписки'/);
    assert.match(translations, /'developer\.nav\.subscriptions': 'Բաժանորդագրություններ'/);
  });

  it('3. developer-only routing (ProtectedDeveloperRoute wraps cabinet)', () => {
    assert.match(app, /ProtectedDeveloperRoute/);
    assert.match(protectedDev, /isDeveloper|developer/);
    assert.match(index, /app\.use\('\/api\/developer',\s*developerAuth/);
  });

  it('4/5. subscriptions page lists salons via batch GET; salon-scoped loading', () => {
    assert.match(page, /getSalonSubscriptions/);
    assert.match(apiClient, /getSalonSubscriptions/);
    assert.match(apiClient, /\/developer\/subscriptions/);
    assert.match(developerRoutes, /router\.get\('\/subscriptions'/);
    assert.match(helper, /listDeveloperSalonSubscriptions/);
    assert.match(helper, /getDeveloperSalonSubscription/);
    assert.match(page, /row\.salonId/);
    assert.match(page, /openConfigure\(row\.salonId\)/);
  });

  it('6. one failed subscription fetch does not blank whole list (loadError row)', () => {
    assert.match(helper, /loadError: true/);
    assert.match(page, /row\.loadError/);
    assert.match(clientTypes, /loadError: boolean/);
  });

  it('7/9. status labels localized; AI copy Would allow/Would deny', () => {
    assert.match(page, /developer\.salons\.subscription\.status\./);
    assert.match(page, /developer\.salons\.subscription\.aiAllowed/);
    assert.match(page, /developer\.salons\.subscription\.aiSuspended/);
    assert.match(translations, /Would allow/);
    assert.match(translations, /Would deny/);
    assert.doesNotMatch(page, /AI active|AI disabled|Telegram disabled|WhatsApp disabled/i);
  });

  it('8. salon active shown separately from subscription status', () => {
    assert.match(page, /colSalonStatus/);
    assert.match(page, /row\.salonActive/);
    assert.match(page, /developer\.salons\.active/);
    assert.doesNotMatch(page, /updateSalon\(|active:\s*!/);
  });

  it('10/11. Configure opens exact salon; editor reuses existing section/PATCH', () => {
    assert.match(page, /ConfigureSalonSubscriptionModal/);
    assert.match(modal, /SalonSubscriptionSection/);
    assert.match(section, /updateSalonSubscription/);
    assert.match(section, /onUpdated/);
    assert.match(page, /setSearchParams\(\{ salonId \}/);
  });

  it('12/13. SalonDetail no longer owns full editor; compact summary + manage link', () => {
    assert.doesNotMatch(detail, /SalonSubscriptionSection/);
    assert.match(detail, /getSalonSubscription/);
    assert.match(detail, /developer\.subscriptions\.manage/);
    assert.match(detail, /\/developer\/subscriptions\?salonId=/);
  });

  it('14/15. deep-link salonId; invalid id does not crash', () => {
    assert.match(page, /searchParams\.get\('salonId'\)/);
    assert.match(page, /UUID_RE/);
    assert.match(page, /invalidSalonId/);
    assert.match(page, /salonNotInList/);
  });

  it('16/17. provider IDs absent; no owner/staff routes', () => {
    assert.doesNotMatch(page, /providerCustomerId|provider_subscription_id/);
    assert.doesNotMatch(helper, /provider_customer_id|providerCustomerId/);
    assert.doesNotMatch(apiClient, /\/owner\/.*subscription|\/staff\/.*subscription/);
    assert.doesNotMatch(appointments, /\/subscription/);
  });

  it('18/19/20. no messenger enforcement; no payment provider; messengers untouched by page', () => {
    const patterns =
      /getSalonEntitlements|evaluateSalonEntitlement|listDeveloperSalonSubscriptions|aiAutomationAllowed/;
    assert.doesNotMatch(telegramBooking, patterns);
    assert.doesNotMatch(waWebhook, patterns);
    assert.doesNotMatch(waFlow, patterns);
    assert.doesNotMatch(igProcess, patterns);
    assert.doesNotMatch(calendar, patterns);
    assert.doesNotMatch(reminders, patterns);
    assert.doesNotMatch(page, /stripe|paddle|paypal/i);
    assert.doesNotMatch(helper, /stripe|paddle|paypal/i);
  });

  it('stale unmount protection on list load', () => {
    assert.match(page, /cancelled = true/);
    assert.match(page, /if \(cancelled\) return/);
  });

  it('package registers SUB-1C2 suite once', () => {
    const n = (packageJson.match(/developerSubscriptions\.sub1c2\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});

describe('SUB-1C2 list response mapping (runtime)', () => {
  it('list item entitlement mapping stays consistent with central helper', () => {
    const entitlements = evaluateSalonEntitlement({
      salonId: 's1',
      salonActive: true,
      plan: 'standard',
      subscriptionStatus: 'active',
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      developerSuspended: false,
    });
    const api = toDeveloperSalonSubscriptionApiResponse(entitlements, null);
    assert.equal(api.aiAutomationAllowed, true);
    assert.equal(api.denyReason, null);
    assert.equal('providerCustomerId' in api, false);
  });
});
