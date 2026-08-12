/**
 * IG-1: Safe Instagram connection DTO mapping (no secrets).
 */

export type InstagramConnectionStatus =
  | 'not_connected'
  | 'connected'
  | 'error'
  | 'disabled';

export type InstagramBusinessConnectionPublic = {
  id: string;
  salonId: string;
  status: InstagramConnectionStatus;
  /** Instagram Professional Account ID (routing identity). */
  instagramUserId: string | null;
  instagramUsername: string | null;
  connectedAt: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
  /** Long-lived token expiry when known (IG-2). */
  tokenExpiresAt: string | null;
  /** True when encrypted access-token material is stored (no ciphertext returned). */
  isAccessTokenStored: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DeveloperInstagramIntegration = {
  salonId: string;
  salonName: string;
  slug: string;
  /**
   * True when Instagram is visible for this salon:
   * salon_integrations(provider=instagram) exists OR a meaningful connection exists.
   * Read-only derived; GET paths never write.
   */
  integrationAdded: boolean;
  connected: boolean;
  connection: InstagramBusinessConnectionPublic | null;
  /**
   * True when local token material is stored and remove would clear credentials.
   * Used for explicit remove confirmation (connected OR error/reconnect with token).
   * Never exposes token contents.
   */
  requiresRemoveConfirmation: boolean;
  /**
   * Read-only mirror of INSTAGRAM_OUTBOUND_ENABLED === "true".
   * Never a toggle — env-gated worker bootstrap only.
   */
  outboundEnabled: boolean;
};

/**
 * Meaningful Instagram connection presence (non-mutating visibility helper).
 * Soft-cleared not_connected rows with no token/user id are NOT meaningful.
 */
export function isMeaningfulInstagramConnectionPresence(
  connection: InstagramBusinessConnectionPublic | null,
  isAccessTokenStored: boolean,
): boolean {
  if (!connection) return false;
  if (isAccessTokenStored) return true;
  if (connection.status === 'connected' || connection.status === 'error') return true;
  if (typeof connection.instagramUserId === 'string' && connection.instagramUserId.trim()) {
    return true;
  }
  return false;
}

/** Metadata row — never includes credential ciphertext columns. */
export type InstagramConnectionMetadataRow = {
  id: string;
  salon_id: string;
  instagram_user_id: string | null;
  instagram_username: string | null;
  status: string;
  connected_at: string | null;
  last_webhook_at: string | null;
  last_error: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Credential presence check only — never returned in API responses. */
export type InstagramCredentialTripleRow = {
  access_token_ciphertext: string | null;
  access_token_iv: string | null;
  access_token_auth_tag: string | null;
};

/** Public metadata only — never select credential columns into the response path. */
export const INSTAGRAM_CONNECTION_PUBLIC_SELECT = `
  id,
  salon_id,
  instagram_user_id,
  instagram_username,
  status,
  connected_at,
  last_webhook_at,
  last_error,
  token_expires_at,
  created_at,
  updated_at
`.replace(/\s+/g, ' ').trim();

export const INSTAGRAM_CREDENTIAL_PRESENCE_SELECT = `
  access_token_ciphertext,
  access_token_iv,
  access_token_auth_tag
`.replace(/\s+/g, ' ').trim();

export function isInstagramCredentialTripleStored(
  ciphertext: string | null,
  iv: string | null,
  authTag: string | null,
): boolean {
  return (
    typeof ciphertext === 'string' &&
    ciphertext.trim().length > 0 &&
    typeof iv === 'string' &&
    iv.trim().length > 0 &&
    typeof authTag === 'string' &&
    authTag.trim().length > 0
  );
}

function asStatus(value: string): InstagramConnectionStatus {
  if (
    value === 'connected' ||
    value === 'not_connected' ||
    value === 'error' ||
    value === 'disabled'
  ) {
    return value;
  }
  return 'not_connected';
}

/**
 * Map DB metadata + credential presence flag → public DTO.
 * Never copies ciphertext/iv/tag into the DTO.
 */
export function mapInstagramConnectionPublic(
  row: InstagramConnectionMetadataRow,
  isAccessTokenStored: boolean,
): InstagramBusinessConnectionPublic {
  return {
    id: row.id,
    salonId: row.salon_id,
    status: asStatus(String(row.status ?? 'not_connected')),
    instagramUserId: row.instagram_user_id,
    instagramUsername: row.instagram_username,
    connectedAt: row.connected_at,
    lastWebhookAt: row.last_webhook_at,
    lastError: row.last_error,
    tokenExpiresAt: row.token_expires_at ?? null,
    isAccessTokenStored,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FORBIDDEN_SECRET_KEYS = new Set([
  'access_token_ciphertext',
  'access_token_iv',
  'access_token_auth_tag',
  'ciphertext',
  'auth_tag',
  'authTag',
  'iv',
  'accessToken',
  'access_token',
  'plaintext',
  'token',
]);

function objectHasForbiddenSecretKeys(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => objectHasForbiddenSecretKeys(item, seen));
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(key)) return true;
    if (objectHasForbiddenSecretKeys(child, seen)) return true;
  }
  return false;
}

/** Assert a public DTO has no secret-shaped keys (for tests). */
export function instagramPublicDtoHasNoSecrets(dto: unknown): boolean {
  if (!dto || typeof dto !== 'object') return false;
  // isAccessTokenStored is a safe boolean flag (not a secret).
  return !objectHasForbiddenSecretKeys(dto);
}

/** Truncate Professional Account ID for developer UI display. */
export function maskInstagramUserId(userId: string | null | undefined): string | null {
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
