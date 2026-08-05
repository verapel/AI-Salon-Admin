/**
 * WA-4F2: WhatsApp outbound outbox batch worker + process bootstrap.
 * WhatsApp-only. No Telegram. No booking/appointment mutations.
 * Meta HTTP only via flush (real send or injected sendFn in tests).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  flushWhatsAppOutboundMessage,
  type WhatsAppOutboundSendFn,
} from './whatsappOutbound.js';

export const WHATSAPP_OUTBOUND_BATCH_LIMIT = 20;
/** Pilot fallback interval (inline flush covers the hot path). */
export const WHATSAPP_OUTBOUND_WORKER_INTERVAL_MS = 45_000;

export type WhatsAppOutboundBatchResult = {
  scanned: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  skipped: number;
  errors: number;
};

export type WhatsAppOutboundWorkerHandle = {
  started: boolean;
  intervalMs: number;
  /** Test/helper: stop interval (no large SIGTERM framework). */
  stop: () => void;
};

let workerIntervalId: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
let workerStarted = false;

/**
 * Claim/send due pending (and reclaimable) outbox rows.
 * Selection is best-effort; per-row claim CAS prevents double-send.
 * One row failure does not stop the batch.
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

  let data: Array<{ id?: unknown }> | null = null;
  try {
    const res = await params.db
      .from('whatsapp_outbound_messages')
      .select('id')
      .or(
        `and(status.eq.pending,or(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})),status.eq.claimed`,
      )
      .order('created_at', { ascending: true })
      .limit(limit);

    if (res.error) {
      // Missing table / RLS / network — safe no-op for bootstrap-before-migration.
      console.error('[whatsapp/outbound-worker] batch select failed', {
        operation: 'outbound_batch_select',
        result: 'error',
        code: typeof res.error.code === 'string' ? res.error.code : 'select_error',
      });
      summary.errors += 1;
      return summary;
    }
    data = res.data ?? [];
  } catch {
    console.error('[whatsapp/outbound-worker] batch select exception', {
      operation: 'outbound_batch_select',
      result: 'exception',
    });
    summary.errors += 1;
    return summary;
  }

  const ids = (data ?? [])
    .map((r: { id?: unknown }) => (typeof r.id === 'string' ? r.id : null))
    .filter((id: string | null): id is string => Boolean(id));

  summary.scanned = ids.length;

  for (const id of ids) {
    try {
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

      console.log('[whatsapp/outbound-worker] flush', {
        operation: 'outbound_flush',
        outboxId: id,
        result: result.kind,
        code: 'code' in result ? result.code : undefined,
      });
    } catch {
      summary.errors += 1;
      console.error('[whatsapp/outbound-worker] flush exception', {
        operation: 'outbound_flush',
        outboxId: id,
        result: 'exception',
      });
    }
  }

  return summary;
}

async function tickWhatsAppOutboundWorker(params: {
  db: SupabaseClient | any;
  sendFn?: WhatsAppOutboundSendFn;
}): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const summary = await runWhatsAppOutboundBatch({
      db: params.db,
      sendFn: params.sendFn,
    });
    if (
      summary.scanned > 0 ||
      summary.errors > 0 ||
      summary.sent > 0 ||
      summary.retryScheduled > 0 ||
      summary.failed > 0
    ) {
      console.log('[whatsapp/outbound-worker] batch', {
        operation: 'outbound_batch',
        scanned: summary.scanned,
        sent: summary.sent,
        retryScheduled: summary.retryScheduled,
        failed: summary.failed,
        skipped: summary.skipped,
        errors: summary.errors,
      });
    }
  } catch {
    console.error('[whatsapp/outbound-worker] batch exception', {
      operation: 'outbound_batch',
      result: 'exception',
    });
  } finally {
    workerRunning = false;
  }
}

/**
 * Start the WhatsApp outbound retry worker once per process.
 * Immediate first batch, then interval. Safe without Meta credentials / empty outbox.
 */
export function startWhatsAppOutboundWorker(params: {
  db: SupabaseClient | any;
  intervalMs?: number;
  sendFn?: WhatsAppOutboundSendFn;
  /** When false, skip immediate boot batch (tests). Default true. */
  runImmediately?: boolean;
}): WhatsAppOutboundWorkerHandle {
  const intervalMs = params.intervalMs ?? WHATSAPP_OUTBOUND_WORKER_INTERVAL_MS;

  if (workerStarted && workerIntervalId !== null) {
    return {
      started: true,
      intervalMs,
      stop: stopWhatsAppOutboundWorker,
    };
  }

  workerStarted = true;

  const run = () => {
    void tickWhatsAppOutboundWorker({ db: params.db, sendFn: params.sendFn });
  };

  if (params.runImmediately !== false) {
    run();
  }

  workerIntervalId = setInterval(run, intervalMs);

  console.log('[whatsapp/outbound-worker] started', {
    operation: 'outbound_worker_start',
    intervalMs,
    immediate: params.runImmediately !== false,
  });

  return {
    started: true,
    intervalMs,
    stop: stopWhatsAppOutboundWorker,
  };
}

/** Stop worker interval (idempotent). Used by tests; no SIGTERM framework required. */
export function stopWhatsAppOutboundWorker(): void {
  if (workerIntervalId !== null) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
  }
  workerStarted = false;
  workerRunning = false;
}

/** Test helper: observe in-process guards. */
export function getWhatsAppOutboundWorkerDebugState(): {
  started: boolean;
  running: boolean;
  hasInterval: boolean;
} {
  return {
    started: workerStarted,
    running: workerRunning,
    hasInterval: workerIntervalId !== null,
  };
}
