/**
 * GOOGLE-CAL-FAST-7B: Unresolved Google events as a calendar overlay.
 * Reuses calendar_import_issues (Apple foundation). Does not create fake
 * clients/services or weaken appointment constraints. No Google writes.
 */

import { parseExternalCalendarEvent, resolveParserTimezone } from './calendarEventParser.js';
import type { CalendarEventMatchingPreview } from './calendarEventMatcher.js';
import {
  buildGoogleOccurrenceKey,
  buildGoogleOccurrenceRecurrenceId,
  loadGoogleImportedOccurrenceKeys,
} from './googleCalendarImport.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';

function isImportedGoogleOccurrence(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  importedKeys: Set<string>,
): boolean {
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(ev);
  const full = buildGoogleOccurrenceKey({
    calendarId: ev.calendarId || '',
    eventId: ev.id,
    recurrenceId,
  });
  const keys = recurrenceId ? [full, ev.id, `${ev.id}:${recurrenceId}`] : [full, ev.id];
  return keys.some((k) => importedKeys.has(k));
}

export const GOOGLE_REVIEW_ISSUE_PROVIDER = 'google' as const;

const OVERLAY_SKIP_REASONS = new Set([
  'no_exact_phone',
  'unsafe_client_name',
  'client_ambiguous',
  'service_not_matched',
  'service_inactive_or_invalid',
  'appointment_conflict',
  'overnight',
  'invalid_time',
  'import_bound',
  'client_review_required',
  'service_review_required',
  'service_invalid',
  'google_event_not_importable',
]);

const HIDDEN_SKIP_REASONS = new Set([
  'cancelled',
  'google_event_cancelled',
  'all_day',
  'already_imported',
  'google_event_already_imported',
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
};

export function isGoogleEventCancelledOrDeleted(
  ev: Pick<GoogleEventPreviewItem, 'status'>,
): boolean {
  const status = (ev.status || '').toLowerCase();
  return status === 'cancelled' || status === 'deleted';
}

export function isGoogleEventAllDay(ev: Pick<GoogleEventPreviewItem, 'start' | 'end'>): boolean {
  return Boolean(
    ev.start?.allDay ||
      ev.end?.allDay ||
      (ev.start?.date && !ev.start?.dateTime) ||
      (ev.end?.date && !ev.end?.dateTime),
  );
}

/**
 * Timed, non-cancelled Google events can appear on the salon calendar.
 * All-day and cancelled/deleted events are not shown as active blocks.
 */
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
  if (!reason) return false;
  if (HIDDEN_SKIP_REASONS.has(reason)) return false;
  return OVERLAY_SKIP_REASONS.has(reason) || reason === 'other';
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
  const tz = resolveParserTimezone(salonTimeZone);
  const parsed = parseExternalCalendarEvent(
    {
      summary: ev.summary ?? null,
      description: ev.description ?? null,
      status: ev.status ?? null,
      start: ev.start,
      end: ev.end,
    },
    tz,
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
  const start = formatClockInTimeZone(ev.start.dateTime || '', tz);
  const end = formatClockInTimeZone(ev.end.dateTime || '', tz);
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
  };
}

export function representedInSalonCalendar(params: {
  ev: GoogleEventPreviewItem;
  importedKeys: Set<string>;
  overlayEventIds: Set<string>;
}): boolean {
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return false;
  if (isImportedGoogleOccurrence(params.ev, params.importedKeys)) return true;
  const rec = buildGoogleOccurrenceRecurrenceId(params.ev);
  const keys = rec ? [params.ev.id, `${params.ev.id}:${rec}`] : [params.ev.id];
  return keys.some((k) => params.overlayEventIds.has(k));
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
}): Promise<boolean> {
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return false;
  if (!googleSkipReasonNeedsCalendarOverlay(params.reasonCode) && params.reasonCode !== 'other') {
    return false;
  }
  const snapshot = buildGoogleReviewSnapshot({
    ev: params.ev,
    salonTimeZone: params.salonTimeZone,
    staffId: params.staffId,
    staffName: params.staffName,
    matching: params.matching,
  });
  if (!snapshot) return false;

  const recurrenceId = buildGoogleOccurrenceRecurrenceId(params.ev);
  const nowIso = new Date().toISOString();
  const payload = {
    salon_id: params.salonId,
    calendar_connection_id: params.calendarConnectionId,
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
    },
    parsed_event: snapshot,
    reason_code: params.reasonCode,
    reason_message: params.reasonMessage ?? null,
    status: 'open',
    updated_at: nowIso,
  };

  try {
    const existing = await params.db
      .from('calendar_import_issues')
      .select('id')
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId)
      .eq('external_uid', params.ev.id)
      .eq('recurrence_id', recurrenceId)
      .eq('status', 'open')
      .maybeSingle();

    if (existing?.data?.id) {
      const { error } = await params.db
        .from('calendar_import_issues')
        .update(payload)
        .eq('id', existing.data.id)
        .eq('salon_id', params.salonId);
      return !error;
    }

    const { error } = await params.db.from('calendar_import_issues').insert({
      ...payload,
      created_at: nowIso,
    });
    if (!error) return true;
    const { error: updErr } = await params.db
      .from('calendar_import_issues')
      .update(payload)
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId)
      .eq('external_uid', params.ev.id)
      .eq('recurrence_id', recurrenceId)
      .eq('status', 'open');
    return !updErr;
  } catch {
    return false;
  }
}

export async function resolveGoogleCalendarReviewIssue(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: Pick<GoogleEventPreviewItem, 'id' | 'recurringEventId' | 'originalStartTime'>;
  appointmentId?: string | null;
}): Promise<void> {
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(params.ev);
  const nowIso = new Date().toISOString();
  try {
    await params.db
      .from('calendar_import_issues')
      .update({
        status: 'resolved',
        resolved_appointment_id: params.appointmentId ?? null,
        resolved_at: nowIso,
        updated_at: nowIso,
      })
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId)
      .eq('external_uid', params.ev.id)
      .eq('recurrence_id', recurrenceId)
      .eq('status', 'open');
  } catch {
    // Overlay resolve is best-effort; RPC uniqueness remains authoritative.
  }
}

export async function listGoogleReviewCalendarItems(params: {
  db: any;
  salonId: string;
  calendarConnectionId?: string | null;
}): Promise<GoogleReviewCalendarItem[]> {
  let query = params.db
    .from('calendar_import_issues')
    .select('id, external_uid, recurrence_id, reason_code, parsed_event, calendar_connection_id')
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
    let importedKeys = new Set<string>();
    try {
      importedKeys = await loadGoogleImportedOccurrenceKeys(params.db, {
        salonId: params.salonId,
        calendarConnectionId: connId,
      });
    } catch {
      importedKeys = new Set();
    }
    for (const row of rows) {
      const mapped = mapGoogleReviewIssueToCalendarItem(row);
      if (!mapped) continue;
      const synthetic = {
        id: mapped.eventId,
        calendarId: '',
        recurringEventId: mapped.recurrenceId || null,
        originalStartTime: mapped.recurrenceId
          ? { dateTime: mapped.recurrenceId, date: null, timeZone: null, allDay: false }
          : null,
      };
      if (
        isImportedGoogleOccurrence(
          synthetic as GoogleEventPreviewItem,
          importedKeys,
        ) ||
        importedKeys.has(mapped.eventId) ||
        (mapped.recurrenceId && importedKeys.has(`${mapped.eventId}:${mapped.recurrenceId}`))
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
}): Promise<'overlay' | 'resolved' | 'hidden'> {
  if (isImportedGoogleOccurrence(params.ev, params.importedKeys)) {
    await resolveGoogleCalendarReviewIssue({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
      ev: params.ev,
    });
    return 'resolved';
  }
  if (!isGoogleEventEligibleForSalonCalendarDisplay(params.ev)) return 'hidden';
  if (!googleSkipReasonNeedsCalendarOverlay(params.reasonCode)) return 'hidden';
  const ok = await upsertGoogleCalendarReviewIssue(params);
  return ok ? 'overlay' : 'hidden';
}
