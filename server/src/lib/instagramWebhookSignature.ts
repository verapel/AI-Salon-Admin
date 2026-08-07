/**
 * IG-3: Instagram webhook crypto helpers.
 * Same Meta contract as WhatsApp Cloud: timing-safe verify token + X-Hub-Signature-256.
 * Never log secrets, signatures, or raw bodies.
 */

import {
  computeWhatsAppHubSignatureHex,
  parseHubSignature256,
  timingSafeEqualUtf8,
  verifyWhatsAppHubSignature,
} from './whatsappWebhookSignature.js';

export { timingSafeEqualUtf8, parseHubSignature256 };

/** Compute HMAC-SHA256 hex of raw body with Instagram app secret. */
export function computeInstagramHubSignatureHex(appSecret: string, rawBody: Buffer): string {
  return computeWhatsAppHubSignatureHex(appSecret, rawBody);
}

/**
 * Verify Meta X-Hub-Signature-256 against raw body + INSTAGRAM_APP_SECRET.
 * Uses exact raw bytes — never re-serialized JSON.
 */
export function verifyInstagramHubSignature(params: {
  appSecret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
}): boolean {
  return verifyWhatsAppHubSignature(params);
}

export function loadInstagramWebhookVerifyToken(): string | null {
  const token = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim() ?? '';
  return token.length > 0 ? token : null;
}

export function loadInstagramAppSecretForWebhook(): string | null {
  const secret = process.env.INSTAGRAM_APP_SECRET?.trim() ?? '';
  return secret.length > 0 ? secret : null;
}
