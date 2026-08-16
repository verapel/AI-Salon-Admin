/**
 * GOOGLE-CAL-A3: Signed short-lived + durable single-use Google Calendar OAuth state.
 * Mirrors Instagram OAuth state security (HMAC + DB nonce) with Google-specific purpose/secret.
 *
 * Flow:
 *   auth-url → persist nonce → sign state
 *   callback → verify signature/TTL → atomic consume → THEN token exchange
 *
 * Failed Google exchange after consume does NOT restore the nonce.
 * Never stores tokens / client secrets / authorization codes in the state table.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const STATE_TTL_MS = 10 * 60 * 1000;
const PURPOSE = 'google_calendar_oauth' as const;

export type GoogleCalendarOAuthStatePayload = {
  v: 1;
  purpose: typeof PURPOSE;
  salonId: string;
  nonce: string;
  exp: number;
};

export type GoogleCalendarOAuthStateErrorCode =
  | 'GOOGLE_OAUTH_STATE_INVALID'
  | 'GOOGLE_OAUTH_STATE_EXPIRED'
  | 'GOOGLE_OAUTH_STATE_REPLAY'
  | 'GOOGLE_OAUTH_NOT_CONFIGURED'
  | 'GOOGLE_OAUTH_STATE_PERSIST_FAILED';

export class GoogleCalendarOAuthStateError extends Error {
  readonly code: GoogleCalendarOAuthStateErrorCode;

  constructor(code: GoogleCalendarOAuthStateErrorCode, message: string) {
    super(message);
    this.name = 'GoogleCalendarOAuthStateError';
    this.code = code;
  }
}

/**
 * HMAC key for OAuth state.
 * Prefer dedicated GOOGLE_CALENDAR_OAUTH_STATE_SECRET.
 * Fallback: domain-separated derivation from GOOGLE_CALENDAR_CLIENT_SECRET
 * (same pattern as Instagram — never use raw secret bytes as HMAC key).
 */
function loadStateSecret(): Buffer {
  const dedicated = process.env.GOOGLE_CALENDAR_OAUTH_STATE_SECRET?.trim();
  if (dedicated) {
    return createHmac('sha256', 'gcal-oauth-state-v1').update(dedicated).digest();
  }
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_NOT_CONFIGURED',
      'Google Calendar OAuth is not configured',
    );
  }
  return createHmac('sha256', 'gcal-oauth-state-v1').update(clientSecret).digest();
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function sign(secret: Buffer, payloadB64: string): string {
  return b64url(createHmac('sha256', secret).update(payloadB64).digest());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Create opaque signed state encoding salonId + nonce + expiry (no DB). */
export function createGoogleCalendarOAuthState(
  salonId: string,
  nowMs = Date.now(),
  nonce: string = randomBytes(16).toString('hex'),
): string {
  const trimmed = salonId.trim();
  if (!trimmed) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'salonId is required for OAuth state',
    );
  }
  const nonceTrimmed = nonce.trim();
  if (!nonceTrimmed) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth nonce is required',
    );
  }

  const secret = loadStateSecret();
  const payload: GoogleCalendarOAuthStatePayload = {
    v: 1,
    purpose: PURPOSE,
    salonId: trimmed,
    nonce: nonceTrimmed,
    exp: nowMs + STATE_TTL_MS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

/**
 * Validate signed state (signature + structure + TTL).
 * Does NOT consume durable nonce — use consumeGoogleCalendarOAuthState.
 */
export function parseGoogleCalendarOAuthState(
  state: string,
  nowMs = Date.now(),
): { salonId: string; nonce: string; exp: number } {
  if (typeof state !== 'string' || !state.trim()) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state is required',
    );
  }

  const parts = state.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  const [payloadB64, sig] = parts;
  const secret = loadStateSecret();
  const expected = sign(secret, payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  let payload: GoogleCalendarOAuthStatePayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8')) as GoogleCalendarOAuthStatePayload;
  } catch {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  if (
    payload?.v !== 1 ||
    payload.purpose !== PURPOSE ||
    typeof payload.salonId !== 'string' ||
    !payload.salonId.trim() ||
    typeof payload.nonce !== 'string' ||
    !payload.nonce.trim() ||
    typeof payload.exp !== 'number'
  ) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  if (nowMs > payload.exp) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_EXPIRED',
      'OAuth state has expired',
    );
  }

  return {
    salonId: payload.salonId.trim(),
    nonce: payload.nonce.trim(),
    exp: payload.exp,
  };
}

export function getGoogleCalendarOAuthStateTtlMs(): number {
  return STATE_TTL_MS;
}

/**
 * Persist pending nonce then return signed state (auth-url).
 * Opaque random nonce — never tokens/secrets.
 */
export async function createPersistedGoogleCalendarOAuthState(params: {
  db: SupabaseClient | any;
  salonId: string;
  initiatorUserId?: string | null;
  nowMs?: number;
}): Promise<string> {
  const nowMs = params.nowMs ?? Date.now();
  const salonId = params.salonId.trim();
  if (!salonId) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'salonId is required for OAuth state',
    );
  }

  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(nowMs + STATE_TTL_MS).toISOString();
  const initiator =
    typeof params.initiatorUserId === 'string' && params.initiatorUserId.trim()
      ? params.initiatorUserId.trim()
      : null;

  const { data, error } = await params.db.rpc('create_google_calendar_oauth_state', {
    p_salon_id: salonId,
    p_nonce: nonce,
    p_expires_at: expiresAt,
    p_initiator_user_id: initiator,
  });

  if (error) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_PERSIST_FAILED',
      'OAuth state could not be persisted',
    );
  }
  const row = asRecord(data);
  if (!row || String(row.kind ?? '') !== 'created') {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_PERSIST_FAILED',
      'OAuth state could not be persisted',
    );
  }

  return createGoogleCalendarOAuthState(salonId, nowMs, nonce);
}

/**
 * Verify signed state then atomically consume durable nonce.
 * Must run BEFORE Google token exchange. Replay / concurrent loser → rejected.
 * Authoritative salon_id is the signed+DB-matched salon (never from free query params).
 */
export async function consumeGoogleCalendarOAuthState(params: {
  db: SupabaseClient | any;
  state: string;
  nowMs?: number;
}): Promise<{ salonId: string; nonce: string }> {
  const nowMs = params.nowMs ?? Date.now();
  const parsed = parseGoogleCalendarOAuthState(params.state, nowMs);

  const { data, error } = await params.db.rpc('consume_google_calendar_oauth_state', {
    p_salon_id: parsed.salonId,
    p_nonce: parsed.nonce,
    p_now: new Date(nowMs).toISOString(),
  });

  if (error) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state could not be consumed',
    );
  }

  const row = asRecord(data);
  if (!row) {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state could not be consumed',
    );
  }

  const kind = String(row.kind ?? '');
  if (kind === 'consumed') {
    const dbSalonId = typeof row.salon_id === 'string' ? row.salon_id.trim() : '';
    if (!dbSalonId || dbSalonId !== parsed.salonId) {
      throw new GoogleCalendarOAuthStateError(
        'GOOGLE_OAUTH_STATE_INVALID',
        'OAuth state is invalid',
      );
    }
    return { salonId: dbSalonId, nonce: parsed.nonce };
  }

  const code = String(row.code ?? '');
  if (code === 'expired') {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_EXPIRED',
      'OAuth state has expired',
    );
  }
  if (code === 'already_consumed') {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_REPLAY',
      'OAuth state has already been used',
    );
  }
  if (code === 'unknown_nonce' || code === 'salon_mismatch' || code === 'not_consumable') {
    throw new GoogleCalendarOAuthStateError(
      'GOOGLE_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  throw new GoogleCalendarOAuthStateError(
    'GOOGLE_OAUTH_STATE_INVALID',
    'OAuth state is invalid',
  );
}
