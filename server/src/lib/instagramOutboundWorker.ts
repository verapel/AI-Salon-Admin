/**
 * IG-7: Instagram outbound outbox batch worker.
 * Instagram-only. No Telegram/WhatsApp/Apple mutations.
 * Meta HTTP only via flush (real send or injected sendFn in tests).
 *
 * Activation: INSTAGRAM_OUTBOUND_ENABLED must be exactly "true".
 * Default / unset → worker does not start (production-safe no-op).
 * Not wired into server bootstrap in IG-7 (activation is a later stage).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  flushInstagramOutboundMessage,
} from './instagramOutbound.js';
import type { InstagramSendTextFn } from './instagramMessagingApi.js';

export const INSTAGRAM_OUTBOUND_BATCH_LIMIT = 20;
export const INSTAGRAM_OUTBOUND_WORKER_INTERVAL_MS = 45_000;
export const INSTAGRAM_OUTBOUND_ENABLED_ENV = 'INSTAGRAM_OUTBOUND_ENABLED';

export type InstagramOutboundBatchResult = {
  scanned: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  skipped: number;
  errors: number;
};

export type InstagramOutboundWorkerHandle = {
  started: boolean;
  enabled: boolean;
  intervalMs: number;
  stop: () => void;
};

let workerIntervalId: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
let workerStarted = false;

export function isInstagramOutboundEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env[INSTAGRAM_OUTBOUND_ENABLED_ENV] ?? '').trim() === 'true';
}

/**
 * Claim/send due pending (and reclaimable) Instagram outbox rows.
 * Selection is best-effort; per-row claim CAS prevents double-send.
 */
export async function runInstagramOutboundBatch(params: {
  db: SupabaseClient | any;
  limit?: number;
  sendFn?: InstagramSendTextFn;
  nowIso?: string;
}): Promise<InstagramOutboundBatchResult> {
  const limit = params.limit ?? INSTAGRAM_OUTBOUND_BATCH_LIMIT;
  const nowIso = params.nowIso ?? new Date().toISOString();
  const summary: InstagramOutboundBatchResult = {
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
      .from('instagram_outbound_messages')
      .select('id')
      .or(
        `and(status.eq.pending,or(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})),status.eq.claimed`,
      )
      .order('created_at', { ascending: true })
      .limit(limit);

    if (res.error) {
      console.error('[instagram/outbound-worker] batch select failed', {
        operation: 'outbound_batch_select',
        result: 'error',
        code: typeof res.error.code === 'string' ? res.error.code : 'select_error',
      });
      summary.errors += 1;
      return summary;
    }
    data = res.data ?? [];
  } catch {
    console.error('[instagram/outbound-worker] batch select exception', {
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
      const result = await flushInstagramOutboundMessage({
        db: params.db,
        messageId: id,
        sendFn: params.sendFn,
      });
      if (result.kind === 'sent') summary.sent += 1;
      else if (result.kind === 'retry_scheduled') summary.retryScheduled += 1;
      else if (result.kind === 'failed') summary.failed += 1;
      else if (result.kind === 'skipped') summary.skipped += 1;
      else summary.errors += 1;

      console.log('[instagram/outbound-worker] flush', {
        operation: 'outbound_flush',
        outboxId: id,
        result: result.kind,
        code: 'code' in result ? result.code : undefined,
      });
    } catch {
      summary.errors += 1;
      console.error('[instagram/outbound-worker] flush exception', {
        operation: 'outbound_flush',
        outboxId: id,
        result: 'exception',
      });
    }
  }

  return summary;
}

async function tickInstagramOutboundWorker(params: {
  db: SupabaseClient | any;
  sendFn?: InstagramSendTextFn;
}): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const summary = await runInstagramOutboundBatch({
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
      console.log('[instagram/outbound-worker] batch', {
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
    console.error('[instagram/outbound-worker] batch exception', {
      operation: 'outbound_batch',
      result: 'exception',
    });
  } finally {
    workerRunning = false;
  }
}

/**
 * Start Instagram outbound worker only when INSTAGRAM_OUTBOUND_ENABLED=true.
 * Otherwise returns started:false (no interval, no Meta calls).
 */
export function startInstagramOutboundWorker(params: {
  db: SupabaseClient | any;
  intervalMs?: number;
  sendFn?: InstagramSendTextFn;
  runImmediately?: boolean;
  /** Test override for env flag. */
  enabled?: boolean;
}): InstagramOutboundWorkerHandle {
  const intervalMs = params.intervalMs ?? INSTAGRAM_OUTBOUND_WORKER_INTERVAL_MS;
  const enabled =
    typeof params.enabled === 'boolean'
      ? params.enabled
      : isInstagramOutboundEnabled();

  const noopStop = () => {
    /* no-op */
  };

  if (!enabled) {
    return {
      started: false,
      enabled: false,
      intervalMs,
      stop: noopStop,
    };
  }

  if (workerStarted && workerIntervalId !== null) {
    return {
      started: true,
      enabled: true,
      intervalMs,
      stop: stopInstagramOutboundWorker,
    };
  }

  workerStarted = true;

  const run = () => {
    void tickInstagramOutboundWorker({ db: params.db, sendFn: params.sendFn });
  };

  if (params.runImmediately !== false) {
    run();
  }

  workerIntervalId = setInterval(run, intervalMs);

  console.log('[instagram/outbound-worker] started', {
    operation: 'outbound_worker_start',
    intervalMs,
    immediate: params.runImmediately !== false,
  });

  return {
    started: true,
    enabled: true,
    intervalMs,
    stop: stopInstagramOutboundWorker,
  };
}

export function stopInstagramOutboundWorker(): void {
  if (workerIntervalId !== null) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
  }
  workerStarted = false;
  workerRunning = false;
}

export function getInstagramOutboundWorkerDebugState(): {
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
