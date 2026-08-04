/**
 * Canonical public app origin for developer-facing absolute URLs.
 * Uses configured APP_URL only — never request Host headers.
 */

/** Normalized public origin (scheme + host[+port]), or null if APP_URL is missing/invalid. */
export function getPublicAppOrigin(): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;

  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    if (!url.hostname) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Absolute Meta WhatsApp Cloud webhook callback URL for a routing webhook_key.
 * Returns null when APP_URL is not configured or webhookKey is blank.
 */
export function buildWhatsAppWebhookCallbackUrl(webhookKey: string): string | null {
  const key = typeof webhookKey === 'string' ? webhookKey.trim() : '';
  if (!key) return null;

  const origin = getPublicAppOrigin();
  if (!origin) return null;

  return `${origin}/api/webhooks/whatsapp/${key}`;
}
