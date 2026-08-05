/**
 * WA-4F1: WhatsApp outbound outbox batch worker (callable).
 * Not bootstrapped automatically — export runWhatsAppOutboundBatch only.
 * No Telegram. No Meta calls unless flush runs with real sendFn.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  flushWhatsAppOutboundMessage,
  type WhatsAppOutboundSendFn,
} from './whatsappOutbound.js';

export const WHATSAPP_OUTBOUND_BATCH_LIMIT = 20;

export type WhatsAppOutboundBatchResult = {
  scanned: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  skipped: number;
  errors: number;
};

/**
 * Claim/send due pending (and reclaimable) outbox rows.
 * Selection is best-effort; per-row claim CAS prevents double-send.
 */
export async function runWhatsAppOutboundBatch(params: {
  db: SupabaseClient | any;
  limit?: number;
  sendFn?: WhatsAppOutboundSendFn;
  nowIso?: string;
}): Promise<WhatsAppOutboundBatchResult> {
  const limit = params.limit ?? WHATSAPP_OUTBOUND_BATCH_LIMIT;
  const nowIso = params.nowIso ?? new Date().toISOString();
  const summary: WhatsAppOutboundBatchResult = {
    scanned: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
  };

  // Pending due now, or claimed (flush CAS reclaim only if stale).
  // Retryable failures are returned to status=pending by finalize RPC.
  const { data, error } = await params.db
    .from('whatsapp_outbound_messages')
    .select('id')
    .or(
      `and(status.eq.pending,or(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})),status.eq.claimed`,
    )
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    summary.errors += 1;
    return summary;
  }

  const ids = (data ?? [])
    .map((r: { id?: unknown }) => (typeof r.id === 'string' ? r.id : null))
    .filter((id: string | null): id is string => Boolean(id));

  summary.scanned = ids.length;

  for (const id of ids) {
    const result = await flushWhatsAppOutboundMessage({
      db: params.db,
      messageId: id,
      sendFn: params.sendFn,
    });
    if (result.kind === 'sent') summary.sent += 1;
    else if (result.kind === 'retry_scheduled') summary.retryScheduled += 1;
    else if (result.kind === 'failed') summary.failed += 1;
    else if (result.kind === 'skipped') summary.skipped += 1;
    else summary.errors += 1;
  }

  return summary;
}
