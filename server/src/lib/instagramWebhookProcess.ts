/**
 * IG-3: Per-event Instagram webhook processing (route → claim → finalize).
 * No conversations, identities, booking, or outbound.
 */

import type { ReceiptClaimResult } from './whatsappWebhookReceipts.js';
import {
  instagramReceiptPayloadHash,
  type NormalizedInstagramWebhookEvent,
} from './instagramWebhookEvents.js';
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
};

export function createDefaultInstagramProcessDeps(
  routingDeps?: InstagramRoutingDeps,
): InstagramProcessDeps {
  return {
    route: (id) => resolveInstagramProfessionalAccountRoute(id, routingDeps),
    claim: (input) => claimInstagramEventReceipt(supabase as any, input),
    finalize: (params) => finalizeInstagramEventReceipt(supabase as any, params),
    markFailed: (params) => markInstagramEventReceiptFailed(supabase as any, params),
  };
}

/**
 * Process one normalized Instagram webhook event.
 *
 * Policy (IG-3B):
 * - no stable Meta mid (empty externalEventId) → ignore, no route, no receipt
 * - unknown account / invalid id → ignore, no receipt (permanent unroutable)
 * - disconnected / inactive → ignored receipt when salon_id known
 * - connected message/postback → claim + finalize processed (business logic deferred)
 * - unsupported echo with real mid → claim + finalize ignored
 * - claim in_flight / failed_transient → retryable
 */
export async function processInstagramWebhookEvent(
  event: NormalizedInstagramWebhookEvent,
  deps: InstagramProcessDeps = createDefaultInstagramProcessDeps(),
): Promise<InstagramEventProcessResult> {
  // Durable receipt requires a stable provider-supplied Meta mid.
  // Malformed / missing-mid / unrecognized → empty id → terminal ignore (no route/claim).
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
    // Permanent: do not invent salon; no receipt write.
    return { outcome: 'ignored', reason: route.reason };
  }

  const salonId = route.salonId;
  const routingCode =
    route.kind === 'connected' ? 'connected' : `disconnected:${route.reason}`;

  let finalStatus: 'processed' | 'ignored';
  if (route.kind === 'disconnected') {
    finalStatus = 'ignored';
  } else if (event.kind === 'message' || event.kind === 'postback') {
    // IG-3: recognized inbound, business processing not implemented yet.
    finalStatus = 'processed';
  } else {
    finalStatus = 'ignored';
  }

  const metadata: Record<string, string> = {
    ...event.receiptMetadata,
    routing: routingCode,
    // Never include text/caption/username/raw payload.
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
    : { outcome: 'ignored', reason: routingCode };
}
