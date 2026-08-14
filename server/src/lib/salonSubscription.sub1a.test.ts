/**
 * SUB-1A: salon_subscriptions foundation — static source contracts + helper unit checks.
 * No DB mutation. Migration not executed here. No messenger gating.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildLegacyActiveSubscriptionFallback,
  isSalonSubscriptionStatus,
  toDeveloperSalonSubscriptionPublic,
} from './salonSubscription.js';
import { SALON_SUBSCRIPTION_STATUSES } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const migration = read(
  'supabase/migrations/20260814000001_salon_subscriptions_foundation.sql',
);
const helper = read('server/src/lib/salonSubscription.ts');
const types = read('server/src/types.ts');
const index = read('server/src/index.ts');
const telegramBooking = read('server/src/lib/telegramBooking.ts');
const waRoutes = read('server/src/routes/whatsappIntegrations.ts');
const waWebhook = read('server/src/routes/whatsappWebhook.ts');
const igRoutes = read('server/src/routes/instagramIntegrations.ts');
const igProcess = read('server/src/lib/instagramWebhookProcess.ts');
const calendar = read('server/src/routes/calendarConnections.ts');
const reminders = read('server/src/lib/telegramReminderWorker.ts');
const developer = read('server/src/routes/developer.ts');
const packageJson = read('server/package.json');

describe('SUB-1A salon_subscriptions foundation (static + helpers)', () => {
  it('1. allowed statuses and CHECK constraint', () => {
    for (const s of ['trial', 'active', 'past_due', 'expired', 'cancelled'] as const) {
      assert.equal(isSalonSubscriptionStatus(s), true);
      assert.ok(SALON_SUBSCRIPTION_STATUSES.includes(s));
    }
    assert.equal(isSalonSubscriptionStatus('suspended'), false);
    assert.equal(isSalonSubscriptionStatus('inactive'), false);
    assert.match(
      migration,
      /CHECK \(status IN \('trial', 'active', 'past_due', 'expired', 'cancelled'\)\)/,
    );
    assert.doesNotMatch(
      migration,
      /CHECK \(status IN \('trial', 'active', 'past_due', 'expired', 'cancelled', 'suspended'\)\)/,
    );
  });

  it('2. schema is 1:1 with salon; no fields on salons; no ai_automation_enabled column', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.salon_subscriptions/);
    assert.match(
      migration,
      /salon_id uuid PRIMARY KEY\s*\n\s*REFERENCES public\.salons\(id\)\s*\n\s*ON DELETE CASCADE/,
    );
    assert.doesNotMatch(migration, /ALTER TABLE public\.salons\s+ADD/);
    assert.doesNotMatch(migration, /ai_automation_enabled/);
    assert.match(migration, /developer_suspended boolean NOT NULL DEFAULT false/);
    assert.match(types, /SalonSubscriptionStatus/);
    assert.match(types, /DeveloperSalonSubscriptionPublic/);
  });

  it('3. backfill defaults active; null period end; does not touch salons.active', () => {
    assert.match(migration, /INSERT INTO public\.salon_subscriptions/);
    assert.match(migration, /ON CONFLICT \(salon_id\) DO NOTHING/);
    assert.match(migration, /'standard'/);
    assert.match(migration, /'active'/);
    assert.match(migration, /developer_suspended[\s\S]{0,80}false|false,\s*\n\s*NULL,\s*\n\s*NULL/);
    assert.doesNotMatch(migration, /UPDATE public\.salons/);
    assert.doesNotMatch(
      migration,
      /UPDATE public\.(appointments|clients|staff|services|reminders|salon_integrations)/,
    );
  });

  it('4. future salon provisioning via AFTER INSERT trigger', () => {
    assert.match(migration, /ensure_salon_subscription_row/);
    assert.match(migration, /AFTER INSERT ON public\.salons/);
    assert.match(migration, /ON CONFLICT \(salon_id\) DO NOTHING/);
    assert.match(migration, /SECURITY INVOKER/);
    // Creation path still inserts salons; trigger covers it without route changes.
    assert.match(developer, /\.from\('salons'\)\s*\.insert\(/);
    assert.doesNotMatch(developer, /salon_subscriptions/);
  });

  it('5. indexes + RLS without client write policies', () => {
    assert.match(migration, /salon_subscriptions_status_idx/);
    assert.match(migration, /salon_subscriptions_current_period_end_idx/);
    assert.match(migration, /salon_subscriptions_provider_subscription_id_unique/);
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(migration, /CREATE POLICY/);
  });

  it('6. missing-row fallback does not disable salon', () => {
    const fb = buildLegacyActiveSubscriptionFallback('salon-1');
    assert.equal(fb.status, 'active');
    assert.equal(fb.plan, 'standard');
    assert.equal(fb.developerSuspended, false);
    assert.equal(fb.currentPeriodEnd, null);
    assert.equal(fb.usedMissingRowFallback, true);
    assert.match(helper, /buildLegacyActiveSubscriptionFallback/);
    assert.match(helper, /usedMissingRowFallback/);
    assert.doesNotMatch(helper, /aiAutomationAllowed|canUseAiAutomation/);
  });

  it('7. developer public DTO omits provider linkage ids; no payment-provider mutation APIs', () => {
    const pub = toDeveloperSalonSubscriptionPublic(
      buildLegacyActiveSubscriptionFallback('s1'),
    );
    assert.equal('providerCustomerId' in pub, false);
    assert.equal('providerSubscriptionId' in pub, false);
    assert.match(helper, /toDeveloperSalonSubscriptionPublic/);
    // SUB-1C adds developer salon subscription PATCH; payment-provider mutation stays forbidden.
    assert.match(developer, /\/salons\/:salonId\/subscription/);
    assert.doesNotMatch(developer, /stripe|paddle|paypal|billingPortal|checkout\.session/i);
    assert.doesNotMatch(helper, /router\.(post|patch|put|delete)/);
  });

  it('8. no payment provider / secrets; messengers / apple / reminders unchanged by this helper', () => {
    assert.doesNotMatch(migration, /stripe|paddle|paypal|cloudpayments|sk_live|webhook_secret/i);
    assert.doesNotMatch(helper, /stripe|paddle|paypal/i);
    assert.doesNotMatch(index, /getSalonSubscription|salonSubscription/);
    assert.doesNotMatch(telegramBooking, /getSalonSubscription|salon_subscriptions/);
    assert.doesNotMatch(waWebhook, /getSalonSubscription|salon_subscriptions/);
    assert.doesNotMatch(waRoutes, /getSalonSubscription|salon_subscriptions/);
    assert.doesNotMatch(igProcess, /getSalonSubscription|salon_subscriptions/);
    assert.doesNotMatch(igRoutes, /getSalonSubscription|salon_subscriptions/);
    assert.doesNotMatch(calendar, /getSalonSubscription|salon_subscriptions/);
    assert.doesNotMatch(reminders, /getSalonSubscription|salon_subscriptions/);
  });

  it('9. migration not executed by tests; package registers suite once', () => {
    // DDL may create the trigger; tests must not invoke provisioning as a runtime call.
    assert.doesNotMatch(migration, /SELECT public\.ensure_salon_subscription_row\(/);
    assert.match(migration, /CREATE TRIGGER trg_salons_ensure_subscription/);
    const n = (packageJson.match(/salonSubscription\.sub1a\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
