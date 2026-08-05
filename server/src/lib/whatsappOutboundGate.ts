/**
 * WA-4F2: Enqueue-before-inbound-finalize gate (WhatsApp only).
 * Extracted for testability without changing webhook semantics.
 */

import type {
  EnqueueWhatsAppOutboundResult,
} from './whatsappOutbound.js';

export type WhatsAppPendingOutbound = {
  conversationId: string | null;
  recipientExternalUserId: string;
  messageKey: string;
  text: string;
};

export type WhatsAppEnqueueThenFinalizeResult<TFinalize> =
  | { kind: 'enqueue_failed'; code: string }
  | {
      kind: 'finalized';
      outboxMessageId: string | null;
      finalize: TFinalize;
    };

/**
 * If pendingOutbound is set, enqueue first.
 * On enqueue failure: never call finalizeInbound.
 * On success / no outbound: call finalizeInbound once.
 */
export async function enqueueWhatsAppOutboundThenFinalizeInbound<TFinalize>(params: {
  pendingOutbound: WhatsAppPendingOutbound | null;
  enqueue: () => Promise<EnqueueWhatsAppOutboundResult>;
  finalizeInbound: () => Promise<TFinalize>;
}): Promise<WhatsAppEnqueueThenFinalizeResult<TFinalize>> {
  let outboxMessageId: string | null = null;

  if (params.pendingOutbound) {
    const enqueued = await params.enqueue();
    if (enqueued.kind === 'error') {
      return { kind: 'enqueue_failed', code: enqueued.code };
    }
    outboxMessageId = enqueued.row.id;
  }

  const finalize = await params.finalizeInbound();
  return { kind: 'finalized', outboxMessageId, finalize };
}
