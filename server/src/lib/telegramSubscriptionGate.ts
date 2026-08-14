/**
 * SUB-1D1: Telegram inbound AI-automation entitlement gate.
 *
 * Decision uses central getSalonEntitlements only (aiAutomationAllowed / denyReason).
 * Does not clear FSM maps. Throttles customer unavailable UX in-memory.
 * WhatsApp / Instagram / Apple / reminders are out of scope.
 */

import {
  getSalonEntitlements,
  isSalonEntitlementNotFoundError,
} from './salonEntitlement.js';
import type { SalonEntitlementDenyReason, SalonEntitlements } from '../types.js';

export const TELEGRAM_AI_UNAVAILABLE_MESSAGES = {
  ru: 'Онлайн-запись сейчас временно недоступна. Пожалуйста, свяжитесь с салоном напрямую.',
  en: 'Online booking is temporarily unavailable. Please contact the salon directly.',
  hy: 'Առցանց գրանցումն այս պահին ժամանակավորապես հասանելի չէ։ Խնդրում ենք կապ հաստատել սրահի հետ անմիջապես։',
} as const;

export type TelegramCustomerLang = keyof typeof TELEGRAM_AI_UNAVAILABLE_MESSAGES;

/** Default: one unavailable customer message per salon+chat every 5 minutes. */
export const TELEGRAM_UNAVAILABLE_THROTTLE_MS = 5 * 60 * 1000;

export function normalizeTelegramCustomerLang(
  raw: string | null | undefined,
): TelegramCustomerLang {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'en' || v.startsWith('en')) return 'en';
  if (v === 'hy' || v.startsWith('hy') || v === 'arm') return 'hy';
  return 'ru';
}

export function telegramAiUnavailableMessage(lang?: string | null): string {
  return TELEGRAM_AI_UNAVAILABLE_MESSAGES[normalizeTelegramCustomerLang(lang)];
}

export function telegramUnavailableThrottleKey(salonId: string, chatId: number): string {
  return `${salonId}:${chatId}`;
}

/** Minimal in-memory throttle; no DB. Injectable for tests. */
export class TelegramUnavailableThrottle {
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly intervalMs: number = TELEGRAM_UNAVAILABLE_THROTTLE_MS) {}

  shouldSend(salonId: string, chatId: number, nowMs: number = Date.now()): boolean {
    const key = telegramUnavailableThrottleKey(salonId, chatId);
    const last = this.lastSentAt.get(key);
    if (last == null) return true;
    return nowMs - last >= this.intervalMs;
  }

  markSent(salonId: string, chatId: number, nowMs: number = Date.now()): void {
    this.lastSentAt.set(telegramUnavailableThrottleKey(salonId, chatId), nowMs);
  }

  clear(salonId: string, chatId: number): void {
    this.lastSentAt.delete(telegramUnavailableThrottleKey(salonId, chatId));
  }

  clearAll(): void {
    this.lastSentAt.clear();
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

export type GetSalonEntitlementsFn = (salonId: string) => Promise<SalonEntitlements>;

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
  const salonId = String(params.salonId ?? '').trim();
  const chatId = params.chatId;
  const hasCallbackQuery = params.hasCallbackQuery === true;
  const throttle = params.throttle ?? defaultTelegramUnavailableThrottle;
  const nowMs = (params.now ?? new Date()).getTime();
  const customerMessage = telegramAiUnavailableMessage(params.languageCode);
  const load = params.getEntitlements ?? ((id: string) => getSalonEntitlements(id));

  let entitlements: SalonEntitlements;
  try {
    entitlements = await load(salonId);
  } catch (err) {
    if (isSalonEntitlementNotFoundError(err)) {
      const sendCustomerMessage = throttle.shouldSend(salonId, chatId, nowMs);
      if (sendCustomerMessage) {
        throttle.markSent(salonId, chatId, nowMs);
      }
      return {
        proceed: false,
        blockKind: 'salon_not_found',
        denyReason: null,
        answerCallbackQuery: hasCallbackQuery,
        sendCustomerMessage,
        customerMessage,
        customerFacingBilling: false,
      };
    }
    // Unexpected loader throw: preserve fail-open posture for Telegram inbound.
    console.error('[telegram/entitlement] unexpected entitlement load failure; fail-open', {
      salonId,
      operation: 'enforce_telegram_ai_automation_gate',
    });
    throttle.clear(salonId, chatId);
    return { proceed: true, entitlements: null };
  }

  if (entitlements.aiAutomationAllowed) {
    // Allowed again → drop throttle so a later deny can notify once more.
    throttle.clear(salonId, chatId);
    return { proceed: true, entitlements };
  }

  const sendCustomerMessage = throttle.shouldSend(salonId, chatId, nowMs);
  if (sendCustomerMessage) {
    throttle.markSent(salonId, chatId, nowMs);
  }

  return {
    proceed: false,
    blockKind: 'denied',
    denyReason: entitlements.denyReason,
    answerCallbackQuery: hasCallbackQuery,
    sendCustomerMessage,
    customerMessage,
    customerFacingBilling: false,
  };
}
