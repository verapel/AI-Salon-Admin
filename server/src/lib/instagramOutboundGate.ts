/**
 * IG-7: Enqueue-before-inbound-finalize gate (Instagram only).
 * If enqueue fails, never finalize the inbound receipt (reply would be lost).
 */

import type { EnqueueInstagramOutboundResult } from './instagramOutbound.js';
import type { InstagramOutboundIntent } from './instagramOutboundIntent.js';

export type InstagramEnqueueThenFinalizeResult<TFinalize> =
  | { kind: 'enqueue_failed'; code: string }
  | { kind: 'lost_ownership' }
  | {
      kind: 'finalized';
      outboxMessageId: string | null;
      created: boolean | null;
      finalize: TFinalize;
    };

/**
 * If pendingIntent is set, owned-enqueue first.
 * On enqueue failure / lost ownership: never call finalizeInbound.
 * On success / no outbound: call finalizeInbound once.
 */
export async function enqueueInstagramOutboundThenFinalizeInbound<TFinalize>(params: {
  pendingIntent: InstagramOutboundIntent | null;
  enqueue: () => Promise<EnqueueInstagramOutboundResult>;
  finalizeInbound: () => Promise<TFinalize>;
}): Promise<InstagramEnqueueThenFinalizeResult<TFinalize>> {
  let outboxMessageId: string | null = null;
  let created: boolean | null = null;

  if (params.pendingIntent) {
    const enqueued = await params.enqueue();
    if (enqueued.kind === 'lost_ownership') {
      return { kind: 'lost_ownership' };
    }
    if (enqueued.kind === 'error') {
      return { kind: 'enqueue_failed', code: enqueued.code };
    }
    outboxMessageId = enqueued.id;
    created = enqueued.created;
  }

  const finalize = await params.finalizeInbound();
  return { kind: 'finalized', outboxMessageId, created, finalize };
}
