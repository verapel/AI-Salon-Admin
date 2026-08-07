/**
 * IG-3 / IG-4: Per-event Instagram webhook processing.
 * Route → claim → (IG-4) owned identity/conversation → finalize.
 * No booking, outbound, or Meta profile lookups.
 */

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
  | { outcome: 'processed' }
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
  /**
   * IG-4 owned identity+conversation mutation.
   * Only invoked for connected message/postback with sender id (never echo).
   */
  applyIdentityConversation: (params: {
    salonId: string;
    receiptId: string;
    attemptCount: number;
    externalUserId: string;
    externalMessageId: string | null;
    messageTimestampIso: string | null;
  }) => Promise<InstagramIdentityConversationResult>;
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

/**
 * Process one normalized Instagram webhook event.
 *
 * Policy:
 * - no stable Meta mid → ignore, no route, no receipt
 * - unknown account → ignore, no receipt
 * - disconnected / inactive → ignored receipt, no identity/conversation
 * - echo with mid → ignored receipt, no identity/conversation
 * - connected message/postback with sender → claim → owned mutation → finalize processed
 * - claim in_flight / failed_transient → retryable
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
      // Do not finalize stale generation.
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
  } else if (
    route.kind === 'connected' &&
    (event.kind === 'message' || event.kind === 'postback') &&
    !event.isEcho &&
    !event.externalUserId?.trim()
  ) {
    // Recognized inbound without opaque sender — cannot form identity key.
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

  return finalStatus === 'processed'
    ? { outcome: 'processed' }
    : { outcome: 'ignored', reason: metadata.reason || routingCode };
}
