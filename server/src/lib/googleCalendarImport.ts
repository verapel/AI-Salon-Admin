/**
 * GOOGLE-CAL-FAST-5B: Manual one-event Google Calendar import foundation.
 * Readiness DTO + occurrence identity + import orchestration.
 * Business writes go through commit_google_calendar_manual_import RPC only.
 * No Google writes. No bulk/auto sync. Does not flip import_enabled.
 */

import {
  parseExternalCalendarEvent,
  resolveParserTimezone,
  type CalendarEventParsedPreview,
} from './calendarEventParser.js';
import {
  phoneDigitsKey,
  type CalendarEventMatchingPreview,
} from './calendarEventMatcher.js';
import { syncAppointmentReminder } from './appointmentReminders.js';
import {
  GOOGLE_CALENDAR_PROVIDER,
  loadGoogleCalendarAppConfig,
  mapGoogleEventPreviewEntry,
  readSelectedGoogleCalendars,
  refreshGoogleAccessToken,
  type GoogleEventPreviewItem,
  type GoogleFetch,
} from './googleCalendarOAuth.js';
import { decryptCalendarCredential } from './calendarCredentialsCrypto.js';

export type GoogleImportReadinessStatus =
  | 'importable'
  | 'needs_client_review'
  | 'needs_service_review'
  | 'needs_staff_review'
  | 'already_imported'
  | 'not_importable';

export type GoogleImportReadiness = {
  status: GoogleImportReadinessStatus;
  reasons: string[];
  /** Occurrence identity for UI/import payload (not authoritative alone). */
  occurrenceKey: string;
  externalUid: string;
  recurrenceId: string;
  suggestedNewClientName: string | null;
  canCreateNewClient: boolean;
};

export type ImportableStaffOption = {
  id: string;
  name: string;
};

export type GoogleEventImportProposal = {
  staffId: string | null;
  serviceId: string | null;
  clientMode: 'existing' | 'new' | null;
  clientId: string | null;
  newClientName: string | null;
};

export const GOOGLE_IMPORT_RPC = 'commit_google_calendar_manual_import' as const;

export type GoogleImportErrorCode =
  | 'google_not_connected'
  | 'google_calendar_not_selected'
  | 'google_event_not_found'
  | 'google_event_changed'
  | 'google_event_cancelled'
  | 'google_event_not_importable'
  | 'google_event_already_imported'
  | 'client_review_required'
  | 'client_ambiguous'
  | 'client_blocked'
  | 'service_review_required'
  | 'service_invalid'
  | 'staff_required'
  | 'staff_invalid'
  | 'appointment_conflict'
  | 'google_import_failed';

export class GoogleCalendarImportError extends Error {
  readonly code: GoogleImportErrorCode;
  constructor(code: GoogleImportErrorCode, message: string) {
    super(message);
    this.name = 'GoogleCalendarImportError';
    this.code = code;
  }
}

/** Build occurrence recurrence key from preview DTO fields. */
export function buildGoogleOccurrenceRecurrenceId(ev: {
  recurringEventId?: string | null;
  originalStartTime?: {
    dateTime?: string | null;
    date?: string | null;
  } | null;
}): string {
  if (!ev.recurringEventId) return '';
  const ost = ev.originalStartTime;
  if (!ost) return '';
  if (typeof ost.dateTime === 'string' && ost.dateTime.trim()) return ost.dateTime.trim();
  if (typeof ost.date === 'string' && ost.date.trim()) return ost.date.trim();
  return '';
}

export function buildGoogleSourceExternalEventId(params: {
  calendarId: string;
  eventId: string;
  recurrenceId: string;
}): string {
  const cal = params.calendarId.trim();
  const id = params.eventId.trim();
  const rec = params.recurrenceId.trim();
  return rec ? `${cal}:${id}:${rec}` : `${cal}:${id}`;
}

export function buildGoogleOccurrenceKey(params: {
  calendarId: string;
  eventId: string;
  recurrenceId: string;
}): string {
  return buildGoogleSourceExternalEventId(params);
}

/**
 * Keys used when *indexing* a stored row.
 * Calendar-scoped rows index only calendarId+uid(+recurrence).
 * Legacy rows without calendarId keep bare uid(+recurrence).
 * Recurring occurrences never use a bare series id (FIX-3).
 * Do not encode calendarId into external_uid.
 */
export function googleStoredOccurrenceKeys(params: {
  calendarId?: string | null;
  eventId: string;
  recurrenceId?: string | null;
}): string[] {
  const uid = params.eventId.trim();
  if (!uid) return [];
  const rec = (params.recurrenceId || '').trim();
  const cal = (params.calendarId || '').trim();
  if (cal) {
    return rec ? [`${cal}:${uid}:${rec}`] : [`${cal}:${uid}`];
  }
  return rec ? [`${uid}:${rec}`] : [uid];
}

/**
 * Keys used when *looking up* a live Google event.
 * Prefer calendar-scoped identity; fall back to legacy bare keys so
 * unscoped single-calendar rows still match.
 */
export function googleOccurrenceLookupKeys(ev: {
  id: string;
  calendarId?: string | null;
  recurringEventId?: string | null;
  originalStartTime?: {
    dateTime?: string | null;
    date?: string | null;
  } | null;
}): string[] {
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(ev);
  const scoped = googleStoredOccurrenceKeys({
    calendarId: ev.calendarId,
    eventId: ev.id,
    recurrenceId,
  });
  const cal = (ev.calendarId || '').trim();
  if (!cal) return scoped;
  const legacy = googleStoredOccurrenceKeys({
    calendarId: '',
    eventId: ev.id,
    recurrenceId,
  });
  return [...scoped, ...legacy.filter((key) => !scoped.includes(key))];
}

/** In-memory remember-after-write: calendar-scoped only when calendarId is present. */
export function googleRememberedOccurrenceKeys(ev: {
  id: string;
  calendarId?: string | null;
  recurringEventId?: string | null;
  originalStartTime?: {
    dateTime?: string | null;
    date?: string | null;
  } | null;
}): string[] {
  return googleStoredOccurrenceKeys({
    calendarId: ev.calendarId,
    eventId: ev.id,
    recurrenceId: buildGoogleOccurrenceRecurrenceId(ev),
  });
}

/** Mirror of commit_google_calendar_manual_import selected-calendar gate. */
export function isGoogleCalendarAllowedForManualImport(params: {
  selectedCalendarId?: string | null;
  providerConfig?: unknown;
  calendarId: string;
}): boolean {
  const wanted = params.calendarId.trim();
  if (!wanted) return false;
  if ((params.selectedCalendarId || '').trim() === wanted) return true;
  return readSelectedGoogleCalendars({
    selectedCalendarId: params.selectedCalendarId,
    providerConfig: params.providerConfig,
  }).some((cal) => cal.id === wanted);
}

/**
 * Deterministic NEW-client name suggestion from original title:
 * take text before the first +phone-like token; collapse whitespace.
 * Always editable in UI — never auto-committed without confirmation.
 */
export function suggestNewClientNameFromTitle(title: string | null | undefined): string | null {
  if (typeof title !== 'string') return null;
  const raw = title.trim();
  if (!raw) return null;
  const beforePhone = raw.split(/\+\d/)[0] ?? raw;
  const cleaned = beforePhone.replace(/\s+/gu, ' ').trim();
  return cleaned || null;
}

export function computeGoogleImportReadiness(params: {
  parsed: CalendarEventParsedPreview;
  matching: CalendarEventMatchingPreview | undefined;
  event: Pick<
    GoogleEventPreviewItem,
    'id' | 'calendarId' | 'status' | 'recurringEventId' | 'originalStartTime' | 'summary'
  >;
  alreadyImported: boolean;
  /** Preview has no persisted staff; pass null unless UI selection is known. */
  selectedStaffId?: string | null;
  /** Optional confirmed new-client name from UI for readiness preview. */
  confirmedNewClientName?: string | null;
}): GoogleImportReadiness {
  const { parsed, matching, event } = params;
  const reasons: string[] = [];
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(event);
  const externalUid = event.id;
  const occurrenceKey = buildGoogleOccurrenceKey({
    calendarId: event.calendarId,
    eventId: event.id,
    recurrenceId,
  });
  const suggestedNewClientName = suggestNewClientNameFromTitle(event.summary);
  const canCreateNewClient =
    parsed.phone.confidence === 'exact' &&
    Boolean(parsed.phone.normalized) &&
    matching?.client.status === 'not_found';

  const base = {
    occurrenceKey,
    externalUid,
    recurrenceId,
    suggestedNewClientName,
    canCreateNewClient,
  };

  if (params.alreadyImported) {
    return { status: 'already_imported', reasons: ['already_imported'], ...base };
  }

  const statusLower = (event.status || '').toLowerCase();
  if (statusLower === 'cancelled') {
    return { status: 'not_importable', reasons: ['cancelled_event'], ...base };
  }
  if (parsed.classification.includes('all_day') || parsed.reasons.includes('all_day_event')) {
    return { status: 'not_importable', reasons: ['all_day_event'], ...base };
  }
  if (
    !parsed.localDate ||
    !parsed.localStartTime ||
    !parsed.localEndTime ||
    parsed.durationMinutes == null ||
    parsed.durationMinutes <= 0
  ) {
    return { status: 'not_importable', reasons: ['invalid_time'], ...base };
  }
  // Pilot: reject overnight (end clock <= start clock on same stored date model).
  const [sh, sm] = parsed.localStartTime.split(':').map(Number);
  const [eh, em] = parsed.localEndTime.split(':').map(Number);
  const startMin = (sh ?? 0) * 60 + (sm ?? 0);
  const endMin = (eh ?? 0) * 60 + (em ?? 0);
  if (endMin <= startMin) {
    return { status: 'not_importable', reasons: ['overnight_or_invalid_duration'], ...base };
  }
  if (parsed.importability === 'not_importable') {
    return { status: 'not_importable', reasons: ['parsed_not_importable'], ...base };
  }

  if (!matching || matching.service.status !== 'matched' || !matching.service.serviceId) {
    reasons.push('needs_service_review');
    return { status: 'needs_service_review', reasons, ...base };
  }

  const clientMatched =
    matching.client.status === 'matched' && Boolean(matching.client.clientId);
  const clientAmbiguous = matching.client.status === 'ambiguous';
  if (clientAmbiguous) {
    reasons.push('client_ambiguous');
    return { status: 'needs_client_review', reasons, ...base };
  }

  const confirmedName = (params.confirmedNewClientName || '').trim();
  const newClientReady = canCreateNewClient && confirmedName.length > 0;
  if (!clientMatched && !newClientReady) {
    reasons.push('needs_client_review');
    return { status: 'needs_client_review', reasons, ...base };
  }

  if (!params.selectedStaffId) {
    reasons.push('needs_staff_review');
    return { status: 'needs_staff_review', reasons, ...base };
  }

  return { status: 'importable', reasons: ['ready'], ...base };
}

export async function loadActiveStaffOptions(
  db: any,
  salonId: string,
): Promise<ImportableStaffOption[]> {
  const { data, error } = await db
    .from('staff')
    .select('id, name')
    .eq('salon_id', salonId)
    .eq('active', true)
    .order('name');
  if (error) {
    console.error('[calendar/google-import] staff load failed', {
      salonId,
      message: error.message,
    });
    return [];
  }
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((r: any) => ({
      id: typeof r?.id === 'string' ? r.id : '',
      name: typeof r?.name === 'string' ? r.name : '',
    }))
    .filter((s: ImportableStaffOption) => s.id && s.name);
}

export async function loadGoogleImportedOccurrenceKeys(
  db: any,
  params: { salonId: string; calendarConnectionId: string },
): Promise<Set<string>> {
  const { data, error } = await db
    .from('appointment_external_links')
    .select('external_uid, recurrence_id, external_calendar_id')
    .eq('salon_id', params.salonId)
    .eq('calendar_connection_id', params.calendarConnectionId)
    .eq('provider', 'google');
  if (error) {
    console.error('[calendar/google-import] links load failed', {
      salonId: params.salonId,
      message: error.message,
    });
    throw new GoogleCalendarImportError(
      'google_import_failed',
      'Could not load import links',
    );
  }
  const set = new Set<string>();
  for (const row of Array.isArray(data) ? data : []) {
    const uid = typeof row?.external_uid === 'string' ? row.external_uid : '';
    const rec =
      typeof row?.recurrence_id === 'string' && row.recurrence_id.trim()
        ? row.recurrence_id.trim()
        : '';
    const cal =
      typeof row?.external_calendar_id === 'string' ? row.external_calendar_id.trim() : '';
    if (!uid) continue;
    for (const key of googleStoredOccurrenceKeys({
      calendarId: cal,
      eventId: uid,
      recurrenceId: rec,
    })) {
      set.add(key);
    }
  }
  return set;
}

function parseGoogleCredentialBlob(plaintext: string): { refresh_token: string } {
  const parsed = JSON.parse(plaintext) as { refresh_token?: string };
  if (!parsed.refresh_token?.trim()) throw new Error('missing refresh');
  return { refresh_token: parsed.refresh_token.trim() };
}

export async function fetchGoogleCalendarEventById(params: {
  accessToken: string;
  calendarId: string;
  eventId: string;
  fetchImpl?: GoogleFetch;
}): Promise<any | null> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GoogleCalendarImportError(
      'google_import_failed',
      'Could not load Google event',
    );
  }
  return res.json();
}

export type ManualGoogleImportRequest = {
  eventId: string;
  /** Source Google calendar. Defaults to the connection primary. */
  calendarId?: string;
  recurrenceId?: string;
  staffId: string;
  serviceId: string;
  client: {
    mode: 'existing' | 'new';
    clientId?: string;
    name?: string;
    phone?: string;
  };
  expectedEtag?: string;
  expectedUpdated?: string;
};

export type ManualGoogleImportResult = {
  appointmentId: string;
  clientId: string;
  clientCreated: boolean;
  alreadyImported: boolean;
};

/**
 * Execute one manual Google import with server-side revalidation.
 * Business core writes via RPC transaction; reminder sync after success.
 */
export async function executeManualGoogleCalendarImport(params: {
  db: any;
  salonId: string;
  body: ManualGoogleImportRequest;
  fetchImpl?: GoogleFetch;
  salonTimeZone?: string;
  /** Test seam — defaults to syncAppointmentReminder. */
  syncReminder?: typeof syncAppointmentReminder;
}): Promise<ManualGoogleImportResult> {
  const salonId = params.salonId.trim();
  const body = params.body;
  if (!body?.eventId?.trim()) {
    throw new GoogleCalendarImportError('google_event_not_found', 'Event id required');
  }
  if (!body.staffId?.trim()) {
    throw new GoogleCalendarImportError('staff_required', 'Staff is required');
  }
  if (!body.serviceId?.trim()) {
    throw new GoogleCalendarImportError('service_review_required', 'Service is required');
  }
  if (!body.client?.mode) {
    throw new GoogleCalendarImportError('client_review_required', 'Client confirmation required');
  }

  const config = loadGoogleCalendarAppConfig();
  const { data: conn, error: connErr } = await params.db
    .from('calendar_connections')
    .select(
      'id, credential_ciphertext, credential_iv, credential_auth_tag, status, selected_calendar_id, selected_calendar_name, provider_config',
    )
    .eq('salon_id', salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();

  if (connErr || !conn?.id) {
    throw new GoogleCalendarImportError('google_not_connected', 'Google Calendar is not connected');
  }
  const primaryCalendarId = String(conn.selected_calendar_id || '').trim();
  const calendarId = (body.calendarId || primaryCalendarId).trim();
  if (
    !calendarId ||
    !isGoogleCalendarAllowedForManualImport({
      selectedCalendarId: primaryCalendarId,
      providerConfig: conn.provider_config,
      calendarId,
    })
  ) {
    throw new GoogleCalendarImportError(
      'google_calendar_not_selected',
      'Google calendar is not selected',
    );
  }
  const selectedRefs = readSelectedGoogleCalendars({
    selectedCalendarId: primaryCalendarId,
    selectedCalendarName: conn.selected_calendar_name,
    providerConfig: conn.provider_config,
  });
  const calendarName =
    selectedRefs.find((cal) => cal.id === calendarId)?.name ||
    (calendarId === primaryCalendarId ? conn.selected_calendar_name : null);

  let refreshToken: string;
  try {
    const plaintext = decryptCalendarCredential({
      ciphertext: conn.credential_ciphertext,
      iv: conn.credential_iv,
      authTag: conn.credential_auth_tag,
    });
    refreshToken = parseGoogleCredentialBlob(plaintext).refresh_token;
  } catch {
    throw new GoogleCalendarImportError('google_not_connected', 'Google credentials unavailable');
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
    throw new GoogleCalendarImportError('google_import_failed', 'Could not refresh Google token');
  }

  const rawEvent = await fetchGoogleCalendarEventById({
    accessToken,
    calendarId,
    eventId: body.eventId.trim(),
    fetchImpl: params.fetchImpl,
  });
  if (!rawEvent) {
    throw new GoogleCalendarImportError('google_event_not_found', 'Google event not found');
  }

  if (body.expectedEtag && rawEvent.etag && String(rawEvent.etag) !== body.expectedEtag) {
    throw new GoogleCalendarImportError('google_event_changed', 'Google event changed since preview');
  }
  if (
    body.expectedUpdated &&
    rawEvent.updated &&
    String(rawEvent.updated) !== body.expectedUpdated
  ) {
    throw new GoogleCalendarImportError('google_event_changed', 'Google event changed since preview');
  }

  const mapped = mapGoogleEventPreviewEntry(
    rawEvent,
    calendarId,
    calendarName ?? null,
  );
  if (!mapped) {
    throw new GoogleCalendarImportError('google_event_not_importable', 'Could not map Google event');
  }

  const statusLower = (mapped.status || '').toLowerCase();
  if (statusLower === 'cancelled') {
    throw new GoogleCalendarImportError('google_event_cancelled', 'Cancelled event');
  }

  const salonTimeZone = resolveParserTimezone(params.salonTimeZone);
  const parsed = parseExternalCalendarEvent(
    {
      summary: mapped.summary,
      description: mapped.description,
      status: mapped.status,
      start: mapped.start,
      end: mapped.end,
    },
    salonTimeZone,
  );

  if (
    parsed.classification.includes('all_day') ||
    !parsed.localDate ||
    !parsed.localStartTime ||
    !parsed.localEndTime ||
    parsed.durationMinutes == null ||
    parsed.durationMinutes <= 0
  ) {
    throw new GoogleCalendarImportError('google_event_not_importable', 'Event not importable');
  }
  const [sh, sm] = parsed.localStartTime.split(':').map(Number);
  const [eh, em] = parsed.localEndTime.split(':').map(Number);
  if ((eh ?? 0) * 60 + (em ?? 0) <= (sh ?? 0) * 60 + (sm ?? 0)) {
    throw new GoogleCalendarImportError(
      'google_event_not_importable',
      'Overnight events are not supported in this pilot',
    );
  }

  // Ensure payload recurrence matches authoritative event when provided.
  const authRecurrence = buildGoogleOccurrenceRecurrenceId(mapped);
  if (
    typeof body.recurrenceId === 'string' &&
    body.recurrenceId.trim() !== authRecurrence
  ) {
    throw new GoogleCalendarImportError('google_event_changed', 'Occurrence identity mismatch');
  }

  const sourceExternalEventId = buildGoogleSourceExternalEventId({
    calendarId,
    eventId: mapped.id,
    recurrenceId: authRecurrence,
  });

  // Authoritative phone for new clients comes from re-parsed Google event only.
  const exactPhone =
    parsed.phone.confidence === 'exact' && parsed.phone.normalized
      ? parsed.phone.normalized
      : null;

  let clientMode = body.client.mode;
  let clientId = body.client.clientId?.trim() || null;
  let clientName = (body.client.name || '').trim();
  let clientPhone: string | null = null;

  if (clientMode === 'new') {
    if (!exactPhone) {
      throw new GoogleCalendarImportError(
        'client_review_required',
        'Exact phone required for new client',
      );
    }
    if (!clientName) {
      throw new GoogleCalendarImportError('client_review_required', 'Client name required');
    }
    // Ignore browser phone substitution — use Google parsed phone.
    clientPhone = exactPhone;
    clientId = null;
  } else {
    if (!clientId) {
      throw new GoogleCalendarImportError('client_review_required', 'Existing client id required');
    }
  }

  const notes = `Google Calendar import\n${mapped.summary || ''}`.slice(0, 2000);

  const { data: rpcData, error: rpcError } = await params.db.rpc(GOOGLE_IMPORT_RPC, {
    p_salon_id: salonId,
    p_calendar_connection_id: conn.id,
    p_external_calendar_id: calendarId,
    p_external_uid: mapped.id,
    p_recurrence_id: authRecurrence,
    p_source_external_event_id: sourceExternalEventId,
    p_service_id: body.serviceId.trim(),
    p_staff_id: body.staffId.trim(),
    p_date: parsed.localDate,
    p_start_time: parsed.localStartTime,
    p_end_time: parsed.localEndTime,
    p_client_mode: clientMode,
    p_client_id: clientId,
    p_client_name: clientName || null,
    p_client_phone: clientPhone,
    p_notes: notes,
  });

  if (rpcError) {
    console.error('[calendar/google-import] rpc failed', {
      salonId,
      message: rpcError.message,
    });
    // Missing RPC / migration not applied.
    if (
      /function .*commit_google_calendar_manual_import/i.test(rpcError.message || '') ||
      rpcError.code === 'PGRST202' ||
      rpcError.code === '42883'
    ) {
      throw new GoogleCalendarImportError(
        'google_import_failed',
        'Google import RPC is not available',
      );
    }
    throw new GoogleCalendarImportError('google_import_failed', 'Import failed');
  }

  const result = rpcData && typeof rpcData === 'object' ? rpcData : null;
  const kind = result?.kind;
  if (kind === 'already_imported') {
    return {
      appointmentId: String(result.appointmentId || ''),
      clientId: result.clientId ? String(result.clientId) : '',
      clientCreated: false,
      alreadyImported: true,
    };
  }
  if (kind !== 'ok') {
    const code = (result?.code || 'google_import_failed') as GoogleImportErrorCode;
    throw new GoogleCalendarImportError(
      code,
      'Import rejected',
    );
  }

  const appointmentId = String(result.appointmentId);
  const createdClientId = String(result.clientId);
  const clientCreated = Boolean(result.clientCreated);

  const syncReminder = params.syncReminder ?? syncAppointmentReminder;
  try {
    await syncReminder({
      salonId,
      appointmentId,
      appointmentDate: parsed.localDate,
      startTime: parsed.localStartTime,
    });
  } catch (err) {
    console.error('[calendar/google-import] reminder sync failed after import', {
      salonId,
      appointmentId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    appointmentId,
    clientId: createdClientId,
    clientCreated,
    alreadyImported: false,
  };
}

/** Exported for tests — phone digit identity. */
export { phoneDigitsKey };
