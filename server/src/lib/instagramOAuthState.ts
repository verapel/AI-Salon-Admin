/**
 * IG-2: Signed short-lived OAuth state for Instagram connect.
 * Prevents CSRF and salon substitution. No durable state table.
 *
 * Technical debt (IG-2A documented — not a commit blocker):
 * State is HMAC-signed with 10-minute TTL and a nonce, but is NOT single-use.
 * Must be hardened to single-use before production Instagram activation.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
  | 'INSTAGRAM_OAUTH_NOT_CONFIGURED';

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

/** Create opaque state encoding salonId + expiry. */
export function createInstagramOAuthState(salonId: string, nowMs = Date.now()): string {
  const trimmed = salonId.trim();
  if (!trimmed) {
    throw new InstagramOAuthStateError(
      'INSTAGRAM_OAUTH_STATE_INVALID',
      'salonId is required for OAuth state',
    );
  }

  const secret = loadStateSecret();
  const payload: InstagramOAuthStatePayload = {
    v: 1,
    purpose: PURPOSE,
    salonId: trimmed,
    nonce: randomBytes(16).toString('hex'),
    exp: nowMs + STATE_TTL_MS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

/** Validate state and return salonId. Fail closed on tamper/expiry. */
export function parseInstagramOAuthState(
  state: string,
  nowMs = Date.now(),
): { salonId: string } {
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

  return { salonId: payload.salonId.trim() };
}

export function getInstagramOAuthStateTtlMs(): number {
  return STATE_TTL_MS;
}
