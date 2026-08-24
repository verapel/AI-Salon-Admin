/**
 * GOOGLE-CAL-FAST-1: Google Calendar OAuth + calendar discovery/selection.
 * No event import. No appointment/client/reminder writes.
 */

import {
  decryptCalendarCredential,
  encryptCalendarCredential,
} from './calendarCredentialsCrypto.js';
import { getPublicAppOrigin } from './publicAppUrl.js';
import {
  instantToSalonLocal,
  parseExternalCalendarEvent,
  resolveParserTimezone,
  type CalendarEventParsedPreview,
} from './calendarEventParser.js';
import {
  loadSalonCalendarMatchCatalog,
  matchParsedCalendarEvent,
  type CalendarEventMatchingPreview,
  type CalendarMatchCatalog,
  type CalendarMatchingStatus,
} from './calendarEventMatcher.js';
import type {
  GoogleImportReadiness,
  ImportableStaffOption,
} from './googleCalendarImport.js';

/** Read-only calendar + OpenID email for account display. No write / Gmail / contacts. */
export const GOOGLE_CALENDAR_OAUTH_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

export const GOOGLE_CALENDAR_OAUTH_SCOPE = GOOGLE_CALENDAR_OAUTH_SCOPES.join(' ');

export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_CALENDAR_LIST_URL =
  'https://www.googleapis.com/calendar/v3/users/me/calendarList';

/** events.list base — append encodeURIComponent(calendarId) + '/events'. */
export const GOOGLE_CALENDAR_EVENTS_URL_PREFIX =
  'https://www.googleapis.com/calendar/v3/calendars/';

export const GOOGLE_CALENDAR_PROVIDER = 'google' as const;

/** FAST-6D/F: persisted events.list page cursor in provider_config. */
export const GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY = 'auto_import_page_token' as const;

/** Helper defaults (auto-pull / low-cap callers). Salon preview overrides these. */
export const GOOGLE_EVENTS_PREVIEW_MAX_PAGES = 10;
export const GOOGLE_EVENTS_PREVIEW_MAX_EVENTS = 500;
export const GOOGLE_EVENTS_PREVIEW_LOOKBACK_DAYS = 30;
/** FAST-6 auto-pull start-window lookahead only. Salon preview has no future timeMax. */
export const GOOGLE_EVENTS_PREVIEW_LOOKAHEAD_DAYS = 90;
/** Salon «Показать события»: same hard cap as manual sync. */
export const GOOGLE_EVENTS_SALON_PREVIEW_MAX_PAGES = 20;
export const GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS = 5000;

/**
 * Live salon-preview diagnostics only. Salon-local dates around the reported gap.
 * Not a product window and not a Google timeMin/timeMax.
 */
export const GOOGLE_PREVIEW_LIVE_TRACE_DATES = [
  '2026-08-20',
  '2026-08-21',
  '2026-08-22',
  '2026-08-23',
] as const;

export type GoogleCalendarOAuthErrorCode =
  | 'GOOGLE_OAUTH_NOT_CONFIGURED'
  | 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED'
  | 'GOOGLE_OAUTH_MISSING_REFRESH_TOKEN'
  | 'GOOGLE_OAUTH_CONNECTION_SAVE_FAILED'
  | 'GOOGLE_OAUTH_ENCRYPT_FAILED'
  | 'GOOGLE_OAUTH_DECRYPT_FAILED'
  | 'GOOGLE_OAUTH_NOT_CONNECTED'
  | 'GOOGLE_CALENDAR_LIST_FAILED'
  | 'GOOGLE_CALENDAR_NOT_FOUND'
  | 'GOOGLE_CALENDAR_SAVE_FAILED'
  | 'GOOGLE_CALENDAR_NOT_SELECTED'
  | 'GOOGLE_EVENTS_FETCH_FAILED'
  | 'GOOGLE_AUTO_STAFF_UNRESOLVED';

export class GoogleCalendarOAuthError extends Error {
  readonly code: GoogleCalendarOAuthErrorCode;

  constructor(code: GoogleCalendarOAuthErrorCode, message: string) {
    super(message);
    this.name = 'GoogleCalendarOAuthError';
    this.code = code;
  }
}

export type GoogleCalendarAppConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
};

export type GoogleTokenExchangeResult = {
  refreshToken: string;
  accessToken: string | null;
  expiresIn: number | null;
  scope: string | null;
  tokenType: string | null;
  idToken: string | null;
};

export type GoogleCalendarCredentialBlob = {
  refresh_token: string;
  scope: string;
  token_type: string;
};

export type GoogleCalendarListItem = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string | null;
  timeZone: string | null;
};

/** Normalized Google event start/end for preview (dateTime vs all-day date). */
export type GoogleEventTimePreview = {
  dateTime: string | null;
  date: string | null;
  timeZone: string | null;
  allDay: boolean;
};

/** Safe events.list preview DTO — no tokens, no attendees dump. */
export type GoogleEventPreviewItem = {
  id: string;
  iCalUID: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  status: string | null;
  start: GoogleEventTimePreview;
  end: GoogleEventTimePreview;
  recurringEventId: string | null;
  originalStartTime: GoogleEventTimePreview | null;
  created: string | null;
  updated: string | null;
  etag: string | null;
  htmlLink: string | null;
  calendarId: string;
  calendarName: string | null;
  /** GOOGLE-CAL-FAST-3B: deterministic parse preview (no import). */
  parsed?: CalendarEventParsedPreview;
  /** GOOGLE-CAL-FAST-4: salon-scoped read-only client/service matching (no writes). */
  matching?: CalendarEventMatchingPreview;
  /** Convenience mirror of matching.matchingStatus for UI. */
  matchingStatus?: CalendarMatchingStatus;
  /** GOOGLE-CAL-FAST-5B: manual import readiness (separate from parsed.importability). */
  importReadiness?: GoogleImportReadiness;
  /** GOOGLE-CAL-FAST-6: auto-pull eligibility when import_enabled. */
  autoImport?: {
    status: 'would_import' | 'skip' | 'already_imported';
    reason: string | null;
  };
};

export type GoogleEventsPreviewResult = {
  events: GoogleEventPreviewItem[];
  count: number;
  truncated: boolean;
  windowStart: string;
  windowEnd: string;
  calendarId: string;
  calendarName: string | null;
  /** Salon IANA timezone used for parsed local times (FAST-3B). */
  salonTimeZone?: string;
  /** Active salon staff for manual import selector (FAST-5B). */
  staffOptions?: ImportableStaffOption[];
  /** True when connection import_enabled and pilot staff configured. */
  autoImportEnabled?: boolean;
};

export type GoogleFetch = typeof fetch;

export function loadGoogleCalendarAppConfig(): GoogleCalendarAppConfig {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() ?? '';
  const explicitRedirect = process.env.GOOGLE_CALENDAR_REDIRECT_URI?.trim() ?? '';
  const origin = getPublicAppOrigin();
  const redirectUri =
    explicitRedirect ||
    (origin ? `${origin}/api/calendar/google/callback` : '');

  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_NOT_CONFIGURED',
      'Google Calendar OAuth is not configured',
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
  };
}

export function buildGoogleCalendarAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', params.state);
  return url.toString();
}

export function serializeGoogleCalendarCredentialBlob(
  blob: GoogleCalendarCredentialBlob,
): string {
  return JSON.stringify({
    refresh_token: blob.refresh_token,
    scope: blob.scope,
    token_type: blob.token_type,
  });
}

export function parseGoogleCalendarCredentialBlob(
  plaintext: string,
): GoogleCalendarCredentialBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_DECRYPT_FAILED',
      'Credential blob is invalid',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_DECRYPT_FAILED',
      'Credential blob is invalid',
    );
  }
  const raw = parsed as Record<string, unknown>;
  const refresh =
    typeof raw.refresh_token === 'string' ? raw.refresh_token.trim() : '';
  if (!refresh) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_DECRYPT_FAILED',
      'Credential blob is missing refresh token',
    );
  }
  return {
    refresh_token: refresh,
    scope:
      typeof raw.scope === 'string' && raw.scope.trim()
        ? raw.scope.trim()
        : GOOGLE_CALENDAR_OAUTH_SCOPE,
    token_type:
      typeof raw.token_type === 'string' && raw.token_type.trim()
        ? raw.token_type.trim()
        : 'Bearer',
  };
}

export function parseGoogleTokenResponse(body: unknown): GoogleTokenExchangeResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      'Token response is invalid',
    );
  }
  const raw = body as Record<string, unknown>;
  const refreshToken =
    typeof raw.refresh_token === 'string' ? raw.refresh_token.trim() : '';
  if (!refreshToken) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_MISSING_REFRESH_TOKEN',
      'Refresh token was not returned',
    );
  }
  return {
    refreshToken,
    accessToken:
      typeof raw.access_token === 'string' && raw.access_token.trim()
        ? raw.access_token.trim()
        : null,
    expiresIn:
      typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)
        ? raw.expires_in
        : null,
    scope: typeof raw.scope === 'string' ? raw.scope.trim() || null : null,
    tokenType: typeof raw.token_type === 'string' ? raw.token_type.trim() || null : null,
    idToken: typeof raw.id_token === 'string' ? raw.id_token.trim() || null : null,
  };
}

function asSafeLogString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asSafeLogNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Safe Google token-error fields only. Never logs tokens, secrets, headers, or raw bodies. */
function logGoogleOAuthTokenFailure(status: number, json: unknown): void {
  const raw = asPlainObject(json);
  console.error({
    operation: 'google_oauth_token_refresh',
    googleHttpStatus: status,
    googleError: raw ? asSafeLogString(raw.error) : null,
    googleErrorDescription: raw ? asSafeLogString(raw.error_description) : null,
  });
}

/** Safe calendarList error fields only. Never logs tokens, secrets, headers, or raw bodies. */
function logGoogleCalendarListFailure(status: number, json: unknown): void {
  const raw = asPlainObject(json);
  const errorObj = raw ? (asPlainObject(raw.error) ?? raw) : null;
  let googleReason: string | null = null;
  const errors = errorObj?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = asPlainObject(errors[0]);
    googleReason = first ? asSafeLogString(first.reason) : null;
  }
  console.error({
    operation: 'google_calendar_list',
    googleHttpStatus: status,
    googleErrorCode: errorObj
      ? (asSafeLogNumber(errorObj.code) ?? asSafeLogString(errorObj.code))
      : null,
    googleErrorStatus: errorObj ? asSafeLogString(errorObj.status) : null,
    googleErrorMessage: errorObj ? asSafeLogString(errorObj.message) : null,
    googleReason,
  });
}

async function postTokenForm(
  body: Record<string, string>,
  fetchImpl: GoogleFetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      'Token request failed',
    );
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    logGoogleOAuthTokenFailure(response.status, json);
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      'Token request failed',
    );
  }
  return json;
}

export async function exchangeGoogleAuthorizationCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: GoogleFetch;
}): Promise<GoogleTokenExchangeResult> {
  const code = params.code.trim();
  if (!code) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      'Authorization code is required',
    );
  }
  const json = await postTokenForm(
    {
      code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    },
    params.fetchImpl ?? fetch,
  );
  return parseGoogleTokenResponse(json);
}

export async function refreshGoogleAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: GoogleFetch;
}): Promise<{ accessToken: string; expiresIn: number | null }> {
  const json = await postTokenForm(
    {
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: 'refresh_token',
    },
    params.fetchImpl ?? fetch,
  );
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      'Refresh token response is invalid',
    );
  }
  const raw = json as Record<string, unknown>;
  const accessToken =
    typeof raw.access_token === 'string' ? raw.access_token.trim() : '';
  if (!accessToken) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      'Access token was not returned',
    );
  }
  return {
    accessToken,
    expiresIn:
      typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)
        ? raw.expires_in
        : null,
  };
}

/**
 * Fetch verified email via OpenID userinfo using a short-lived access token.
 * Returns null if unavailable (connection still valid without email).
 */
export async function fetchGoogleAccountEmail(params: {
  accessToken: string;
  fetchImpl?: GoogleFetch;
}): Promise<string | null> {
  const token = params.accessToken.trim();
  if (!token) return null;
  const fetchImpl = params.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_OAUTH_USERINFO_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const raw = json as Record<string, unknown>;
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  const verified = raw.email_verified === true || raw.email_verified === 'true';
  if (!email || !verified) return null;
  return email;
}

export function mapGoogleCalendarListEntry(raw: unknown): GoogleCalendarListItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  const summary =
    typeof row.summary === 'string' && row.summary.trim()
      ? row.summary.trim()
      : id;
  return {
    id,
    summary,
    primary: row.primary === true,
    accessRole: typeof row.accessRole === 'string' ? row.accessRole : null,
    timeZone: typeof row.timeZone === 'string' ? row.timeZone : null,
  };
}

export async function listGoogleCalendars(params: {
  accessToken: string;
  fetchImpl?: GoogleFetch;
}): Promise<GoogleCalendarListItem[]> {
  const token = params.accessToken.trim();
  if (!token) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_LIST_FAILED',
      'Access token is required',
    );
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const results: GoogleCalendarListItem[] = [];
  let pageToken: string | null = null;

  do {
    const url = new URL(GOOGLE_CALENDAR_LIST_URL);
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('minAccessRole', 'reader');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_CALENDAR_LIST_FAILED',
        'Calendar list request failed',
      );
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      logGoogleCalendarListFailure(response.status, json);
      throw new GoogleCalendarOAuthError(
        'GOOGLE_CALENDAR_LIST_FAILED',
        'Calendar list request failed',
      );
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_CALENDAR_LIST_FAILED',
        'Calendar list response is invalid',
      );
    }
    const body = json as Record<string, unknown>;
    const items = Array.isArray(body.items) ? body.items : [];
    for (const item of items) {
      const mapped = mapGoogleCalendarListEntry(item);
      if (mapped) results.push(mapped);
    }
    pageToken =
      typeof body.nextPageToken === 'string' && body.nextPageToken.trim()
        ? body.nextPageToken.trim()
        : null;
  } while (pageToken);

  return results;
}

export async function persistGoogleCalendarConnection(params: {
  db: any;
  salonId: string;
  refreshToken: string;
  scope: string | null;
  tokenType: string | null;
  accountEmail?: string | null;
  nowIso?: string;
}): Promise<{ id: string }> {
  const salonId = params.salonId.trim();
  if (!salonId) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_CONNECTION_SAVE_FAILED',
      'salonId is required',
    );
  }
  const refreshToken = params.refreshToken.trim();
  if (!refreshToken) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_MISSING_REFRESH_TOKEN',
      'Refresh token is required',
    );
  }

  const blob: GoogleCalendarCredentialBlob = {
    refresh_token: refreshToken,
    scope: (params.scope && params.scope.trim()) || GOOGLE_CALENDAR_OAUTH_SCOPE,
    token_type: (params.tokenType && params.tokenType.trim()) || 'Bearer',
  };

  let encrypted: { ciphertext: string; iv: string; authTag: string };
  try {
    encrypted = encryptCalendarCredential(serializeGoogleCalendarCredentialBlob(blob));
  } catch {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_ENCRYPT_FAILED',
      'Credential encryption failed',
    );
  }

  const now = params.nowIso ?? new Date().toISOString();
  const accountEmail =
    typeof params.accountEmail === 'string' && params.accountEmail.trim()
      ? params.accountEmail.trim()
      : null;

  const upsertRow = {
    salon_id: salonId,
    provider: GOOGLE_CALENDAR_PROVIDER,
    account_email: accountEmail,
    credential_ciphertext: encrypted.ciphertext,
    credential_iv: encrypted.iv,
    credential_auth_tag: encrypted.authTag,
    status: 'connected',
    import_enabled: false,
    last_error: null,
    selected_calendar_id: null,
    selected_calendar_url: null,
    selected_calendar_name: null,
    last_sync_at: null,
    last_sync_started_at: null,
    sync_lock_token: null,
    provider_config: {
      oauth: {
        scope: blob.scope,
        authorizedAt: now,
      },
    },
    updated_at: now,
  };

  const { data, error } = await params.db
    .from('calendar_connections')
    .upsert(upsertRow, { onConflict: 'salon_id,provider' })
    .select('id')
    .maybeSingle();

  if (error || !data?.id) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_CONNECTION_SAVE_FAILED',
      'Could not store Google Calendar connection',
    );
  }

  return { id: String(data.id) };
}

type GoogleConnectionCredentialRow = {
  id: string;
  credential_ciphertext: string | null;
  credential_iv: string | null;
  credential_auth_tag: string | null;
  status: string;
  selected_calendar_id: string | null;
  selected_calendar_name: string | null;
  provider_config: unknown;
};

async function loadGoogleConnectionCredentialRow(
  db: any,
  salonId: string,
): Promise<GoogleConnectionCredentialRow> {
  const { data, error } = await db
    .from('calendar_connections')
    .select(
      'id, credential_ciphertext, credential_iv, credential_auth_tag, status, selected_calendar_id, selected_calendar_name, provider_config',
    )
    .eq('salon_id', salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();

  if (error) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_NOT_CONNECTED',
      'Google Calendar is not connected',
    );
  }
  if (!data) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_NOT_CONNECTED',
      'Google Calendar is not connected',
    );
  }
  const row = data as GoogleConnectionCredentialRow;
  if (
    !row.credential_ciphertext?.trim() ||
    !row.credential_iv?.trim() ||
    !row.credential_auth_tag?.trim()
  ) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_NOT_CONNECTED',
      'Google Calendar is not connected',
    );
  }
  return row;
}

function decryptGoogleRefreshToken(row: GoogleConnectionCredentialRow): string {
  try {
    const plaintext = decryptCalendarCredential({
      ciphertext: row.credential_ciphertext!,
      iv: row.credential_iv!,
      authTag: row.credential_auth_tag!,
    });
    return parseGoogleCalendarCredentialBlob(plaintext).refresh_token;
  } catch {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_DECRYPT_FAILED',
      'Could not decrypt Google credentials',
    );
  }
}

export async function listGoogleCalendarsForSalon(params: {
  db: any;
  salonId: string;
  fetchImpl?: GoogleFetch;
}): Promise<GoogleCalendarListItem[]> {
  const config = loadGoogleCalendarAppConfig();
  const row = await loadGoogleConnectionCredentialRow(params.db, params.salonId);
  const refreshToken = decryptGoogleRefreshToken(row);
  const { accessToken } = await refreshGoogleAccessToken({
    refreshToken,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetchImpl: params.fetchImpl,
  });
  return listGoogleCalendars({
    accessToken,
    fetchImpl: params.fetchImpl,
  });
}

/** Calendar change must drop the previous events.list page cursor. */
export function applyCalendarSelectProviderConfig(
  prevConfig: unknown,
  selectedCalendar: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> =
    prevConfig && typeof prevConfig === 'object' && !Array.isArray(prevConfig)
      ? { ...(prevConfig as Record<string, unknown>) }
      : {};
  next.selectedCalendar = selectedCalendar;
  delete next[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY];
  return next;
}

export async function selectGoogleCalendarForSalon(params: {
  db: any;
  salonId: string;
  calendarId: string;
  fetchImpl?: GoogleFetch;
}): Promise<{ selectedCalendarId: string; selectedCalendarName: string }> {
  const calendarId = params.calendarId.trim();
  if (!calendarId) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_FOUND',
      'calendarId is required',
    );
  }

  const calendars = await listGoogleCalendarsForSalon({
    db: params.db,
    salonId: params.salonId,
    fetchImpl: params.fetchImpl,
  });
  const match = calendars.find((c) => c.id === calendarId);
  if (!match) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_FOUND',
      'Calendar was not found for this Google account',
    );
  }

  const now = new Date().toISOString();
  const { data: existing } = await params.db
    .from('calendar_connections')
    .select('provider_config')
    .eq('salon_id', params.salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();

  const prevConfig =
    existing?.provider_config &&
    typeof existing.provider_config === 'object' &&
    !Array.isArray(existing.provider_config)
      ? (existing.provider_config as Record<string, unknown>)
      : {};

  const provider_config = applyCalendarSelectProviderConfig(prevConfig, {
    id: match.id,
    summary: match.summary,
    timeZone: match.timeZone,
    primary: match.primary,
    accessRole: match.accessRole,
    selectedAt: now,
  });

  const { error } = await params.db
    .from('calendar_connections')
    .update({
      selected_calendar_id: match.id,
      selected_calendar_name: match.summary,
      selected_calendar_url: null,
      import_enabled: false,
      last_error: null,
      provider_config,
      updated_at: now,
    })
    .eq('salon_id', params.salonId)
    .eq('provider', GOOGLE_CALENDAR_PROVIDER);

  if (error) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_SAVE_FAILED',
      'Could not save selected calendar',
    );
  }

  return {
    selectedCalendarId: match.id,
    selectedCalendarName: match.summary,
  };
}

/**
 * Salon preview listing window: same coverage as manual sync.
 * [start of UTC day 30 calendar days ago, +∞). No future timeMax.
 */
export function buildGoogleEventsPreviewWindow(now: Date = new Date()): {
  timeMin: string;
  timeMax?: string;
} {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - GOOGLE_EVENTS_PREVIEW_LOOKBACK_DAYS);
  return {
    timeMin: start.toISOString(),
  };
}

export function buildGoogleCalendarEventsListUrl(params: {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  pageToken?: string | null;
  maxResults?: number;
  /** Preview stays startTime. Auto-pull uses updated + updatedMin (no start-time window). */
  orderBy?: 'startTime' | 'updated';
  /** Lower bound for event last-modification time (RFC3339). */
  updatedMin?: string | null;
}): string {
  const calendarId = params.calendarId.trim();
  if (!calendarId) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_SELECTED',
      'Calendar is not selected',
    );
  }
  const url = new URL(
    `${GOOGLE_CALENDAR_EVENTS_URL_PREFIX}${encodeURIComponent(calendarId)}/events`,
  );
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', params.orderBy === 'updated' ? 'updated' : 'startTime');
  url.searchParams.set('showDeleted', 'false');
  if (params.timeMin) url.searchParams.set('timeMin', params.timeMin);
  if (params.timeMax) url.searchParams.set('timeMax', params.timeMax);
  if (params.updatedMin?.trim()) {
    url.searchParams.set('updatedMin', params.updatedMin.trim());
  }
  url.searchParams.set(
    'maxResults',
    String(params.maxResults && params.maxResults > 0 ? params.maxResults : 250),
  );
  if (params.pageToken?.trim()) {
    url.searchParams.set('pageToken', params.pageToken.trim());
  }
  return url.toString();
}

export function mapGoogleEventTimePreview(raw: unknown): GoogleEventTimePreview {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { dateTime: null, date: null, timeZone: null, allDay: false };
  }
  const row = raw as Record<string, unknown>;
  const dateTime =
    typeof row.dateTime === 'string' && row.dateTime.trim()
      ? row.dateTime.trim()
      : null;
  const date =
    typeof row.date === 'string' && row.date.trim() ? row.date.trim() : null;
  const timeZone =
    typeof row.timeZone === 'string' && row.timeZone.trim()
      ? row.timeZone.trim()
      : null;
  return {
    dateTime,
    date,
    timeZone,
    allDay: Boolean(date) && !dateTime,
  };
}

export function mapGoogleEventPreviewEntry(
  raw: unknown,
  calendarId: string,
  calendarName: string | null,
): GoogleEventPreviewItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;

  const originalStart =
    row.originalStartTime !== undefined && row.originalStartTime !== null
      ? mapGoogleEventTimePreview(row.originalStartTime)
      : null;

  return {
    id,
    iCalUID:
      typeof row.iCalUID === 'string' && row.iCalUID.trim()
        ? row.iCalUID.trim()
        : null,
    summary:
      typeof row.summary === 'string' && row.summary.trim()
        ? row.summary.trim()
        : typeof row.summary === 'string'
          ? row.summary
          : null,
    description:
      typeof row.description === 'string' ? row.description : null,
    location: typeof row.location === 'string' ? row.location : null,
    status: typeof row.status === 'string' ? row.status : null,
    start: mapGoogleEventTimePreview(row.start),
    end: mapGoogleEventTimePreview(row.end),
    recurringEventId:
      typeof row.recurringEventId === 'string' && row.recurringEventId.trim()
        ? row.recurringEventId.trim()
        : null,
    originalStartTime: originalStart,
    created: typeof row.created === 'string' && row.created.trim() ? row.created.trim() : null,
    updated: typeof row.updated === 'string' ? row.updated : null,
    etag: typeof row.etag === 'string' ? row.etag : null,
    htmlLink: typeof row.htmlLink === 'string' ? row.htmlLink : null,
    calendarId,
    calendarName,
  };
}

export type GoogleEventsListPage = {
  pageIndex: number;
  pageTokenUsed: string | null;
  nextPageToken: string | null;
  events: GoogleEventPreviewItem[];
};

/**
 * GOOGLE-CAL-FAST-2: Read-only events.list preview for a selected calendar.
 * No syncToken. No DB writes. Caps pages/events.
 */
export async function listGoogleCalendarEventsPreview(params: {
  accessToken: string;
  calendarId: string;
  calendarName?: string | null;
  timeMin: string;
  timeMax?: string;
  fetchImpl?: GoogleFetch;
  maxPages?: number;
  maxEvents?: number;
  orderBy?: 'startTime' | 'updated';
  onPage?: (page: GoogleEventsListPage) => void | Promise<void>;
  /**
   * Salon preview live-trace only. One callback per fetched events.list page.
   * Receives Google items[] length before mapping. Never pass this from sync/backfill.
   */
  onPreviewLiveTracePage?: (
    page: GooglePreviewLiveTracePage,
  ) => void | Promise<void>;
}): Promise<{ events: GoogleEventPreviewItem[]; truncated: boolean }> {
  const token = params.accessToken.trim();
  if (!token) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_EVENTS_FETCH_FAILED',
      'Access token is required',
    );
  }
  const calendarId = params.calendarId.trim();
  if (!calendarId) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_SELECTED',
      'Calendar is not selected',
    );
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const maxPages = params.maxPages ?? GOOGLE_EVENTS_PREVIEW_MAX_PAGES;
  const maxEvents = params.maxEvents ?? GOOGLE_EVENTS_PREVIEW_MAX_EVENTS;
  const calendarName = params.calendarName ?? null;
  const events: GoogleEventPreviewItem[] = [];
  let pageToken: string | null = null;
  let pages = 0;
  let truncated = false;

  do {
    if (pages >= maxPages || events.length >= maxEvents) {
      truncated = true;
      break;
    }
    pages += 1;

    const remaining = maxEvents - events.length;
    const pageSize = Math.min(250, remaining);
    const url = buildGoogleCalendarEventsListUrl({
      calendarId,
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      pageToken,
      maxResults: pageSize,
      orderBy: params.orderBy,
    });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_EVENTS_FETCH_FAILED',
        'Events list request failed',
      );
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_EVENTS_FETCH_FAILED',
        'Events list request failed',
      );
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_EVENTS_FETCH_FAILED',
        'Events list response is invalid',
      );
    }

    const body = json as Record<string, unknown>;
    const items = Array.isArray(body.items) ? body.items : [];
    const pageEvents: GoogleEventPreviewItem[] = [];
    const pageTokenUsed = pageToken;
    for (const item of items) {
      if (events.length >= maxEvents) {
        truncated = true;
        break;
      }
      const mapped = mapGoogleEventPreviewEntry(item, calendarId, calendarName);
      if (mapped) {
        events.push(mapped);
        pageEvents.push(mapped);
      }
    }

    pageToken =
      typeof body.nextPageToken === 'string' && body.nextPageToken.trim()
        ? body.nextPageToken.trim()
        : null;

    if (params.onPage) {
      await params.onPage({
        pageIndex: pages,
        pageTokenUsed,
        nextPageToken: pageToken,
        events: pageEvents,
      });
    }

    if (params.onPreviewLiveTracePage) {
      const starts: string[] = [];
      const rawTimedStarts: string[] = [];
      for (const item of items) {
        const startVal = googlePreviewRawItemStartValue(item);
        if (startVal) starts.push(startVal);
        const timed = googlePreviewRawItemTimedStart(item);
        if (timed) rawTimedStarts.push(timed);
      }
      await params.onPreviewLiveTracePage({
        pageNumber: pages,
        itemsOnPage: items.length,
        hasNextPageToken: Boolean(pageToken),
        firstEventStart: starts[0] ?? null,
        lastEventStart: starts.length ? starts[starts.length - 1]! : null,
        rawTimedStarts,
      });
    }

    if (pageToken && (pages >= maxPages || events.length >= maxEvents)) {
      truncated = true;
      break;
    }
  } while (pageToken);

  return { events, truncated };
}

/** Stable Google occurrence identity — never date/client/match keys. */
export function googlePreviewItemIdentity(
  ev: Pick<GoogleEventPreviewItem, 'id' | 'start'>,
): string {
  return `${ev.id}::${ev.start.dateTime || ev.start.date || ''}`;
}

/** events.list item start (dateTime or date). No summary/title. */
export function googlePreviewRawItemStartValue(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const start = (item as { start?: unknown }).start;
  if (!start || typeof start !== 'object' || Array.isArray(start)) return null;
  const row = start as { dateTime?: unknown; date?: unknown };
  if (typeof row.dateTime === 'string' && row.dateTime.trim()) return row.dateTime.trim();
  if (typeof row.date === 'string' && row.date.trim()) return row.date.trim();
  return null;
}

/** Timed start only (dateTime). All-day date is ignored. */
export function googlePreviewRawItemTimedStart(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const start = (item as { start?: unknown }).start;
  if (!start || typeof start !== 'object' || Array.isArray(start)) return null;
  const dateTime = (start as { dateTime?: unknown }).dateTime;
  return typeof dateTime === 'string' && dateTime.trim() ? dateTime.trim() : null;
}

export function googlePreviewTimedLocalDateKey(
  dateTime: string,
  timeZone: string,
): string | null {
  return instantToSalonLocal(dateTime, timeZone)?.date ?? null;
}

export type GooglePreviewLiveTracePage = {
  pageNumber: number;
  itemsOnPage: number;
  hasNextPageToken: boolean;
  firstEventStart: string | null;
  lastEventStart: string | null;
  /** In-memory aggregation only — never logged. */
  rawTimedStarts: string[];
};

function emitGooglePreviewLiveTrace(payload: Record<string, unknown>): void {
  console.error(payload);
}

/** 410 always; 400 only when the body points at a bad pageToken. */
export function isRecoverableGooglePageTokenError(
  status: number,
  json: unknown,
): boolean {
  if (status === 410) return true;
  if (status !== 400) return false;
  const text = JSON.stringify(json ?? '').toLowerCase();
  return text.includes('pagetoken') || text.includes('page token');
}

/**
 * FAST-6D: Auto-pull discovery list.
 * Uses updatedMin (Google created/updated after enable), not appointment start/end.
 * Paginates and keeps only caller-selected events so a first page of old
 * updated-ascending rows cannot hide a later new event in the same walk.
 */
export async function listGoogleCalendarEventsForAutoPull(params: {
  accessToken: string;
  calendarId: string;
  calendarName?: string | null;
  updatedMin: string;
  fetchImpl?: GoogleFetch;
  maxPages?: number;
  maxKeepEvents?: number;
  pageToken?: string | null;
  keepEvent: (event: GoogleEventPreviewItem) => boolean;
}): Promise<{
  events: GoogleEventPreviewItem[];
  nextPageToken: string | null;
  pages: number;
  scannedRaw: number;
  truncated: boolean;
}> {
  const token = params.accessToken.trim();
  if (!token) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_EVENTS_FETCH_FAILED',
      'Access token is required',
    );
  }
  const calendarId = params.calendarId.trim();
  if (!calendarId) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_SELECTED',
      'Calendar is not selected',
    );
  }
  const updatedMin = params.updatedMin.trim();
  if (!updatedMin) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_EVENTS_FETCH_FAILED',
      'updatedMin is required',
    );
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const maxPages = params.maxPages ?? GOOGLE_EVENTS_PREVIEW_MAX_PAGES;
  const maxKeep = params.maxKeepEvents ?? GOOGLE_EVENTS_PREVIEW_MAX_EVENTS;
  const calendarName = params.calendarName ?? null;
  const kept: GoogleEventPreviewItem[] = [];
  let pageToken: string | null = params.pageToken?.trim() || null;
  let pages = 0;
  let scannedRaw = 0;
  let retriedExpiredToken = false;

  while (pages < maxPages && kept.length < maxKeep) {
    pages += 1;
    const url = buildGoogleCalendarEventsListUrl({
      calendarId,
      pageToken,
      maxResults: 250,
      orderBy: 'updated',
      updatedMin,
    });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_EVENTS_FETCH_FAILED',
        'Events list request failed',
      );
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (
      pageToken &&
      !retriedExpiredToken &&
      isRecoverableGooglePageTokenError(response.status, json)
    ) {
      retriedExpiredToken = true;
      pageToken = null;
      pages -= 1;
      continue;
    }

    if (!response.ok) {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_EVENTS_FETCH_FAILED',
        'Events list request failed',
      );
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new GoogleCalendarOAuthError(
        'GOOGLE_EVENTS_FETCH_FAILED',
        'Events list response is invalid',
      );
    }

    const body = json as Record<string, unknown>;
    const items = Array.isArray(body.items) ? body.items : [];
    for (const item of items) {
      const mapped = mapGoogleEventPreviewEntry(item, calendarId, calendarName);
      if (!mapped) continue;
      scannedRaw += 1;
      if (params.keepEvent(mapped) && kept.length < maxKeep) {
        kept.push(mapped);
      }
    }

    pageToken =
      typeof body.nextPageToken === 'string' && body.nextPageToken.trim()
        ? body.nextPageToken.trim()
        : null;
    if (!pageToken) break;
  }

  return {
    events: kept,
    nextPageToken: pageToken,
    pages,
    scannedRaw,
    truncated: Boolean(pageToken) || kept.length >= maxKeep,
  };
}

export async function previewGoogleCalendarEventsForSalon(params: {
  db: any;
  salonId: string;
  fetchImpl?: GoogleFetch;
  now?: Date;
  /** Pre-resolved salon IANA timezone (preferred; keeps preview testable without Supabase). */
  salonTimeZone?: string;
  /** Optional loader when salonTimeZone is omitted. */
  getSalonTimeZone?: (salonId: string) => Promise<string>;
  /**
   * GOOGLE-CAL-FAST-4: optional in-memory match catalog (tests / injection).
   * When omitted, loads salon clients+services once (read-only) via db.
   */
  matchCatalog?: CalendarMatchCatalog;
  loadMatchCatalog?: (salonId: string) => Promise<CalendarMatchCatalog>;
}): Promise<GoogleEventsPreviewResult> {
  const config = loadGoogleCalendarAppConfig();
  let row: GoogleConnectionCredentialRow;
  try {
    row = await loadGoogleConnectionCredentialRow(params.db, params.salonId);
  } catch (err) {
    if (err instanceof GoogleCalendarOAuthError) throw err;
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_NOT_CONNECTED',
      'Google Calendar is not connected',
    );
  }

  const calendarId = row.selected_calendar_id?.trim() ?? '';
  if (!calendarId) {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_CALENDAR_NOT_SELECTED',
      'Google calendar is not selected',
    );
  }

  let refreshToken: string;
  try {
    refreshToken = decryptGoogleRefreshToken(row);
  } catch {
    throw new GoogleCalendarOAuthError(
      'GOOGLE_OAUTH_DECRYPT_FAILED',
      'Could not decrypt Google credentials',
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
      'Could not refresh Google access token',
    );
  }

  const window = buildGoogleEventsPreviewWindow(params.now ?? new Date());
  const calendarName = row.selected_calendar_name?.trim() || null;

  // GOOGLE-CAL-FAST-3B: attach pure deterministic parse (no DB writes).
  let salonTimeZone: string;
  if (typeof params.salonTimeZone === 'string' && params.salonTimeZone.trim()) {
    salonTimeZone = resolveParserTimezone(params.salonTimeZone);
  } else if (params.getSalonTimeZone) {
    salonTimeZone = resolveParserTimezone(await params.getSalonTimeZone(params.salonId));
  } else {
    salonTimeZone = resolveParserTimezone(undefined);
  }

  const liveTracePages: GooglePreviewLiveTracePage[] = [];
  /**
   * One events.list from timeMin with no timeMax. Follow nextPageToken until
   * Google is done or maxEvents is hit. maxPages must be able to cover sparse
   * pages (Google may return << maxResults while nextPageToken is set);
   * 20 full-size pages would stop early and drop remaining occurrences.
   */
  const { events, truncated } = await listGoogleCalendarEventsPreview({
    accessToken,
    calendarId,
    calendarName,
    timeMin: window.timeMin,
    ...(window.timeMax ? { timeMax: window.timeMax } : {}),
    fetchImpl: params.fetchImpl,
    maxPages: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
    maxEvents: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
    onPreviewLiveTracePage: (page) => {
      liveTracePages.push(page);
      emitGooglePreviewLiveTrace({
        operation: 'google_preview_page',
        pageNumber: page.pageNumber,
        itemsOnPage: page.itemsOnPage,
        hasNextPageToken: page.hasNextPageToken,
        firstEventStart: page.firstEventStart,
        lastEventStart: page.lastEventStart,
      });
    },
  });

  // GOOGLE-CAL-FAST-4: load salon clients+services once, match all events in memory (read-only).
  let matchCatalog: CalendarMatchCatalog;
  if (params.matchCatalog) {
    matchCatalog = params.matchCatalog;
  } else if (params.loadMatchCatalog) {
    matchCatalog = await params.loadMatchCatalog(params.salonId);
  } else {
    matchCatalog = await loadSalonCalendarMatchCatalog(params.db, params.salonId);
  }

  const eventsWithParsed: GoogleEventPreviewItem[] = events.map((ev) => {
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
      catalog: matchCatalog,
    });
    return {
      ...ev,
      parsed,
      matching,
      matchingStatus: matching.matchingStatus,
    };
  });

  const rawItemsTotal = liveTracePages.reduce((n, page) => n + page.itemsOnPage, 0);
  const uniqueGoogleOccurrences = new Set(
    eventsWithParsed.map((ev) => googlePreviewItemIdentity(ev)),
  ).size;
  const firstEventStart = liveTracePages[0]?.firstEventStart ?? null;
  const lastEventStart = liveTracePages.length
    ? liveTracePages[liveTracePages.length - 1]!.lastEventStart
    : null;

  emitGooglePreviewLiveTrace({
    operation: 'google_preview_summary',
    selectedCalendarId: calendarId,
    pagesFetched: liveTracePages.length,
    rawItemsTotal,
    uniqueGoogleOccurrences,
    backendPreviewItems: eventsWithParsed.length,
    truncated,
    firstEventStart,
    lastEventStart,
  });

  const rawGoogleTimedByDate: Record<string, number> = {};
  const backendPreviewByDate: Record<string, number> = {};
  for (const date of GOOGLE_PREVIEW_LIVE_TRACE_DATES) {
    rawGoogleTimedByDate[date] = 0;
    backendPreviewByDate[date] = 0;
  }
  for (const page of liveTracePages) {
    for (const dateTime of page.rawTimedStarts) {
      const date = googlePreviewTimedLocalDateKey(dateTime, salonTimeZone);
      if (date && date in rawGoogleTimedByDate) {
        rawGoogleTimedByDate[date] += 1;
      }
    }
  }
  for (const ev of eventsWithParsed) {
    const dateTime = ev.start.dateTime;
    if (!dateTime) continue;
    const date = googlePreviewTimedLocalDateKey(dateTime, salonTimeZone);
    if (date && date in backendPreviewByDate) {
      backendPreviewByDate[date] += 1;
    }
  }
  for (const date of GOOGLE_PREVIEW_LIVE_TRACE_DATES) {
    emitGooglePreviewLiveTrace({
      operation: 'google_preview_day',
      date,
      rawGoogleTimedEvents: rawGoogleTimedByDate[date] ?? 0,
      backendPreviewEvents: backendPreviewByDate[date] ?? 0,
    });
  }

  return {
    events: eventsWithParsed,
    count: eventsWithParsed.length,
    truncated,
    windowStart: window.timeMin,
    windowEnd: window.timeMax ?? '',
    calendarId,
    calendarName,
    salonTimeZone,
  };
}

export type GoogleCallbackRedirectReason =
  | 'oauth_denied'
  | 'invalid_state'
  | 'expired_state'
  | 'token_exchange_failed'
  | 'missing_refresh_token'
  | 'connection_save_failed'
  | 'not_configured'
  | 'encrypt_failed';

export function buildGoogleIntegrationsRedirectUrl(
  result: 'connected' | 'error',
  reason?: GoogleCallbackRedirectReason,
): string {
  const origin = getPublicAppOrigin() ?? 'http://localhost';
  const url = new URL('/integrations', origin);
  if (result === 'connected') {
    url.searchParams.set('google', 'connected');
  } else {
    url.searchParams.set('google', 'error');
    if (reason) url.searchParams.set('reason', reason);
  }
  return url.toString();
}

export function mapGoogleOAuthErrorToRedirectReason(
  err: unknown,
): GoogleCallbackRedirectReason {
  if (err instanceof GoogleCalendarOAuthError) {
    switch (err.code) {
      case 'GOOGLE_OAUTH_NOT_CONFIGURED':
        return 'not_configured';
      case 'GOOGLE_OAUTH_MISSING_REFRESH_TOKEN':
        return 'missing_refresh_token';
      case 'GOOGLE_OAUTH_ENCRYPT_FAILED':
        return 'encrypt_failed';
      case 'GOOGLE_OAUTH_CONNECTION_SAVE_FAILED':
        return 'connection_save_failed';
      default:
        return 'token_exchange_failed';
    }
  }
  return 'token_exchange_failed';
}
