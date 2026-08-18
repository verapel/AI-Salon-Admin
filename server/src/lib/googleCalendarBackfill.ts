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
  googleEventOccurrenceKeys,
  isImportedGoogleOccurrence,
  isPilotTatevStaffName,
  readAutoImportStaffIdFromConfig,
  resolvePilotGoogleAutoImportStaff,
  type GoogleAutoImportSkipReason,
} from './googleCalendarAutoImport.js';
import {
  executeManualGoogleCalendarImport,
  GoogleCalendarImportError,
  loadGoogleImportedOccurrenceKeys,
  type ManualGoogleImportResult,
} from './googleCalendarImport.js';
import {
  GOOGLE_CALENDAR_PROVIDER,
  GoogleCalendarOAuthError,
  listGoogleCalendarEventsPreview,
  loadGoogleCalendarAppConfig,
  refreshGoogleAccessToken,
  type GoogleEventPreviewItem,
  type GoogleFetch,
} from './googleCalendarOAuth.js';
import { decryptCalendarCredential } from './calendarCredentialsCrypto.js';
import { getSalonTimezone } from './scheduleSlots.js';
import {
  isGoogleEventEligibleForSalonCalendarDisplay,
  persistGoogleReviewOrResolve,
  resolveGoogleCalendarReviewIssue,
} from './googleCalendarReviewOverlay.js';
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
  reasons: GoogleBackfillReasonCounts;
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
    reasons: emptyGoogleBackfillReasons(),
  };
}

/** Event START window: [now - 30 days, +∞). No future timeMax. */
export function buildGoogleBackfillWindow(now: Date = new Date()): {
  timeMin: string;
  timeMax?: string;
} {
  return {
    timeMin: new Date(now.getTime() - GOOGLE_BACKFILL_LOOKBACK_MS).toISOString(),
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
  for (const key of googleEventOccurrenceKeys(ev)) {
    importedKeys.add(key);
  }
}

function applyBackfillOutcome(
  summary: GoogleBackfillResult,
  outcome: GoogleBackfillOutcome,
): void {
  if (outcome.kind === 'alreadyImported') {
    summary.alreadyImported += 1;
    summary.represented += 1;
    return;
  }
  summary.reasons[outcome.reason] += 1;
  if (outcome.kind === 'failed') {
    summary.failed += 1;
    return;
  }
  summary.skipped += 1;
  if (
    outcome.reason === 'cancelled' ||
    outcome.reason === 'allDay' ||
    outcome.reason === 'invalidTime'
  ) {
    summary.excluded += 1;
  }
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
}): Promise<string | null> {
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return null;
  const rememberedClientId = await loadRememberedGoogleCoverageClientId({
    db: params.db,
    salonId: params.salonId,
    calendarConnectionId: params.calendarConnectionId,
    ev: params.ev,
  });
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
  onProgress?: (progress: { processed: number; total: number }) => void;
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

  const calendarId = String(conn.selected_calendar_id || '').trim();
  if (!calendarId) {
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

  let importedKeys: Set<string>;
  try {
    importedKeys = await loadGoogleImportedOccurrenceKeys(params.db, {
      salonId,
      calendarConnectionId: conn.id,
    });
  } catch (err) {
    if (err instanceof GoogleCalendarImportError) throw err;
    throw new GoogleCalendarImportError('google_import_failed', 'Could not load import links');
  }

  let listedEvents: GoogleEventPreviewItem[];
  let truncated = Boolean(params.truncatedOverride);
  if (params.eventsOverride) {
    listedEvents = params.eventsOverride;
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

    const listed = await listGoogleCalendarEventsForBackfill({
      accessToken,
      calendarId,
      calendarName: conn.selected_calendar_name ?? null,
      timeMin: window.timeMin,
      ...(window.timeMax ? { timeMax: window.timeMax } : {}),
      fetchImpl: params.fetchImpl,
      maxPages: params.maxPages,
      maxEvents: params.maxEvents,
    });
    listedEvents = listed.events;
    truncated = listed.truncated;
  }

  summary.truncated = truncated;
  const events = selectGoogleEventsForBackfill(listedEvents, window);
  params.onProgress?.({ processed: 0, total: events.length });

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

  for (const ev of events) {
    summary.scanned += 1;
    try {
      if (isImportedGoogleOccurrence(ev, importedKeys)) {
        applyBackfillOutcome(summary, { kind: 'alreadyImported' });
        await resolveGoogleCalendarReviewIssue({
          db: params.db,
          salonId,
          calendarConnectionId: conn.id,
          ev,
        });
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

      const decision = decideGoogleAutoImport({
        parsed,
        matching,
        eventStatus: ev.status,
        summary: ev.summary,
        staffId: staff.id,
        alreadyImported: false,
        serviceNames,
      });

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
      });

      if (decision.action === 'skip') {
        applyBackfillOutcome(
          summary,
          classifyGoogleBackfillSkip({
            decisionReason: decision.reason,
            serviceStatus: matching.service.status,
          }),
        );
        const persistKind = await persistGoogleReviewOrResolve({
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
          clientId: coverageClientId,
        });
        if (persistKind === 'overlay') {
          summary.reviewEvents += 1;
          summary.represented += 1;
        }
        continue;
      }

      const result: ManualGoogleImportResult = await executeImport({
        db: params.db,
        salonId,
        salonTimeZone,
        fetchImpl: params.fetchImpl,
        body: {
          eventId: ev.id,
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
        applyBackfillOutcome(summary, { kind: 'alreadyImported' });
        await resolveGoogleCalendarReviewIssue({
          db: params.db,
          salonId,
          calendarConnectionId: conn.id,
          ev,
          appointmentId: result.appointmentId,
        });
      } else {
        rememberImportedOccurrence(ev, importedKeys);
        summary.imported += 1;
        summary.appointments += 1;
        summary.represented += 1;
        await resolveGoogleCalendarReviewIssue({
          db: params.db,
          salonId,
          calendarConnectionId: conn.id,
          ev,
          appointmentId: result.appointmentId,
        });
      }
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code || 'other')
          : 'other';
      applyBackfillOutcome(
        summary,
        classifyGoogleBackfillSkip({
          importErrorCode: code,
        }),
      );
      const persistKind = await persistGoogleReviewOrResolve({
        db: params.db,
        salonId,
        calendarConnectionId: conn.id,
        ev,
        reasonCode: code,
        staffId: staff.id,
        staffName: staff.name,
        salonTimeZone,
        importedKeys,
      });
      if (persistKind === 'overlay') {
        summary.reviewEvents += 1;
        summary.represented += 1;
      }
      if (code === 'other' || !('code' in (err as object))) {
        console.error('[calendar/google-backfill] event import failed', {
          salonId,
          connectionId: conn.id,
          eventId: ev.id,
          code,
        });
      }
    } finally {
      params.onProgress?.({ processed: summary.scanned, total: events.length });
    }
  }

  return summary;
}
