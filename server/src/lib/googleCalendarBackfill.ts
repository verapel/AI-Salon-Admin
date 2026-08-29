/**
 * GOOGLE-CAL-FAST-7D: Manual coverage from now-30d through all future Google events.
 * Isolated from FAST-6 auto-pull. Does not write watermarks, page tokens, or Google events.
 * Reuses decideGoogleAutoImport (without autoImportSince) + executeManualGoogleCalendarImport.
 */

import {
  matchParsedCalendarEvent,
  loadSalonCalendarMatchCatalog,
  type CalendarMatchCatalog,
} from './calendarEventMatcher.js';
import { parseExternalCalendarEvent, resolveParserTimezone } from './calendarEventParser.js';
import {
  decideGoogleAutoImport,
  isPilotTatevStaffName,
  readAutoImportStaffIdFromConfig,
  resolvePilotGoogleAutoImportStaff,
  type GoogleAutoImportSkipReason,
} from './googleCalendarAutoImport.js';
import {
  executeManualGoogleCalendarImport,
  GoogleCalendarImportError,
  buildGoogleOccurrenceRecurrenceId,
  googleStoredOccurrenceKeys,
  type ManualGoogleImportResult,
} from './googleCalendarImport.js';
import {
  GOOGLE_CALENDAR_PROVIDER,
  GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
  GoogleCalendarOAuthError,
  googlePreviewItemIdentity,
  listGoogleCalendarEventsPreview,
  loadGoogleCalendarAppConfig,
  readSelectedGoogleCalendars,
  refreshGoogleAccessToken,
  type GoogleEventPreviewItem,
  type GoogleEventsListPage,
  type GoogleFetch,
} from './googleCalendarOAuth.js';
import { decryptCalendarCredential } from './calendarCredentialsCrypto.js';
import { getSalonTimezone } from './scheduleSlots.js';
import {
  findRememberedCoverageClientId,
  googleReviewOverlayRecordIsVisible,
  isGoogleEventAllDay,
  isGoogleEventCancelledOrDeleted,
  isGoogleEventEligibleForSalonCalendarDisplay,
  loadGoogleReviewCoverageIndex,
  persistGoogleReviewOrResolve,
  rememberGoogleReviewCoverage,
  resolveGoogleCalendarReviewIssue,
  type GoogleReviewCoverageIndex,
} from './googleCalendarReviewOverlay.js';
import {
  findImportedOccurrenceRecord,
  findOverlayRecord,
  googleImportedAppointmentIsVisible,
  googleImportedOccurrenceUnchanged,
  googleImportedRowNeedsBusyMetadataRetarget,
  googleOverlayOccurrenceUnchanged,
  loadGoogleImportedOccurrenceIndex,
  persistCanonicalGoogleBusyAppointment,
  pickCanonicalGoogleBusyServiceId,
  ensureUnresolvedGoogleBusyServiceId,
  retainGoogleBusyClientId,
  reconcileGoogleReviewOverlay,
  reconcileGoogleSourcedAppointment,
  type GoogleImportedOccurrenceIndex,
} from './googleCalendarReconcile.js';
import {
  applyGoogleSyncTerminal,
  emptyGoogleSyncTerminalCounts,
  googleSyncAccountingConsistent,
  type GoogleSyncConvenienceTotals,
  type GoogleSyncTerminal,
  type GoogleSyncTerminalCounts,
} from './googleCalendarSyncTerminals.js';
import {
  loadGoogleCoverageClientSession,
  loadRememberedGoogleCoverageClientId,
  pickGoogleCoverageDisplayName,
  resolveOrCreateGoogleCoverageClient,
  type CoverageClientRecord,
} from './googleCalendarCoverageClient.js';

export const GOOGLE_BACKFILL_LOOKBACK_DAYS = 30;
export const GOOGLE_BACKFILL_LOOKBACK_MS = GOOGLE_BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
export const GOOGLE_BACKFILL_MAX_PAGES = 20;
export const GOOGLE_BACKFILL_MAX_SCAN_EVENTS = 5000;

export type GoogleBackfillReasonCounts = {
  noPhone: number;
  unsafeClientName: number;
  clientAmbiguous: number;
  serviceUnmatched: number;
  serviceAmbiguous: number;
  conflict: number;
  cancelled: number;
  allDay: number;
  invalidTime: number;
  other: number;
};

export type GoogleBackfillResult = {
  scanned: number;
  represented: number;
  imported: number;
  appointments: number;
  reviewEvents: number;
  clientsCreated: number;
  clientsReused: number;
  alreadyImported: number;
  skipped: number;
  excluded: number;
  failed: number;
  truncated: boolean;
  newEvents: number;
  updatedEvents: number;
  unchangedEvents: number;
  appointmentsCreated: number;
  appointmentsUpdated: number;
  reviewEventsCreated: number;
  reviewEventsUpdated: number;
  conflicts: number;
  reasons: GoogleBackfillReasonCounts;
  terminals: GoogleSyncTerminalCounts;
  inconsistent: boolean;
};

export type GoogleBackfillOutcome =
  | { kind: 'alreadyImported' }
  | { kind: 'skipped'; reason: keyof GoogleBackfillReasonCounts }
  | { kind: 'failed'; reason: keyof GoogleBackfillReasonCounts };

const MAYA_FIRST_NAMES = new Set(['maya', 'майя', 'майа', 'մայա']);

function parseGoogleCredentialBlob(plaintext: string): { refresh_token: string } {
  const parsed = JSON.parse(plaintext) as { refresh_token?: string };
  if (!parsed.refresh_token?.trim()) throw new Error('missing refresh');
  return { refresh_token: parsed.refresh_token.trim() };
}

export function emptyGoogleBackfillReasons(): GoogleBackfillReasonCounts {
  return {
    noPhone: 0,
    unsafeClientName: 0,
    clientAmbiguous: 0,
    serviceUnmatched: 0,
    serviceAmbiguous: 0,
    conflict: 0,
    cancelled: 0,
    allDay: 0,
    invalidTime: 0,
    other: 0,
  };
}

export function emptyGoogleBackfillResult(truncated = false): GoogleBackfillResult {
  return {
    scanned: 0,
    represented: 0,
    imported: 0,
    appointments: 0,
    reviewEvents: 0,
    clientsCreated: 0,
    clientsReused: 0,
    alreadyImported: 0,
    skipped: 0,
    excluded: 0,
    failed: 0,
    truncated,
    newEvents: 0,
    updatedEvents: 0,
    unchangedEvents: 0,
    appointmentsCreated: 0,
    appointmentsUpdated: 0,
    reviewEventsCreated: 0,
    reviewEventsUpdated: 0,
    conflicts: 0,
    reasons: emptyGoogleBackfillReasons(),
    terminals: emptyGoogleSyncTerminalCounts(),
    inconsistent: false,
  };
}

/**
 * Event START window: [now - 30 days, +∞).
 * timeMin is the start of the UTC calendar day 30 days before `now`,
 * so the entire "30 days ago" day is visible. No future timeMax.
 */
export function buildGoogleBackfillWindow(now: Date = new Date()): {
  timeMin: string;
  timeMax?: string;
} {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - GOOGLE_BACKFILL_LOOKBACK_DAYS);
  return {
    timeMin: start.toISOString(),
  };
}

export function googleEventStartMs(
  ev: Pick<GoogleEventPreviewItem, 'start'>,
): number | null {
  const dateTime = ev.start?.dateTime?.trim();
  if (dateTime) {
    const ms = Date.parse(dateTime);
    return Number.isFinite(ms) ? ms : null;
  }
  const date = ev.start?.date?.trim();
  if (date) {
    const ms = Date.parse(date);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function isGoogleEventStartInBackfillWindow(
  ev: Pick<GoogleEventPreviewItem, 'start'>,
  window: { timeMin: string; timeMax?: string },
): boolean {
  const startMs = googleEventStartMs(ev);
  if (startMs == null) return false;
  const min = Date.parse(window.timeMin);
  if (!Number.isFinite(min) || startMs < min) return false;
  if (!window.timeMax) return true;
  const max = Date.parse(window.timeMax);
  if (!Number.isFinite(max)) return true;
  return startMs < max;
}

export function selectGoogleEventsForBackfill(
  events: GoogleEventPreviewItem[],
  window: { timeMin: string; timeMax?: string },
): GoogleEventPreviewItem[] {
  return events.filter((ev) => isGoogleEventStartInBackfillWindow(ev, window));
}

export function isForbiddenMayaStaffName(name: string): boolean {
  const raw = name.trim().toLowerCase();
  if (!raw) return false;
  const first = raw.split(/\s+/)[0]?.replace(/[^\p{L}]/gu, '') ?? '';
  return MAYA_FIRST_NAMES.has(first);
}

export function classifyGoogleBackfillSkip(params: {
  decisionReason?: GoogleAutoImportSkipReason | string;
  serviceStatus?: string | null;
  importErrorCode?: string | null;
}): GoogleBackfillOutcome {
  const code = params.importErrorCode || params.decisionReason || 'other';
  if (code === 'already_imported' || code === 'google_event_already_imported') {
    return { kind: 'alreadyImported' };
  }
  if (code === 'no_exact_phone') {
    return { kind: 'skipped', reason: 'noPhone' };
  }
  if (code === 'unsafe_client_name') {
    return { kind: 'skipped', reason: 'unsafeClientName' };
  }
  if (
    code === 'client_ambiguous' ||
    code === 'client_review_required' ||
    code === 'client_blocked'
  ) {
    return { kind: 'skipped', reason: 'clientAmbiguous' };
  }
  if (code === 'service_not_matched' || code === 'service_inactive_or_invalid') {
    if (params.serviceStatus === 'ambiguous') {
      return { kind: 'skipped', reason: 'serviceAmbiguous' };
    }
    return { kind: 'skipped', reason: 'serviceUnmatched' };
  }
  if (code === 'service_review_required' || code === 'service_invalid') {
    if (params.serviceStatus === 'ambiguous') {
      return { kind: 'skipped', reason: 'serviceAmbiguous' };
    }
    return { kind: 'skipped', reason: 'serviceUnmatched' };
  }
  if (code === 'appointment_conflict') {
    return { kind: 'skipped', reason: 'conflict' };
  }
  if (code === 'cancelled' || code === 'google_event_cancelled') {
    return { kind: 'skipped', reason: 'cancelled' };
  }
  if (code === 'all_day') {
    return { kind: 'skipped', reason: 'allDay' };
  }
  if (code === 'invalid_time' || code === 'overnight' || code === 'google_event_not_importable') {
    return { kind: 'skipped', reason: 'invalidTime' };
  }
  return { kind: 'failed', reason: 'other' };
}

export async function listGoogleCalendarEventsForBackfill(params: {
  accessToken: string;
  calendarId: string;
  calendarName?: string | null;
  timeMin: string;
  timeMax?: string;
  fetchImpl?: GoogleFetch;
  maxPages?: number;
  maxEvents?: number;
  onPage?: (page: GoogleEventsListPage) => void | Promise<void>;
}): Promise<{ events: GoogleEventPreviewItem[]; truncated: boolean }> {
  return listGoogleCalendarEventsPreview({
    accessToken: params.accessToken,
    calendarId: params.calendarId,
    calendarName: params.calendarName,
    timeMin: params.timeMin,
    timeMax: params.timeMax,
    fetchImpl: params.fetchImpl,
    maxPages: params.maxPages ?? GOOGLE_BACKFILL_MAX_PAGES,
    maxEvents: params.maxEvents ?? GOOGLE_BACKFILL_MAX_SCAN_EVENTS,
    orderBy: 'startTime',
    onPage: params.onPage,
  });
}

/**
 * Resolve Tatev for backfill. Reuses FAST-6 stored staff id when it is still
 * the unique active Tatev; otherwise resolves live. Never persists config.
 * Maya is never accepted.
 */
export async function resolveGoogleBackfillPilotStaff(params: {
  db: any;
  salonId: string;
  providerConfig?: unknown;
}): Promise<{ id: string; name: string } | null> {
  const storedId = readAutoImportStaffIdFromConfig(params.providerConfig);
  if (storedId) {
    const { data, error } = await params.db
      .from('staff')
      .select('id, name')
      .eq('id', storedId)
      .eq('salon_id', params.salonId)
      .eq('active', true)
      .maybeSingle();
    if (!error && data?.id && typeof data.name === 'string') {
      if (isPilotTatevStaffName(data.name) && !isForbiddenMayaStaffName(data.name)) {
        return { id: data.id, name: data.name };
      }
    }
  }

  const resolved = await resolvePilotGoogleAutoImportStaff(params.db, params.salonId);
  if (!resolved) return null;
  if (isForbiddenMayaStaffName(resolved.name) || !isPilotTatevStaffName(resolved.name)) {
    return null;
  }
  return resolved;
}

function rememberImportedOccurrence(
  ev: GoogleEventPreviewItem,
  importedKeys: Set<string>,
): void {
  for (const key of googleStoredOccurrenceKeys({
    calendarId: ev.calendarId,
    eventId: ev.id,
    recurrenceId: buildGoogleOccurrenceRecurrenceId(ev),
  })) {
    importedKeys.add(key);
  }
}

function convenienceFromSummary(summary: GoogleBackfillResult): GoogleSyncConvenienceTotals {
  return {
    newEvents: summary.newEvents,
    updatedEvents: summary.updatedEvents,
    unchangedEvents: summary.unchangedEvents,
    excluded: summary.excluded,
    failed: summary.failed,
    represented: summary.represented,
    imported: summary.imported,
    appointments: summary.appointments,
    appointmentsCreated: summary.appointmentsCreated,
    appointmentsUpdated: summary.appointmentsUpdated,
    reviewEvents: summary.reviewEvents,
    reviewEventsCreated: summary.reviewEventsCreated,
    reviewEventsUpdated: summary.reviewEventsUpdated,
    alreadyImported: summary.alreadyImported,
    skipped: summary.skipped,
    conflicts: summary.conflicts,
    cancelled: summary.reasons.cancelled,
    allDay: summary.reasons.allDay,
    invalidTime: summary.reasons.invalidTime,
    conflictReason: summary.reasons.conflict,
    otherFailed: summary.reasons.other,
  };
}

function writeConvenience(summary: GoogleBackfillResult, totals: GoogleSyncConvenienceTotals): void {
  summary.newEvents = totals.newEvents;
  summary.updatedEvents = totals.updatedEvents;
  summary.unchangedEvents = totals.unchangedEvents;
  summary.excluded = totals.excluded;
  summary.failed = totals.failed;
  summary.represented = totals.represented;
  summary.imported = totals.imported;
  summary.appointments = totals.appointments;
  summary.appointmentsCreated = totals.appointmentsCreated;
  summary.appointmentsUpdated = totals.appointmentsUpdated;
  summary.reviewEvents = totals.reviewEvents;
  summary.reviewEventsCreated = totals.reviewEventsCreated;
  summary.reviewEventsUpdated = totals.reviewEventsUpdated;
  summary.alreadyImported = totals.alreadyImported;
  summary.skipped = totals.skipped;
  summary.conflicts = totals.conflicts;
  summary.reasons.cancelled = totals.cancelled;
  summary.reasons.allDay = totals.allDay;
  summary.reasons.invalidTime = totals.invalidTime;
  summary.reasons.conflict = totals.conflictReason;
  summary.reasons.other = totals.otherFailed;
}

function finishTerminal(summary: GoogleBackfillResult, terminal: GoogleSyncTerminal): void {
  const totals = convenienceFromSummary(summary);
  applyGoogleSyncTerminal(summary.terminals, totals, terminal);
  writeConvenience(summary, totals);
}

async function persistEligibleOverlay(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  reasonCode: string;
  staffId: string;
  staffName: string;
  salonTimeZone: string;
  matching?: Parameters<typeof persistGoogleReviewOrResolve>[0]['matching'];
  importedKeys: Set<string>;
  importedIndex: GoogleImportedOccurrenceIndex;
  catalog: CalendarMatchCatalog;
  selectedCalendarId?: string | null;
  clientId?: string | null;
  reviewIndex: GoogleReviewCoverageIndex;
  existing: boolean;
}): Promise<GoogleSyncTerminal> {
  const matchedClientId =
    params.matching?.client.status === 'matched' && params.matching.client.clientId
      ? params.matching.client.clientId
      : null;
  const scoped = matchedClientId
    ? null
    : params.existing && params.clientId
      ? { clientId: params.clientId }
      : await resolveOrCreateGoogleCoverageClient({
          db: params.db,
          salonId: params.salonId,
          session: [],
          catalog: params.catalog,
          ev: params.ev,
          displayName: pickGoogleCoverageDisplayName({
            title: params.ev.summary,
          }),
          phoneDigits: '',
          rememberedClientId: params.existing ? params.clientId ?? null : null,
          eventScoped: true,
        });
  const clientId = matchedClientId || scoped?.clientId || null;
  const serviceId =
    pickCanonicalGoogleBusyServiceId(params.matching, params.catalog.services) ||
    (await ensureUnresolvedGoogleBusyServiceId({
      db: params.db,
      salonId: params.salonId,
    }));
  if (clientId && serviceId && isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) {
    const persisted = await persistCanonicalGoogleBusyAppointment({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
      ev: params.ev,
      staffId: params.staffId,
      staffName: params.staffName,
      salonTimeZone: params.salonTimeZone,
      clientId,
      serviceId,
      importedIndex: params.importedIndex,
      selectedCalendarId: params.selectedCalendarId,
      matching: params.matching,
    });
    if (persisted.appointmentId && persisted.kind !== 'conflict' && persisted.kind !== 'missing') {
      await resolveGoogleCalendarReviewIssue({
        db: params.db,
        salonId: params.salonId,
        calendarConnectionId: params.calendarConnectionId,
        ev: params.ev,
        appointmentId: persisted.appointmentId,
      });
      if (persisted.kind === 'created') return 'newAppointment';
      if (persisted.kind === 'updated') return 'updatedAppointment';
      return 'unchangedAppointment';
    }
  }
  const persistKind = await persistGoogleReviewOrResolve({
    db: params.db,
    salonId: params.salonId,
    calendarConnectionId: params.calendarConnectionId,
    ev: params.ev,
    reasonCode: params.reasonCode,
    staffId: params.staffId,
    staffName: params.staffName,
    salonTimeZone: params.salonTimeZone,
    matching: params.matching,
    importedKeys: params.importedKeys,
    clientId,
    ignoreImportedLink: true,
  });
  if (persistKind === 'overlay') {
    rememberGoogleReviewCoverage(params.ev, params.reviewIndex, clientId);
    return params.existing ? 'updatedReviewOverlay' : 'newReviewOverlay';
  }
  if (persistKind === 'failed') return 'failed';
  if (persistKind === 'resolved') return 'unchangedAppointment';
  if (isGoogleEventAllDay(params.ev) || isGoogleEventCancelledOrDeleted(params.ev)) {
    return isGoogleEventCancelledOrDeleted(params.ev) ? 'excludedCancelled' : 'excludedAllDay';
  }
  return 'excludedInvalidTime';
}

async function ensureCoverageClient(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  parsedClientName: string | null;
  phoneDigits: string;
  session: CoverageClientRecord[];
  catalog: CalendarMatchCatalog;
  summary: GoogleBackfillResult;
  rememberedClientId?: string | null;
  eventScoped?: boolean;
}): Promise<string | null> {
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return null;
  const rememberedClientId =
    params.rememberedClientId ??
    (await loadRememberedGoogleCoverageClientId({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
      ev: params.ev,
    }));
  const resolved = await resolveOrCreateGoogleCoverageClient({
    db: params.db,
    salonId: params.salonId,
    session: params.session,
    catalog: params.catalog,
    ev: params.ev,
    displayName: pickGoogleCoverageDisplayName({
      clientNameCandidate: params.parsedClientName,
      title: params.ev.summary,
    }),
    phoneDigits: params.phoneDigits,
    rememberedClientId,
    eventScoped: params.eventScoped,
  });
  if (!resolved) return null;
  if (resolved.created) params.summary.clientsCreated += 1;
  else params.summary.clientsReused += 1;
  return resolved.clientId;
}

/**
 * Manual now-30d → all-future coverage. Does not write FAST-6 provider_config keys.
 * One unsafe event is counted and skipped; later events still run.
 */
export async function importGoogleCalendarLast30Days(params: {
  db: any;
  salonId: string;
  fetchImpl?: GoogleFetch;
  matchCatalog?: CalendarMatchCatalog;
  now?: Date;
  executeImport?: typeof executeManualGoogleCalendarImport;
  eventsOverride?: GoogleEventPreviewItem[];
  truncatedOverride?: boolean;
  salonTimeZone?: string;
  maxPages?: number;
  maxEvents?: number;
  onProgress?: (progress: {
    processed: number;
    total: number | null;
    pagesProcessed?: number;
  }) => void;
  onPage?: (page: GoogleEventsListPage) => void | Promise<void>;
}): Promise<GoogleBackfillResult> {
  const salonId = params.salonId.trim();
  const now = params.now ?? new Date();
  const window = buildGoogleBackfillWindow(now);
  const summary = emptyGoogleBackfillResult(false);

  const { data: conn, error: connErr } = await params.db
    .from('calendar_connections')
    .select(
      'id, salon_id, credential_ciphertext, credential_iv, credential_auth_tag, status, selected_calendar_id, selected_calendar_name, provider_config',
    )
    .eq('salon_id', salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();

  if (connErr || !conn?.id) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_NOT_CONNECTED',
      'Google Calendar is not connected',
    );
  }

  const selectedCalendars = readSelectedGoogleCalendars({
    selectedCalendarId: conn.selected_calendar_id,
    selectedCalendarName: conn.selected_calendar_name,
    providerConfig: conn.provider_config,
  });
  if (selectedCalendars.length === 0) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_SELECTED',
      'Google calendar is not selected',
    );
  }

  const staff = await resolveGoogleBackfillPilotStaff({
    db: params.db,
    salonId,
    providerConfig: conn.provider_config,
  });
  if (!staff) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_AUTO_STAFF_UNRESOLVED',
      'Could not uniquely resolve active Tatev/Tatevik staff for this salon',
    );
  }

  let importedIndex: GoogleImportedOccurrenceIndex;
  try {
    importedIndex = await loadGoogleImportedOccurrenceIndex({
      db: params.db,
      salonId,
      calendarConnectionId: conn.id,
    });
  } catch (err) {
    if (err instanceof GoogleCalendarImportError) throw err;
    throw new GoogleCalendarImportError('google_import_failed', 'Could not load import links');
  }
  const importedKeys = importedIndex.keys;

  const reviewIndex: GoogleReviewCoverageIndex = await loadGoogleReviewCoverageIndex({
    db: params.db,
    salonId,
    calendarConnectionId: conn.id,
  });

  let salonTimeZone: string;
  if (params.salonTimeZone) {
    salonTimeZone = resolveParserTimezone(params.salonTimeZone);
  } else {
    try {
      salonTimeZone = resolveParserTimezone(await getSalonTimezone(salonId));
    } catch {
      salonTimeZone = resolveParserTimezone(undefined);
    }
  }

  const loadedCatalog =
    params.matchCatalog ?? (await loadSalonCalendarMatchCatalog(params.db, salonId));
  const catalog = {
    clients: [...loadedCatalog.clients],
    services: loadedCatalog.services,
  };
  const executeImport = params.executeImport ?? executeManualGoogleCalendarImport;
  const serviceNames = catalog.services.map((s) => s.name);
  const clientSession: CoverageClientRecord[] = await loadGoogleCoverageClientSession({
    db: params.db,
    salonId,
    catalog,
  });

  let knownTotal: number | null = null;
  let pagesProcessed = 0;

  const emitProgress = () => {
    params.onProgress?.({
      processed: summary.scanned,
      total: knownTotal,
      pagesProcessed,
    });
  };

  const seenOccurrences = new Set<string>();

  const processEvents = async (events: GoogleEventPreviewItem[]) => {
    for (const ev of events) {
      const identity = googlePreviewItemIdentity(ev);
      if (seenOccurrences.has(identity)) continue;
      seenOccurrences.add(identity);
      summary.scanned += 1;
      let settled = false;
      const finish = (terminal: GoogleSyncTerminal) => {
        if (settled) return;
        settled = true;
        finishTerminal(summary, terminal);
      };
      try {
        const importedRecord = findImportedOccurrenceRecord(ev, importedIndex);
        const overlayRecord = findOverlayRecord(ev, reviewIndex);
        const importedVisible = googleImportedAppointmentIsVisible(importedRecord);
        const overlayVisible = googleReviewOverlayRecordIsVisible(overlayRecord);

        if (isGoogleEventCancelledOrDeleted(ev)) {
          if (overlayRecord) {
            await reconcileGoogleReviewOverlay({
              db: params.db,
              salonId,
              calendarConnectionId: conn.id,
              ev,
              overlays: reviewIndex,
              staffId: staff.id,
              staffName: staff.name,
              salonTimeZone,
            });
          }
          finish('excludedCancelled');
          continue;
        }

        if (isGoogleEventAllDay(ev)) {
          finish('excludedAllDay');
          continue;
        }

        if (!isGoogleEventEligibleForSalonCalendarDisplay(ev)) {
          finish('excludedInvalidTime');
          continue;
        }

        const parsed = parseExternalCalendarEvent(
          {
            summary: ev.summary,
            description: ev.description,
            status: ev.status,
            start: ev.start,
            end: ev.end,
          },
          salonTimeZone,
        );
        const matching = matchParsedCalendarEvent({
          parsed,
          originalTitle: ev.summary,
          catalog,
        });

        if (importedVisible) {
          if (
            googleImportedOccurrenceUnchanged(ev, importedRecord, salonTimeZone) &&
            !googleImportedRowNeedsBusyMetadataRetarget(importedRecord, importedIndex)
          ) {
            finish('unchangedAppointment');
            continue;
          }
          const desiredClientId =
            retainGoogleBusyClientId({
              eventId: ev.id,
              currentAppointmentId: importedRecord?.appointmentId,
              currentClientId: importedRecord?.clientId,
              matchedClientId:
                matching.client.status === 'matched' ? matching.client.clientId : null,
              currentServiceId: importedRecord?.serviceId,
              matchedServiceId: pickCanonicalGoogleBusyServiceId(matching, catalog.services),
              catalogServiceIds: catalog.services.map((row) => row.id),
              index: importedIndex,
              catalogClientIds: catalog.clients.map((row) => row.id),
            }) ||
            (await ensureCoverageClient({
              db: params.db,
              salonId,
              calendarConnectionId: conn.id,
              ev,
              parsedClientName: parsed.clientNameCandidate,
              phoneDigits: parsed.phone.normalized || '',
              session: clientSession,
              catalog,
              summary,
              eventScoped: true,
            }));
          const desiredServiceId =
            pickCanonicalGoogleBusyServiceId(matching, catalog.services) ||
            (await ensureUnresolvedGoogleBusyServiceId({
              db: params.db,
              salonId,
            }));
          const moved = await reconcileGoogleSourcedAppointment({
            db: params.db,
            salonId,
            calendarConnectionId: conn.id,
            ev,
            record: importedRecord!,
            salonTimeZone,
            staffId: staff.id,
            staffName: staff.name,
            matching,
            desiredClientId,
            desiredServiceId,
          });
          if (moved.kind === 'updated') {
            finish('updatedAppointment');
            continue;
          }
          if (moved.kind === 'conflict') {
            const coverageClientId = await ensureCoverageClient({
              db: params.db,
              salonId,
              calendarConnectionId: conn.id,
              ev,
              parsedClientName: parsed.clientNameCandidate,
              phoneDigits: parsed.phone.normalized || '',
              session: clientSession,
              catalog,
              summary,
              rememberedClientId: findRememberedCoverageClientId(ev, reviewIndex.clientByKey),
            });
            const terminal = await persistEligibleOverlay({
              db: params.db,
              salonId,
              calendarConnectionId: conn.id,
              ev,
              reasonCode: 'appointment_conflict',
              staffId: staff.id,
              staffName: staff.name,
              salonTimeZone,
              matching,
              importedKeys,
              importedIndex,
              catalog,
              selectedCalendarId: ev.calendarId,
              clientId: coverageClientId,
              reviewIndex,
              existing: overlayVisible,
            });
            finish(terminal === 'newReviewOverlay' || terminal === 'updatedReviewOverlay'
              ? 'conflictReview'
              : terminal);
            continue;
          }
        }

        if (overlayVisible && !importedVisible) {
          const remembered = findRememberedCoverageClientId(ev, reviewIndex.clientByKey);
          if (remembered) summary.clientsReused += 1;
          const coverageClientId =
            remembered ||
            (await ensureCoverageClient({
              db: params.db,
              salonId,
              calendarConnectionId: conn.id,
              ev,
              parsedClientName: parsed.clientNameCandidate,
              phoneDigits: parsed.phone.normalized || '',
              session: clientSession,
              catalog,
              summary,
              rememberedClientId: remembered,
            }));
          const terminal = await persistEligibleOverlay({
            db: params.db,
            salonId,
            calendarConnectionId: conn.id,
            ev,
            reasonCode: overlayRecord?.reasonCode || 'service_not_matched',
            staffId: staff.id,
            staffName: staff.name,
            salonTimeZone,
            matching,
            importedKeys,
            importedIndex,
            catalog,
            selectedCalendarId: ev.calendarId,
            clientId: coverageClientId,
            reviewIndex,
            existing: true,
          });
          if (
            (terminal === 'updatedReviewOverlay' || terminal === 'newReviewOverlay') &&
            googleOverlayOccurrenceUnchanged(ev, overlayRecord, salonTimeZone)
          ) {
            finish('unchangedReviewOverlay');
          } else {
            finish(terminal);
          }
          continue;
        }

        const coverageClientId = await ensureCoverageClient({
          db: params.db,
          salonId,
          calendarConnectionId: conn.id,
          ev,
          parsedClientName: parsed.clientNameCandidate,
          phoneDigits: parsed.phone.normalized || '',
          session: clientSession,
          catalog,
          summary,
          rememberedClientId: findRememberedCoverageClientId(ev, reviewIndex.clientByKey),
        });

        const decision = decideGoogleAutoImport({
          parsed,
          matching,
          eventStatus: ev.status,
          summary: ev.summary,
          staffId: staff.id,
          alreadyImported: false,
          serviceNames,
        });

        if (decision.action === 'skip') {
          const classified = classifyGoogleBackfillSkip({
            decisionReason: decision.reason,
            serviceStatus: matching.service.status,
          });
          if (classified.kind === 'skipped' || classified.kind === 'failed') {
            if (classified.kind === 'skipped' && classified.reason !== 'cancelled' && classified.reason !== 'allDay' && classified.reason !== 'invalidTime' && classified.reason !== 'conflict') {
              summary.reasons[classified.reason] += 1;
            }
          }
          finish(
            await persistEligibleOverlay({
              db: params.db,
              salonId,
              calendarConnectionId: conn.id,
              ev,
              reasonCode: decision.reason,
              staffId: staff.id,
              staffName: staff.name,
              salonTimeZone,
              matching,
              importedKeys,
              importedIndex,
              catalog,
              selectedCalendarId: ev.calendarId,
              clientId: coverageClientId,
              reviewIndex,
              existing: false,
            }),
          );
          continue;
        }

        const result: ManualGoogleImportResult = await executeImport({
          db: params.db,
          salonId,
          salonTimeZone,
          fetchImpl: params.fetchImpl,
          body: {
            eventId: ev.id,
            calendarId: ev.calendarId,
            staffId: decision.staffId,
            serviceId: decision.serviceId,
            client:
              coverageClientId
                ? { mode: 'existing', clientId: coverageClientId }
                : decision.clientMode === 'existing'
                  ? { mode: 'existing', clientId: decision.clientId }
                  : { mode: 'new', name: decision.clientName },
            expectedEtag: ev.etag || undefined,
            expectedUpdated: ev.updated || undefined,
          },
        });

        if (result.alreadyImported) {
          rememberImportedOccurrence(ev, importedKeys);
          if (importedVisible) {
            finish('unchangedAppointment');
          } else {
            finish(
              await persistEligibleOverlay({
                db: params.db,
                salonId,
                calendarConnectionId: conn.id,
                ev,
                reasonCode: 'imported_appointment_missing',
                staffId: staff.id,
                staffName: staff.name,
                salonTimeZone,
                matching,
                importedKeys,
                importedIndex,
                catalog,
                selectedCalendarId: ev.calendarId,
                clientId: coverageClientId,
                reviewIndex,
                existing: overlayVisible,
              }),
            );
          }
        } else {
          rememberImportedOccurrence(ev, importedKeys);
          finish('newAppointment');
        }
        await resolveGoogleCalendarReviewIssue({
          db: params.db,
          salonId,
          calendarConnectionId: conn.id,
          ev,
          appointmentId: result.appointmentId,
        });
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: string }).code || 'other')
            : 'other';
        const persistKind = await persistEligibleOverlay({
          db: params.db,
          salonId,
          calendarConnectionId: conn.id,
          ev,
          reasonCode: code,
          staffId: staff.id,
          staffName: staff.name,
          salonTimeZone,
          importedKeys,
          importedIndex,
          catalog,
          selectedCalendarId: ev.calendarId,
          clientId: null,
          reviewIndex,
          existing: Boolean(findOverlayRecord(ev, reviewIndex)),
        });
        finish(
          persistKind === 'failed'
            ? 'failed'
            : code === 'appointment_conflict' && persistKind !== 'excludedInvalidTime'
              ? 'conflictReview'
              : persistKind,
        );
        if (code === 'other' || !('code' in (err as object))) {
          console.error('[calendar/google-backfill] event import failed', {
            salonId,
            connectionId: conn.id,
            eventId: ev.id,
            code,
          });
        }
      } finally {
        if (!settled) finish('failed');
        emitProgress();
      }
    }
  };

  let truncated = Boolean(params.truncatedOverride);
  if (params.eventsOverride) {
    const events = selectGoogleEventsForBackfill(params.eventsOverride, window);
    knownTotal = events.length;
    params.onProgress?.({ processed: 0, total: knownTotal, pagesProcessed: 0 });
    await processEvents(events);
  } else {
    const config = loadGoogleCalendarAppConfig();
    let refreshToken: string;
    try {
      const plaintext = decryptCalendarCredential({
        ciphertext: conn.credential_ciphertext,
        iv: conn.credential_iv,
        authTag: conn.credential_auth_tag,
      });
      refreshToken = parseGoogleCredentialBlob(plaintext).refresh_token;
    } catch {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_OAUTH_DECRYPT_FAILED',
        'Google credentials unavailable',
      );
    }

    let accessToken: string;
    try {
      const refreshed = await refreshGoogleAccessToken({
        refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        fetchImpl: params.fetchImpl,
      });
      accessToken = refreshed.accessToken;
    } catch {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
        'Could not refresh Google token',
      );
    }

    const perCalendarCap = params.maxEvents ?? GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS;
    const perCalendarPages = params.maxPages ?? GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS;
    for (const calendar of selectedCalendars) {
      const listed = await listGoogleCalendarEventsForBackfill({
        accessToken,
        calendarId: calendar.id,
        calendarName: calendar.name,
        timeMin: window.timeMin,
        ...(window.timeMax ? { timeMax: window.timeMax } : {}),
        fetchImpl: params.fetchImpl,
        maxPages: perCalendarPages,
        maxEvents: perCalendarCap,
        onPage: async (page) => {
          pagesProcessed += 1;
          await params.onPage?.(page);
          const slice = selectGoogleEventsForBackfill(page.events, window);
          await processEvents(slice);
          emitProgress();
        },
      });
      if (listed.truncated) truncated = true;
    }
    knownTotal = summary.scanned;
    emitProgress();
  }

  summary.truncated = truncated;
  summary.inconsistent = !googleSyncAccountingConsistent({
    scanned: summary.scanned,
    terminals: summary.terminals,
  });
  if (summary.inconsistent) {
    console.error('[calendar/google-backfill] terminal accounting inconsistent', {
      salonId,
      scanned: summary.scanned,
      terminals: summary.terminals,
    });
  }
  return summary;
}
