/**
 * IG-2 / IG-2A / IG-2B: Minimal Instagram API with Instagram Login client.
 * Mockable via injected fetch. No Meta SDK. Never logs tokens/codes/secrets.
 *
 * Instagram Professional Account IDs are opaque strings — never JSON numbers /
 * JS Number / BigInt coercion (IEEE-754 precision loss).
 *
 * Technical debt (document only — not single-use in IG-2A/B):
 * OAuth state is HMAC-signed with 10-minute TTL and nonce, but is NOT single-use.
 * Harden to single-use before production Instagram activation.
 */

import { getPublicAppOrigin } from './publicAppUrl.js';

export const INSTAGRAM_GRAPH_API_VERSION = 'v22.0';
const AUTHORIZE_BASE = 'https://www.instagram.com/oauth/authorize';
const SHORT_LIVED_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const LONG_LIVED_TOKEN_URL = 'https://graph.instagram.com/access_token';
const ME_URL = `https://graph.instagram.com/${INSTAGRAM_GRAPH_API_VERSION}/me`;
const REQUEST_TIMEOUT_MS = 12_000;

export const INSTAGRAM_REQUIRED_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
] as const;

export type InstagramApiErrorCode =
  | 'INSTAGRAM_NOT_CONFIGURED'
  | 'INSTAGRAM_TIMEOUT'
  | 'INSTAGRAM_PROVIDER_4XX'
  | 'INSTAGRAM_PROVIDER_5XX'
  | 'INSTAGRAM_INVALID_TOKEN'
  | 'INSTAGRAM_MISSING_PERMISSION'
  | 'INSTAGRAM_PERMISSIONS_UNVERIFIED'
  | 'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL'
  | 'INSTAGRAM_IDENTITY_CONFLICT'
  | 'INSTAGRAM_INVALID_IDENTITY'
  | 'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE'
  | 'INSTAGRAM_OAUTH_DENIED'
  | 'INSTAGRAM_ACCOUNT_IN_USE'
  | 'INSTAGRAM_INVALID_TOKEN_EXPIRY';

export class InstagramApiError extends Error {
  readonly code: InstagramApiErrorCode;
  readonly httpStatus: number;

  constructor(code: InstagramApiErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'InstagramApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isInstagramApiError(err: unknown): err is InstagramApiError {
  return err instanceof InstagramApiError;
}

export type InstagramFetch = typeof fetch;

export type InstagramAppConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

export type InstagramVerifiedAccount = {
  instagramUserId: string;
  username: string | null;
  accountType: string;
  accessToken: string;
  tokenExpiresAt: string | null;
  /** Actual scopes returned by Meta token exchange — never fabricated. */
  grantedScopes: string[];
};

/** Non-identity string fields (tokens, usernames). Never used for Instagram IDs. */
function asNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Opaque Instagram identity (user_id / instagram_user_id).
 * Accepts only non-empty strings (trim). Rejects numbers and all other types —
 * never String(number) / BigInt / parseInt (precision may already be lost).
 */
export function parseRequiredInstagramOpaqueId(value: unknown): string {
  if (typeof value === 'number') {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_IDENTITY',
      400,
      'Instagram identity must be a string',
    );
  }
  if (typeof value !== 'string') {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_IDENTITY',
      400,
      'Instagram identity is missing or invalid',
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_IDENTITY',
      400,
      'Instagram identity is missing or invalid',
    );
  }
  return trimmed;
}

/** Optional exchange user_id: absent/null → null; present → must be opaque string. */
export function parseOptionalInstagramOpaqueId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return parseRequiredInstagramOpaqueId(value);
}

export function loadInstagramAppConfig(): InstagramAppConfig {
  const appId = process.env.INSTAGRAM_APP_ID?.trim() ?? '';
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim() ?? '';
  const explicitRedirect = process.env.INSTAGRAM_REDIRECT_URI?.trim() ?? '';
  const origin = getPublicAppOrigin();
  const redirectUri =
    explicitRedirect ||
    (origin ? `${origin}/api/integrations/instagram/callback` : '');

  if (!appId || !appSecret || !redirectUri) {
    throw new InstagramApiError(
      'INSTAGRAM_NOT_CONFIGURED',
      503,
      'Instagram OAuth is not configured',
    );
  }

  return { appId, appSecret, redirectUri };
}

export function buildInstagramAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const scopes = (input.scopes ?? INSTAGRAM_REQUIRED_SCOPES).join(',');
  const url = new URL(AUTHORIZE_BASE);
  url.searchParams.set('client_id', input.appId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', input.state);
  return url.toString();
}

async function fetchJson(
  fetchImpl: InstagramFetch,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new InstagramApiError(
        'INSTAGRAM_TIMEOUT',
        502,
        'Instagram provider timed out',
      );
    }
    throw new InstagramApiError(
      'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE',
      502,
      'Instagram provider temporarily unavailable',
    );
  } finally {
    clearTimeout(timer);
  }
}

function throwForProviderStatus(status: number): never {
  if (status === 401 || status === 403) {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_TOKEN',
      400,
      'Instagram token could not be verified',
    );
  }
  if (status >= 500) {
    throw new InstagramApiError(
      'INSTAGRAM_PROVIDER_5XX',
      502,
      'Instagram provider temporarily unavailable',
    );
  }
  if (status >= 400) {
    throw new InstagramApiError(
      'INSTAGRAM_PROVIDER_4XX',
      400,
      'Instagram provider rejected the request',
    );
  }
  throw new InstagramApiError(
    'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE',
    502,
    'Instagram provider temporarily unavailable',
  );
}

/**
 * Normalize Meta permissions. Returns null when the field is absent/unusable
 * (caller must fail closed). Returns string[] when a permissions list is present.
 */
export function normalizePermissionsField(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    const out = raw
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    // Invalid non-string entries only → treat as unverified shape if nothing usable
    if (out.length === 0) return null;
    return out;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    return trimmed
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

export function assertRequiredPermissions(granted: string[]): void {
  if (!Array.isArray(granted) || granted.length === 0) {
    throw new InstagramApiError(
      'INSTAGRAM_PERMISSIONS_UNVERIFIED',
      400,
      'Instagram permissions could not be verified',
    );
  }
  const set = new Set(granted);
  for (const scope of INSTAGRAM_REQUIRED_SCOPES) {
    if (!set.has(scope)) {
      throw new InstagramApiError(
        'INSTAGRAM_MISSING_PERMISSION',
        400,
        'Instagram account is missing required permissions',
      );
    }
  }
}

/** Require positively verified permissions from Meta (fail closed if absent). */
export function requireVerifiedPermissions(raw: unknown): string[] {
  const normalized = normalizePermissionsField(raw);
  if (normalized === null) {
    throw new InstagramApiError(
      'INSTAGRAM_PERMISSIONS_UNVERIFIED',
      400,
      'Instagram permissions could not be verified',
    );
  }
  assertRequiredPermissions(normalized);
  return normalized;
}

const PROFESSIONAL_ACCOUNT_TYPES = new Set(['business', 'media_creator', 'creator']);

export function assertProfessionalAccountType(accountType: unknown): string {
  if (typeof accountType !== 'string' || !accountType.trim()) {
    throw new InstagramApiError(
      'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL',
      400,
      'Instagram account must be a Professional Account',
    );
  }
  const normalized = accountType.trim().toLowerCase();
  if (!PROFESSIONAL_ACCOUNT_TYPES.has(normalized)) {
    throw new InstagramApiError(
      'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL',
      400,
      'Instagram account must be a Professional Account',
    );
  }
  return normalized;
}

/** Parse Meta expires_in. Null only when field omitted. Reject non-positive/invalid. */
export function parsePositiveExpiresIn(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;

  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    if (!/^\d+(\.\d+)?$/.test(raw.trim())) {
      throw new InstagramApiError(
        'INSTAGRAM_INVALID_TOKEN_EXPIRY',
        400,
        'Instagram token expiry is invalid',
      );
    }
    value = Number(raw.trim());
  } else {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_TOKEN_EXPIRY',
      400,
      'Instagram token expiry is invalid',
    );
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_TOKEN_EXPIRY',
      400,
      'Instagram token expiry is invalid',
    );
  }

  return Math.floor(value);
}

export function assertIdentityConsistency(
  exchangeUserId: string | null,
  meUserId: string,
): void {
  if (!exchangeUserId) return;
  if (exchangeUserId !== meUserId) {
    throw new InstagramApiError(
      'INSTAGRAM_IDENTITY_CONFLICT',
      400,
      'Instagram account identity mismatch',
    );
  }
}

type ShortLivedTokenResult = {
  accessToken: string;
  permissions: string[];
  exchangeUserId: string | null;
};

export async function exchangeInstagramAuthorizationCode(
  input: {
    code: string;
    appId: string;
    appSecret: string;
    redirectUri: string;
  },
  fetchImpl: InstagramFetch = fetch,
): Promise<ShortLivedTokenResult> {
  const code = input.code.trim().replace(/#_+$/, '');
  if (!code) {
    throw new InstagramApiError(
      'INSTAGRAM_PROVIDER_4XX',
      400,
      'Authorization code is required',
    );
  }

  const body = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
    code,
  });

  const { status, body: json } = await fetchJson(fetchImpl, SHORT_LIVED_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (status < 200 || status >= 300) {
    throwForProviderStatus(status);
  }

  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const data0 =
    root && Array.isArray(root.data) && root.data[0] && typeof root.data[0] === 'object'
      ? (root.data[0] as Record<string, unknown>)
      : root;

  const accessToken = asNonBlankString(data0?.access_token);
  if (!accessToken) {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_TOKEN',
      400,
      'Instagram token exchange returned no access token',
    );
  }

  const permissionsRaw =
    data0 && 'permissions' in data0
      ? data0.permissions
      : root && 'permissions' in root
        ? root.permissions
        : undefined;
  const permissions = requireVerifiedPermissions(permissionsRaw);
  // Optional: absent → null; numeric/malformed present → INSTAGRAM_INVALID_IDENTITY.
  const exchangeUserId = parseOptionalInstagramOpaqueId(data0?.user_id ?? root?.user_id);

  return { accessToken, permissions, exchangeUserId };
}

export async function exchangeInstagramLongLivedToken(
  input: {
    shortLivedToken: string;
    appSecret: string;
  },
  fetchImpl: InstagramFetch = fetch,
): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
  const url = new URL(LONG_LIVED_TOKEN_URL);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', input.appSecret);
  url.searchParams.set('access_token', input.shortLivedToken);

  const { status, body: json } = await fetchJson(fetchImpl, url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (status < 200 || status >= 300) {
    throwForProviderStatus(status);
  }

  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const accessToken = asNonBlankString(root?.access_token);
  if (!accessToken) {
    throw new InstagramApiError(
      'INSTAGRAM_INVALID_TOKEN',
      400,
      'Instagram long-lived token exchange failed',
    );
  }

  const expiresInSeconds =
    root && 'expires_in' in root ? parsePositiveExpiresIn(root.expires_in) : null;

  return { accessToken, expiresInSeconds };
}

export async function fetchInstagramProfessionalProfile(
  accessToken: string,
  fetchImpl: InstagramFetch = fetch,
): Promise<{
  instagramUserId: string;
  username: string | null;
  accountType: string;
}> {
  const url = new URL(ME_URL);
  url.searchParams.set('fields', 'user_id,username,account_type');
  url.searchParams.set('access_token', accessToken);

  const { status, body: json } = await fetchJson(fetchImpl, url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (status < 200 || status >= 300) {
    throwForProviderStatus(status);
  }

  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const data0 =
    root && Array.isArray(root.data) && root.data[0] && typeof root.data[0] === 'object'
      ? (root.data[0] as Record<string, unknown>)
      : root;

  // /me user_id is required and must be an opaque string (never a JSON number).
  const instagramUserId = parseRequiredInstagramOpaqueId(data0?.user_id);

  const username = asNonBlankString(data0?.username);
  const accountType = assertProfessionalAccountType(data0?.account_type);

  return { instagramUserId, username, accountType };
}

/**
 * Full verify path: code → short-lived (+ permissions) → long-lived → /me identity.
 * Never returns plaintext to logs; caller encrypts before DB write.
 */
export async function verifyInstagramOAuthConnection(
  input: {
    code: string;
    appId: string;
    appSecret: string;
    redirectUri: string;
  },
  fetchImpl: InstagramFetch = fetch,
): Promise<InstagramVerifiedAccount> {
  const shortLived = await exchangeInstagramAuthorizationCode(input, fetchImpl);
  // Permissions already fail-closed in exchange; re-assert for defense in depth.
  assertRequiredPermissions(shortLived.permissions);

  const longLived = await exchangeInstagramLongLivedToken(
    {
      shortLivedToken: shortLived.accessToken,
      appSecret: input.appSecret,
    },
    fetchImpl,
  );
  const profile = await fetchInstagramProfessionalProfile(longLived.accessToken, fetchImpl);

  assertIdentityConsistency(shortLived.exchangeUserId, profile.instagramUserId);

  const tokenExpiresAt =
    longLived.expiresInSeconds != null
      ? new Date(Date.now() + longLived.expiresInSeconds * 1000).toISOString()
      : null;

  return {
    instagramUserId: profile.instagramUserId,
    username: profile.username,
    accountType: profile.accountType,
    accessToken: longLived.accessToken,
    tokenExpiresAt,
    grantedScopes: [...shortLived.permissions],
  };
}
