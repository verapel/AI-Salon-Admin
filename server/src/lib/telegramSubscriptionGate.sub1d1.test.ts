/**
 * SUB-1D1: Telegram subscription enforcement — runtime gate + static contracts.
 * Patch-only stage: no DB mutation, no WhatsApp/Instagram/Apple/reminder changes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  evaluateSalonEntitlement,
  SalonEntitlementNotFoundError,
  type EvaluateSalonEntitlementInput,
} from './salonEntitlement.js';
import {
  TELEGRAM_AI_UNAVAILABLE_MESSAGES,
  TELEGRAM_UNAVAILABLE_THROTTLE_MS,
  TelegramUnavailableThrottle,
  enforceTelegramAiAutomationGate,
  normalizeTelegramCustomerLang,
  telegramAiUnavailableMessage,
  telegramUnavailableThrottleKey,
} from './telegramSubscriptionGate.js';
import type { SalonEntitlements } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const NOW = new Date('2026-08-14T12:00:00.000Z');
const FUTURE = '2026-08-20T12:00:00.000Z';
const PAST = '2026-08-01T12:00:00.000Z';

function baseInput(
  overrides: Partial<EvaluateSalonEntitlementInput> = {},
): EvaluateSalonEntitlementInput {
  return {
    salonId: 'salon-a',
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

function entitlementsFrom(
  overrides: Partial<EvaluateSalonEntitlementInput> = {},
): SalonEntitlements {
  return evaluateSalonEntitlement(baseInput(overrides), NOW);
}

/** Simulated FSM map — gate must never mutate this. */
type FakeBooking = { step: string; service?: string; date?: string; time?: string };

/**
 * Minimal inbound handler mirror: gate first, then optional mutation.
 * Proves deny → zero business mutation + optional callback answer + throttled UX.
 */
async function simulateTelegramInbound(params: {
  salonId: string;
  chatId: number;
  languageCode?: string;
  hasCallbackQuery?: boolean;
  callbackData?: string;
  text?: string;
  getEntitlements: (salonId: string) => Promise<SalonEntitlements>;
  throttle: TelegramUnavailableThrottle;
  bookingState: Map<string, FakeBooking>;
  appointments: { id: string; status: string; date?: string; start_time?: string }[];
  clientsInserted: string[];
  answeredCallbacks: string[];
  sentMessages: string[];
  now?: Date;
}): Promise<'allowed' | 'blocked'> {
  const stateKey = `${params.salonId}:${params.chatId}`;
  const gate = await enforceTelegramAiAutomationGate({
    salonId: params.salonId,
    chatId: params.chatId,
    languageCode: params.languageCode,
    hasCallbackQuery: params.hasCallbackQuery === true,
    getEntitlements: params.getEntitlements,
    throttle: params.throttle,
    now: params.now ?? NOW,
  });

  if (!gate.proceed) {
    if (gate.answerCallbackQuery) {
      params.answeredCallbacks.push('cb-1');
    }
    if (gate.sendCustomerMessage) {
      params.sentMessages.push(gate.customerMessage);
    }
    return 'blocked';
  }

  // Allowed path — mirror a few mutation surfaces that must stay gated when denied.
  if (params.hasCallbackQuery && params.callbackData?.startsWith('cancel_confirm:')) {
    const id = params.callbackData.slice('cancel_confirm:'.length);
    const appt = params.appointments.find((a) => a.id === id);
    if (appt) appt.status = 'cancelled';
    params.answeredCallbacks.push('cb-1');
    return 'allowed';
  }
  if (params.hasCallbackQuery && params.callbackData?.startsWith('rtime:')) {
    const appt = params.appointments[0];
    if (appt) {
      appt.date = '2026-09-01';
      appt.start_time = '15:00:00';
    }
    params.answeredCallbacks.push('cb-1');
    return 'allowed';
  }
  if (params.hasCallbackQuery && params.callbackData?.startsWith('time:')) {
    const cur = params.bookingState.get(stateKey);
    if (cur?.step === 'time') {
      params.bookingState.set(stateKey, { ...cur, step: 'name', time: '14:00' });
    }
    params.answeredCallbacks.push('cb-1');
    return 'allowed';
  }

  if (params.text && params.bookingState.get(stateKey)?.step === 'phone') {
    params.clientsInserted.push(params.text);
    params.appointments.push({ id: 'new-appt', status: 'scheduled' });
    params.bookingState.set(stateKey, { step: 'done' });
    return 'allowed';
  }

  if (params.text === '/start') {
    params.bookingState.set(stateKey, { step: 'service' });
    return 'allowed';
  }

  if (params.text && params.bookingState.get(stateKey)?.step === 'time') {
    params.bookingState.set(stateKey, {
      ...params.bookingState.get(stateKey)!,
      step: 'name',
      time: params.text,
    });
    return 'allowed';
  }

  return 'allowed';
}

describe('SUB-1D1 Telegram entitlement gate (runtime)', () => {
  it('1. active subscription → Telegram normal path unchanged (proceed)', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const bookingState = new Map<string, FakeBooking>([
      ['salon-a:1', { step: 'time', date: '2026-08-20' }],
    ]);
    const appointments: { id: string; status: string }[] = [];
    const result = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 1,
      text: '14:00',
      getEntitlements: async () => entitlementsFrom(),
      throttle,
      bookingState,
      appointments,
      clientsInserted: [],
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(result, 'allowed');
    assert.equal(bookingState.get('salon-a:1')?.step, 'name');
    assert.equal(bookingState.get('salon-a:1')?.time, '14:00');
  });

  it('2. developer_suspended → customer gets unavailable message (no billing copy)', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const sentMessages: string[] = [];
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 42,
      languageCode: 'ru',
      getEntitlements: async () => entitlementsFrom({ developerSuspended: true }),
      throttle,
      now: NOW,
    });
    assert.equal(gate.proceed, false);
    if (!gate.proceed) {
      assert.equal(gate.sendCustomerMessage, true);
      assert.equal(gate.customerMessage, TELEGRAM_AI_UNAVAILABLE_MESSAGES.ru);
      assert.equal(gate.customerFacingBilling, false);
      assert.equal(gate.denyReason, 'developer_suspended');
      assert.doesNotMatch(gate.customerMessage, /subscription|payment|оплат|подписк|billing|suspended|истек/i);
      sentMessages.push(gate.customerMessage);
    }
    assert.equal(sentMessages.length, 1);
  });

  it('3. suspended booking state does not advance', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const bookingState = new Map<string, FakeBooking>([
      ['salon-a:7', { step: 'time', date: '2026-08-20' }],
    ]);
    const before = structuredClone(bookingState.get('salon-a:7'));
    const result = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 7,
      text: '14:00',
      getEntitlements: async () => entitlementsFrom({ developerSuspended: true }),
      throttle,
      bookingState,
      appointments: [],
      clientsInserted: [],
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(result, 'blocked');
    assert.deepEqual(bookingState.get('salon-a:7'), before);
  });

  it('4. suspended phone step does not insert appointment/client', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const bookingState = new Map<string, FakeBooking>([
      ['salon-a:8', { step: 'phone', name: 'Anna' }],
    ]);
    const appointments: { id: string; status: string }[] = [];
    const clientsInserted: string[] = [];
    const result = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 8,
      text: '+37400000000',
      getEntitlements: async () => entitlementsFrom({ developerSuspended: true }),
      throttle,
      bookingState,
      appointments,
      clientsInserted,
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(result, 'blocked');
    assert.equal(clientsInserted.length, 0);
    assert.equal(appointments.length, 0);
    assert.equal(bookingState.get('salon-a:8')?.step, 'phone');
  });

  it('5. suspended cancel callback does not cancel appointment', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const appointments = [{ id: 'appt-1', status: 'scheduled' }];
    const answeredCallbacks: string[] = [];
    const result = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 9,
      hasCallbackQuery: true,
      callbackData: 'cancel_confirm:appt-1',
      getEntitlements: async () => entitlementsFrom({ developerSuspended: true }),
      throttle,
      bookingState: new Map(),
      appointments,
      clientsInserted: [],
      answeredCallbacks,
      sentMessages: [],
    });
    assert.equal(result, 'blocked');
    assert.equal(appointments[0].status, 'scheduled');
    assert.deepEqual(answeredCallbacks, ['cb-1']);
  });

  it('6. suspended reschedule callback does not mutate appointment', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const appointments = [{ id: 'appt-2', status: 'scheduled', date: '2026-08-15', start_time: '10:00:00' }];
    const result = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 10,
      hasCallbackQuery: true,
      callbackData: 'rtime:appt-2:15:00',
      getEntitlements: async () => entitlementsFrom({ developerSuspended: true }),
      throttle,
      bookingState: new Map(),
      appointments,
      clientsInserted: [],
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(result, 'blocked');
    assert.equal(appointments[0].date, '2026-08-15');
    assert.equal(appointments[0].start_time, '10:00:00');
  });

  it('7. callback denied → callback query answered', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 11,
      hasCallbackQuery: true,
      getEntitlements: async () => entitlementsFrom({ subscriptionStatus: 'cancelled' }),
      throttle,
      now: NOW,
    });
    assert.equal(gate.proceed, false);
    if (!gate.proceed) {
      assert.equal(gate.answerCallbackQuery, true);
    }
  });

  it('8. repeated denied messages throttle unavailable response', async () => {
    const throttle = new TelegramUnavailableThrottle(TELEGRAM_UNAVAILABLE_THROTTLE_MS);
    const load = async () => entitlementsFrom({ developerSuspended: true });
    const first = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 12,
      getEntitlements: load,
      throttle,
      now: NOW,
    });
    const second = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 12,
      getEntitlements: load,
      throttle,
      now: new Date(NOW.getTime() + 60_000),
    });
    assert.equal(first.proceed, false);
    assert.equal(second.proceed, false);
    if (!first.proceed && !second.proceed) {
      assert.equal(first.sendCustomerMessage, true);
      assert.equal(second.sendCustomerMessage, false);
    }
  });

  it('9. throttle does not block callback answer', async () => {
    const throttle = new TelegramUnavailableThrottle(TELEGRAM_UNAVAILABLE_THROTTLE_MS);
    const load = async () => entitlementsFrom({ developerSuspended: true });
    await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 13,
      hasCallbackQuery: true,
      getEntitlements: load,
      throttle,
      now: NOW,
    });
    const again = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 13,
      hasCallbackQuery: true,
      getEntitlements: load,
      throttle,
      now: new Date(NOW.getTime() + 1_000),
    });
    assert.equal(again.proceed, false);
    if (!again.proceed) {
      assert.equal(again.sendCustomerMessage, false);
      assert.equal(again.answerCallbackQuery, true);
    }
  });

  it('10/11. restore subscription → next inbound resumes; preserved FSM same step', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const bookingState = new Map<string, FakeBooking>([
      ['salon-a:14', { step: 'time', date: '2026-08-20' }],
    ]);
    let suspended = true;
    const load = async () =>
      entitlementsFrom({ developerSuspended: suspended });

    const blocked = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 14,
      text: '14:00',
      getEntitlements: load,
      throttle,
      bookingState,
      appointments: [],
      clientsInserted: [],
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(blocked, 'blocked');
    assert.equal(bookingState.get('salon-a:14')?.step, 'time');

    suspended = false;
    const resumed = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 14,
      text: '14:00',
      getEntitlements: load,
      throttle,
      bookingState,
      appointments: [],
      clientsInserted: [],
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(resumed, 'allowed');
    assert.equal(bookingState.get('salon-a:14')?.step, 'name');
    assert.equal(bookingState.get('salon-a:14')?.time, '14:00');
  });

  it('12. expired subscription denied', async () => {
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 15,
      getEntitlements: async () =>
        entitlementsFrom({ subscriptionStatus: 'expired' }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, false);
    if (!gate.proceed) assert.equal(gate.denyReason, 'subscription_expired');
  });

  it('13. reactivated expired subscription resumes', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    let status: EvaluateSalonEntitlementInput['subscriptionStatus'] = 'expired';
    const load = async () => entitlementsFrom({ subscriptionStatus: status });
    const denied = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 16,
      getEntitlements: load,
      throttle,
      now: NOW,
    });
    assert.equal(denied.proceed, false);
    status = 'active';
    const allowed = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 16,
      getEntitlements: load,
      throttle,
      now: NOW,
    });
    assert.equal(allowed.proceed, true);
  });

  it('14. past_due denied', async () => {
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 17,
      getEntitlements: async () =>
        entitlementsFrom({ subscriptionStatus: 'past_due' }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, false);
    if (!gate.proceed) assert.equal(gate.denyReason, 'subscription_past_due');
  });

  it('15. cancelled denied', async () => {
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 18,
      getEntitlements: async () =>
        entitlementsFrom({ subscriptionStatus: 'cancelled' }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, false);
    if (!gate.proceed) assert.equal(gate.denyReason, 'subscription_cancelled');
  });

  it('16. trial expired denied', async () => {
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 19,
      getEntitlements: async () =>
        entitlementsFrom({ subscriptionStatus: 'trial', trialEndsAt: PAST }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, false);
    if (!gate.proceed) assert.equal(gate.denyReason, 'trial_expired');
  });

  it('17. entitlement DB read failure → fail-open normal flow', async () => {
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 20,
      getEntitlements: async () =>
        entitlementsFrom({
          usedSubscriptionReadFailureFallback: true,
          usedMissingSubscriptionFallback: true,
        }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    // Central helper marks fail-open as allowed active fallback.
    assert.equal(gate.proceed, true);
  });

  it('18. missing subscription fallback → normal flow', async () => {
    const gate = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 21,
      getEntitlements: async () =>
        entitlementsFrom({ usedMissingSubscriptionFallback: true }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(gate.proceed, true);
  });

  it('19. salon not found → no AI/business mutation', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const bookingState = new Map<string, FakeBooking>([
      ['missing:22', { step: 'time', date: '2026-08-20' }],
    ]);
    const appointments: { id: string; status: string }[] = [{ id: 'a', status: 'scheduled' }];
    const result = await simulateTelegramInbound({
      salonId: 'missing',
      chatId: 22,
      text: '14:00',
      getEntitlements: async () => {
        throw new SalonEntitlementNotFoundError('missing');
      },
      throttle,
      bookingState,
      appointments,
      clientsInserted: [],
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(result, 'blocked');
    assert.equal(bookingState.get('missing:22')?.step, 'time');
    assert.equal(appointments[0].status, 'scheduled');
  });

  it('20. salon A suspended does not affect salon B', async () => {
    const throttle = new TelegramUnavailableThrottle(60_000);
    const load = async (salonId: string) =>
      entitlementsFrom({
        salonId,
        developerSuspended: salonId === 'salon-a',
      });

    const a = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 1,
      getEntitlements: load,
      throttle,
      now: NOW,
    });
    const b = await enforceTelegramAiAutomationGate({
      salonId: 'salon-b',
      chatId: 1,
      getEntitlements: load,
      throttle,
      now: NOW,
    });
    assert.equal(a.proceed, false);
    assert.equal(b.proceed, true);
    assert.equal(
      telegramUnavailableThrottleKey('salon-a', 1),
      'salon-a:1',
    );
    assert.notEqual(
      telegramUnavailableThrottleKey('salon-a', 1),
      telegramUnavailableThrottleKey('salon-b', 1),
    );
  });

  it('EN/HY unavailable copy; /start while denied does not reset FSM', async () => {
    assert.equal(normalizeTelegramCustomerLang('en-US'), 'en');
    assert.equal(normalizeTelegramCustomerLang('hy'), 'hy');
    assert.equal(
      telegramAiUnavailableMessage('en'),
      TELEGRAM_AI_UNAVAILABLE_MESSAGES.en,
    );
    assert.equal(
      telegramAiUnavailableMessage('hy'),
      TELEGRAM_AI_UNAVAILABLE_MESSAGES.hy,
    );

    const throttle = new TelegramUnavailableThrottle(60_000);
    const bookingState = new Map<string, FakeBooking>([
      ['salon-a:30', { step: 'time', date: '2026-08-20' }],
    ]);
    const blocked = await simulateTelegramInbound({
      salonId: 'salon-a',
      chatId: 30,
      text: '/start',
      languageCode: 'en',
      getEntitlements: async () => entitlementsFrom({ developerSuspended: true }),
      throttle,
      bookingState,
      appointments: [],
      clientsInserted: [],
      answeredCallbacks: [],
      sentMessages: [],
    });
    assert.equal(blocked, 'blocked');
    assert.equal(bookingState.get('salon-a:30')?.step, 'time');
  });

  it('active period still valid with future end; trial future allowed', async () => {
    const active = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 31,
      getEntitlements: async () =>
        entitlementsFrom({ currentPeriodEnd: FUTURE }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    const trial = await enforceTelegramAiAutomationGate({
      salonId: 'salon-a',
      chatId: 32,
      getEntitlements: async () =>
        entitlementsFrom({ subscriptionStatus: 'trial', trialEndsAt: FUTURE }),
      throttle: new TelegramUnavailableThrottle(),
      now: NOW,
    });
    assert.equal(active.proceed, true);
    assert.equal(trial.proceed, true);
  });
});

describe('SUB-1D1 Telegram entitlement (static source contracts)', () => {
  const index = read('server/src/index.ts');
  const gate = read('server/src/lib/telegramSubscriptionGate.ts');
  const sharedGate = read('server/src/lib/messengerAiAutomationGate.ts');
  const entitlement = read('server/src/lib/salonEntitlement.ts');
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
  const processFn = index.slice(index.indexOf('async function processTelegramUpdate'));

  it('21. gate wired at top of processTelegramUpdate before callback mutations / FSM / AI', () => {
    assert.match(index, /from '\.\/lib\/telegramSubscriptionGate\.js'/);
    assert.match(processFn, /enforceTelegramAiAutomationGate/);
    const gatePos = processFn.indexOf('enforceTelegramAiAutomationGate');
    const cancelPos = processFn.indexOf("cancel_confirm:");
    const generatePos = processFn.indexOf('generateAIResponse');
    const startPos = processFn.indexOf('isTelegramStartCommand');
    assert.ok(gatePos > 0);
    assert.ok(gatePos < cancelPos);
    assert.ok(gatePos < generatePos);
    assert.ok(gatePos < startPos);
  });

  it('central entitlement only; no direct subscription field inspection in Telegram gate UX path', () => {
    assert.match(gate, /enforceMessengerAiAutomationGate/);
    assert.match(sharedGate, /getSalonEntitlements/);
    assert.match(sharedGate, /aiAutomationAllowed/);
    assert.match(sharedGate, /denyReason/);
    // Gate must not re-implement status / developer_suspended checks.
    assert.doesNotMatch(gate, /subscriptionStatus\s*===/);
    assert.doesNotMatch(gate, /developerSuspended\s*===/);
    assert.doesNotMatch(gate, /current_period_end|currentPeriodEnd/);
    assert.doesNotMatch(sharedGate, /subscriptionStatus\s*===/);
    assert.doesNotMatch(sharedGate, /developerSuspended\s*===/);
    assert.match(entitlement, /export async function getSalonEntitlements/);
  });

  it('denied UX: neutral copy; no billing leak; throttle in-memory', () => {
    assert.match(sharedGate, /Сервис временно недоступен\. Пожалуйста, свяжитесь с салоном напрямую\./);
    assert.match(gate, /MESSENGER_AI_UNAVAILABLE_MESSAGE/);
    assert.doesNotMatch(gate, /unpaid|stripe|подписк|оплат/i);
    assert.doesNotMatch(sharedGate, /unpaid|stripe|подписк|оплат/i);
    assert.doesNotMatch(
      TELEGRAM_AI_UNAVAILABLE_MESSAGES.ru +
        TELEGRAM_AI_UNAVAILABLE_MESSAGES.en +
        TELEGRAM_AI_UNAVAILABLE_MESSAGES.hy,
      /unpaid|billing|stripe|subscription|подписк|оплат|suspended|expired/i,
    );
    assert.match(gate, /TELEGRAM_UNAVAILABLE_THROTTLE_MS/);
    assert.match(gate, /\$\{salonId\}:\$\{chatId\}/);
    assert.doesNotMatch(gate, /from\('salon_subscriptions'\)|\.update\(|INSERT/i);
  });

  it('FSM preservation: processTelegramUpdate deny path does not clear booking/manage/birthday maps', () => {
    const denyBlock = processFn.slice(
      processFn.indexOf('if (!gate.proceed)'),
      processFn.indexOf('// Нажатие на inline-кнопку'),
    );
    assert.doesNotMatch(denyBlock, /bookingState\.delete|manageState\.delete|birthdayState\.delete/);
    assert.match(denyBlock, /answerCallbackQuery/);
    assert.match(denyBlock, /sendTelegramMessage/);
  });

  it('22/23/24. WhatsApp / Instagram inbound use shared gate; poller / Apple / reminders stay ungated', () => {
    const patterns = /getSalonEntitlements|evaluateSalonEntitlement|salonEntitlement|telegramSubscriptionGate|aiAutomationAllowed/;
    assert.doesNotMatch(telegramBooking, patterns);
    assert.doesNotMatch(telegramBotManager, patterns);
    assert.doesNotMatch(telegramPolling, patterns);
    assert.doesNotMatch(waFlow, patterns);
    assert.doesNotMatch(waOutbound, patterns);
    assert.doesNotMatch(igRoutes, patterns);
    assert.doesNotMatch(calendar, patterns);
    assert.doesNotMatch(reminders, patterns);
    assert.doesNotMatch(appointmentReminders, patterns);
    assert.match(waWebhook, /enforceMessengerAiAutomationGate|messengerAiAutomationGate/);
    assert.match(igProcess, /enforceMessengerAiAutomationGate|messengerAiAutomationGate/);
  });

  it('package registers SUB-1D1 suite once', () => {
    const n = (packageJson.match(/telegramSubscriptionGate\.sub1d1\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
