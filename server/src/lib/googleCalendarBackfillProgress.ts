export type GoogleBackfillProgressStatus = 'idle' | 'listing' | 'processing' | 'done' | 'error';

export type GoogleBackfillProgress = {
  processed: number;
  total: number | null;
  percent: number;
  status: GoogleBackfillProgressStatus;
};

const store = new Map<string, GoogleBackfillProgress>();

export function googleBackfillPercent(
  processed: number,
  total: number | null,
  status: GoogleBackfillProgressStatus
): number {
  if (status === 'done') return 100;
  if (status === 'error' || total == null || total <= 0) {
    return status === 'error' ? 0 : 0;
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
  };
}

export function beginGoogleBackfillProgress(salonId: string): GoogleBackfillProgress {
  const next = emptyGoogleBackfillProgress('listing');
  store.set(salonId, next);
  return next;
}

export function updateGoogleBackfillProgress(
  salonId: string,
  patch: Partial<Pick<GoogleBackfillProgress, 'processed' | 'total' | 'status'>>
): GoogleBackfillProgress {
  const current = store.get(salonId) ?? emptyGoogleBackfillProgress('processing');
  const status = patch.status ?? current.status;
  const processed = patch.processed ?? current.processed;
  const total = patch.total === undefined ? current.total : patch.total;
  const next: GoogleBackfillProgress = {
    processed,
    total,
    status,
    percent: googleBackfillPercent(processed, total, status),
  };
  store.set(salonId, next);
  return next;
}

export function getGoogleBackfillProgress(salonId: string): GoogleBackfillProgress {
  return store.get(salonId) ?? emptyGoogleBackfillProgress('idle');
}
