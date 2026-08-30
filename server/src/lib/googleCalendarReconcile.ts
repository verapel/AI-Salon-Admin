/**
 * GOOGLE-CAL-SYNC-FIX-2: Compare Google occurrences with existing AI rows
 * and update the SAME overlay/appointment. No Google writes. No migration.
 */

import { randomUUID } from 'node:crypto';
import { syncAppointmentReminder } from './appointmentReminders.js';
import {
  buildGoogleOccurrenceKey,
  buildGoogleOccurrenceRecurrenceId,
  buildGoogleSourceExternalEventId,
  googleImportedAppointmentNotes,
  classifyGoogleStoredIdentifierType,
  googleCalendarIdsEquivalent,
  googleCanonicalLinkCalendarId,
  googleOccurrenceLookupKeys,
  googleOccurrenceReconcileLookupKeys,
  googleStoredOccurrenceKeys,
  googleStoredUidMatchesEvent,
  legacyStoredGoogleIdentityMatchesEvent,
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
  eventId?: string | null;
  calendarId?: string | null;
  source?: string | null;
  etag: string | null;
  lastModified: string | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  staffId: string | null;
  clientId: string | null;
  serviceId?: string | null;
  status: string | null;
  notes: string | null;
};

export type GoogleImportedOccurrenceIndex = {
  keys: Set<string>;
  byKey: Map<string, GoogleImportedOccurrenceRecord>;
  /** Client ids shared by 2+ visible Google rows at index load. Not mutated mid-tick. */
  sharedGoogleClientIds?: Set<string>;
};

export type GoogleAppointmentReconcileResult =
  | { kind: 'unchanged' }
  | { kind: 'updated' }
  | { kind: 'conflict' }
  | { kind: 'cancelled' }
  | { kind: 'missing' };

function isGoogleSourcedAppointment(record: GoogleImportedOccurrenceRecord): boolean {
  return (record.source || 'google').trim().toLowerCase() === 'google';
}

const ACTIVE_STATUSES = new Set(['scheduled', 'confirmed']);

function logGoogleIdentityReconcile(params: {
  appointmentId: string;
  identifierType: string;
  matchedEventId: string;
  oldStart: string | null | undefined;
  oldEnd: string | null | undefined;
  newStart: string | null;
  newEnd: string | null;
  result: string;
  error: string | null;
}): void {
  console.log('[calendar/google-auto] google identity reconcile', {
    identifierType: params.identifierType,
    matchedEventId: params.matchedEventId,
    appointmentId: params.appointmentId,
    oldStart: params.oldStart || null,
    oldEnd: params.oldEnd || null,
    newStart: params.newStart,
    newEnd: params.newEnd,
    result: params.result,
    error: params.error,
  });
}

function occurrenceKeys(
  ev: Pick<
    GoogleEventPreviewItem,
    'id' | 'calendarId' | 'iCalUID' | 'recurringEventId' | 'originalStartTime'
  >,
): string[] {
  return googleOccurrenceReconcileLookupKeys(ev);
}

function isImportedGoogleOccurrence(
  ev: Pick<
    GoogleEventPreviewItem,
    'id' | 'calendarId' | 'iCalUID' | 'recurringEventId' | 'originalStartTime'
  >,
  importedKeys: Set<string>,
): boolean {
  return occurrenceKeys(ev).some((k) => importedKeys.has(k));
}

function clock5(value: string | null | undefined): string {
  return (value || '').trim().slice(0, 5);
}

function googleBusyMetadataPatch(
  record: Pick<GoogleImportedOccurrenceRecord, 'clientId' | 'serviceId'>,
  desired: { clientId?: string | null; serviceId?: string | null },
): { client_id?: string; service_id?: string } | null {
  const patch: { client_id?: string; service_id?: string } = {};
  const clientId = (desired.clientId || '').trim();
  const serviceId = (desired.serviceId || '').trim();
  if (clientId && clientId !== (record.clientId || '')) patch.client_id = clientId;
  if (serviceId && serviceId !== (record.serviceId || '')) patch.service_id = serviceId;
  return patch.client_id || patch.service_id ? patch : null;
}

function applyGoogleBusyMetadataToRecord(
  record: GoogleImportedOccurrenceRecord,
  patch: { client_id?: string; service_id?: string } | null,
): void {
  if (!patch) return;
  if (patch.client_id) record.clientId = patch.client_id;
  if (patch.service_id) record.serviceId = patch.service_id;
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
      eventId: uid,
      calendarId: cal || null,
      etag: typeof row.external_etag === 'string' ? row.external_etag : null,
      lastModified:
        typeof row.external_last_modified === 'string' ? row.external_last_modified : null,
      date: date10(appt?.date) || null,
      startTime: clock5(typeof appt?.start_time === 'string' ? appt.start_time : '') || null,
      endTime: clock5(typeof appt?.end_time === 'string' ? appt.end_time : '') || null,
      staffId: typeof appt?.staff_id === 'string' ? appt.staff_id : null,
      clientId: typeof appt?.client_id === 'string' ? appt.client_id : null,
      serviceId: typeof appt?.service_id === 'string' ? appt.service_id : null,
      status: typeof appt?.status === 'string' ? appt.status : null,
      source: typeof appt?.source === 'string' ? appt.source : null,
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
    if (cal === 'primary') {
      for (const key of googleStoredOccurrenceKeys({
        calendarId: '',
        eventId: uid,
        recurrenceId: rec,
      })) {
        keys.add(key);
        byKey.set(key, record);
      }
    }
  }
  return { keys, byKey, sharedGoogleClientIds: collectSharedGoogleBusyClientIds(byKey.values()) };
}

export function findImportedOccurrenceRecord(
  ev: Pick<
    GoogleEventPreviewItem,
    'id' | 'calendarId' | 'iCalUID' | 'recurringEventId' | 'originalStartTime'
  >,
  index: GoogleImportedOccurrenceIndex,
): GoogleImportedOccurrenceRecord | null {
  let hidden: GoogleImportedOccurrenceRecord | null = null;
  for (const key of occurrenceKeys(ev)) {
    const row = index.byKey.get(key);
    if (!row) continue;
    if (googleImportedAppointmentIsVisible(row)) return row;
    hidden = hidden ?? row;
  }
  const seen = new Set<string>();
  for (const row of index.byKey.values()) {
    if (!row.appointmentId || seen.has(row.appointmentId)) continue;
    seen.add(row.appointmentId);
    if (!googleStoredUidMatchesEvent(row.eventId, ev)) continue;
    if (!googleCalendarIdsEquivalent(row.calendarId, ev.calendarId)) continue;
    if (googleImportedAppointmentIsVisible(row)) return row;
    hidden = hidden ?? row;
  }
  return hidden;
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
  if (isGoogleEventCancelledOrDeleted(ev)) {
    if (imported) {
      return googleImportedAppointmentIsVisible(
        findImportedOccurrenceRecord(ev, params.imported),
      );
    }
    return overlay;
  }
  if (imported) {
    const record = findImportedOccurrenceRecord(ev, params.imported);
    if (googleImportedRowNeedsBusyMetadataRetarget(record, params.imported)) return true;
    return !googleImportedOccurrenceUnchanged(ev, record, params.salonTimeZone);
  }
  return !googleOverlayOccurrenceUnchanged(
    ev,
    findOverlayRecord(ev, params.overlays),
    params.salonTimeZone,
  );
}

export function rememberImportedOccurrence(
  index: GoogleImportedOccurrenceIndex,
  record: GoogleImportedOccurrenceRecord,
  ev: Pick<
    GoogleEventPreviewItem,
    'id' | 'calendarId' | 'iCalUID' | 'recurringEventId' | 'originalStartTime'
  >,
): void {
  for (const key of googleOccurrenceReconcileLookupKeys(ev)) {
    index.keys.add(key);
    index.byKey.set(key, record);
  }
}

/** Inactive salon service used only when THIS Google event did not match a catalog service. */
export const GOOGLE_UNRESOLVED_BUSY_SERVICE_NAME = 'Google • Требует проверки';

function collectSharedGoogleBusyClientIds(
  records: Iterable<GoogleImportedOccurrenceRecord>,
): Set<string> {
  const clientToAppointments = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.appointmentId || seen.has(record.appointmentId)) continue;
    seen.add(record.appointmentId);
    if (!isGoogleSourcedAppointment(record)) continue;
    if (!googleImportedAppointmentIsVisible(record)) continue;
    const clientId = (record.clientId || '').trim();
    if (!clientId) continue;
    const bucket = clientToAppointments.get(clientId) ?? new Set<string>();
    bucket.add(record.appointmentId);
    clientToAppointments.set(clientId, bucket);
  }
  const shared = new Set<string>();
  for (const [clientId, appts] of clientToAppointments) {
    if (appts.size > 1) shared.add(clientId);
  }
  return shared;
}

export function googleBusyClientIsSharedAcrossEvents(
  clientId: string,
  currentAppointmentId: string,
  index: GoogleImportedOccurrenceIndex,
): boolean {
  const wanted = clientId.trim();
  const selfAppt = currentAppointmentId.trim();
  if (!wanted || !selfAppt) return false;
  if (index.sharedGoogleClientIds) return index.sharedGoogleClientIds.has(wanted);
  const seen = new Set<string>();
  for (const record of index.byKey.values()) {
    if (!record.appointmentId || seen.has(record.appointmentId)) continue;
    seen.add(record.appointmentId);
    if (record.appointmentId === selfAppt) continue;
    if (!isGoogleSourcedAppointment(record)) continue;
    if (!googleImportedAppointmentIsVisible(record)) continue;
    if ((record.clientId || '') === wanted) return true;
  }
  return false;
}

/** Shared inherited client/service must reconcile even when title/time already match. */
export function googleImportedRowNeedsBusyMetadataRetarget(
  record: GoogleImportedOccurrenceRecord | null | undefined,
  index: GoogleImportedOccurrenceIndex,
): boolean {
  if (!googleImportedAppointmentIsVisible(record)) return false;
  const client = (record!.clientId || '').trim();
  if (!client) return false;
  return googleBusyClientIsSharedAcrossEvents(client, record!.appointmentId, index);
}

/** Keep an existing per-event client; retarget only inherited/shared clients. */
export function retainGoogleBusyClientId(params: {
  eventId: string;
  currentAppointmentId?: string | null;
  currentClientId: string | null | undefined;
  matchedClientId: string | null | undefined;
  currentServiceId?: string | null;
  matchedServiceId?: string | null;
  catalogServiceIds?: Iterable<string>;
  index: GoogleImportedOccurrenceIndex;
  catalogClientIds?: Iterable<string>;
}): string | null {
  const matched = (params.matchedClientId || '').trim();
  if (matched) return matched;
  const current = (params.currentClientId || '').trim();
  if (!current) return null;
  const catalogServiceIds = new Set(
    [...(params.catalogServiceIds ?? [])].map((id) => id.trim()).filter(Boolean),
  );
  const currentService = (params.currentServiceId || '').trim();
  const inheritedCatalogService =
    !(params.matchedServiceId || '').trim() &&
    Boolean(currentService) &&
    catalogServiceIds.has(currentService);
  // Only detach a client when this unmatched event also inherited a real
  // catalog service (the 05f4fa6 first-service fallback) and that client is
  // shared with another Google row.
  if (
    inheritedCatalogService &&
    googleBusyClientIsSharedAcrossEvents(
      current,
      params.currentAppointmentId || '',
      params.index,
    )
  ) {
    return null;
  }
  void params.catalogClientIds;
  return current;
}

export function pickCanonicalGoogleBusyServiceId(
  matching: CalendarEventMatchingPreview | undefined,
  _catalogServices?: Array<{ id?: string | null }>,
): string | null {
  void _catalogServices;
  const matched =
    matching?.service?.status === 'matched' && typeof matching.service.serviceId === 'string'
      ? matching.service.serviceId.trim()
      : '';
  return matched || null;
}

export async function ensureUnresolvedGoogleBusyServiceId(params: {
  db: any;
  salonId: string;
}): Promise<string | null> {
  try {
    const listed = await params.db
      .from('services')
      .select('id, name, salon_id')
      .eq('salon_id', params.salonId)
      .eq('name', GOOGLE_UNRESOLVED_BUSY_SERVICE_NAME);
    const rows = Array.isArray(listed?.data) ? listed.data : [];
    const existing = rows.find((row: { id?: string }) => typeof row?.id === 'string' && row.id);
    if (existing?.id) return existing.id as string;

    const insertRow = {
      id: randomUUID(),
      salon_id: params.salonId,
      name: GOOGLE_UNRESOLVED_BUSY_SERVICE_NAME,
      description: 'Unresolved Google Calendar busy block. Not a bookable salon service.',
      duration: 60,
      price: 0,
      category: 'General',
      active: false,
    };
    const insertQuery = params.db.from('services').insert(insertRow);
    let inserted: { data?: { id?: string } | null; error?: unknown } | null = null;
    if (insertQuery && typeof insertQuery.select === 'function') {
      inserted = await insertQuery.select('id').single();
    } else if (insertQuery && typeof insertQuery.then === 'function') {
      inserted = await insertQuery;
    }
    if (inserted?.error) return null;
    const id =
      (typeof inserted?.data?.id === 'string' && inserted.data.id) || insertRow.id;
    return id || null;
  } catch {
    return randomUUID();
  }
}

/** User-cancelled source=google row for this live event. Sync must not insert a twin. */
export async function findUserCancelledGoogleAppointmentForEvent(params: {
  db: any;
  salonId: string;
  ev: Pick<
    GoogleEventPreviewItem,
    'id' | 'calendarId' | 'iCalUID' | 'recurringEventId' | 'originalStartTime'
  >;
}): Promise<string | null> {
  const loaded = await params.db
    .from('appointments')
    .select('id, source, status, source_external_event_id')
    .eq('salon_id', params.salonId)
    .eq('source', 'google')
    .eq('status', 'cancelled');
  const rows = Array.isArray(loaded?.data) ? loaded.data : [];
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (!id) continue;
    if (String(row?.source || '').trim().toLowerCase() !== 'google') continue;
    if (String(row?.status || '').toLowerCase() !== 'cancelled') continue;
    if (legacyStoredGoogleIdentityMatchesEvent(row?.source_external_event_id, params.ev)) {
      return id;
    }
  }
  return null;
}

export async function persistCanonicalGoogleBusyAppointment(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: GoogleEventPreviewItem;
  staffId: string;
  staffName?: string;
  salonTimeZone: string;
  clientId: string;
  serviceId: string;
  importedIndex: GoogleImportedOccurrenceIndex;
  selectedCalendarId?: string | null;
  matching?: CalendarEventMatchingPreview;
}): Promise<{
  kind: 'created' | 'updated' | 'unchanged' | 'cancelled' | 'conflict' | 'missing';
  appointmentId: string | null;
}> {
  const existing = findImportedOccurrenceRecord(params.ev, params.importedIndex);
  if (existing?.appointmentId) {
    if (!googleImportedAppointmentIsVisible(existing)) {
      // User removed this card in /bookings. Do not revive or insert a twin.
      return { kind: 'unchanged', appointmentId: existing.appointmentId };
    }
    const moved = await reconcileGoogleSourcedAppointment({
      db: params.db,
      salonId: params.salonId,
      calendarConnectionId: params.calendarConnectionId,
      ev: params.ev,
      record: existing,
      salonTimeZone: params.salonTimeZone,
      staffId: params.staffId,
      staffName: params.staffName || 'Tatev',
      matching: params.matching,
      desiredClientId: params.clientId,
      desiredServiceId: params.serviceId,
    });
    return { kind: moved.kind, appointmentId: existing.appointmentId };
  }

  if (isGoogleEventCancelledOrDeleted(params.ev)) {
    return { kind: 'cancelled', appointmentId: null };
  }

  const userCancelledId = await findUserCancelledGoogleAppointmentForEvent({
    db: params.db,
    salonId: params.salonId,
    ev: params.ev,
  });
  if (userCancelledId) {
    return { kind: 'unchanged', appointmentId: userCancelledId };
  }

  const times = googleEventCalendarTimes(params.ev, params.salonTimeZone);
  if (!times) return { kind: 'missing', appointmentId: null };

  const appointmentId = randomUUID();
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(params.ev);
  const calendarId =
    googleCanonicalLinkCalendarId(params.ev.calendarId, params.selectedCalendarId) ||
    (params.ev.calendarId || '').trim() ||
    'primary';
  const sourceExternalEventId = buildGoogleSourceExternalEventId({
    calendarId,
    eventId: params.ev.id,
    recurrenceId,
  });
  const notes = googleImportedAppointmentNotes(params.ev.summary);

  try {
    const inserted = params.db.from('appointments').insert({
      id: appointmentId,
      salon_id: params.salonId,
      client_id: params.clientId,
      staff_id: params.staffId,
      service_id: params.serviceId,
      date: times.date,
      start_time: times.startTime,
      end_time: times.endTime,
      status: 'scheduled',
      notes,
      reminder_sent: false,
      source: 'google',
      source_external_event_id: sourceExternalEventId,
    });
    const insertResult = typeof inserted?.then === 'function' ? await inserted : inserted;
    if (insertResult?.error) return { kind: 'missing', appointmentId: null };
  } catch {
    return { kind: 'missing', appointmentId: null };
  }

  try {
    await params.db.from('appointment_external_links').insert({
      salon_id: params.salonId,
      appointment_id: appointmentId,
      calendar_connection_id: params.calendarConnectionId,
      provider: 'google',
      external_calendar_id: calendarId,
      external_uid: params.ev.id,
      recurrence_id: recurrenceId,
      external_etag: params.ev.etag || null,
      external_last_modified: params.ev.updated || null,
    });
  } catch {
    return { kind: 'missing', appointmentId: null };
  }

  const record: GoogleImportedOccurrenceRecord = {
    appointmentId,
    eventId: params.ev.id,
    calendarId,
    etag: params.ev.etag || null,
    lastModified: params.ev.updated || null,
    date: times.date,
    startTime: times.startTime,
    endTime: times.endTime,
    staffId: params.staffId,
    clientId: params.clientId,
    serviceId: params.serviceId,
    status: 'scheduled',
    notes,
    source: 'google',
  };
  rememberImportedOccurrence(params.importedIndex, record, params.ev);
  return { kind: 'created', appointmentId };
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
    return { keys, byKey: new Map(), sharedGoogleClientIds: new Set() };
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
      .select('id, date, start_time, end_time, staff_id, client_id, service_id, status, notes, source')
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
    .select('id, start_time, end_time, status, source')
    .eq('salon_id', params.salonId)
    .eq('staff_id', params.staffId)
    .eq('date', params.date);
  const rows = Array.isArray(loaded?.data) ? loaded.data : [];
  return rows.some((row: {
    id?: string;
    start_time?: string;
    end_time?: string;
    status?: string;
    source?: string;
  }) => {
    if (row.id === params.excludeAppointmentId) return false;
    // Other source=google rows are Google-owned and reconciled separately.
    // Treating them as blockers deadlocks a same-day cluster (Aug 30).
    if (String(row.source || '').trim().toLowerCase() === 'google') return false;
    if (!ACTIVE_STATUSES.has(String(row.status || ''))) return false;
    const otherStart = minutesFromClock(row.start_time || '');
    const otherEnd = minutesFromClock(row.end_time || '');
    if (otherStart == null || otherEnd == null) return false;
    return intervalsOverlap(startMin, endMin, otherStart, otherEnd);
  });
}

export function collectGoogleSourcedDuplicatesForEvent(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'iCalUID' | 'calendarId'>,
  index: GoogleImportedOccurrenceIndex,
  keepAppointmentId: string,
): GoogleImportedOccurrenceRecord[] {
  const keep = keepAppointmentId.trim();
  const seen = new Set<string>();
  const out: GoogleImportedOccurrenceRecord[] = [];
  for (const record of index.byKey.values()) {
    if (!record.appointmentId || seen.has(record.appointmentId)) continue;
    if (record.appointmentId === keep) continue;
    if (!isGoogleSourcedAppointment(record)) continue;
    if (!googleImportedAppointmentIsVisible(record)) continue;
    if (!googleStoredUidMatchesEvent(record.eventId, ev)) continue;
    if (!googleCalendarIdsEquivalent(record.calendarId, ev.calendarId)) continue;
    seen.add(record.appointmentId);
    out.push(record);
  }
  return out;
}

function googleDuplicateGroupKey(
  record: GoogleImportedOccurrenceRecord,
  selectedCalendarId?: string | null,
): string {
  const raw = (record.eventId || '').trim();
  const local = raw.replace(/@google\.com$/i, '');
  const cal = googleCanonicalLinkCalendarId(record.calendarId, selectedCalendarId);
  return `${cal}::${local}`;
}

export async function deactivateIndexGoogleSourcedDuplicates(params: {
  db: any;
  salonId: string;
  index: GoogleImportedOccurrenceIndex;
  selectedCalendarId?: string | null;
}): Promise<number> {
  const groups = new Map<string, GoogleImportedOccurrenceRecord[]>();
  const seen = new Set<string>();
  for (const record of params.index.byKey.values()) {
    if (!record.appointmentId || seen.has(record.appointmentId)) continue;
    if (!isGoogleSourcedAppointment(record)) continue;
    if (!googleImportedAppointmentIsVisible(record)) continue;
    if (!(record.eventId || '').trim()) continue;
    seen.add(record.appointmentId);
    const key = googleDuplicateGroupKey(record, params.selectedCalendarId);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  let deactivated = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const kept = [...group].sort((a, b) => a.appointmentId.localeCompare(b.appointmentId))[0]!;
    for (const record of group) {
      if (record.appointmentId === kept.appointmentId) continue;
      const { error } = await params.db
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('id', record.appointmentId)
        .eq('salon_id', params.salonId)
        .eq('source', 'google');
      if (error) continue;
      record.status = 'cancelled';
      deactivated += 1;
      console.log('[calendar/google-auto] google identity reconcile', {
        identifierType: classifyGoogleStoredIdentifierType(
          record.calendarId ? `${record.calendarId}:${record.eventId || ''}` : record.eventId,
        ),
        matchedEventId: kept.eventId,
        appointmentId: record.appointmentId,
        keptAppointmentId: kept.appointmentId,
        oldStart: record.startTime,
        oldEnd: record.endTime,
        newStart: null,
        newEnd: null,
        result: 'duplicate_cancelled',
        error: null,
      });
    }
  }
  return deactivated;
}

export async function deactivateDuplicateGoogleSourcedAppointments(params: {
  db: any;
  salonId: string;
  ev: Pick<GoogleEventPreviewItem, 'id' | 'iCalUID' | 'calendarId'>;
  index: GoogleImportedOccurrenceIndex;
  keepAppointmentId: string;
}): Promise<number> {
  const extras = collectGoogleSourcedDuplicatesForEvent(
    params.ev,
    params.index,
    params.keepAppointmentId,
  );
  let deactivated = 0;
  for (const record of extras) {
    const { error } = await params.db
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', record.appointmentId)
      .eq('salon_id', params.salonId)
      .eq('source', 'google');
    if (error) continue;
    record.status = 'cancelled';
    deactivated += 1;
    console.log('[calendar/google-auto] google identity reconcile', {
      identifierType: classifyGoogleStoredIdentifierType(
        record.calendarId ? `${record.calendarId}:${record.eventId || ''}` : record.eventId,
      ),
      matchedEventId: params.ev.id,
      appointmentId: record.appointmentId,
      keptAppointmentId: params.keepAppointmentId,
      oldStart: record.startTime,
      oldEnd: record.endTime,
      newStart: null,
      newEnd: null,
      result: 'duplicate_cancelled',
      error: null,
    });
  }
  return deactivated;
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
  desiredClientId?: string | null;
  desiredServiceId?: string | null;
  syncReminder?: typeof syncAppointmentReminder;
}): Promise<GoogleAppointmentReconcileResult> {
  if (!params.record.appointmentId) return { kind: 'missing' };
  if (!isGoogleSourcedAppointment(params.record)) return { kind: 'unchanged' };
  if (isGoogleEventCancelledOrDeleted(params.ev)) {
    if (!googleImportedAppointmentIsVisible(params.record)) return { kind: 'unchanged' };
    const { error } = await params.db
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', params.record.appointmentId)
      .eq('salon_id', params.salonId);
    logGoogleIdentityReconcile({
      appointmentId: params.record.appointmentId,
      identifierType: classifyGoogleStoredIdentifierType(
        params.record.calendarId
          ? `${params.record.calendarId}:${params.record.eventId || ''}`
          : params.record.eventId,
      ),
      matchedEventId: params.ev.id,
      oldStart: params.record.startTime,
      oldEnd: params.record.endTime,
      newStart: null,
      newEnd: null,
      result: error ? 'error' : 'cancelled',
      error: error ? String((error as { message?: string }).message || error) : null,
    });
    if (error) return { kind: 'missing' };
    params.record.status = 'cancelled';
    await touchImportedLink(params);
    return { kind: 'cancelled' };
  }
  const times = googleEventCalendarTimes(params.ev, params.salonTimeZone);
  if (!times) return { kind: 'missing' };
  const notes = googleImportedAppointmentNotes(params.ev.summary);
  const identityType = classifyGoogleStoredIdentifierType(
    params.record.calendarId
      ? `${params.record.calendarId}:${params.record.eventId || ''}`
      : params.record.eventId,
  );
  const timesChanged =
    params.record.date !== times.date ||
    clock5(params.record.startTime) !== times.startTime ||
    clock5(params.record.endTime) !== times.endTime;
  const notesChanged = params.record.notes !== notes;
  const metadataPatch = googleBusyMetadataPatch(params.record, {
    clientId: params.desiredClientId,
    serviceId: params.desiredServiceId,
  });
  if (!timesChanged) {
    if (!notesChanged && !metadataPatch) {
      await touchImportedLink(params);
      return { kind: 'unchanged' };
    }
    const { error } = await params.db
      .from('appointments')
      .update({
        ...(notesChanged ? { notes } : {}),
        ...(metadataPatch || {}),
      })
      .eq('id', params.record.appointmentId)
      .eq('salon_id', params.salonId);
    if (error) return { kind: 'missing' };
    if (notesChanged) params.record.notes = notes;
    applyGoogleBusyMetadataToRecord(params.record, metadataPatch);
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
      ...(metadataPatch || {}),
    })
      .eq('id', params.record.appointmentId)
      .eq('salon_id', params.salonId);
  logGoogleIdentityReconcile({
    appointmentId: params.record.appointmentId,
    identifierType: identityType,
    matchedEventId: params.ev.id,
    oldStart: params.record.startTime,
    oldEnd: params.record.endTime,
    newStart: times.startTime,
    newEnd: times.endTime,
    result: error ? 'error' : 'updated',
    error: error ? String((error as { message?: string }).message || error) : null,
  });
  if (error) return { kind: 'missing' };

  params.record.date = times.date;
  params.record.startTime = times.startTime;
  params.record.endTime = times.endTime;
  params.record.notes = notes;
  applyGoogleBusyMetadataToRecord(params.record, metadataPatch);
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
