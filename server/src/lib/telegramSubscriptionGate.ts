/**
 * SUB-1D1: Telegram inbound AI-automation entitlement gate.
 *
 * Decision uses the shared messenger helper (getSalonEntitlements only).
 * Does not clear FSM maps. Throttles customer unavailable UX in-memory.
 * Does not stop polling or disconnect the bot.
 */

import {
  MESSENGER_AI_UNAVAILABLE_MESSAGE,
  MESSENGER_AI_UNAVAILABLE_THROTTLE_MS,
  MessengerUnavailableThrottle,
  enforceMessengerAiAutomationGate,
  type EnforceMessengerAiAutomationGateResult,
  type GetSalonEntitlementsFn,
} from './messengerAiAutomationGate.js';
import type { SalonEntitlementDenyReason, SalonEntitlements } from '../types.js';

export const TELEGRAM_AI_UNAVAILABLE_MESSAGES = {
  ru: MESSENGER_AI_UNAVAILABLE_MESSAGE,
  en: MESSENGER_AI_UNAVAILABLE_MESSAGE,
  hy: MESSENGER_AI_UNAVAILABLE_MESSAGE,
} as const;

export type TelegramCustomerLang = keyof typeof TELEGRAM_AI_UNAVAILABLE_MESSAGES;

/** Default: one unavailable customer message per salon+chat every 5 minutes. */
export const TELEGRAM_UNAVAILABLE_THROTTLE_MS = MESSENGER_AI_UNAVAILABLE_THROTTLE_MS;

export function normalizeTelegramCustomerLang(
  raw: string | null | undefined,
): TelegramCustomerLang {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'en' || v.startsWith('en')) return 'en';
  if (v === 'hy' || v.startsWith('hy') || v === 'arm') return 'hy';
  return 'ru';
}

export function telegramAiUnavailableMessage(_lang?: string | null): string {
  return MESSENGER_AI_UNAVAILABLE_MESSAGE;
}

export function telegramUnavailableThrottleKey(salonId: string, chatId: number): string {
  return `${salonId}:${chatId}`;
}

/** Telegram-shaped throttle adapter over the shared in-memory helper. */
export class TelegramUnavailableThrottle {
  private readonly inner: MessengerUnavailableThrottle;

  constructor(intervalMs: number = TELEGRAM_UNAVAILABLE_THROTTLE_MS) {
    this.inner = new MessengerUnavailableThrottle(intervalMs);
  }

  shouldSend(salonId: string, chatId: number, nowMs: number = Date.now()): boolean {
    return this.inner.shouldSend(salonId, String(chatId), nowMs);
  }

  markSent(salonId: string, chatId: number, nowMs: number = Date.now()): void {
    this.inner.markSent(salonId, String(chatId), nowMs);
  }

  clear(salonId: string, chatId: number): void {
    this.inner.clear(salonId, String(chatId));
  }

  clearAll(): void {
    this.inner.clearAll();
  }

  asMessengerThrottle(): MessengerUnavailableThrottle {
    return this.inner;
  }
}

export const defaultTelegramUnavailableThrottle = new TelegramUnavailableThrottle();

export type TelegramAiAutomationGateBlockKind = 'denied' | 'salon_not_found';

export type EnforceTelegramAiAutomationGateResult =
  | {
      proceed: true;
      entitlements: SalonEntitlements | null;
    }
  | {
      proceed: false;
      blockKind: TelegramAiAutomationGateBlockKind;
      denyReason: SalonEntitlementDenyReason | null;
      /** Always true for callback_query — caller must answer to stop Telegram spinner. */
      answerCallbackQuery: boolean;
      sendCustomerMessage: boolean;
      customerMessage: string;
      /** Never expose denyReason / billing to customers. */
      customerFacingBilling: false;
    };

export type { GetSalonEntitlementsFn };

function withTelegramCallback(
  result: EnforceMessengerAiAutomationGateResult,
  hasCallbackQuery: boolean,
): EnforceTelegramAiAutomationGateResult {
  if (result.proceed) return result;
  return {
    ...result,
    answerCallbackQuery: hasCallbackQuery,
  };
}

/**
 * Top-level Telegram inbound gate (after salonId known).
 * Explicit deny / salon-not-found → block automation.
 * Subscription or salon read failure → fail-open (helper semantics).
 * Missing subscription row → fail-open (helper fallback).
 */
export async function enforceTelegramAiAutomationGate(params: {
  salonId: string;
  chatId: number;
  languageCode?: string | null;
  hasCallbackQuery?: boolean;
  now?: Date;
  getEntitlements?: GetSalonEntitlementsFn;
  throttle?: TelegramUnavailableThrottle;
}): Promise<EnforceTelegramAiAutomationGateResult> {
  const hasCallbackQuery = params.hasCallbackQuery === true;
  const throttle = params.throttle ?? defaultTelegramUnavailableThrottle;
  const result = await enforceMessengerAiAutomationGate({
    salonId: params.salonId,
    conversationKey: String(params.chatId),
    now: params.now,
    getEntitlements: params.getEntitlements,
    throttle: throttle.asMessengerThrottle(),
  });
  return withTelegramCallback(result, hasCallbackQuery);
}
