/**
 * WA-UI-1: Developer WhatsApp visibility helpers (non-mutating).
 * Never exposes credential contents — presence flags only.
 */

import type { WhatsAppBusinessConnectionPublic } from '../types.js';

/** True when any encrypted credential field has non-empty material (complete or partial). */
export function hasAnyWhatsAppCredentialMaterial(row: {
  access_token_ciphertext?: string | null;
  access_token_iv?: string | null;
  access_token_auth_tag?: string | null;
  app_secret_ciphertext?: string | null;
  app_secret_iv?: string | null;
  app_secret_auth_tag?: string | null;
  verify_token_ciphertext?: string | null;
  verify_token_iv?: string | null;
  verify_token_auth_tag?: string | null;
} | null): boolean {
  if (!row) return false;
  const fields = [
    row.access_token_ciphertext,
    row.access_token_iv,
    row.access_token_auth_tag,
    row.app_secret_ciphertext,
    row.app_secret_iv,
    row.app_secret_auth_tag,
    row.verify_token_ciphertext,
    row.verify_token_iv,
    row.verify_token_auth_tag,
  ];
  return fields.some((v) => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Meaningful WhatsApp connection presence for orphan-safe visibility.
 * Soft-cleared / prepare-only shells (webhook_key alone) are NOT meaningful.
 */
export function isMeaningfulWhatsAppConnectionPresence(
  connection: WhatsAppBusinessConnectionPublic | null,
  hasCredentialMaterial: boolean,
): boolean {
  if (!connection) return false;
  if (hasCredentialMaterial) return true;
  if (typeof connection.phoneNumberId === 'string' && connection.phoneNumberId.trim()) return true;
  if (typeof connection.businessAccountId === 'string' && connection.businessAccountId.trim()) {
    return true;
  }
  if (
    typeof connection.displayPhoneNumber === 'string' &&
    connection.displayPhoneNumber.trim()
  ) {
    return true;
  }
  if (typeof connection.verifiedName === 'string' && connection.verifiedName.trim()) return true;
  return false;
}
