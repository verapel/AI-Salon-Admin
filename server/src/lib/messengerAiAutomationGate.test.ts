/**
 * Messenger AI subscription enforcement: shared gate + Telegram/WhatsApp/Instagram wiring.
 * No DB mutation. No production provider calls.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import {
  evaluateSalonEntitlement,
  SalonEntitlementNotFoundError,
  type EvaluateSalonEntitlementInput,
} from './salonEntitlement.js';
import {
  MESSENGER_AI_UNAVAILABLE_MESSAGE,
  MESSENGER_AI_UNAVAILABLE_THROTTLE_MS,
  MessengerUnavailableThrottle,
  defaultMessengerUnavailableThrottle,
  enforceMessengerAiAutomationGate,
} from './messengerAiAutomationGate.js';
import { enforceTelegramAiAutomationGate, TelegramUnavailableThrottle } from './telegramSubscriptionGate.js';
import {
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from './instagramWebhookProcess.js';
import { normalizeInstagramWebhookPayload } from './instagramWebhookEvents.js';
import instagramWebhookRouter, {
  setInstagramWebhookProcessDepsForTests,
} from '../routes/instagramWebhook.js';
import { computeInstagramHubSignatureHex } from './instagramWebhookSignature.js';
import type { SalonEntitlements } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const NOW = new Date('2026-09-09T12:00:00.000Z');
const FUTURE = '2026-10-09T12:00:00.000Z';
const PAST = '2026-08-01T12:00:00.000Z';
const SALON = '11111111-1111-1111-1111-111111111111';
const SENDER = '17841400000000099';
const IG_ACCOUNT = '17841400000000001';

function baseInput(
  overrides: Partial<EvaluateSalonEntitlementInput> = {},
): EvaluateSalonEntitlementInput {
  return {
    salonId: SALON,
    salonActive: true,
    plan: 'standard',
    subscriptionStatus: 'active',
    trialEndsAt: null,
    currentPeriodStart: NOW.toISOString(),
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    developerSuspended: false,
    usedMissingSubscriptionFallback: false,
    usedSubscriptionReadFailureFallback: false,
    usedSalonReadFailureFallback: false,
    ...overrides,
  };
}

function entitlementsFrom(
  overrides: Partial<EvaluateSalonEntitlementInput> = {},
): SalonEntitlements {
  return evaluateSalonEntitlement(baseInput(overrides), NOW);
}

function igMessageEvent(mid = 'mid.sub.1', text = 'hi') {
  return normalizeInstagramWebhookPayload({
    object: 'instagram',
    entry: [
      {
        id: IG_ACCOUNT,
        messaging: [
          {
            sender: { id: SENDER },
            recipient: { id: IG_ACCOUNT },
            timestamp: 1_700_000_000_000,
            message: { mid, text },
          },
        ],
      },
    ],
  })[0];
}

function instagramProcessDeps(
  overrides: Partial<InstagramProcessDeps> & {
    fsmCalls?: { n: number };
    identityCalls?: { n: number };
    commitCalls?: { n: number };
  } = {},
): InstagramProcessDeps {
  const fsmCalls = overrides.fsmCalls ?? { n: 0 };
  const identityCalls = overrides.identityCalls ?? { n: 0 };
  const commitCalls = overrides.commitCalls ?? { n: 0 };
  return {
    route: async () => ({
      kind: 'connected',
      salonId: SALON,
      professionalAccountId: IG_ACCOUNT,
    }),
    claim: async () => ({ kind: 'claimed', receiptId: 'r-sub', attemptCount: 1 }),
    finalize: async (p) => ({ ok: true, status: p.finalStatus }),
    markFailed: async () => ({ ok: true }),
    applyIdentityConversation: async () => {
      identityCalls.n += 1;
      return {
        kind: 'ok',
        identityId: 'id-1',
        conversationId: 'conv-1',
        clientId: null,
        advanced: true,
        identityCreated: false,
        conversationCreated: false,
      };
    },
    runBookingFsm: async () => {
      fsmCalls.n += 1;
      return { kind: 'ask_service', messageKey: 'k', text: 'choose' };
    },
    commitBooking: async () => {
      commitCalls.n += 1;
      return { kind: 'error', code: 'should_not_commit' };
    },
    enqueueOutbound: async ({ intent }) => ({
      kind: 'enqueued',
      id: 'ob-1',
      created: true,
      intentKey: intent.kind,
    }),
    ...overrides,
  };
}

afterEach(() => {
  setInstagramWebhookProcessDepsForTests(null);
  defaultMessengerUnavailableThrottle.clearAll();
});

describe('messenger AI entitlement gate (shared)', () => {
  it('active paid subscription allows AI processing', async () => {
    const gate = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-1',
      getEntitlements: async () => entitlementsFrom(),
      throttle: new MessengerUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, true);
  });

  it('cancel_at_period_end with future current_period_end still allows AI', async () => {
    const gate = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-1',
      getEntitlements: async () =>
        entitlementsFrom({
          cancelAtPeriodEnd: true,
          currentPeriodEnd: FUTURE,
        }),
      throttle: new MessengerUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, true);
  });

  it('expired / unpaid / past_due / developer_suspended block AI and send the same Russian message', async () => {
    const cases: Array<Partial<EvaluateSalonEntitlementInput>> = [
      { subscriptionStatus: 'expired' },
      { subscriptionStatus: 'unpaid' },
      { subscriptionStatus: 'past_due' },
      { developerSuspended: true },
    ];
    for (const overrides of cases) {
      const gate = await enforceMessengerAiAutomationGate({
        salonId: SALON,
        conversationKey: 'peer-deny',
        getEntitlements: async () => entitlementsFrom(overrides),
        throttle: new MessengerUnavailableThrottle(),
        now: NOW,
      });
      assert.equal(gate.proceed, false);
      if (!gate.proceed) {
        assert.equal(gate.customerMessage, MESSENGER_AI_UNAVAILABLE_MESSAGE);
        assert.equal(gate.customerFacingBilling, false);
        assert.equal(gate.sendCustomerMessage, true);
        assert.doesNotMatch(
          gate.customerMessage,
          /subscription|payment|оплат|подписк|billing|suspended|истек|15000/i,
        );
      }
    }
  });

  it('throttles duplicate unavailable replies; restoring entitlement clears throttle without reconnect', async () => {
    const throttle = new MessengerUnavailableThrottle(MESSENGER_AI_UNAVAILABLE_THROTTLE_MS);
    let allowed = false;
    const load = async () =>
      entitlementsFrom(allowed ? {} : { subscriptionStatus: 'unpaid' });

    const first = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-2',
      getEntitlements: load,
      throttle,
      now: NOW,
    });
    const dup = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-2',
      getEntitlements: load,
      throttle,
      now: new Date(NOW.getTime() + 1_000),
    });
    assert.equal(first.proceed, false);
    assert.equal(dup.proceed, false);
    if (!first.proceed && !dup.proceed) {
      assert.equal(first.sendCustomerMessage, true);
      assert.equal(dup.sendCustomerMessage, false);
    }

    allowed = true;
    const resumed = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-2',
      getEntitlements: load,
      throttle,
      now: new Date(NOW.getTime() + 2_000),
    });
    assert.equal(resumed.proceed, true);

    allowed = false;
    const laterDeny = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-2',
      getEntitlements: load,
      throttle,
      now: new Date(NOW.getTime() + 3_000),
    });
    assert.equal(laterDeny.proceed, false);
    if (!laterDeny.proceed) assert.equal(laterDeny.sendCustomerMessage, true);
  });

  it('salon-not-found blocks AI; unexpected loader throw fail-opens', async () => {
    const denied = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-3',
      getEntitlements: async () => {
        throw new SalonEntitlementNotFoundError(SALON);
      },
      throttle: new MessengerUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(denied.proceed, false);

    const open = await enforceMessengerAiAutomationGate({
      salonId: SALON,
      conversationKey: 'peer-3',
      getEntitlements: async () => {
        throw new Error('db down');
      },
      throttle: new MessengerUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(open.proceed, true);
  });
});

describe('Instagram inbound AI gate', () => {
  it('active subscription still runs booking FSM', async () => {
    const fsmCalls = { n: 0 };
    const r = await processInstagramWebhookEvent(
      igMessageEvent(),
      instagramProcessDeps({
        fsmCalls,
        getEntitlements: async () => entitlementsFrom(),
      }),
    );
    assert.equal(r.outcome, 'processed');
    assert.equal(fsmCalls.n, 1);
  });

  it('expired subscription skips FSM/identity/commit and enqueues the inactive message', async () => {
    const fsmCalls = { n: 0 };
    const identityCalls = { n: 0 };
    const commitCalls = { n: 0 };
    const r = await processInstagramWebhookEvent(
      igMessageEvent(),
      instagramProcessDeps({
        fsmCalls,
        identityCalls,
        commitCalls,
        getEntitlements: async () => entitlementsFrom({ subscriptionStatus: 'expired' }),
      }),
    );
    assert.equal(r.outcome, 'processed');
    assert.equal(fsmCalls.n, 0);
    assert.equal(identityCalls.n, 0);
    assert.equal(commitCalls.n, 0);
    if (r.outcome === 'processed') {
      assert.equal(r.outboundIntent?.text, MESSENGER_AI_UNAVAILABLE_MESSAGE);
    }
  });

  it('duplicate receipt does not send another unavailable message', async () => {
    const throttle = new MessengerUnavailableThrottle();
    let claimN = 0;
    const enqueued: string[] = [];
    const event = igMessageEvent('mid.dup.1');
    const deps = instagramProcessDeps({
      throttle,
      getEntitlements: async () => entitlementsFrom({ subscriptionStatus: 'unpaid' }),
      claim: async () => {
        claimN += 1;
        if (claimN === 1) return { kind: 'claimed', receiptId: 'r-dup', attemptCount: 1 };
        return { kind: 'duplicate_terminal', status: 'processed' };
      },
      enqueueOutbound: async ({ intent }) => {
        enqueued.push(intent.text);
        return { kind: 'enqueued', id: 'ob-dup', created: true, intentKey: intent.kind };
      },
    });
    const first = await processInstagramWebhookEvent(event, deps);
    const second = await processInstagramWebhookEvent(event, deps);
    assert.equal(first.outcome, 'processed');
    assert.equal(second.outcome, 'duplicate_terminal');
    assert.deepEqual(enqueued, [MESSENGER_AI_UNAVAILABLE_MESSAGE]);
  });

  it('new entitlement resumes Instagram AI without reconnecting', async () => {
    const fsmCalls = { n: 0 };
    let allowed = false;
    const deps = instagramProcessDeps({
      fsmCalls,
      getEntitlements: async () =>
        entitlementsFrom(allowed ? {} : { subscriptionStatus: 'past_due' }),
    });
    const blocked = await processInstagramWebhookEvent(igMessageEvent('mid.resume.1'), deps);
    assert.equal(blocked.outcome, 'processed');
    assert.equal(fsmCalls.n, 0);
    allowed = true;
    const resumed = await processInstagramWebhookEvent(igMessageEvent('mid.resume.2'), deps);
    assert.equal(resumed.outcome, 'processed');
    assert.equal(fsmCalls.n, 1);
  });

  it('webhook still acknowledges HTTP 200 when subscription is inactive', async () => {
    const previousSecret = process.env.INSTAGRAM_APP_SECRET;
    process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret-test';
    const fsmCalls = { n: 0 };
    setInstagramWebhookProcessDepsForTests(
      instagramProcessDeps({
        fsmCalls,
        getEntitlements: async () => entitlementsFrom({ developerSuspended: true }),
      }),
    );
    const app = express();
    app.use('/api/webhooks/instagram', instagramWebhookRouter);
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      assert.ok(addr && typeof addr !== 'string');
      const payload = {
        object: 'instagram',
        entry: [
          {
            id: IG_ACCOUNT,
            messaging: [
              {
                sender: { id: SENDER },
                recipient: { id: IG_ACCOUNT },
                timestamp: 1,
                message: { mid: 'mid.http.inactive', text: 'hello' },
              },
            ],
          },
        ],
      };
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = `sha256=${computeInstagramHubSignatureHex('ig-app-secret-test', body)}`;
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/webhooks/instagram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
        body,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
      assert.equal(fsmCalls.n, 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      if (previousSecret == null) delete process.env.INSTAGRAM_APP_SECRET;
      else process.env.INSTAGRAM_APP_SECRET = previousSecret;
    }
  });
});

describe('Telegram wrapper keeps poller intact and uses the shared message', () => {
  it('Telegram deny uses the shared inactive message and does not imply poller teardown', async () => {
    const gate = await enforceTelegramAiAutomationGate({
      salonId: SALON,
      chatId: 42,
      getEntitlements: async () => entitlementsFrom({ subscriptionStatus: 'expired' }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, false);
    if (!gate.proceed) {
      assert.equal(gate.customerMessage, MESSENGER_AI_UNAVAILABLE_MESSAGE);
    }
  });
});

describe('messenger AI entitlement source contracts', () => {
  const index = read('server/src/index.ts');
  const telegramProcess = index.slice(index.indexOf('async function processTelegramUpdate'));
  const waWebhook = read('server/src/routes/whatsappWebhook.ts');
  const igProcess = read('server/src/lib/instagramWebhookProcess.ts');
  const botManager = read('server/src/lib/telegramBotManager.ts');
  const polling = read('server/src/lib/telegramPollingControl.ts');
  const packageJson = read('server/package.json');
  const waClaim = waWebhook.slice(waWebhook.indexOf('async function claimAndFinalizeReceipt'));
  const igFn = igProcess.slice(igProcess.indexOf('export async function processInstagramWebhookEvent'));

  it('wires the shared gate before Telegram LLM, WhatsApp FSM, and Instagram FSM', () => {
    const tgGate = telegramProcess.indexOf('enforceTelegramAiAutomationGate');
    const llm = telegramProcess.indexOf('generateAIResponse');
    assert.ok(tgGate > 0 && tgGate < llm);

    const waGate = waClaim.indexOf('enforceMessengerAiAutomationGate');
    const waFsm = waClaim.indexOf('processWhatsAppBookingFsm');
    assert.ok(waGate > 0 && waGate < waFsm);
    assert.match(waClaim, /MESSENGER_AI_UNAVAILABLE_MESSAGE_KEY/);
    assert.match(waClaim, /skipAiAutomation/);

    const igGate = igFn.indexOf('enforceMessengerAiAutomationGate');
    const igFsm = igFn.indexOf('runBookingFsm');
    assert.ok(igGate > 0 && igGate < igFsm);
    assert.match(igProcess, /getEntitlements:\s*\(salonId\)\s*=>\s*getSalonEntitlements/);
  });

  it('Telegram deny path does not stop polling or disconnect the bot', () => {
    const denyBlock = telegramProcess.slice(
      telegramProcess.indexOf('if (!gate.proceed)'),
      telegramProcess.indexOf('// Нажатие на inline-кнопку'),
    );
    assert.doesNotMatch(denyBlock, /stopPoller|stopAll|restartTelegramPolling|isPolling\s*=\s*false/);
    assert.doesNotMatch(botManager, /enforceMessengerAiAutomationGate|getSalonEntitlements/);
    assert.doesNotMatch(polling, /enforceMessengerAiAutomationGate|getSalonEntitlements/);
  });

  it('WhatsApp / Instagram deny path does not disconnect or retry as a 500', () => {
    assert.doesNotMatch(waClaim, /status:\s*'disconnected'/);
    assert.match(waClaim, /skipAiAutomation = true/);
    assert.match(waClaim, /finalizeStatus = 'processed'/);
    assert.doesNotMatch(igFn, /status:\s*'disconnected'/);
    assert.match(igFn, /skipAiAutomation = true/);
  });

  it('package registers this suite once', () => {
    const n = (packageJson.match(/messengerAiAutomationGate\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
