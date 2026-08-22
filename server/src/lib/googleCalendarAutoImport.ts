/**
 * GOOGLE-CAL-FAST-6 / FAST-8: Automatic Google Calendar pull import (pilot → Tatev).
 * Reuses manual-import execution/RPC and FAST-7D coverage/overlay helpers.
 * FAST-8: coverage clients + overlays only for overlay-eligible NEW events.
 * Pre-watermark / already-imported / cancelled skips must not create cards.
 * No Google writes. No AI. No staff inference from titles.
 * Default staff is salon-scoped Tatev/Tatevik resolved into provider_config.auto_import_staff_id.
 */

import { randomUUID } from 'node:crypto';
import {
  matchParsedCalendarEvent,
  loadSalonCalendarMatchCatalog,
  type CalendarMatchCatalog,
} from './calendarEventMatcher.js';
import {
  parseExternalCalendarEvent,
  resolveParserTimezone,
  type CalendarEventParsedPreview,
} from './calendarEventParser.js';
import {
  buildGoogleOccurrenceKey,
  buildGoogleOccurrenceRecurrenceId,
  executeManualGoogleCalendarImport,
  loadGoogleImportedOccurrenceKeys,
  suggestNewClientNameFromTitle,
  type ManualGoogleImportResult,
} from './googleCalendarImport.js';
import {
  GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY,
  GOOGLE_CALENDAR_PROVIDER,
  GoogleCalendarOAuthError,
  GOOGLE_EVENTS_PREVIEW_LOOKAHEAD_DAYS,
  listGoogleCalendarEventsForAutoPull,
  loadGoogleCalendarAppConfig,
  refreshGoogleAccessToken,
  type GoogleEventPreviewItem,
  type GoogleFetch,
} from './googleCalendarOAuth.js';
import { decryptCalendarCredential } from './calendarCredentialsCrypto.js';
import { getSalonTimezone } from './scheduleSlots.js';
import {
  googleSkipReasonNeedsCalendarOverlay,
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

export const GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY = 'auto_import_staff_id' as const;
/** ISO watermark: only events with Google `created` strictly after this instant are auto-imported. */
export const GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY = 'auto_import_since' as const;

/** Pilot interval: 5 minutes. */
export const GOOGLE_CALENDAR_PULL_INTERVAL_MS = 5 * 60 * 1000;

/** Stale lock reclaim window. */
export const GOOGLE_CALENDAR_PULL_LOCK_STALE_MS = 10 * 60 * 1000;

/** Scan cap per connection (read-only list). Imports are separately bounded. */
export const GOOGLE_CALENDAR_PULL_MAX_SCAN_EVENTS = 250;

/** Max successful/attempted imports per connection per tick. */
export const GOOGLE_CALENDAR_PULL_MAX_IMPORTS = 20;

/** Max enabled Google connections processed per tick. */
export const GOOGLE_CALENDAR_PULL_MAX_CONNECTIONS = 10;

/** Max events.list pages walked per connection per tick while collecting NEW events. */
export const GOOGLE_CALENDAR_PULL_MAX_LIST_PAGES = 20;

export { GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY } from './googleCalendarOAuth.js';

/** @deprecated Start-time lookback is no longer used for auto-pull discovery. */
export const GOOGLE_CALENDAR_PULL_START_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** @deprecated Prefer MAX_SCAN_EVENTS / MAX_IMPORTS. Kept as scan alias. */
export const GOOGLE_CALENDAR_PULL_MAX_EVENTS = GOOGLE_CALENDAR_PULL_MAX_SCAN_EVENTS;

export type GoogleAutoImportSkipReason =
  | 'already_imported'
  | 'cancelled'
  | 'all_day'
  | 'invalid_time'
  | 'overnight'
  | 'service_not_matched'
  | 'service_inactive_or_invalid'
  | 'client_ambiguous'
  | 'no_exact_phone'
  | 'unsafe_client_name'
  | 'staff_unresolved'
  | 'staff_invalid'
  | 'appointment_conflict'
  | 'import_disabled'
  | 'before_auto_import'
  | 'created_unknown'
  | 'google_event_changed'
  | 'google_event_not_found'
  | 'other';

export type GoogleAutoImportDecision =
  | {
      action: 'import';
      clientMode: 'existing' | 'new';
      clientId?: string;
      clientName?: string;
      serviceId: string;
      staffId: string;
    }
  | { action: 'skip'; reason: GoogleAutoImportSkipReason; detail?: string };

const TATEV_FIRST_NAMES = new Set([
  'tatev',
  'tatevik',
  'татев',
  'татевик',
]);

const NAME_WORD_RE = /^[\p{L}][\p{L}'’\-]*$/u;

/**
 * Multilingual service-like tokens (EN/RU/HY). Not a name dictionary —
 * used only to fail-closed auto client creation.
 */
const SERVICE_LIKE_TOKENS = new Set([
  'coloring',
  'colouring',
  'haircut',
  'manicure',
  'pedicure',
  'massage',
  'makeup',
  'lashes',
  'brows',
  'highlights',
  'highlight',
  'balayage',
  'keratin',
  'wax',
  'waxing',
  'окрашивание',
  'стрижка',
  'маникюр',
  'педикюр',
  'массаж',
  'макияж',
  'мелирование',
  'кератин',
  'воск',
  'депиляция',
  'ներկում',
  'կտրվածք',
  'մատնահարդարում',
  'ոտնահարդարում',
  'մերսում',
  'դիմահարդարում',
  'client',
  'клиент',
  'հաճախորդ',
  'test',
  'тест',
  'թեստ',
  'vip',
  'new',
  'новый',
  'новая',
  'новое',
  'նոր',
  'color',
  'colour',
  'consultation',
  'consult',
  'консультация',
  'խորհրդատվություն',
  'wedding',
  'свадьба',
  'հարսանիք',
  'appointment',
  'booking',
  'запись',
  'бронь',
  'hair',
  'волосы',
  'մազեր',
  'guest',
]);

function foldToken(value: string): string {
  return value.trim().toLowerCase();
}

function parseGoogleCredentialBlob(plaintext: string): { refresh_token: string } {
  const parsed = JSON.parse(plaintext) as { refresh_token?: string };
  if (!parsed.refresh_token?.trim()) throw new Error('missing refresh');
  return { refresh_token: parsed.refresh_token.trim() };
}

function readProviderConfig(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {};
}

export function readAutoImportStaffIdFromConfig(providerConfig: unknown): string | null {
  const cfg = readProviderConfig(providerConfig);
  const id = cfg[GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY];
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function readAutoImportSinceFromConfig(providerConfig: unknown): string | null {
  const cfg = readProviderConfig(providerConfig);
  const since = cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY];
  if (typeof since !== 'string' || !since.trim()) return null;
  const ms = Date.parse(since.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseStrictEnabledFlag(raw: unknown): boolean | null {
  if (raw === true) return true;
  if (raw === false) return false;
  return null;
}

export function buildGoogleAutoPullWindow(now: Date = new Date()): {
  timeMin: string;
  timeMax: string;
} {
  const start = new Date(now.getTime() - GOOGLE_CALENDAR_PULL_START_LOOKBACK_MS);
  const end = new Date(now.getTime());
  end.setUTCDate(end.getUTCDate() + GOOGLE_EVENTS_PREVIEW_LOOKAHEAD_DAYS);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

/**
 * New-event rule: Google `created` must be strictly after the enable watermark.
 * `updated` is ignored so editing an old event cannot become a new appointment.
 */
export function classifyAutoImportCreatedAt(params: {
  created: string | null | undefined;
  autoImportSince: string | null | undefined;
}): 'new' | 'before_auto_import' | 'created_unknown' {
  if (!params.autoImportSince) return 'created_unknown';
  if (!params.created?.trim()) return 'created_unknown';
  const createdMs = Date.parse(params.created);
  const sinceMs = Date.parse(params.autoImportSince);
  if (!Number.isFinite(createdMs) || !Number.isFinite(sinceMs)) return 'created_unknown';
  return createdMs > sinceMs ? 'new' : 'before_auto_import';
}

/** Worker queue: only events created after the enable watermark, oldest-created first. */
export function selectNewGoogleEventsForAutoPull(
  events: GoogleEventPreviewItem[],
  autoImportSince: string | null | undefined,
): GoogleEventPreviewItem[] {
  return events
    .filter(
      (ev) =>
        classifyAutoImportCreatedAt({
          created: ev.created,
          autoImportSince,
        }) === 'new',
    )
    .sort((a, b) => {
      const am = Date.parse(a.created || '');
      const bm = Date.parse(b.created || '');
      if (am !== bm) return am - bm;
      return a.id.localeCompare(b.id);
    });
}

export function readAutoImportPageTokenFromConfig(providerConfig: unknown): string | null {
  const cfg = readProviderConfig(providerConfig);
  const token = cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY];
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

export function googleEventOccurrenceKeys(ev: Pick<
  GoogleEventPreviewItem,
  'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'
>): string[] {
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(ev);
  const full = buildGoogleOccurrenceKey({
    calendarId: ev.calendarId || '',
    eventId: ev.id,
    recurrenceId,
  });
  return recurrenceId
    ? [full, ev.id, `${ev.id}:${recurrenceId}`]
    : [full, ev.id];
}

export function isImportedGoogleOccurrence(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>,
  importedKeys: Set<string>,
): boolean {
  return googleEventOccurrenceKeys(ev).some((k) => importedKeys.has(k));
}

/** Least-recently-synced enabled connections first — cheap multi-salon fairness. */
export function pickGooglePullConnections(
  rows: Array<{ id: string; salon_id: string; last_sync_at?: string | null }>,
  limit: number = GOOGLE_CALENDAR_PULL_MAX_CONNECTIONS,
): Array<{ id: string; salon_id: string }> {
  return rows
    .map((r) => ({
      id: typeof r?.id === 'string' ? r.id : '',
      salon_id: typeof r?.salon_id === 'string' ? r.salon_id : '',
      last_sync_at: typeof r?.last_sync_at === 'string' ? r.last_sync_at : null,
    }))
    .filter((r) => r.id && r.salon_id)
    .sort((a, b) => {
      const am = a.last_sync_at ? Date.parse(a.last_sync_at) : 0;
      const bm = b.last_sync_at ? Date.parse(b.last_sync_at) : 0;
      const aOk = Number.isFinite(am) ? am : 0;
      const bOk = Number.isFinite(bm) ? bm : 0;
      if (aOk !== bOk) return aOk - bOk;
      return a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, limit))
    .map(({ id, salon_id }) => ({ id, salon_id }));
}

/**
 * Pilot staff resolver: unique active salon staff whose first name token is Tatev/Tatevik.
 * Never returns a cross-salon id. Ambiguous/missing → null.
 */
export function isPilotTatevStaffName(name: string): boolean {
  const raw = name.trim().toLowerCase();
  if (!raw) return false;
  const first = raw.split(/\s+/)[0]?.replace(/[^\p{L}]/gu, '') ?? '';
  return TATEV_FIRST_NAMES.has(first);
}

export async function resolvePilotGoogleAutoImportStaff(
  db: any,
  salonId: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db
    .from('staff')
    .select('id, name')
    .eq('salon_id', salonId)
    .eq('active', true);
  if (error) {
    console.error('[calendar/google-auto] staff resolve failed', {
      salonId,
      message: error.message,
    });
    return null;
  }
  const matches = (Array.isArray(data) ? data : [])
    .map((r: any) => ({
      id: typeof r?.id === 'string' ? r.id : '',
      name: typeof r?.name === 'string' ? r.name : '',
    }))
    .filter((s: { id: string; name: string }) => s.id && isPilotTatevStaffName(s.name));

  if (matches.length !== 1) return null;
  return matches[0];
}

/**
 * Conservative auto-create name:
 * text before exact +phone, 2–4 letter words, no digits.
 * Rejects salon service tokens and multilingual service-like words.
 * Example: "Agunik Yeganian +380 … окрашивание…" → "Agunik Yeganian".
 */
export function extractSafeAutoClientName(params: {
  title: string | null | undefined;
  exactPhoneNormalized: string;
  serviceNames?: string[];
  serviceCandidate?: string | null;
}): string | null {
  const title = typeof params.title === 'string' ? params.title.trim() : '';
  if (!title) return null;
  const suggested = suggestNewClientNameFromTitle(title);
  if (!suggested) return null;
  if (/\d/.test(suggested)) return null;
  const words = suggested.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return null;
  if (!words.every((w) => NAME_WORD_RE.test(w))) return null;
  const digits = params.exactPhoneNormalized.replace(/\D/g, '');
  const titleDigits = title.replace(/\D/g, '');
  if (!digits || !titleDigits.includes(digits)) return null;

  const catalogTokens = new Set<string>();
  for (const name of params.serviceNames ?? []) {
    for (const part of foldToken(name).split(/\s+/).filter(Boolean)) {
      catalogTokens.add(part);
    }
  }
  for (const word of words) {
    const folded = foldToken(word);
    if (SERVICE_LIKE_TOKENS.has(folded) || catalogTokens.has(folded)) {
      return null;
    }
  }
  return suggested;
}

export function decideGoogleAutoImport(params: {
  parsed: CalendarEventParsedPreview;
  matching: ReturnType<typeof matchParsedCalendarEvent>;
  eventStatus: string | null | undefined;
  summary: string | null | undefined;
  staffId: string | null;
  alreadyImported: boolean;
  created?: string | null;
  autoImportSince?: string | null;
  serviceNames?: string[];
}): GoogleAutoImportDecision {
  if (params.alreadyImported) {
    return { action: 'skip', reason: 'already_imported' };
  }
  const createdClass = classifyAutoImportCreatedAt({
    created: params.created,
    autoImportSince: params.autoImportSince,
  });
  if (params.autoImportSince) {
    if (createdClass === 'before_auto_import') {
      return { action: 'skip', reason: 'before_auto_import' };
    }
    if (createdClass === 'created_unknown') {
      return { action: 'skip', reason: 'created_unknown' };
    }
  }
  if (!params.staffId) {
    return { action: 'skip', reason: 'staff_unresolved' };
  }
  const statusLower = (params.eventStatus || '').toLowerCase();
  if (statusLower === 'cancelled') {
    return { action: 'skip', reason: 'cancelled' };
  }
  const { parsed, matching } = params;
  if (parsed.classification.includes('all_day') || parsed.reasons.includes('all_day_event')) {
    return { action: 'skip', reason: 'all_day' };
  }
  if (
    !parsed.localDate ||
    !parsed.localStartTime ||
    !parsed.localEndTime ||
    parsed.durationMinutes == null ||
    parsed.durationMinutes <= 0
  ) {
    return { action: 'skip', reason: 'invalid_time' };
  }
  const [sh, sm] = parsed.localStartTime.split(':').map(Number);
  const [eh, em] = parsed.localEndTime.split(':').map(Number);
  if ((eh ?? 0) * 60 + (em ?? 0) <= (sh ?? 0) * 60 + (sm ?? 0)) {
    return { action: 'skip', reason: 'overnight' };
  }

  if (matching.service.status !== 'matched' || !matching.service.serviceId) {
    return { action: 'skip', reason: 'service_not_matched' };
  }

  if (matching.client.status === 'ambiguous') {
    return { action: 'skip', reason: 'client_ambiguous' };
  }

  if (matching.client.status === 'matched' && matching.client.clientId) {
    return {
      action: 'import',
      clientMode: 'existing',
      clientId: matching.client.clientId,
      serviceId: matching.service.serviceId,
      staffId: params.staffId,
    };
  }

  // not_found / not_attempted / possible → only auto-create with exact phone + safe name
  if (parsed.phone.confidence !== 'exact' || !parsed.phone.normalized) {
    return { action: 'skip', reason: 'no_exact_phone' };
  }
  if (matching.client.status !== 'not_found') {
    // possible/not_attempted without exact match → review
    return { action: 'skip', reason: 'client_ambiguous', detail: matching.client.status };
  }

  const safeName = extractSafeAutoClientName({
    title: params.summary,
    exactPhoneNormalized: parsed.phone.normalized,
    serviceNames: params.serviceNames,
    serviceCandidate: parsed.serviceCandidate,
  });
  if (!safeName) {
    return { action: 'skip', reason: 'unsafe_client_name' };
  }

  return {
    action: 'import',
    clientMode: 'new',
    clientName: safeName,
    serviceId: matching.service.serviceId,
    staffId: params.staffId,
  };
}

export async function setGoogleCalendarImportEnabled(params: {
  db: any;
  salonId: string;
  enabled: boolean;
}): Promise<{
  importEnabled: boolean;
  autoImportStaffId: string | null;
  autoImportStaffName: string | null;
}> {
  const salonId = params.salonId.trim();
  const { data: conn, error: connErr } = await params.db
    .from('calendar_connections')
    .select('id, status, selected_calendar_id, provider_config, import_enabled')
    .eq('salon_id', salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();

  if (connErr || !conn?.id) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_NOT_CONNECTED',
      'Google Calendar is not connected',
    );
  }
  if (!String(conn.selected_calendar_id || '').trim()) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_SELECTED',
      'Google calendar is not selected',
    );
  }

  const prev = readProviderConfig(conn.provider_config);
  let staffId = readAutoImportStaffIdFromConfig(prev);
  let staffName: string | null = null;

  if (params.enabled) {
    const resolved = await resolvePilotGoogleAutoImportStaff(params.db, salonId);
    if (!resolved) {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_AUTO_STAFF_UNRESOLVED',
        'Could not uniquely resolve active Tatev/Tatevik staff for this salon',
      );
    }
    staffId = resolved.id;
    staffName = resolved.name;
    prev[GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY] = resolved.id;
    // Watermark only on first enable / missing cursor so a repeat PUT true
    // cannot silently move the "new event" boundary.
    if (!conn.import_enabled || !readAutoImportSinceFromConfig(prev)) {
      prev[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY] = new Date().toISOString();
      delete prev[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY];
    }
  } else {
    delete prev[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY];
    if (staffId) {
      const { data: st } = await params.db
        .from('staff')
        .select('name')
        .eq('id', staffId)
        .eq('salon_id', salonId)
        .maybeSingle();
      staffName = typeof st?.name === 'string' ? st.name : null;
    }
  }

  const now = new Date().toISOString();
  const { error: updErr } = await params.db
    .from('calendar_connections')
    .update({
      import_enabled: params.enabled,
      provider_config: prev,
      last_error: null,
      updated_at: now,
    })
    .eq('id', conn.id)
    .eq('salon_id', salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER);

  if (updErr) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_SAVE_FAILED',
      'Could not update Google import setting',
    );
  }

  return {
    importEnabled: params.enabled,
    autoImportStaffId: staffId,
    autoImportStaffName: staffName,
  };
}

async function claimGooglePullLock(params: {
  db: any;
  connectionId: string;
  salonId: string;
  now?: Date;
}): Promise<string | null> {
  const now = params.now ?? new Date();
  const token = randomUUID();
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - GOOGLE_CALENDAR_PULL_LOCK_STALE_MS).toISOString();

  // Claim when unlocked or stale.
  const { data: row } = await params.db
    .from('calendar_connections')
    .select('id, sync_lock_token, last_sync_started_at')
    .eq('id', params.connectionId)
    .eq('salon_id', params.salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .eq('import_enabled', true)
    .maybeSingle();

  if (!row?.id) return null;

  const lockToken = row.sync_lock_token;
  const started = row.last_sync_started_at;
  const lockedFresh =
    typeof lockToken === 'string' &&
    lockToken.trim() &&
    typeof started === 'string' &&
    started > staleIso;
  if (lockedFresh) return null;

  const { data: claimed, error } = await params.db
    .from('calendar_connections')
    .update({
      sync_lock_token: token,
      last_sync_started_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', params.connectionId)
    .eq('salon_id', params.salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .eq('import_enabled', true)
    .or(
      `sync_lock_token.is.null,last_sync_started_at.is.null,last_sync_started_at.lte.${staleIso}`,
    )
    .select('id, sync_lock_token')
    .maybeSingle();

  if (error || !claimed || claimed.sync_lock_token !== token) {
    return null;
  }
  return token;
}

async function releaseGooglePullLock(params: {
  db: any;
  connectionId: string;
  salonId: string;
  token: string;
  lastError?: string | null;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await params.db
    .from('calendar_connections')
    .update({
      sync_lock_token: null,
      last_sync_at: nowIso,
      last_error: params.lastError ?? null,
      updated_at: nowIso,
    })
    .eq('id', params.connectionId)
    .eq('salon_id', params.salonId)
    .eq('sync_lock_token', params.token);
}

/** Merge page token only when the live connection is still the same auto-import session. */
export function mergeAutoImportPageTokenIfSameSession(params: {
  currentImportEnabled: boolean;
  currentCalendarId: string | null | undefined;
  currentProviderConfig: unknown;
  expectedWatermark: string;
  expectedCalendarId: string;
  pageToken: string | null;
}): Record<string, unknown> | null {
  if (!params.currentImportEnabled) return null;
  const currentCal = String(params.currentCalendarId || '').trim();
  const expectedCal = params.expectedCalendarId.trim();
  if (!currentCal || currentCal !== expectedCal) return null;
  const currentSince = readAutoImportSinceFromConfig(params.currentProviderConfig);
  const expectedSince = readAutoImportSinceFromConfig({
    [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: params.expectedWatermark,
  });
  if (!currentSince || !expectedSince || currentSince !== expectedSince) return null;
  const cfg = readProviderConfig(params.currentProviderConfig);
  if (params.pageToken?.trim()) {
    cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY] = params.pageToken.trim();
  } else {
    delete cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY];
  }
  return cfg;
}

export async function persistAutoImportPageToken(params: {
  db: any;
  connectionId: string;
  salonId: string;
  expectedWatermark: string;
  expectedCalendarId: string;
  pageToken: string | null;
}): Promise<boolean> {
  const { data: live, error } = await params.db
    .from('calendar_connections')
    .select('import_enabled, selected_calendar_id, provider_config')
    .eq('id', params.connectionId)
    .eq('salon_id', params.salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();
  if (error || !live) return false;

  const merged = mergeAutoImportPageTokenIfSameSession({
    currentImportEnabled: Boolean(live.import_enabled),
    currentCalendarId: live.selected_calendar_id,
    currentProviderConfig: live.provider_config,
    expectedWatermark: params.expectedWatermark,
    expectedCalendarId: params.expectedCalendarId,
    pageToken: params.pageToken,
  });
  if (!merged) return false;

  const nowIso = new Date().toISOString();
  const { error: updErr } = await params.db
    .from('calendar_connections')
    .update({ provider_config: merged, updated_at: nowIso })
    .eq('id', params.connectionId)
    .eq('salon_id', params.salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER);
  return !updErr;
}

export type GooglePullConnectionResult = {
  salonId: string;
  connectionId: string;
  scanned: number;
  imported: number;
  skipped: number;
  conflicts: number;
  errors: number;
  skippedByReason: Record<string, number>;
};

/**
 * Pull + auto-import one Google connection. Isolated; never throws to caller batch.
 */
export async function pullGoogleCalendarConnection(params: {
  db: any;
  salonId: string;
  connectionId: string;
  fetchImpl?: GoogleFetch;
  matchCatalog?: CalendarMatchCatalog;
  now?: Date;
  /** Test seam for import execution. */
  executeImport?: typeof executeManualGoogleCalendarImport;
  /** Test seam: skip Google list. */
  eventsOverride?: GoogleEventPreviewItem[];
  /** Test seam: disable mid-batch. */
  isStillEnabled?: () => Promise<boolean>;
  /** Test seam: avoid salon timezone network lookup. */
  salonTimeZone?: string;
}): Promise<GooglePullConnectionResult> {
  const summary: GooglePullConnectionResult = {
    salonId: params.salonId,
    connectionId: params.connectionId,
    scanned: 0,
    imported: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
    skippedByReason: {},
  };

  const bumpSkip = (reason: string) => {
    summary.skipped += 1;
    summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + 1;
  };

  const lockToken = await claimGooglePullLock({
    db: params.db,
    connectionId: params.connectionId,
    salonId: params.salonId,
    now: params.now,
  });
  if (!lockToken) {
    bumpSkip('lock_busy');
    return summary;
  }

  let lastError: string | null = null;
  try {
    const { data: conn, error: connErr } = await params.db
      .from('calendar_connections')
      .select(
        'id, salon_id, credential_ciphertext, credential_iv, credential_auth_tag, status, selected_calendar_id, selected_calendar_name, provider_config, import_enabled',
      )
      .eq('id', params.connectionId)
      .eq('salon_id', params.salonId)
      .eq('provider', GOOGLE_CALENDAR_PROVIDER)
      .maybeSingle();

    if (connErr || !conn?.id || !conn.import_enabled) {
      bumpSkip('import_disabled');
      return summary;
    }

    const calendarId = String(conn.selected_calendar_id || '').trim();
    if (!calendarId) {
      bumpSkip('calendar_not_selected');
      lastError = 'google_calendar_not_selected';
      return summary;
    }

    let staffId = readAutoImportStaffIdFromConfig(conn.provider_config);
    if (!staffId) {
      const resolved = await resolvePilotGoogleAutoImportStaff(params.db, params.salonId);
      staffId = resolved?.id ?? null;
    }
    if (!staffId) {
      bumpSkip('staff_unresolved');
      lastError = 'staff_unresolved';
      return summary;
    }

    // Revalidate staff still active in this salon.
    const { data: staffRow } = await params.db
      .from('staff')
      .select('id, name')
      .eq('id', staffId)
      .eq('salon_id', params.salonId)
      .eq('active', true)
      .maybeSingle();
    if (!staffRow?.id) {
      bumpSkip('staff_invalid');
      lastError = 'staff_invalid';
      return summary;
    }
    const staffName =
      typeof staffRow.name === 'string' && staffRow.name.trim()
        ? staffRow.name.trim()
        : 'Tatev';

    const watermark = readAutoImportSinceFromConfig(conn.provider_config);
    if (!watermark) {
      bumpSkip('created_unknown');
      lastError = 'auto_import_since_missing';
      return summary;
    }

    let importedKeys = new Set<string>();
    try {
      importedKeys = await loadGoogleImportedOccurrenceKeys(params.db, {
        salonId: params.salonId,
        calendarConnectionId: params.connectionId,
      });
    } catch (linkErr) {
      console.error('[calendar/google-auto] imported keys load failed', {
        salonId: params.salonId,
        connectionId: params.connectionId,
        message: linkErr instanceof Error ? linkErr.message : String(linkErr),
      });
      importedKeys = new Set();
    }

    const keepDiscoverable = (ev: GoogleEventPreviewItem) =>
      classifyAutoImportCreatedAt({
        created: ev.created,
        autoImportSince: watermark,
      }) === 'new' && !isImportedGoogleOccurrence(ev, importedKeys);

    let listedEvents: GoogleEventPreviewItem[];
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
        bumpSkip('credentials');
        lastError = 'google_credentials';
        return summary;
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
        bumpSkip('token_refresh');
        lastError = 'google_token_refresh_failed';
        return summary;
      }

      const listed = await listGoogleCalendarEventsForAutoPull({
        accessToken,
        calendarId,
        calendarName: conn.selected_calendar_name ?? null,
        updatedMin: watermark,
        fetchImpl: params.fetchImpl,
        maxPages: GOOGLE_CALENDAR_PULL_MAX_LIST_PAGES,
        maxKeepEvents: GOOGLE_CALENDAR_PULL_MAX_SCAN_EVENTS,
        pageToken: readAutoImportPageTokenFromConfig(conn.provider_config),
        keepEvent: keepDiscoverable,
      });
      listedEvents = listed.events;
      try {
        await persistAutoImportPageToken({
          db: params.db,
          connectionId: params.connectionId,
          salonId: params.salonId,
          expectedWatermark: watermark,
          expectedCalendarId: calendarId,
          pageToken: listed.nextPageToken,
        });
      } catch (persistErr) {
        console.error('[calendar/google-auto] page token persist failed', {
          salonId: params.salonId,
          connectionId: params.connectionId,
          message: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    }

    const events = selectNewGoogleEventsForAutoPull(listedEvents, watermark).filter(
      (ev) => !isImportedGoogleOccurrence(ev, importedKeys),
    );

    let salonTimeZone: string;
    if (params.salonTimeZone) {
      salonTimeZone = resolveParserTimezone(params.salonTimeZone);
    } else {
      try {
        salonTimeZone = resolveParserTimezone(await getSalonTimezone(params.salonId));
      } catch {
        salonTimeZone = resolveParserTimezone(undefined);
      }
    }

    const loadedCatalog =
      params.matchCatalog ??
      (await loadSalonCalendarMatchCatalog(params.db, params.salonId));
    const catalog = {
      clients: [...loadedCatalog.clients],
      services: loadedCatalog.services,
    };

    const executeImport = params.executeImport ?? executeManualGoogleCalendarImport;
    const serviceNames = catalog.services.map((s) => s.name);
    const clientSession: CoverageClientRecord[] = await loadGoogleCoverageClientSession({
      db: params.db,
      salonId: params.salonId,
      catalog,
    });
    let attemptedImports = 0;

    const ensureAutoCoverageClient = async (
      ev: GoogleEventPreviewItem,
      parsedClientName: string | null,
      phoneDigits: string,
    ): Promise<string | null> => {
      if (!isGoogleEventEligibleForSalonCalendarDisplay(ev)) return null;
      const rememberedClientId = await loadRememberedGoogleCoverageClientId({
        db: params.db,
        salonId: params.salonId,
        calendarConnectionId: params.connectionId,
        ev,
      });
      const resolved = await resolveOrCreateGoogleCoverageClient({
        db: params.db,
        salonId: params.salonId,
        session: clientSession,
        catalog,
        ev,
        displayName: pickGoogleCoverageDisplayName({
          clientNameCandidate: parsedClientName,
          title: ev.summary,
        }),
        phoneDigits,
        rememberedClientId,
      });
      return resolved?.clientId ?? null;
    };

    for (const ev of events) {
      summary.scanned += 1;
      let parsed: CalendarEventParsedPreview | undefined;
      let matching: ReturnType<typeof matchParsedCalendarEvent> | undefined;
      try {
        parsed = parseExternalCalendarEvent(
          {
            summary: ev.summary,
            description: ev.description,
            status: ev.status,
            start: ev.start,
            end: ev.end,
          },
          salonTimeZone,
        );
        matching = matchParsedCalendarEvent({
          parsed,
          originalTitle: ev.summary,
          catalog,
        });

        const decision = decideGoogleAutoImport({
          parsed,
          matching,
          eventStatus: ev.status,
          summary: ev.summary,
          staffId,
          alreadyImported: isImportedGoogleOccurrence(ev, importedKeys),
          created: ev.created,
          autoImportSince: watermark,
          serviceNames,
        });

        if (decision.action === 'skip') {
          bumpSkip(decision.reason);
          const needsCoverage = googleSkipReasonNeedsCalendarOverlay(decision.reason);
          const coverageClientId = needsCoverage
            ? await ensureAutoCoverageClient(
                ev,
                parsed.clientNameCandidate,
                parsed.phone.normalized || '',
              )
            : null;
          await persistGoogleReviewOrResolve({
            db: params.db,
            salonId: params.salonId,
            calendarConnectionId: params.connectionId,
            ev,
            reasonCode: decision.reason,
            staffId,
            staffName,
            salonTimeZone,
            matching,
            importedKeys,
            clientId: coverageClientId,
          });
          continue;
        }

        if (attemptedImports >= GOOGLE_CALENDAR_PULL_MAX_IMPORTS) {
          bumpSkip('import_bound');
          const coverageClientId = await ensureAutoCoverageClient(
            ev,
            parsed.clientNameCandidate,
            parsed.phone.normalized || '',
          );
          await persistGoogleReviewOrResolve({
            db: params.db,
            salonId: params.salonId,
            calendarConnectionId: params.connectionId,
            ev,
            reasonCode: 'import_bound',
            staffId,
            staffName,
            salonTimeZone,
            matching,
            importedKeys,
            clientId: coverageClientId,
          });
          continue;
        }

        const stillEnabled = params.isStillEnabled
          ? await params.isStillEnabled()
          : Boolean(
              (
                await params.db
                  .from('calendar_connections')
                  .select('import_enabled')
                  .eq('id', params.connectionId)
                  .eq('salon_id', params.salonId)
                  .eq('provider', GOOGLE_CALENDAR_PROVIDER)
                  .maybeSingle()
              )?.data?.import_enabled,
            );
        if (!stillEnabled) {
          bumpSkip('import_disabled');
          break;
        }
        attemptedImports += 1;

        const coverageClientId = await ensureAutoCoverageClient(
          ev,
          parsed.clientNameCandidate,
          parsed.phone.normalized || '',
        );
        const result: ManualGoogleImportResult = await executeImport({
          db: params.db,
          salonId: params.salonId,
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
          bumpSkip('already_imported');
          for (const key of googleEventOccurrenceKeys(ev)) importedKeys.add(key);
          await resolveGoogleCalendarReviewIssue({
            db: params.db,
            salonId: params.salonId,
            calendarConnectionId: params.connectionId,
            ev,
            appointmentId: result.appointmentId,
          });
        } else {
          summary.imported += 1;
          for (const key of googleEventOccurrenceKeys(ev)) importedKeys.add(key);
          await resolveGoogleCalendarReviewIssue({
            db: params.db,
            salonId: params.salonId,
            calendarConnectionId: params.connectionId,
            ev,
            appointmentId: result.appointmentId,
          });
        }
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: string }).code || 'other')
            : 'other';
        if (code === 'appointment_conflict') {
          summary.conflicts += 1;
          bumpSkip('appointment_conflict');
        } else if (code === 'google_event_already_imported') {
          bumpSkip('already_imported');
          await resolveGoogleCalendarReviewIssue({
            db: params.db,
            salonId: params.salonId,
            calendarConnectionId: params.connectionId,
            ev,
          });
        } else if (
          code === 'google_event_cancelled' ||
          code === 'google_event_not_importable' ||
          code === 'google_event_not_found' ||
          code === 'google_event_changed' ||
          code === 'client_ambiguous' ||
          code === 'client_review_required' ||
          code === 'client_blocked' ||
          code === 'service_invalid' ||
          code === 'service_review_required' ||
          code === 'staff_invalid' ||
          code === 'staff_required'
        ) {
          bumpSkip(code);
        } else {
          summary.errors += 1;
          bumpSkip('other');
          console.error('[calendar/google-auto] event import failed', {
            salonId: params.salonId,
            connectionId: params.connectionId,
            eventId: ev.id,
            code,
          });
        }
        if (code !== 'google_event_already_imported') {
          const needsCoverage = googleSkipReasonNeedsCalendarOverlay(code);
          const coverageClientId =
            needsCoverage && parsed
              ? await ensureAutoCoverageClient(
                  ev,
                  parsed.clientNameCandidate,
                  parsed.phone.normalized || '',
                )
              : null;
          await persistGoogleReviewOrResolve({
            db: params.db,
            salonId: params.salonId,
            calendarConnectionId: params.connectionId,
            ev,
            reasonCode: code,
            staffId,
            staffName,
            salonTimeZone,
            matching,
            importedKeys,
            clientId: coverageClientId,
          });
        }
      }
    }
  } catch (err) {
    summary.errors += 1;
    lastError = err instanceof Error ? err.message.slice(0, 200) : 'pull_failed';
    console.error('[calendar/google-auto] connection pull failed', {
      salonId: params.salonId,
      connectionId: params.connectionId,
      message: lastError,
    });
  } finally {
    try {
      await releaseGooglePullLock({
        db: params.db,
        connectionId: params.connectionId,
        salonId: params.salonId,
        token: lockToken,
        lastError,
      });
    } catch (releaseErr) {
      console.error('[calendar/google-auto] lock release failed', {
        salonId: params.salonId,
        connectionId: params.connectionId,
        message: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
  }

  return summary;
}

export type GooglePullBatchResult = {
  connections: number;
  imported: number;
  skipped: number;
  conflicts: number;
  errors: number;
  results: GooglePullConnectionResult[];
};

/** Process all Google connections with import_enabled=true. One failure does not stop others. */
export async function runGoogleCalendarPullBatch(params: {
  db: any;
  fetchImpl?: GoogleFetch;
  now?: Date;
  executeImport?: typeof executeManualGoogleCalendarImport;
}): Promise<GooglePullBatchResult> {
  const batch: GooglePullBatchResult = {
    connections: 0,
    imported: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
    results: [],
  };

  let rows: Array<{ id: string; salon_id: string }> = [];
  try {
    const { data, error } = await params.db
      .from('calendar_connections')
      .select('id, salon_id, last_sync_at')
      .eq('provider', GOOGLE_CALENDAR_PROVIDER)
      .eq('import_enabled', true)
      .eq('status', 'connected');
    if (error) {
      console.error('[calendar/google-auto] list connections failed', {
        message: error.message,
      });
      batch.errors += 1;
      return batch;
    }
    rows = pickGooglePullConnections(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('[calendar/google-auto] list connections exception', {
      message: err instanceof Error ? err.message : String(err),
    });
    batch.errors += 1;
    return batch;
  }

  batch.connections = rows.length;
  for (const row of rows) {
    try {
      const result = await pullGoogleCalendarConnection({
        db: params.db,
        salonId: row.salon_id,
        connectionId: row.id,
        fetchImpl: params.fetchImpl,
        now: params.now,
        executeImport: params.executeImport,
      });
      batch.results.push(result);
      batch.imported += result.imported;
      batch.skipped += result.skipped;
      batch.conflicts += result.conflicts;
      batch.errors += result.errors;
    } catch (err) {
      batch.errors += 1;
      console.error('[calendar/google-auto] connection iteration failed', {
        salonId: row.salon_id,
        connectionId: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return batch;
}
