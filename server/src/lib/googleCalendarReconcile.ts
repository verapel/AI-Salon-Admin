/**
 * GOOGLE-CAL-SYNC-FIX-2: Compare Google occurrences with existing AI rows
 * and update the SAME overlay/appointment. No Google writes. No migration.
 */

import { syncAppointmentReminder } from './appointmentReminders.js';
import {
  buildGoogleOccurrenceKey,
  buildGoogleOccurrenceRecurrenceId,
  googleImportedAppointmentNotes,
  googleOccurrenceLookupKeys,
  googleStoredOccurrenceKeys,
  loadGoogleImportedOccurrenceKeys,
} from './googleCalendarImport.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';
import {
  buildGoogleReviewSnapshot,
  dismissGoogleReviewOverlay,
  findRememberedCoverageClientId,
  googleEventCalendarTimes,
  isGoogleEventCancelledOrDeleted,
  isGoogleReviewOverlayRepresented,
  googleReviewOverlayRecordIsVisible,
  type GoogleReviewCoverageIndex,
  type GoogleReviewOverlayRecord,
  upsertGoogleCalendarReviewIssue,
} from './googleCalendarReviewOverlay.js';
import type { CalendarEventMatchingPreview } from './calendarEventMatcher.js';

export type GoogleImportedOccurrenceRecord = {
  appointmentId: string;
  etag: string | null;
  lastModified: string | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  staffId: string | null;
  clientId: string | null;
  status: string | null;
  notes: string | null;
};

export type GoogleImportedOccurrenceIndex = {
  keys: Set<string>;
  byKey: Map<string, GoogleImportedOccurrenceRecord>;
};

export type GoogleAppointmentReconcileResult =
  | { kind: 'unchanged' }
  | { kind: 'updated' }
  | { kind: 'conflict' }
  | { kind: 'cancelled_preserved' }
  | { kind: 'missing' };

const ACTIVE_STATUSES = new Set(['scheduled', 'confirmed']);

function occurrenceKeys(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
): string[] {
  return googleOccurrenceLookupKeys(ev);
}

function isImportedGoogleOccurrence(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  importedKeys: Set<string>,
): boolean {
  return occurrenceKeys(ev).some((k) => importedKeys.has(k));
}

function clock5(value: string | null | undefined): string {
  return (value || '').trim().slice(0, 5);
}

function date10(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 10);
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return '';
}

function minutesFromClock(value: string): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(clock5(value));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function normalizeImportedOccurrenceIndex(
  links: Array<Record<string, unknown>>,
  appointments: Array<Record<string, unknown>>,
): GoogleImportedOccurrenceIndex {
  const apptById = new Map<string, Record<string, unknown>>();
  for (const row of appointments) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (id) apptById.set(id, row);
  }
  const keys = new Set<string>();
  const byKey = new Map<string, GoogleImportedOccurrenceRecord>();
  for (const row of links) {
    const uid = typeof row.external_uid === 'string' ? row.external_uid : '';
    if (!uid) continue;
    const rec =
      typeof row.recurrence_id === 'string' && row.recurrence_id.trim()
        ? row.recurrence_id.trim()
        : '';
    const cal =
      typeof row.external_calendar_id === 'string' ? row.external_calendar_id.trim() : '';
    const appointmentId = typeof row.appointment_id === 'string' ? row.appointment_id : '';
    const appt = appointmentId ? apptById.get(appointmentId) : undefined;
    const record: GoogleImportedOccurrenceRecord = {
      appointmentId,
      etag: typeof row.external_etag === 'string' ? row.external_etag : null,
      lastModified:
        typeof row.external_last_modified === 'string' ? row.external_last_modified : null,
      date: date10(appt?.date) || null,
      startTime: clock5(typeof appt?.start_time === 'string' ? appt.start_time : '') || null,
      endTime: clock5(typeof appt?.end_time === 'string' ? appt.end_time : '') || null,
      staffId: typeof appt?.staff_id === 'string' ? appt.staff_id : null,
      clientId: typeof appt?.client_id === 'string' ? appt.client_id : null,
      status: typeof appt?.status === 'string' ? appt.status : null,
      notes: typeof appt?.notes === 'string' ? appt.notes : null,
    };
    const variants = googleStoredOccurrenceKeys({
      calendarId: cal,
      eventId: uid,
      recurrenceId: rec,
    });
    for (const key of variants) {
      keys.add(key);
      byKey.set(key, record);
    }
  }
  return { keys, byKey };
}

export function findImportedOccurrenceRecord(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  index: GoogleImportedOccurrenceIndex,
): GoogleImportedOccurrenceRecord | null {
  for (const key of occurrenceKeys(ev)) {
    const row = index.byKey.get(key);
    if (row) return row;
  }
  return null;
}

export function googleImportedAppointmentIsVisible(
  record: GoogleImportedOccurrenceRecord | null | undefined,
): boolean {
  if (!record?.appointmentId) return false;
  if (!record.date || !record.startTime || !record.endTime) return false;
  const status = (record.status || 'scheduled').toLowerCase();
  return status !== 'cancelled' && status !== 'deleted';
}

export function googleImportedOccurrenceUnchanged(
  ev: GoogleEventPreviewItem,
  record: GoogleImportedOccurrenceRecord | null | undefined,
  salonTimeZone: string,
): boolean {
  if (!googleImportedAppointmentIsVisible(record)) return false;
  const times = googleEventCalendarTimes(ev, salonTimeZone);
  if (!times) return false;
  const timesSame =
    record!.date === times.date &&
    clock5(record!.startTime) === times.startTime &&
    clock5(record!.endTime) === times.endTime;
  const expectedNotes = googleImportedAppointmentNotes(ev.summary);
  const notesSame =
    record!.notes == null || record!.notes === expectedNotes;
  if (record!.etag && ev.etag) {
    return record!.etag === ev.etag && timesSame && notesSame;
  }
  if (record!.lastModified && ev.updated) {
    return record!.lastModified === ev.updated && timesSame && notesSame;
  }
  return timesSame && notesSame;
}

export function googleOverlayOccurrenceUnchanged(
  ev: GoogleEventPreviewItem,
  record: GoogleReviewOverlayRecord | null | undefined,
  salonTimeZone: string,
): boolean {
  if (!record || !googleReviewOverlayRecordIsVisible(record)) return false;
  const snapshot = buildGoogleReviewSnapshot({
    ev,
    salonTimeZone,
    staffId: record.staffId || 'staff',
    staffName: record.staffName || 'Tatev',
  });
  if (!snapshot) return false;
  if (record.etag && ev.etag && record.etag === ev.etag) {
    return (
      (record.title || '').trim() === snapshot.title.trim() &&
      record.date === snapshot.date &&
      clock5(record.startTime) === snapshot.startTime &&
      clock5(record.endTime) === snapshot.endTime
    );
  }
  return (
    (record.title || '').trim() === snapshot.title.trim() &&
    record.date === snapshot.date &&
    clock5(record.startTime) === snapshot.startTime &&
    clock5(record.endTime) === snapshot.endTime
  );
}

export function googleOccurrenceNeedsAutoReconcile(params: {
  ev: GoogleEventPreviewItem;
  imported: GoogleImportedOccurrenceIndex;
  overlays: GoogleReviewCoverageIndex;
  salonTimeZone: string;
}): boolean {
  const ev = params.ev;
  const imported = isImportedGoogleOccurrence(ev, params.imported.keys);
  const overlay = isGoogleReviewOverlayRepresented(ev, params.overlays.overlayKeys);
  if (!imported && !overlay) return false;
  if (isGoogleEventCancelledOrDeleted(ev)) return overlay;
  if (imported) {
    return !googleImportedOccurrenceUnchanged(
      ev,
      findImportedOccurrenceRecord(ev, params.imported),
      params.salonTimeZone,
    );
  }
  return !googleOverlayOccurrenceUnchanged(
    ev,
    findOverlayRecord(ev, params.overlays),
    params.salonTimeZone,
  );
}

export function findOverlayRecord(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  index: GoogleReviewCoverageIndex,
): GoogleReviewOverlayRecord | null {
  const keys = googleOccurrenceLookupKeys(ev);
  for (const key of keys) {
    const row = index.overlayByKey.get(key);
    if (row) return row;
  }
  return null;
}

export async function loadGoogleImportedOccurrenceIndex(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
}): Promise<GoogleImportedOccurrenceIndex> {
  const { data, error } = await params.db
    .from('appointment_external_links')
    .select(
      'appointment_id, external_uid, recurrence_id, external_calendar_id, external_etag, external_last_modified',
    )
    .eq('salon_id', params.salonId)
    .eq('calendar_connection_id', params.calendarConnectionId)
    .eq('provider', 'google');
  if (error) {
    const keys = await loadGoogleImportedOccurrenceKeys(params.db, {
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
    });
    return { keys, byKey: new Map() };
  }
  const links = Array.isArray(data) ? data : [];
  const appointmentIds = [
    ...new Set(
      links
        .map((row: { appointment_id?: string }) =>
          typeof row.appointment_id === 'string' ? row.appointment_id : '',
        )
        .filter(Boolean),
    ),
  ];
  let appointments: Array<Record<string, unknown>> = [];
  if (appointmentIds.length > 0) {
    const loaded = await params.db
      .from('appointments')
      .select('id, date, start_time, end_time, staff_id, client_id, status, notes')
      .eq('salon_id', params.salonId);
    const rows = Array.isArray(loaded?.data) ? loaded.data : [];
    const wanted = new Set(appointmentIds);
    appointments = rows.filter((row: { id?: string }) => wanted.has(String(row?.id || '')));
  }
  return normalizeImportedOccurrenceIndex(links, appointments);
}

async function staffHasConflict(params: {
  db: any;
  salonId: string;
  staffId: string;
  date: string;
  startTime: string;
  endTime: string;
  excludeAppointmentId: string;
}): Promise<boolean> {
  const startMin = minutesFromClock(params.startTime);
  const endMin = minutesFromClock(params.endTime);
  if (startMin == null || endMin == null || endMin <= startMin) return true;
  const loaded = await params.db
    .from('appointments')
    .select('id, start_time, end_time, status')
    .eq('salon_id', params.salonId)
    .eq('staff_id', params.staffId)
    .eq('date', params.date);
  const rows = Array.isArray(loaded?.data) ? loaded.data : [];
  return rows.some((row: { id?: string; start_time?: string; end_time?: string; status?: string }) => {
    if (row.id === params.excludeAppointmentId) return false;
    if (!ACTIVE_STATUSES.has(String(row.status || ''))) return false;
    const otherStart = minutesFromClock(row.start_time || '');
    const otherEnd = minutesFromClock(row.end_time || '');
    if (otherStart == null || otherEnd == null) return false;
    return intervalsOverlap(startMin, endMin, otherStart, otherEnd);
  });
}

export async function reconcileGoogleSourcedAppointment(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  record: GoogleImportedOccurrenceRecord;
  salonTimeZone: string;
  staffId: string;
  staffName: string;
  matching?: CalendarEventMatchingPreview;
  syncReminder?: typeof syncAppointmentReminder;
}): Promise<GoogleAppointmentReconcileResult> {
  if (!params.record.appointmentId) return { kind: 'missing' };
  if (isGoogleEventCancelledOrDeleted(params.ev)) {
    return { kind: 'cancelled_preserved' };
  }
  const times = googleEventCalendarTimes(params.ev, params.salonTimeZone);
  if (!times) return { kind: 'missing' };
  const notes = googleImportedAppointmentNotes(params.ev.summary);
  const timesChanged =
    params.record.date !== times.date ||
    clock5(params.record.startTime) !== times.startTime ||
    clock5(params.record.endTime) !== times.endTime;
  const notesChanged = params.record.notes !== notes;
  if (!timesChanged) {
    if (!notesChanged) {
      await touchImportedLink(params);
      return { kind: 'unchanged' };
    }
    const { error } = await params.db
      .from('appointments')
      .update({ notes })
      .eq('id', params.record.appointmentId)
      .eq('salon_id', params.salonId);
    if (error) return { kind: 'missing' };
    params.record.notes = notes;
    await touchImportedLink(params);
    return { kind: 'updated' };
  }

  const staffId = params.record.staffId || params.staffId;
  const conflict = await staffHasConflict({
    db: params.db,
    salonId: params.salonId,
    staffId,
    date: times.date,
    startTime: times.startTime,
    endTime: times.endTime,
    excludeAppointmentId: params.record.appointmentId,
  });
  if (conflict) {
    await upsertGoogleCalendarReviewIssue({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
      ev: params.ev,
      reasonCode: 'appointment_conflict',
      reasonMessage: 'Google time change conflicts with an existing Tatev appointment',
      staffId: params.staffId,
      staffName: params.staffName,
      salonTimeZone: params.salonTimeZone,
      matching: params.matching,
      clientId: params.record.clientId,
    });
    return { kind: 'conflict' };
  }

  const { error } = await params.db
    .from('appointments')
    .update({
      date: times.date,
      start_time: times.startTime,
      end_time: times.endTime,
      notes,
    })
    .eq('id', params.record.appointmentId)
    .eq('salon_id', params.salonId);
  if (error) return { kind: 'missing' };

  params.record.date = times.date;
  params.record.startTime = times.startTime;
  params.record.endTime = times.endTime;
  params.record.notes = notes;
  await touchImportedLink(params);

  const syncReminder = params.syncReminder ?? syncAppointmentReminder;
  try {
    await syncReminder({
      salonId: params.salonId,
      appointmentId: params.record.appointmentId,
      appointmentDate: times.date,
      startTime: times.startTime,
    });
  } catch {
    // Reminder sync is best-effort; the appointment move already landed.
  }
  return { kind: 'updated' };
}

async function touchImportedLink(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  record: GoogleImportedOccurrenceRecord;
}): Promise<void> {
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(params.ev);
  const nowIso = new Date().toISOString();
  params.record.etag = params.ev.etag || params.record.etag;
  params.record.lastModified = params.ev.updated || params.record.lastModified;
  try {
    let query = params.db
      .from('appointment_external_links')
      .update({
        external_etag: params.ev.etag || null,
        external_last_modified: params.ev.updated || null,
        last_seen_at: nowIso,
        updated_at: nowIso,
      })
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId)
      .eq('external_uid', params.ev.id)
      .eq('recurrence_id', recurrenceId);
    const calendarId = (params.ev.calendarId || '').trim();
    if (calendarId) {
      query = query.eq('external_calendar_id', calendarId);
    }
    await query;
  } catch {
    // Fingerprint write is best-effort.
  }
}

export async function reconcileGoogleReviewOverlay(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  overlays: GoogleReviewCoverageIndex;
  staffId: string;
  staffName: string;
  salonTimeZone: string;
  matching?: CalendarEventMatchingPreview;
  reasonCode?: string;
}): Promise<'updated' | 'unchanged' | 'hidden' | 'failed'> {
  if (isGoogleEventCancelledOrDeleted(params.ev)) {
    const hidden = await dismissGoogleReviewOverlay({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
      ev: params.ev,
    });
    return hidden ? 'hidden' : 'unchanged';
  }
  const existing = findOverlayRecord(params.ev, params.overlays);
  const remembered = findRememberedCoverageClientId(params.ev, params.overlays.clientByKey);
  const ok = await upsertGoogleCalendarReviewIssue({
    db: params.db,
    salonId: params.salonId,
    calendarConnectionId: params.calendarConnectionId,
    ev: params.ev,
    reasonCode: params.reasonCode || existing?.reasonCode || 'other',
    staffId: params.staffId,
    staffName: params.staffName,
    salonTimeZone: params.salonTimeZone,
    matching: params.matching,
    clientId: remembered,
  });
  return ok ? 'updated' : 'failed';
}

export function occurrenceKeyForEvent(ev: GoogleEventPreviewItem): string {
  return buildGoogleOccurrenceKey({
    calendarId: ev.calendarId || '',
    eventId: ev.id,
    recurrenceId: buildGoogleOccurrenceRecurrenceId(ev),
  });
}
