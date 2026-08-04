/**
 * WhatsApp inbound sender identity helpers (WA-4B).
 * Normalization + in-memory sender extraction support.
 * No client creation, appointments, or outbound messaging.
 */

/**
 * Digits-only normalized WhatsApp address for matching.
 * No country-code guessing and no fabricated '+' prefix.
 * Blank / non-digit-only-after-strip → null.
 */
export function normalizeWhatsAppAddress(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Reject obvious non-address tokens (message ids, etc.).
  if (trimmed.includes('@') || trimmed.includes(':')) return null;

  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) return null;

  // Require a plausible phone-like length (E.164 max 15; min 8 for safety).
  if (digits.length < 8 || digits.length > 15) return null;

  return digits;
}

/** Preserve Meta sender id for durable routing (trim only; do not rewrite). */
export function canonicalizeWhatsAppExternalUserId(
  input: string | null | undefined
): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type InboundSenderIdentity = {
  /** Canonical durable sender key — prefer messages[].from */
  externalUserId: string;
  contactWaId: string | null;
  profileName: string | null;
  /** Original sender address string for display (not rewritten). */
  displayAddress: string | null;
  /** messages[].from vs contacts[].wa_id disagree when both present. */
  senderAddressMismatch: boolean;
  normalizedAddress: string | null;
};

/**
 * Parse Meta WhatsApp messages[].timestamp (unix seconds string/number) to ISO.
 * Returns null when missing/invalid. Used for out-of-order conversation ordering.
 */
export function parseWhatsAppMessageTimestamp(
  value: unknown
): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      const ms = trimmed.length <= 10 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    const d = new Date(trimmed);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

/**
 * Resolve canonical sender from message.from + optional contacts[].wa_id.
 * Prefers messages[].from. Flags mismatch when both exist and differ.
 */
export function resolveInboundSenderIdentity(params: {
  messageFrom: string | null;
  contactWaId: string | null;
  profileName: string | null;
}): InboundSenderIdentity | null {
  const from = canonicalizeWhatsAppExternalUserId(params.messageFrom);
  const contactWaId = canonicalizeWhatsAppExternalUserId(params.contactWaId);
  const profileName =
    typeof params.profileName === 'string' && params.profileName.trim().length > 0
      ? params.profileName.trim().slice(0, 120)
      : null;

  const externalUserId = from ?? contactWaId;
  if (!externalUserId) return null;

  const senderAddressMismatch = Boolean(from && contactWaId && from !== contactWaId);

  return {
    externalUserId,
    contactWaId,
    profileName,
    displayAddress: from ?? contactWaId,
    senderAddressMismatch,
    normalizedAddress: normalizeWhatsAppAddress(externalUserId),
  };
}
