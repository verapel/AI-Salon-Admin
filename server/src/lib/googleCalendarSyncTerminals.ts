/**
 * GOOGLE-CAL-SYNC-FIX-3: mutually exclusive terminal outcomes for one scanned event.
 * Convenience totals are derived from these buckets only.
 */

export const GOOGLE_SYNC_TERMINALS = [
  'newAppointment',
  'newReviewOverlay',
  'updatedAppointment',
  'updatedReviewOverlay',
  'unchangedAppointment',
  'unchangedReviewOverlay',
  'excludedCancelled',
  'excludedAllDay',
  'excludedInvalidTime',
  'conflictReview',
  'failed',
] as const;

export type GoogleSyncTerminal = (typeof GOOGLE_SYNC_TERMINALS)[number];

export type GoogleSyncTerminalCounts = Record<GoogleSyncTerminal, number>;

export function emptyGoogleSyncTerminalCounts(): GoogleSyncTerminalCounts {
  return {
    newAppointment: 0,
    newReviewOverlay: 0,
    updatedAppointment: 0,
    updatedReviewOverlay: 0,
    unchangedAppointment: 0,
    unchangedReviewOverlay: 0,
    excludedCancelled: 0,
    excludedAllDay: 0,
    excludedInvalidTime: 0,
    conflictReview: 0,
    failed: 0,
  };
}

export function googleSyncTerminalTotal(counts: GoogleSyncTerminalCounts): number {
  return GOOGLE_SYNC_TERMINALS.reduce((sum, key) => sum + counts[key], 0);
}

export function googleSyncAccountingConsistent(params: {
  scanned: number;
  terminals: GoogleSyncTerminalCounts;
}): boolean {
  return params.scanned === googleSyncTerminalTotal(params.terminals);
}

export type GoogleSyncConvenienceTotals = {
  newEvents: number;
  updatedEvents: number;
  unchangedEvents: number;
  excluded: number;
  failed: number;
  represented: number;
  imported: number;
  appointments: number;
  appointmentsCreated: number;
  appointmentsUpdated: number;
  reviewEvents: number;
  reviewEventsCreated: number;
  reviewEventsUpdated: number;
  alreadyImported: number;
  skipped: number;
  conflicts: number;
  cancelled: number;
  allDay: number;
  invalidTime: number;
  conflictReason: number;
  otherFailed: number;
};

export function applyGoogleSyncTerminal(
  terminals: GoogleSyncTerminalCounts,
  totals: GoogleSyncConvenienceTotals,
  terminal: GoogleSyncTerminal,
): void {
  terminals[terminal] += 1;
  switch (terminal) {
    case 'newAppointment':
      totals.newEvents += 1;
      totals.imported += 1;
      totals.appointments += 1;
      totals.appointmentsCreated += 1;
      totals.represented += 1;
      return;
    case 'newReviewOverlay':
      totals.newEvents += 1;
      totals.reviewEvents += 1;
      totals.reviewEventsCreated += 1;
      totals.represented += 1;
      totals.skipped += 1;
      return;
    case 'updatedAppointment':
      totals.updatedEvents += 1;
      totals.appointmentsUpdated += 1;
      totals.alreadyImported += 1;
      totals.represented += 1;
      return;
    case 'updatedReviewOverlay':
      totals.updatedEvents += 1;
      totals.reviewEvents += 1;
      totals.reviewEventsUpdated += 1;
      totals.represented += 1;
      return;
    case 'unchangedAppointment':
      totals.unchangedEvents += 1;
      totals.alreadyImported += 1;
      totals.represented += 1;
      return;
    case 'unchangedReviewOverlay':
      totals.unchangedEvents += 1;
      totals.reviewEvents += 1;
      totals.represented += 1;
      return;
    case 'excludedCancelled':
      totals.excluded += 1;
      totals.skipped += 1;
      totals.cancelled += 1;
      return;
    case 'excludedAllDay':
      totals.excluded += 1;
      totals.skipped += 1;
      totals.allDay += 1;
      return;
    case 'excludedInvalidTime':
      totals.excluded += 1;
      totals.skipped += 1;
      totals.invalidTime += 1;
      return;
    case 'conflictReview':
      totals.conflicts += 1;
      totals.conflictReason += 1;
      totals.reviewEvents += 1;
      totals.reviewEventsUpdated += 1;
      totals.represented += 1;
      totals.skipped += 1;
      return;
    case 'failed':
      totals.failed += 1;
      totals.otherFailed += 1;
      return;
  }
}
