/**
 * IG-3 / IG-3A / IG-3B: Instagram Messaging webhook event normalization.
 * Extracts receipt-safe facts only — never persists DM text/captions/usernames.
 * No booking / conversations / outbound.
 *
 * Object contract: payload.object MUST equal exactly "instagram" (fail closed).
 * Receipt identity: durable claim requires a stable Meta mid (message.mid / postback.mid).
 * No synthetic externalEventId (no ig_malformed / ig_unsupported / index digests).
 */

import { createHash } from 'node:crypto';

export type InstagramWebhookEventKind =
  | 'message'
  | 'postback'
  | 'unsupported'
  | 'malformed';

export type NormalizedInstagramWebhookEvent = {
  provider: 'instagram';
  /**
   * Stable Meta message/postback mid when present.
   * Empty when the event has no stable provider identity (must not claim receipt).
   */
  externalEventId: string;
  externalMessageId: string | null;
  /** Instagram Professional Account ID (routing key). Opaque string. */
  professionalAccountId: string | null;
  /** Sender Instagram-scoped ID. Opaque string. */
  externalUserId: string | null;
  kind: InstagramWebhookEventKind;
  timestampMs: number | null;
  isEcho: boolean;
  /**
   * Ephemeral inbound message text for IG-5 FSM parsing only.
   * Never copied into receiptMetadata / identity / durable state.
   */
  inboundText: string | null;
  /**
   * Ephemeral postback.payload for IG-5 FSM parsing only.
   * Never copied into receiptMetadata / durable state.
   */
  inboundPostbackPayload: string | null;
  /** Minimal non-content metadata for receipt row only. */
  receiptMetadata: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Opaque Instagram ID for webhook payloads.
 * Strings only — numeric IDs fail closed (null) without Number/String coercion.
 */
export function tryParseInstagramWebhookOpaqueId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Terminal no-id event: process layer must not route or claim. */
function noClaimEvent(
  partial: Omit<
    NormalizedInstagramWebhookEvent,
    | 'provider'
    | 'externalEventId'
    | 'externalMessageId'
    | 'inboundText'
    | 'inboundPostbackPayload'
  > &
    Partial<
      Pick<NormalizedInstagramWebhookEvent, 'inboundText' | 'inboundPostbackPayload'>
    >,
): NormalizedInstagramWebhookEvent {
  return {
    provider: 'instagram',
    externalEventId: '',
    externalMessageId: null,
    inboundText: null,
    inboundPostbackPayload: null,
    ...partial,
  };
}

/**
 * Normalize Instagram Messaging webhook payload (object=instagram, entry[].messaging[]).
 * Text/caption/payload/title content is never placed in receiptMetadata.
 *
 * Wrong/missing object → [] (caller returns HTTP 200, no receipt, no retry storm).
 * Malformed / no Meta mid → empty externalEventId (no durable receipt).
 *
 * Stable-id note: there is no current "malformed but mid present" path.
 * If message.mid / postback.mid parses as opaque string, the event is message/postback
 * (or unsupported echo) using that exact mid — never a synthetic id.
 */
export function normalizeInstagramWebhookPayload(
  payload: unknown,
): NormalizedInstagramWebhookEvent[] {
  const root = asRecord(payload);
  if (!root) return [];

  // Fail closed: object must be the exact string "instagram".
  const objectType = typeof root.object === 'string' ? root.object.trim() : null;
  if (objectType !== 'instagram') {
    return [];
  }

  const entries = Array.isArray(root.entry) ? root.entry : [];
  const events: NormalizedInstagramWebhookEvent[] = [];

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = asRecord(entries[entryIndex]);
    if (!entry) {
      events.push(
        noClaimEvent({
          professionalAccountId: null,
          externalUserId: null,
          kind: 'malformed',
          timestampMs: null,
          isEcho: false,
          receiptMetadata: { kind: 'malformed', reason: 'bad_entry' },
        }),
      );
      continue;
    }

    const entryProfessionalId = tryParseInstagramWebhookOpaqueId(entry.id);
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];

    if (messaging.length === 0) {
      events.push(
        noClaimEvent({
          professionalAccountId: entryProfessionalId,
          externalUserId: null,
          kind: 'unsupported',
          timestampMs:
            typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : null,
          isEcho: false,
          receiptMetadata: {
            kind: 'unsupported',
            reason: 'no_messaging',
            hasProfessionalId: entryProfessionalId ? '1' : '0',
          },
        }),
      );
      continue;
    }

    for (let msgIndex = 0; msgIndex < messaging.length; msgIndex++) {
      const item = asRecord(messaging[msgIndex]);
      if (!item) {
        events.push(
          noClaimEvent({
            professionalAccountId: entryProfessionalId,
            externalUserId: null,
            kind: 'malformed',
            timestampMs: null,
            isEcho: false,
            receiptMetadata: { kind: 'malformed', reason: 'bad_messaging_item' },
          }),
        );
        continue;
      }

      const sender = asRecord(item.sender);
      const recipient = asRecord(item.recipient);
      const senderId = tryParseInstagramWebhookOpaqueId(sender?.id);
      const recipientId = tryParseInstagramWebhookOpaqueId(recipient?.id);
      const professionalAccountId = entryProfessionalId ?? recipientId;

      // Numeric identity → malformed (fail closed). No Number/String(number) coercion.
      if (
        (sender && 'id' in sender && typeof sender.id === 'number') ||
        (recipient && 'id' in recipient && typeof recipient.id === 'number') ||
        (entry && 'id' in entry && typeof entry.id === 'number')
      ) {
        events.push(
          noClaimEvent({
            professionalAccountId: null,
            externalUserId: null,
            kind: 'malformed',
            timestampMs: null,
            isEcho: false,
            receiptMetadata: { kind: 'malformed', reason: 'numeric_identity' },
          }),
        );
        continue;
      }

      const timestampMs =
        typeof item.timestamp === 'number' && Number.isFinite(item.timestamp)
          ? item.timestamp
          : null;

      const message = asRecord(item.message);
      const postback = asRecord(item.postback);

      if (message) {
        const mid = tryParseInstagramWebhookOpaqueId(message.mid);
        const isEcho = message.is_echo === true || message.is_self === true;
        if (!mid) {
          events.push(
            noClaimEvent({
              professionalAccountId,
              externalUserId: senderId,
              kind: 'malformed',
              timestampMs,
              isEcho,
              receiptMetadata: {
                kind: 'malformed',
                reason: 'missing_mid',
                hasMessage: '1',
              },
            }),
          );
          continue;
        }

        const hasText = typeof message.text === 'string' && message.text.trim().length > 0;
        const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
        const kind: InstagramWebhookEventKind = isEcho ? 'unsupported' : 'message';

        const inboundText =
          typeof message.text === 'string' && message.text.trim().length > 0
            ? message.text.trim()
            : null;

        events.push({
          provider: 'instagram',
          externalEventId: mid,
          externalMessageId: mid,
          professionalAccountId,
          externalUserId: senderId,
          kind,
          timestampMs,
          isEcho,
          inboundText,
          inboundPostbackPayload: null,
          receiptMetadata: {
            kind,
            hasMessage: '1',
            hasText: hasText ? '1' : '0',
            hasAttachments: hasAttachments ? '1' : '0',
            isEcho: isEcho ? '1' : '0',
            hasSender: senderId ? '1' : '0',
            hasProfessionalId: professionalAccountId ? '1' : '0',
          },
        });
        continue;
      }

      if (postback) {
        const mid = tryParseInstagramWebhookOpaqueId(postback.mid);
        const inboundPostbackPayload =
          typeof postback.payload === 'string' && postback.payload.trim().length > 0
            ? postback.payload.trim()
            : null;
        if (!mid) {
          events.push(
            noClaimEvent({
              professionalAccountId,
              externalUserId: senderId,
              kind: 'unsupported',
              timestampMs,
              isEcho: false,
              receiptMetadata: {
                kind: 'unsupported',
                reason: 'postback_missing_mid',
                hasPostback: '1',
                hasMid: '0',
                hasSender: senderId ? '1' : '0',
                hasProfessionalId: professionalAccountId ? '1' : '0',
              },
            }),
          );
          continue;
        }

        events.push({
          provider: 'instagram',
          externalEventId: mid,
          externalMessageId: mid,
          professionalAccountId,
          externalUserId: senderId,
          kind: 'postback',
          timestampMs,
          isEcho: false,
          inboundText: null,
          inboundPostbackPayload,
          receiptMetadata: {
            kind: 'postback',
            hasPostback: '1',
            hasMid: '1',
            hasSender: senderId ? '1' : '0',
            hasProfessionalId: professionalAccountId ? '1' : '0',
          },
        });
        continue;
      }

      // Unrecognized messaging item — no stable Meta mid; no synthetic receipt id.
      events.push(
        noClaimEvent({
          professionalAccountId,
          externalUserId: senderId,
          kind: 'unsupported',
          timestampMs,
          isEcho: false,
          receiptMetadata: {
            kind: 'unsupported',
            reason: 'unrecognized_messaging_item',
            hasSender: senderId ? '1' : '0',
          },
        }),
      );
    }
  }

  return events;
}

/**
 * SHA-256 hex of a real stable external event id for payload_hash column.
 * Callers must only pass Meta mid / provider event id — never message text,
 * postback payload, raw body, or synthetic ids (none are generated).
 */
export function instagramReceiptPayloadHash(externalEventId: string): string {
  return createHash('sha256').update(externalEventId, 'utf8').digest('hex');
}
