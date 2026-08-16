/**
 * GOOGLE-CAL-FAST-6: Google Calendar auto-pull worker bootstrap.
 * Bounded interval, no overlapping ticks, per-connection isolation inside batch.
 * Read-only Google. No Telegram/WA/IG/Apple coupling.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  GOOGLE_CALENDAR_PULL_INTERVAL_MS,
  runGoogleCalendarPullBatch,
  type GooglePullBatchResult,
} from './googleCalendarAutoImport.js';
import type { GoogleFetch } from './googleCalendarOAuth.js';

export type GoogleCalendarPullWorkerHandle = {
  started: boolean;
  intervalMs: number;
  stop: () => void;
};

let workerIntervalId: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
let workerStarted = false;

export async function tickGoogleCalendarPullWorker(params: {
  db: SupabaseClient | any;
  fetchImpl?: GoogleFetch;
  now?: Date;
}): Promise<GooglePullBatchResult | null> {
  if (workerRunning) {
    console.log('[calendar/google-auto] tick skipped — already running', {
      operation: 'google_pull_tick_skip',
    });
    return null;
  }
  workerRunning = true;
  try {
    const result = await runGoogleCalendarPullBatch({
      db: params.db,
      fetchImpl: params.fetchImpl,
      now: params.now,
    });
    if (result.connections > 0 || result.errors > 0) {
      console.log('[calendar/google-auto] tick complete', {
        operation: 'google_pull_tick',
        connections: result.connections,
        imported: result.imported,
        skipped: result.skipped,
        conflicts: result.conflicts,
        errors: result.errors,
      });
    }
    return result;
  } catch (err) {
    console.error('[calendar/google-auto] tick failed', {
      operation: 'google_pull_tick',
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    workerRunning = false;
  }
}

export function startGoogleCalendarPullWorker(params: {
  db: SupabaseClient | any;
  intervalMs?: number;
  runImmediately?: boolean;
  fetchImpl?: GoogleFetch;
}): GoogleCalendarPullWorkerHandle {
  const intervalMs = params.intervalMs ?? GOOGLE_CALENDAR_PULL_INTERVAL_MS;

  if (workerStarted) {
    return {
      started: true,
      intervalMs,
      stop: stopGoogleCalendarPullWorker,
    };
  }

  workerStarted = true;

  const run = () => {
    void tickGoogleCalendarPullWorker({
      db: params.db,
      fetchImpl: params.fetchImpl,
    });
  };

  if (params.runImmediately !== false) {
    run();
  }

  workerIntervalId = setInterval(run, intervalMs);

  console.log('[calendar/google-auto] worker started', {
    operation: 'google_pull_worker_start',
    intervalMs,
    immediate: params.runImmediately !== false,
  });

  return {
    started: true,
    intervalMs,
    stop: stopGoogleCalendarPullWorker,
  };
}

export function stopGoogleCalendarPullWorker(): void {
  if (workerIntervalId !== null) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
  }
  workerStarted = false;
  workerRunning = false;
}

export function getGoogleCalendarPullWorkerDebugState(): {
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
