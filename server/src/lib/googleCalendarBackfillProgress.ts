export type GoogleBackfillProgressStatus = 'idle' | 'listing' | 'processing' | 'done' | 'error';

export type GoogleBackfillProgress = {
  processed: number;
  total: number | null;
  percent: number;
  status: GoogleBackfillProgressStatus;
  pagesProcessed: number;
  result?: unknown | null;
};

const store = new Map<string, GoogleBackfillProgress>();

export function isGoogleBackfillJobRunning(status: GoogleBackfillProgressStatus): boolean {
  return status === 'listing' || status === 'processing';
}

export function googleBackfillPercent(
  processed: number,
  total: number | null,
  status: GoogleBackfillProgressStatus
): number {
  if (status === 'done') return 100;
  if (status === 'error' || total == null || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((processed / total) * 100));
}

export function emptyGoogleBackfillProgress(
  status: GoogleBackfillProgressStatus = 'idle'
): GoogleBackfillProgress {
  return {
    processed: 0,
    total: null,
    percent: status === 'done' ? 100 : 0,
    status,
    pagesProcessed: 0,
    result: null,
  };
}

export function resetGoogleBackfillProgressStore(): void {
  store.clear();
}

export function beginGoogleBackfillProgress(salonId: string): GoogleBackfillProgress {
  const next = emptyGoogleBackfillProgress('listing');
  store.set(salonId, next);
  return next;
}

/** Start a new job only when the salon is not already listing/processing. */
export function tryBeginGoogleBackfillProgress(salonId: string): {
  started: boolean;
  progress: GoogleBackfillProgress;
} {
  const current = store.get(salonId);
  if (current && isGoogleBackfillJobRunning(current.status)) {
    return { started: false, progress: current };
  }
  return { started: true, progress: beginGoogleBackfillProgress(salonId) };
}

export function updateGoogleBackfillProgress(
  salonId: string,
  patch: Partial<
    Pick<GoogleBackfillProgress, 'processed' | 'total' | 'status' | 'pagesProcessed' | 'result'>
  >
): GoogleBackfillProgress {
  const current = store.get(salonId) ?? emptyGoogleBackfillProgress('processing');
  const status = patch.status ?? current.status;
  const incomingProcessed = patch.processed ?? current.processed;
  const processed =
    isGoogleBackfillJobRunning(status)
      ? Math.max(current.processed, incomingProcessed)
      : incomingProcessed;
  const incomingPages = patch.pagesProcessed ?? current.pagesProcessed;
  const pagesProcessed = isGoogleBackfillJobRunning(status)
    ? Math.max(current.pagesProcessed, incomingPages)
    : incomingPages;
  const total = patch.total === undefined ? current.total : patch.total;
  const result = patch.result === undefined ? current.result ?? null : patch.result;
  const next: GoogleBackfillProgress = {
    processed,
    total,
    status,
    pagesProcessed,
    result,
    percent: googleBackfillPercent(processed, total, status),
  };
  store.set(salonId, next);
  return next;
}

export function getGoogleBackfillProgress(salonId: string): GoogleBackfillProgress {
  return store.get(salonId) ?? emptyGoogleBackfillProgress('idle');
}
