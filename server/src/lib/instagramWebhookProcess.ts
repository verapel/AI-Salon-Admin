/**
 * IG-3 / IG-4 / IG-5: Per-event Instagram webhook processing.
 * Route → claim → identity/conversation touch → booking FSM → finalize.
 * No appointment/client writes. No Meta outbound.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReceiptClaimResult } from './whatsappWebhookReceipts.js';
import {
  instagramReceiptPayloadHash,
  type NormalizedInstagramWebhookEvent,
} from './instagramWebhookEvents.js';
import {
  applyInstagramInboundIdentityConversationOwned,
  parseInstagramMessageTimestamp,
  type InstagramIdentityConversationResult,
} from './instagramIdentityConversation.js';
import {
  processInstagramBookingFsm,
  type InstagramBookingFsmDeps,
} from './instagramBookingFlow.js';
import type { InstagramBookingIntent } from './instagramBookingState.js';
import {
  claimInstagramEventReceipt,
  finalizeInstagramEventReceipt,
  markInstagramEventReceiptFailed,
  type InstagramReceiptInsertInput,
} from './instagramWebhookReceipts.js';
import {
  resolveInstagramProfessionalAccountRoute,
  type InstagramRouteResult,
  type InstagramRoutingDeps,
} from './instagramWebhookRouting.js';
import { supabase } from './supabase.js';

export type InstagramEventProcessResult =
  | { outcome: 'processed'; bookingIntent?: InstagramBookingIntent }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'duplicate_terminal' }
  | { outcome: 'in_flight' }
  | { outcome: 'failed_transient'; code: string };

export type InstagramProcessDeps = {
  route: (
    professionalAccountId: unknown,
  ) => Promise<InstagramRouteResult>;
  claim: (input: InstagramReceiptInsertInput) => Promise<ReceiptClaimResult>;
  finalize: (params: {
    salonId: string;
    receiptId: string;
    attemptCount: number;
    finalStatus: 'processed' | 'ignored';
  }) => Promise<{ ok: true; status: 'processed' | 'ignored' } | { ok: false; code: string }>;
  markFailed: (params: {
    salonId: string;
    receiptId: string;
    attemptCount: number;
    errorCode: string;
  }) => Promise<{ ok: true } | { ok: false; code: string }>;
  applyIdentityConversation: (params: {
    salonId: string;
    receiptId: string;
    attemptCount: number;
    externalUserId: string;
    externalMessageId: string | null;
    messageTimestampIso: string | null;
  }) => Promise<InstagramIdentityConversationResult>;
  /** Injectable FSM runner (tests). Production uses processInstagramBookingFsm. */
  runBookingFsm?: (params: {
    db: SupabaseClient | any;
    salonId: string;
    externalUserId: string;
    text: string;
    externalMessageId: string | null;
    messageTimestampIso: string | null;
    receiptId: string;
    attemptCount: number;
    inboundAdvanced?: boolean;
  }) => Promise<InstagramBookingIntent>;
  bookingFsmDeps?: InstagramBookingFsmDeps;
  db?: SupabaseClient | any;
};

export function createDefaultInstagramProcessDeps(
  routingDeps?: InstagramRoutingDeps,
): InstagramProcessDeps {
  return {
    route: (id) => resolveInstagramProfessionalAccountRoute(id, routingDeps),
    claim: (input) => claimInstagramEventReceipt(supabase as any, input),
    finalize: (params) => finalizeInstagramEventReceipt(supabase as any, params),
    markFailed: (params) => markInstagramEventReceiptFailed(supabase as any, params),
    applyIdentityConversation: (params) =>
      applyInstagramInboundIdentityConversationOwned({
        db: supabase as any,
        ...params,
      }),
    runBookingFsm: (params) => processInstagramBookingFsm(params),
    db: supabase as any,
  };
}

function shouldTouchIdentityConversation(
  event: NormalizedInstagramWebhookEvent,
  routeKind: 'connected' | 'disconnected',
): boolean {
  if (routeKind !== 'connected') return false;
  if (event.isEcho) return false;
  if (event.kind !== 'message' && event.kind !== 'postback') return false;
  if (!event.externalUserId || !event.externalUserId.trim()) return false;
  return true;
}

function ephemeralFsmText(event: NormalizedInstagramWebhookEvent): string | null {
  if (event.kind === 'message' && event.inboundText) return event.inboundText;
  if (event.kind === 'postback' && event.inboundPostbackPayload) {
    return event.inboundPostbackPayload;
  }
  // Empty text still starts idle→service (greeting with no body).
  if (event.kind === 'message' || event.kind === 'postback') return '';
  return null;
}

/**
 * Process one normalized Instagram webhook event.
 */
export async function processInstagramWebhookEvent(
  event: NormalizedInstagramWebhookEvent,
  deps: InstagramProcessDeps = createDefaultInstagramProcessDeps(),
): Promise<InstagramEventProcessResult> {
  if (!event.externalEventId.trim()) {
    return {
      outcome: 'ignored',
      reason: event.receiptMetadata.reason || 'no_stable_event_id',
    };
  }

  const route = await deps.route(event.professionalAccountId);
  if (route.kind === 'failed_transient') {
    return { outcome: 'failed_transient', code: route.code };
  }

  if (route.kind === 'unknown') {
    return { outcome: 'ignored', reason: route.reason };
  }

  const salonId = route.salonId;
  const routingCode =
    route.kind === 'connected' ? 'connected' : `disconnected:${route.reason}`;

  let finalStatus: 'processed' | 'ignored';
  if (route.kind === 'disconnected') {
    finalStatus = 'ignored';
  } else if (event.isEcho) {
    finalStatus = 'ignored';
  } else if (event.kind === 'message' || event.kind === 'postback') {
    finalStatus = 'processed';
  } else {
    finalStatus = 'ignored';
  }

  const metadata: Record<string, string> = {
    ...event.receiptMetadata,
    routing: routingCode,
  };

  const claim = await deps.claim({
    salonId,
    externalEventId: event.externalEventId,
    externalMessageId: event.externalMessageId,
    eventType: `instagram.${event.kind}`,
    payloadHash: instagramReceiptPayloadHash(event.externalEventId),
    metadata,
  });

  if (claim.kind === 'duplicate_terminal') {
    return { outcome: 'duplicate_terminal' };
  }
  if (claim.kind === 'in_flight') {
    return { outcome: 'in_flight' };
  }
  if (claim.kind === 'failed_transient') {
    return { outcome: 'failed_transient', code: claim.code };
  }
  if (claim.kind === 'cross_salon_conflict') {
    return { outcome: 'failed_transient', code: 'cross_salon_conflict' };
  }

  let inboundAdvanced = true;
  let bookingIntent: InstagramBookingIntent | undefined;

  if (shouldTouchIdentityConversation(event, route.kind)) {
    const touched = await deps.applyIdentityConversation({
      salonId,
      receiptId: claim.receiptId,
      attemptCount: claim.attemptCount,
      externalUserId: event.externalUserId!,
      externalMessageId: event.externalMessageId,
      messageTimestampIso: parseInstagramMessageTimestamp(event.timestampMs),
    });

    if (touched.kind === 'lost_ownership') {
      return { outcome: 'in_flight' };
    }
    if (touched.kind === 'error') {
      await deps.markFailed({
        salonId,
        receiptId: claim.receiptId,
        attemptCount: claim.attemptCount,
        errorCode: touched.code,
      });
      return { outcome: 'failed_transient', code: touched.code };
    }
    inboundAdvanced = touched.advanced;

    const fsmText = ephemeralFsmText(event);
    if (fsmText != null && deps.runBookingFsm) {
      const fsm = await deps.runBookingFsm({
        db: deps.db ?? supabase,
        salonId,
        externalUserId: event.externalUserId!,
        text: fsmText,
        externalMessageId: event.externalMessageId,
        messageTimestampIso: parseInstagramMessageTimestamp(event.timestampMs),
        receiptId: claim.receiptId,
        attemptCount: claim.attemptCount,
        inboundAdvanced,
      });

      if (fsm.kind === 'lost_ownership') {
        return { outcome: 'in_flight' };
      }
      if (fsm.kind === 'error') {
        await deps.markFailed({
          salonId,
          receiptId: claim.receiptId,
          attemptCount: claim.attemptCount,
          errorCode: fsm.code,
        });
        return { outcome: 'failed_transient', code: fsm.code };
      }
      // stale_step / outdated / invalid_state / noop / intents → finalize (no appointment side effects)
      // invalid_state is deterministic malformed next-state — terminal, not 500-retry.
      bookingIntent = fsm;
    }
  } else if (
    route.kind === 'connected' &&
    (event.kind === 'message' || event.kind === 'postback') &&
    !event.isEcho &&
    !event.externalUserId?.trim()
  ) {
    finalStatus = 'ignored';
    metadata.reason = 'missing_sender';
  }

  const finalized = await deps.finalize({
    salonId,
    receiptId: claim.receiptId,
    attemptCount: claim.attemptCount,
    finalStatus,
  });

  if (!finalized.ok) {
    if (finalized.code === 'finalize_lost_ownership') {
      return { outcome: 'in_flight' };
    }
    await deps.markFailed({
      salonId,
      receiptId: claim.receiptId,
      attemptCount: claim.attemptCount,
      errorCode: finalized.code,
    });
    return { outcome: 'failed_transient', code: finalized.code };
  }

  if (finalStatus === 'processed') {
    return bookingIntent
      ? { outcome: 'processed', bookingIntent }
      : { outcome: 'processed' };
  }
  return { outcome: 'ignored', reason: metadata.reason || routingCode };
}
