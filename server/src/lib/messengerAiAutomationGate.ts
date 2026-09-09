/**
 * Shared messenger AI-automation entitlement gate.
 *
 * Decision uses central getSalonEntitlements only (aiAutomationAllowed / denyReason).
 * Telegram / WhatsApp / Instagram inbound reuse this helper — no second billing check.
 * Does not disconnect messengers, mutate credentials, or clear conversations.
 */

import {
  getSalonEntitlements,
  isSalonEntitlementNotFoundError,
} from './salonEntitlement.js';
import type { SalonEntitlementDenyReason, SalonEntitlements } from '../types.js';

/** Neutral customer copy. Do not include billing, price, or account status. */
export const MESSENGER_AI_UNAVAILABLE_MESSAGE =
  'Сервис временно недоступен. Пожалуйста, свяжитесь с салоном напрямую.';

export const MESSENGER_AI_UNAVAILABLE_THROTTLE_MS = 5 * 60 * 1000;

export const MESSENGER_AI_UNAVAILABLE_MESSAGE_KEY = 'messenger.aiUnavailable';

export function messengerUnavailableThrottleKey(
  salonId: string,
  conversationKey: string,
): string {
  return `${salonId}:${conversationKey}`;
}

/** Minimal in-memory throttle; no DB. Injectable for tests. */
export class MessengerUnavailableThrottle {
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly intervalMs: number = MESSENGER_AI_UNAVAILABLE_THROTTLE_MS) {}

  shouldSend(salonId: string, conversationKey: string, nowMs: number = Date.now()): boolean {
    const key = messengerUnavailableThrottleKey(salonId, conversationKey);
    const last = this.lastSentAt.get(key);
    if (last == null) return true;
    return nowMs - last >= this.intervalMs;
  }

  markSent(salonId: string, conversationKey: string, nowMs: number = Date.now()): void {
    this.lastSentAt.set(messengerUnavailableThrottleKey(salonId, conversationKey), nowMs);
  }

  clear(salonId: string, conversationKey: string): void {
    this.lastSentAt.delete(messengerUnavailableThrottleKey(salonId, conversationKey));
  }

  clearAll(): void {
    this.lastSentAt.clear();
  }
}

export const defaultMessengerUnavailableThrottle = new MessengerUnavailableThrottle();

export type MessengerAiAutomationGateBlockKind = 'denied' | 'salon_not_found';

export type EnforceMessengerAiAutomationGateResult =
  | {
      proceed: true;
      entitlements: SalonEntitlements | null;
    }
  | {
      proceed: false;
      blockKind: MessengerAiAutomationGateBlockKind;
      denyReason: SalonEntitlementDenyReason | null;
      sendCustomerMessage: boolean;
      customerMessage: string;
      /** Never expose denyReason / billing to customers. */
      customerFacingBilling: false;
    };

export type GetSalonEntitlementsFn = (salonId: string) => Promise<SalonEntitlements>;

export type MessengerUnavailableThrottleLike = {
  shouldSend(salonId: string, conversationKey: string, nowMs?: number): boolean;
  markSent(salonId: string, conversationKey: string, nowMs?: number): void;
  clear(salonId: string, conversationKey: string): void;
};

/**
 * After salonId is known, before AI / LLM / booking automation.
 * Explicit deny / salon-not-found → block automation.
 * Subscription or salon read failure → fail-open (central helper semantics).
 * Missing subscription row → fail-open (central helper fallback).
 */
export async function enforceMessengerAiAutomationGate(params: {
  salonId: string;
  conversationKey: string;
  now?: Date;
  getEntitlements?: GetSalonEntitlementsFn;
  throttle?: MessengerUnavailableThrottleLike;
}): Promise<EnforceMessengerAiAutomationGateResult> {
  const salonId = String(params.salonId ?? '').trim();
  const conversationKey = String(params.conversationKey ?? '').trim();
  const throttle = params.throttle ?? defaultMessengerUnavailableThrottle;
  const nowMs = (params.now ?? new Date()).getTime();
  const customerMessage = MESSENGER_AI_UNAVAILABLE_MESSAGE;
  const load = params.getEntitlements ?? ((id: string) => getSalonEntitlements(id));

  let entitlements: SalonEntitlements;
  try {
    entitlements = await load(salonId);
  } catch (err) {
    if (isSalonEntitlementNotFoundError(err)) {
      const sendCustomerMessage = throttle.shouldSend(salonId, conversationKey, nowMs);
      if (sendCustomerMessage) {
        throttle.markSent(salonId, conversationKey, nowMs);
      }
      return {
        proceed: false,
        blockKind: 'salon_not_found',
        denyReason: null,
        sendCustomerMessage,
        customerMessage,
        customerFacingBilling: false,
      };
    }
    console.error('[messenger/entitlement] unexpected entitlement load failure; fail-open', {
      salonId,
      operation: 'enforce_messenger_ai_automation_gate',
    });
    throttle.clear(salonId, conversationKey);
    return { proceed: true, entitlements: null };
  }

  if (entitlements.aiAutomationAllowed) {
    throttle.clear(salonId, conversationKey);
    return { proceed: true, entitlements };
  }

  const sendCustomerMessage = throttle.shouldSend(salonId, conversationKey, nowMs);
  if (sendCustomerMessage) {
    throttle.markSent(salonId, conversationKey, nowMs);
  }

  return {
    proceed: false,
    blockKind: 'denied',
    denyReason: entitlements.denyReason,
    sendCustomerMessage,
    customerMessage,
    customerFacingBilling: false,
  };
}
