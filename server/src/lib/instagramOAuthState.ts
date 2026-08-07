/**
 * IG-2 / IG-ACTIVATE-1: Signed short-lived + durable single-use OAuth state.
 * Prevents CSRF, salon substitution, and callback replay.
 *
 * Flow:
 *   connect/start → persist nonce → sign state (HMAC)
 *   callback → verify signature/TTL → atomic consume → THEN Meta token exchange
 *
 * Failed Meta exchange after consume does NOT restore the nonce (user restarts OAuth).
 * Never stores access tokens / authorization codes / app secrets in the state table.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const STATE_TTL_MS = 10 * 60 * 1000;
const PURPOSE = 'ig_connect' as const;

export type InstagramOAuthStatePayload = {
  v: 1;
  purpose: typeof PURPOSE;
  salonId: string;
  nonce: string;
  exp: number;
};

export type InstagramOAuthStateErrorCode =
  | 'INSTAGRAM_OAUTH_STATE_INVALID'
  | 'INSTAGRAM_OAUTH_STATE_EXPIRED'
  | 'INSTAGRAM_OAUTH_STATE_REPLAY'
  | 'INSTAGRAM_OAUTH_NOT_CONFIGURED'
  | 'INSTAGRAM_OAUTH_STATE_PERSIST_FAILED';

export class InstagramOAuthStateError extends Error {
  readonly code: InstagramOAuthStateErrorCode;

  constructor(code: InstagramOAuthStateErrorCode, message: string) {
    super(message);
    this.name = 'InstagramOAuthStateError';
    this.code = code;
  }
}

function loadStateSecret(): Buffer {
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim();
  if (!appSecret) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_NOT_CONFIGURED',
      'Instagram OAuth is not configured',
    );
  }
  // Derive a dedicated HMAC key from app secret (never use raw token material).
  return createHmac('sha256', 'ig-oauth-state-v1').update(appSecret).digest();
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
export function createInstagramOAuthState(
  salonId: string,
  nowMs = Date.now(),
  nonce: string = randomBytes(16).toString('hex'),
): string {
  const trimmed = salonId.trim();
  if (!trimmed) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'salonId is required for OAuth state',
    );
  }
  const nonceTrimmed = nonce.trim();
  if (!nonceTrimmed) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth nonce is required',
    );
  }

  const secret = loadStateSecret();
  const payload: InstagramOAuthStatePayload = {
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
 * Does NOT consume durable nonce — use consumeInstagramOAuthState for single-use.
 */
export function parseInstagramOAuthState(
  state: string,
  nowMs = Date.now(),
): { salonId: string; nonce: string; exp: number } {
  if (typeof state !== 'string' || !state.trim()) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth state is required',
    );
  }

  const parts = state.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  const [payloadB64, sig] = parts;
  const secret = loadStateSecret();
  const expected = sign(secret, payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  let payload: InstagramOAuthStatePayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8')) as InstagramOAuthStatePayload;
  } catch {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
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
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  if (nowMs > payload.exp) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_EXPIRED',
      'OAuth state has expired',
    );
  }

  return {
    salonId: payload.salonId.trim(),
    nonce: payload.nonce.trim(),
    exp: payload.exp,
  };
}

export function getInstagramOAuthStateTtlMs(): number {
  return STATE_TTL_MS;
}

/**
 * Persist pending nonce then return signed state (connect/start).
 * Opaque random nonce — never tokens/secrets.
 */
export async function createPersistedInstagramOAuthState(params: {
  db: SupabaseClient | any;
  salonId: string;
  nowMs?: number;
}): Promise<string> {
  const nowMs = params.nowMs ?? Date.now();
  const salonId = params.salonId.trim();
  if (!salonId) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'salonId is required for OAuth state',
    );
  }

  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(nowMs + STATE_TTL_MS).toISOString();

  const { data, error } = await params.db.rpc('create_instagram_oauth_state', {
    p_salon_id: salonId,
    p_nonce: nonce,
    p_expires_at: expiresAt,
  });

  if (error) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_PERSIST_FAILED',
      'OAuth state could not be persisted',
    );
  }
  const row = asRecord(data);
  if (!row || String(row.kind ?? '') !== 'created') {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_PERSIST_FAILED',
      'OAuth state could not be persisted',
    );
  }

  return createInstagramOAuthState(salonId, nowMs, nonce);
}

/**
 * Verify signed state then atomically consume durable nonce.
 * Must run BEFORE Meta token exchange. Replay / concurrent loser → rejected.
 */
export async function consumeInstagramOAuthState(params: {
  db: SupabaseClient | any;
  state: string;
  nowMs?: number;
}): Promise<{ salonId: string; nonce: string }> {
  const nowMs = params.nowMs ?? Date.now();
  const parsed = parseInstagramOAuthState(params.state, nowMs);

  const { data, error } = await params.db.rpc('consume_instagram_oauth_state', {
    p_salon_id: parsed.salonId,
    p_nonce: parsed.nonce,
    p_now: new Date(nowMs).toISOString(),
  });

  if (error) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth state could not be consumed',
    );
  }

  const row = asRecord(data);
  if (!row) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth state could not be consumed',
    );
  }

  const kind = String(row.kind ?? '');
  if (kind === 'consumed') {
    return { salonId: parsed.salonId, nonce: parsed.nonce };
  }

  const code = String(row.code ?? '');
  if (code === 'expired') {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_EXPIRED',
      'OAuth state has expired',
    );
  }
  if (code === 'already_consumed') {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_REPLAY',
      'OAuth state has already been used',
    );
  }
  if (code === 'unknown_nonce' || code === 'salon_mismatch' || code === 'not_consumable') {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'OAuth state is invalid',
    );
  }

  throw new InstagramOAuthStateError(
    'INSTAGRAM_OAUTH_STATE_INVALID',
    'OAuth state is invalid',
  );
}
