/**
 * WhatsApp Cloud webhook crypto helpers (WA-3B).
 * Timing-safe compare for verify tokens and X-Hub-Signature-256 HMAC.
 * Never log secrets, signatures, or raw bodies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';
const SHA256_HEX_LEN = 64;

/** Constant-time string equality for UTF-8 tokens (length mismatch → false). */
export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Parse `X-Hub-Signature-256` header value; returns lowercase hex digest or null. */
export function parseHubSignature256(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith(SIGNATURE_PREFIX)) return null;
  const hex = trimmed.slice(SIGNATURE_PREFIX.length).trim();
  if (hex.length !== SHA256_HEX_LEN) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return hex.toLowerCase();
}

/** Compute HMAC-SHA256 hex of raw body with app secret. */
export function computeWhatsAppHubSignatureHex(appSecret: string, rawBody: Buffer): string {
  return createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/**
 * Verify Meta X-Hub-Signature-256 against raw body + app secret.
 * Returns false for missing/malformed signature or mismatch.
 */
export function verifyWhatsAppHubSignature(params: {
  appSecret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
}): boolean {
  if (!Buffer.isBuffer(params.rawBody)) return false;
  if (typeof params.appSecret !== 'string' || !params.appSecret.trim()) return false;

  const providedHex = parseHubSignature256(params.signatureHeader);
  if (!providedHex) return false;

  const expectedHex = computeWhatsAppHubSignatureHex(params.appSecret, params.rawBody);
  const provided = Buffer.from(providedHex, 'utf8');
  const expected = Buffer.from(expectedHex, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
