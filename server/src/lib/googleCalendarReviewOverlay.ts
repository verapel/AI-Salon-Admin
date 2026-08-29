/**
 * GOOGLE-CAL-FAST-7B: Unresolved Google events as a calendar overlay.
 * Reuses calendar_import_issues (Apple foundation). Does not create fake
 * clients/services or weaken appointment constraints. No Google writes.
 */

import {
  parseExternalCalendarEvent,
  resolveGoogleEventDisplayTimezone,
  resolveParserTimezone,
} from './calendarEventParser.js';
import type { CalendarEventMatchingPreview } from './calendarEventMatcher.js';
import {
  buildGoogleOccurrenceRecurrenceId,
  googleOccurrenceLookupKeys,
  googleRememberedOccurrenceKeys,
  googleStoredOccurrenceKeys,
} from './googleCalendarImport.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';

function isImportedGoogleOccurrence(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  importedKeys: Set<string>,
): boolean {
  return googleOccurrenceLookupKeys(ev).some((k) => importedKeys.has(k));
}

function googleLegacyOverlayMatchesImported(
  eventId: string,
  recurrenceId: string,
  importedKeys: Set<string>,
): boolean {
  const uid = eventId.trim();
  if (!uid) return false;
  const rec = recurrenceId.trim();
  if (importedKeys.has(rec ? `${uid}:${rec}` : uid)) return true;
  for (const key of importedKeys) {
    if (rec) {
      if (key.endsWith(`:${uid}:${rec}`)) return true;
    } else if (key.endsWith(`:${uid}`) && key.split(':').length === 2) {
      return true;
    }
  }
  return false;
}

export const GOOGLE_REVIEW_ISSUE_PROVIDER = 'google' as const;

/** Only non-displayable / already-handled identities may skip overlay. */
const EXCLUDED_SKIP_REASONS = new Set([
  'cancelled',
  'google_event_cancelled',
  'all_day',
  'already_imported',
  'google_event_already_imported',
  'invalid_time',
  'overnight',
]);

const WATERMARK_SKIP_REASONS = new Set([
  'before_auto_import',
  'created_unknown',
  'import_disabled',
]);

export type GoogleReviewCalendarItem = {
  id: string;
  kind: 'google_review';
  source: 'google';
  reviewStatus: 'needs_review';
  eventId: string;
  recurrenceId: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number | null;
  staffId: string;
  staffName: string;
  reasonCode: string;
  clientCandidate: string | null;
  phoneCandidate: string | null;
  serviceCandidate: string | null;
  clientId: string | null;
};

export type GoogleReviewParsedSnapshot = {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number | null;
  staffId: string;
  staffName: string;
  clientCandidate: string | null;
  phoneCandidate: string | null;
  serviceCandidate: string | null;
  clientId: string | null;
};

export function isGoogleEventCancelledOrDeleted(
  ev: Pick<GoogleEventPreviewItem, 'status'>,
): boolean {
  const status = (ev.status || '').toLowerCase();
  return status === 'cancelled' || status === 'deleted';
}

export function usableGoogleDateTime(value: string | null | undefined): boolean {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return false;
  return Number.isFinite(Date.parse(raw));
}

/**
 * All-day only when there is no usable start+end dateTime pair.
 * A leftover `date` or `allDay` flag must not hide a timed Google event.
 */
export function isGoogleEventAllDay(ev: Pick<GoogleEventPreviewItem, 'start' | 'end'>): boolean {
  const startDt = usableGoogleDateTime(ev.start?.dateTime);
  const endDt = usableGoogleDateTime(ev.end?.dateTime);
  if (startDt && endDt) return false;
  const startDateOnly = Boolean(ev.start?.date?.trim()) && !startDt;
  const endDateOnly = Boolean(ev.end?.date?.trim()) && !endDt;
  const flagged =
    Boolean(ev.start?.allDay || ev.end?.allDay) && !startDt && !endDt;
  return startDateOnly || endDateOnly || flagged;
}

/**
 * Timed, non-cancelled Google events can appear on the salon calendar.
 * All-day and cancelled/deleted events are not shown as active blocks.
 */
function googleIssueRowCalendarId(row: {
  external_calendar_id?: string | null;
  raw_event?: unknown;
}): string {
  if (typeof row.external_calendar_id === 'string' && row.external_calendar_id.trim()) {
    return row.external_calendar_id.trim();
  }
  const raw = row.raw_event;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const calendarId = (raw as Record<string, unknown>).calendarId;
    if (typeof calendarId === 'string' && calendarId.trim()) return calendarId.trim();
  }
  return '';
}

export function pickGoogleIssueRow<T extends { external_calendar_id?: string | null; raw_event?: unknown }>(
  rows: T[],
  calendarId?: string | null,
): T | null {
  if (!rows.length) return null;
  const cal = (calendarId || '').trim();
  if (!cal) return rows[0] ?? null;
  const scoped = rows.find((row) => googleIssueRowCalendarId(row) === cal);
  if (scoped) return scoped;
  return rows.find((row) => !googleIssueRowCalendarId(row)) ?? null;
}

async function loadOpenGoogleIssueRows(
  db: any,
  params: {
    salonId: string;
    calendarConnectionId: string;
    ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>;
  },
): Promise<any[]> {
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(params.ev);
  const listed = await db
    .from('calendar_import_issues')
    .select('id, external_calendar_id, raw_event')
    .eq('salon_id', params.salonId)
    .eq('calendar_connection_id', params.calendarConnectionId)
    .eq('external_uid', params.ev.id)
    .eq('recurrence_id', recurrenceId)
    .eq('status', 'open');
  return Array.isArray(listed?.data) ? listed.data : [];
}

export function googleReviewOccurrenceLookupKeys(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'recurringEventId' | 'originalStartTime'> & {
    calendarId?: string | null;
  },
): string[] {
  return googleOccurrenceLookupKeys(ev);
}

export type GoogleReviewOverlayRecord = {
  issueId: string;
  etag: string | null;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  staffId: string;
  staffName: string;
  reasonCode: string;
  clientId: string | null;
};

export type GoogleReviewCoverageIndex = {
  overlayKeys: Set<string>;
  clientByKey: Map<string, string>;
  overlayByKey: Map<string, GoogleReviewOverlayRecord>;
};

export async function loadGoogleReviewCoverageIndex(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
}): Promise<GoogleReviewCoverageIndex> {
  const overlayKeys = new Set<string>();
  const clientByKey = new Map<string, string>();
  const overlayByKey = new Map<string, GoogleReviewOverlayRecord>();
  try {
    const { data, error } = await params.db
      .from('calendar_import_issues')
      .select(
        'id, external_uid, recurrence_id, parsed_event, raw_event, status, external_etag, reason_code, external_calendar_id',
      )
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId);
    if (error || !Array.isArray(data)) return { overlayKeys, clientByKey, overlayByKey };
    for (const row of data) {
      if (row?.status && row.status !== 'open') continue;
      const uid = typeof row?.external_uid === 'string' ? row.external_uid : '';
      if (!uid) continue;
      const rec =
        typeof row?.recurrence_id === 'string' && row.recurrence_id.trim()
          ? row.recurrence_id.trim()
          : '';
      const cal = googleIssueRowCalendarId(row);
      const keys = googleStoredOccurrenceKeys({
        calendarId: cal,
        eventId: uid,
        recurrenceId: rec,
      });
      for (const key of keys) overlayKeys.add(key);
      const parsed = row?.parsed_event;
      const raw = row?.raw_event;
      const snapshot = readSnapshot(parsed);
      const clientId =
        snapshot?.clientId ||
        (raw && typeof raw === 'object' && typeof raw.clientId === 'string' ? raw.clientId : '');
      if (clientId) {
        for (const key of keys) clientByKey.set(key, clientId);
      }
      const record: GoogleReviewOverlayRecord = {
        issueId: typeof row?.id === 'string' ? row.id : '',
        etag: typeof row?.external_etag === 'string' ? row.external_etag : null,
        title: snapshot?.title || '',
        date: snapshot?.date || '',
        startTime: snapshot?.startTime || '',
        endTime: snapshot?.endTime || '',
        staffId: snapshot?.staffId || '',
        staffName: snapshot?.staffName || '',
        reasonCode: typeof row?.reason_code === 'string' ? row.reason_code : 'other',
        clientId: clientId || null,
      };
      for (const key of keys) overlayByKey.set(key, record);
    }
  } catch {
    return { overlayKeys, clientByKey, overlayByKey };
  }
  return { overlayKeys, clientByKey, overlayByKey };
}

export function findRememberedCoverageClientId(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  clientByKey: Map<string, string>,
): string | null {
  for (const key of googleReviewOccurrenceLookupKeys(ev)) {
    const id = clientByKey.get(key);
    if (id) return id;
  }
  return null;
}

export function isGoogleReviewOverlayRepresented(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  overlayKeys: Set<string>,
): boolean {
  return googleReviewOccurrenceLookupKeys(ev).some((key) => overlayKeys.has(key));
}

export function rememberGoogleReviewCoverage(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  index: GoogleReviewCoverageIndex,
  clientId?: string | null,
  record?: GoogleReviewOverlayRecord | null,
): void {
  for (const key of googleRememberedOccurrenceKeys(ev)) {
    index.overlayKeys.add(key);
    if (clientId) index.clientByKey.set(key, clientId);
    if (record) index.overlayByKey.set(key, record);
  }
}

export async function dismissGoogleReviewOverlay(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>;
}): Promise<boolean> {
  const nowIso = new Date().toISOString();
  try {
    const existing = pickGoogleIssueRow(await loadOpenGoogleIssueRows(params.db, params), params.ev.calendarId);
    if (!existing?.id) return true;
    const { error } = await params.db
      .from('calendar_import_issues')
      .update({
        status: 'dismissed',
        updated_at: nowIso,
      })
      .eq('id', existing.id)
      .eq('salon_id', params.salonId);
    return !error;
  } catch {
    return false;
  }
}

export function isGoogleEventEligibleForSalonCalendarDisplay(
  ev: Pick<GoogleEventPreviewItem, 'status' | 'start' | 'end'>,
): boolean {
  if (isGoogleEventCancelledOrDeleted(ev)) return false;
  if (isGoogleEventAllDay(ev)) return false;
  const start = ev.start?.dateTime?.trim();
  const end = ev.end?.dateTime?.trim();
  if (!start || !end) return false;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

export function googleSkipReasonNeedsCalendarOverlay(reason: string | null | undefined): boolean {
  if (!reason) return true;
  if (EXCLUDED_SKIP_REASONS.has(reason)) return false;
  if (WATERMARK_SKIP_REASONS.has(reason)) return false;
  return true;
}

export function googleReviewOverlayRecordIsVisible(
  record: Pick<GoogleReviewOverlayRecord, 'date' | 'startTime' | 'endTime' | 'staffId'> | null | undefined,
): boolean {
  if (!record) return false;
  return Boolean(
    record.date?.trim() &&
      record.startTime?.trim() &&
      record.endTime?.trim() &&
      record.staffId?.trim(),
  );
}

export function formatClockInTimeZone(iso: string, timeZone: string): {
  date: string;
  time: string;
} | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const tz = resolveParserTimezone(timeZone);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const time = `${get('hour')}:${get('minute')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
    return { date, time };
  } catch {
    return null;
  }
}

export function googleEventCalendarTimes(
  ev: Pick<GoogleEventPreviewItem, 'status' | 'start' | 'end' | 'summary' | 'description'>,
  salonTimeZone: string,
): { date: string; startTime: string; endTime: string; durationMinutes: number } | null {
  if (!isGoogleEventEligibleForSalonCalendarDisplay(ev)) return null;
  const displayTz = resolveGoogleEventDisplayTimezone(
    ev.start?.timeZone || ev.end?.timeZone,
    salonTimeZone,
  );
  const parsed = parseExternalCalendarEvent(
    {
      summary: ev.summary ?? null,
      description: ev.description ?? null,
      status: ev.status ?? null,
      start: ev.start,
      end: ev.end,
    },
    displayTz,
  );
  if (parsed.localDate && parsed.localStartTime && parsed.localEndTime) {
    const duration =
      parsed.durationMinutes && parsed.durationMinutes > 0
        ? parsed.durationMinutes
        : durationFromClocks(parsed.localStartTime, parsed.localEndTime);
    return {
      date: parsed.localDate,
      startTime: parsed.localStartTime.slice(0, 5),
      endTime: parsed.localEndTime.slice(0, 5),
      durationMinutes: duration,
    };
  }
  const start = formatClockInTimeZone(ev.start.dateTime || '', displayTz);
  const end = formatClockInTimeZone(ev.end.dateTime || '', displayTz);
  if (!start || !end) return null;
  const startMs = Date.parse(ev.start.dateTime || '');
  const endMs = Date.parse(ev.end.dateTime || '');
  const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
  return {
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    durationMinutes,
  };
}

function durationFromClocks(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, (eh ?? 0) * 60 + (em ?? 0) - ((sh ?? 0) * 60 + (sm ?? 0)));
}

export function buildGoogleReviewSnapshot(params: {
  ev: GoogleEventPreviewItem;
  salonTimeZone: string;
  staffId: string;
  staffName: string;
  matching?: CalendarEventMatchingPreview;
  clientId?: string | null;
}): GoogleReviewParsedSnapshot | null {
  const times = googleEventCalendarTimes(params.ev, params.salonTimeZone);
  if (!times) return null;
  const parsed = parseExternalCalendarEvent(
    {
      summary: params.ev.summary,
      description: params.ev.description,
      status: params.ev.status,
      start: params.ev.start,
      end: params.ev.end,
    },
    resolveParserTimezone(params.salonTimeZone),
  );
  return {
    title: (params.ev.summary || '').trim() || 'Google',
    date: times.date,
    startTime: times.startTime,
    endTime: times.endTime,
    durationMinutes: times.durationMinutes,
    staffId: params.staffId,
    staffName: params.staffName,
    clientCandidate: parsed.clientNameCandidate,
    phoneCandidate: parsed.phone.normalized || parsed.phone.value,
    serviceCandidate:
      params.matching?.service.displayName || parsed.serviceCandidate,
    clientId: params.clientId ?? null,
  };
}

export function mapGoogleReviewIssueToCalendarItem(row: {
  id: string;
  external_uid: string;
  recurrence_id?: string | null;
  reason_code: string;
  parsed_event?: unknown;
}): GoogleReviewCalendarItem | null {
  const parsed = readSnapshot(row.parsed_event);
  if (!parsed?.date || !parsed.startTime || !parsed.endTime || !parsed.staffId) {
    return null;
  }
  return {
    id: `google-review:${row.id}`,
    kind: 'google_review',
    source: 'google',
    reviewStatus: 'needs_review',
    eventId: row.external_uid,
    recurrenceId: typeof row.recurrence_id === 'string' ? row.recurrence_id : '',
    title: parsed.title || 'Google',
    date: parsed.date,
    startTime: parsed.startTime.slice(0, 5),
    endTime: parsed.endTime.slice(0, 5),
    durationMinutes: parsed.durationMinutes,
    staffId: parsed.staffId,
    staffName: parsed.staffName || 'Tatev',
    reasonCode: row.reason_code,
    clientCandidate: parsed.clientCandidate,
    phoneCandidate: parsed.phoneCandidate,
    serviceCandidate: parsed.serviceCandidate,
    clientId: parsed.clientId,
  };
}

function readSnapshot(raw: unknown): GoogleReviewParsedSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const date = typeof o.date === 'string' ? o.date : '';
  const startTime = typeof o.startTime === 'string' ? o.startTime : '';
  const endTime = typeof o.endTime === 'string' ? o.endTime : '';
  const staffId = typeof o.staffId === 'string' ? o.staffId : '';
  if (!date || !startTime || !endTime || !staffId) return null;
  return {
    title: typeof o.title === 'string' ? o.title : 'Google',
    date,
    startTime,
    endTime,
    durationMinutes: typeof o.durationMinutes === 'number' ? o.durationMinutes : null,
    staffId,
    staffName: typeof o.staffName === 'string' ? o.staffName : '',
    clientCandidate: typeof o.clientCandidate === 'string' ? o.clientCandidate : null,
    phoneCandidate: typeof o.phoneCandidate === 'string' ? o.phoneCandidate : null,
    serviceCandidate: typeof o.serviceCandidate === 'string' ? o.serviceCandidate : null,
    clientId: typeof o.clientId === 'string' ? o.clientId : null,
  };
}

export function representedInSalonCalendar(params: {
  ev: GoogleEventPreviewItem;
  importedKeys: Set<string>;
  overlayEventIds: Set<string>;
}): boolean {
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return false;
  if (isImportedGoogleOccurrence(params.ev, params.importedKeys)) return true;
  return googleOccurrenceLookupKeys(params.ev).some((k) => params.overlayEventIds.has(k));
}

export async function upsertGoogleCalendarReviewIssue(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  reasonCode: string;
  reasonMessage?: string | null;
  staffId: string;
  staffName: string;
  salonTimeZone: string;
  matching?: CalendarEventMatchingPreview;
  clientId?: string | null;
}): Promise<boolean> {
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return false;
  const snapshot = buildGoogleReviewSnapshot({
    ev: params.ev,
    salonTimeZone: params.salonTimeZone,
    staffId: params.staffId,
    staffName: params.staffName,
    matching: params.matching,
    clientId: params.clientId,
  });
  if (!snapshot) return false;

  const recurrenceId = buildGoogleOccurrenceRecurrenceId(params.ev);
  const nowIso = new Date().toISOString();
  const payload = {
    salon_id: params.salonId,
    calendar_connection_id: params.calendarConnectionId,
    external_calendar_id: (params.ev.calendarId || '').trim() || null,
    external_uid: params.ev.id,
    recurrence_id: recurrenceId,
    external_etag: params.ev.etag,
    raw_event: {
      id: params.ev.id,
      summary: params.ev.summary,
      status: params.ev.status,
      start: params.ev.start,
      end: params.ev.end,
      calendarId: params.ev.calendarId,
      clientId: snapshot.clientId,
    },
    parsed_event: snapshot,
    reason_code: params.reasonCode,
    reason_message: params.reasonMessage ?? null,
    status: 'open',
    updated_at: nowIso,
  };

  try {
    const existing = pickGoogleIssueRow(await loadOpenGoogleIssueRows(params.db, params), params.ev.calendarId);

    if (existing?.id) {
      const { error } = await params.db
        .from('calendar_import_issues')
        .update(payload)
        .eq('id', existing.id)
        .eq('salon_id', params.salonId);
      return !error;
    }

    const { error } = await params.db.from('calendar_import_issues').insert({
      ...payload,
      created_at: nowIso,
    });
    if (!error) return true;
    const cal = (params.ev.calendarId || '').trim();
    const raced = pickGoogleIssueRow(
      await loadOpenGoogleIssueRows(params.db, params),
      params.ev.calendarId,
    );
    if (raced?.id) {
      let byId = params.db
        .from('calendar_import_issues')
        .update(payload)
        .eq('id', raced.id)
        .eq('salon_id', params.salonId);
      if (cal) byId = byId.eq('external_calendar_id', cal);
      else {
        byId = byId.or('external_calendar_id.is.null,external_calendar_id.eq.');
      }
      const { error: byIdErr } = await byId;
      return !byIdErr;
    }
    let upd = params.db
      .from('calendar_import_issues')
      .update(payload)
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId)
      .eq('external_uid', params.ev.id)
      .eq('recurrence_id', recurrenceId)
      .eq('status', 'open');
    if (cal) upd = upd.eq('external_calendar_id', cal);
    else upd = upd.or('external_calendar_id.is.null,external_calendar_id.eq.');
    const { error: updErr } = await upd;
    return !updErr;
  } catch {
    return false;
  }
}

export async function resolveGoogleCalendarReviewIssue(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>;
  appointmentId?: string | null;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    const existing = pickGoogleIssueRow(await loadOpenGoogleIssueRows(params.db, params), params.ev.calendarId);
    if (!existing?.id) return;
    await params.db
      .from('calendar_import_issues')
      .update({
        status: 'resolved',
        resolved_appointment_id: params.appointmentId ?? null,
        resolved_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', existing.id)
      .eq('salon_id', params.salonId);
  } catch {
    // Overlay resolve is best-effort; RPC uniqueness remains authoritative.
  }
}

async function loadVisibleImportedOccurrenceKeys(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
}): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const { data, error } = await params.db
      .from('appointment_external_links')
      .select('appointment_id, external_uid, recurrence_id, external_calendar_id')
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId)
      .eq('provider', 'google');
    if (error || !Array.isArray(data) || data.length === 0) return keys;
    const appointmentIds = [
      ...new Set(
        data
          .map((row: { appointment_id?: string }) =>
            typeof row.appointment_id === 'string' ? row.appointment_id : '',
          )
          .filter(Boolean),
      ),
    ];
    if (appointmentIds.length === 0) return keys;
    const loaded = await params.db
      .from('appointments')
      .select('id, date, start_time, end_time, status')
      .eq('salon_id', params.salonId);
    const rows = Array.isArray(loaded?.data) ? loaded.data : [];
    const visibleIds = new Set(
      rows
        .filter((row: { id?: string; date?: string; start_time?: string; end_time?: string; status?: string }) => {
          const status = String(row.status || 'scheduled').toLowerCase();
          return (
            Boolean(row.id && row.date && row.start_time && row.end_time) &&
            status !== 'cancelled' &&
            status !== 'deleted'
          );
        })
        .map((row: { id: string }) => row.id),
    );
    for (const row of data) {
      const appointmentId = typeof row.appointment_id === 'string' ? row.appointment_id : '';
      if (!appointmentId || !visibleIds.has(appointmentId)) continue;
      const uid = typeof row.external_uid === 'string' ? row.external_uid : '';
      if (!uid) continue;
      const rec =
        typeof row.recurrence_id === 'string' && row.recurrence_id.trim()
          ? row.recurrence_id.trim()
          : '';
      const cal =
        typeof row.external_calendar_id === 'string' ? row.external_calendar_id.trim() : '';
      for (const key of googleStoredOccurrenceKeys({
        calendarId: cal,
        eventId: uid,
        recurrenceId: rec,
      })) {
        keys.add(key);
      }
    }
  } catch {
    return keys;
  }
  return keys;
}

export async function listGoogleReviewCalendarItems(params: {
  db: any;
  salonId: string;
  calendarConnectionId?: string | null;
}): Promise<GoogleReviewCalendarItem[]> {
  let query = params.db
    .from('calendar_import_issues')
    .select('id, external_uid, recurrence_id, reason_code, parsed_event, calendar_connection_id, external_calendar_id, raw_event')
    .eq('salon_id', params.salonId)
    .eq('status', 'open');
  if (params.calendarConnectionId) {
    query = query.eq('calendar_connection_id', params.calendarConnectionId);
  }
  const { data, error } = await query;
  if (error || !Array.isArray(data)) return [];

  const byConnection = new Map<string, any[]>();
  for (const row of data) {
    const connId = typeof row.calendar_connection_id === 'string' ? row.calendar_connection_id : '';
    if (!connId) continue;
    const list = byConnection.get(connId) ?? [];
    list.push(row);
    byConnection.set(connId, list);
  }

  const items: GoogleReviewCalendarItem[] = [];
  for (const [connId, rows] of byConnection) {
    const visibleImportedKeys = await loadVisibleImportedOccurrenceKeys({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: connId,
    });
    for (const row of rows) {
      const mapped = mapGoogleReviewIssueToCalendarItem(row);
      if (!mapped) continue;
      const synthetic = {
        id: mapped.eventId,
        calendarId: googleIssueRowCalendarId(row),
        recurringEventId: mapped.recurrenceId || null,
        originalStartTime: mapped.recurrenceId
          ? { dateTime: mapped.recurrenceId, date: null, timeZone: null, allDay: false }
          : null,
      };
      if (
        isImportedGoogleOccurrence(synthetic as GoogleEventPreviewItem, visibleImportedKeys) ||
        (!synthetic.calendarId &&
          googleLegacyOverlayMatchesImported(
            mapped.eventId,
            mapped.recurrenceId,
            visibleImportedKeys,
          ))
      ) {
        continue;
      }
      items.push(mapped);
    }
  }
  return items;
}

export async function persistGoogleReviewOrResolve(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  reasonCode: string;
  staffId: string;
  staffName: string;
  salonTimeZone: string;
  matching?: CalendarEventMatchingPreview;
  importedKeys: Set<string>;
  clientId?: string | null;
  /** Stale/conflict paths still need an open overlay even if a link key exists. */
  ignoreImportedLink?: boolean;
}): Promise<'overlay' | 'resolved' | 'excluded' | 'failed'> {
  if (!params.ignoreImportedLink && isImportedGoogleOccurrence(params.ev, params.importedKeys)) {
    await resolveGoogleCalendarReviewIssue({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
      ev: params.ev,
    });
    return 'resolved';
  }
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return 'excluded';
  const skipNeedsOverlay = googleSkipReasonNeedsCalendarOverlay(params.reasonCode);
  const timedPair =
    usableGoogleDateTime(params.ev.start?.dateTime) &&
    usableGoogleDateTime(params.ev.end?.dateTime);
  const falseAllDaySkip =
    (params.reasonCode === 'all_day' || params.reasonCode === 'google_event_all_day') &&
    timedPair &&
    !isGoogleEventAllDay(params.ev);
  if (!skipNeedsOverlay && !falseAllDaySkip) return 'excluded';
  const snapshot = buildGoogleReviewSnapshot({
    ev: params.ev,
    salonTimeZone: params.salonTimeZone,
    staffId: params.staffId,
    staffName: params.staffName,
    matching: params.matching,
    clientId: params.clientId,
  });
  if (!snapshot) return 'excluded';
  const ok = await upsertGoogleCalendarReviewIssue(params);
  if (!ok) {
    console.error('[calendar/google-overlay] upsert failed for eligible timed event', {
      salonId: params.salonId,
      eventId: params.ev.id,
      reasonCode: params.reasonCode,
    });
    return 'failed';
  }
  return 'overlay';
}
