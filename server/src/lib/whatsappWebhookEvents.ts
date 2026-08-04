/**
 * WhatsApp Cloud webhook event classification + deterministic external IDs (WA-3B / WA-4B / WA-4C).
 * Extracts minimal inbound sender identity fields + in-memory text body for FSM.
 * Text body is never placed in receipt metadata. Does not write identities/conversations.
 */

import { createHash } from 'node:crypto';
import {
  canonicalizeWhatsAppExternalUserId,
  parseWhatsAppMessageTimestamp,
  resolveInboundSenderIdentity,
  type InboundSenderIdentity,
} from './whatsappInboundIdentity.js';

export type WhatsAppWebhookEventCategory = 'inbound_message' | 'message_status' | 'unsupported';

export interface ClassifiedWhatsAppWebhookEvent {
  category: WhatsAppWebhookEventCategory;
  externalEventId: string;
  externalMessageId: string | null;
  eventType: string;
  phoneNumberId: string | null;
  /** Minimal non-secret metadata for receipt row only (no body, no wa_id/phone). */
  receiptMetadata: Record<string, string>;
  isInboundMessage: boolean;
  /** Inbound sender identity when extractable; null for status/unsupported/malformed. */
  inboundSender: InboundSenderIdentity | null;
  /**
   * Meta messages[].timestamp as ISO (ordering only).
   * Not stored in receipt metadata.
   */
  messageTimestampIso: string | null;
  /** messages[].type — in-memory only. */
  messageType: string | null;
  /**
   * messages[].text.body when type=text — in-memory FSM only.
   * Never copy into receipt metadata, logs, or conversation.state.
   */
  messageTextBody: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractPhoneNumberId(value: unknown): string | null {
  const change = asRecord(value);
  const valueObj = asRecord(change?.value);
  const metadata = asRecord(valueObj?.metadata);
  return asNonEmptyString(metadata?.phone_number_id);
}

/**
 * Build a wa_id → profile map from value.contacts (no raw payload persistence).
 */
function indexContacts(
  contactsRaw: unknown
): Map<string, { waId: string; profileName: string | null }> {
  const map = new Map<string, { waId: string; profileName: string | null }>();
  if (!Array.isArray(contactsRaw)) return map;

  for (const contactRaw of contactsRaw) {
    const contact = asRecord(contactRaw);
    if (!contact) continue;
    const waId = canonicalizeWhatsAppExternalUserId(asNonEmptyString(contact.wa_id));
    if (!waId) continue;
    const profile = asRecord(contact.profile);
    const profileName = asNonEmptyString(profile?.name);
    map.set(waId, { waId, profileName });
  }
  return map;
}

function unsupportedEventId(parts: string[]): string {
  const material = parts.join('|');
  const digest = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
  return `unsupported:${digest}`;
}

/**
 * Extract classified events from a parsed Meta WhatsApp webhook payload.
 * Text body is extracted in-memory for type=text only (not persisted here).
 */
export function classifyWhatsAppWebhookPayload(
  payload: unknown
): ClassifiedWhatsAppWebhookEvent[] {
  const root = asRecord(payload);
  if (!root) return [];

  const entries = Array.isArray(root.entry) ? root.entry : [];
  const events: ClassifiedWhatsAppWebhookEvent[] = [];

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = asRecord(entries[entryIndex]);
    if (!entry) continue;
    const entryId = asNonEmptyString(entry.id) ?? `entry${entryIndex}`;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
      const change = asRecord(changes[changeIndex]);
      if (!change) continue;
      const field = asNonEmptyString(change.field) ?? 'unknown';
      const value = asRecord(change.value);
      const phoneNumberId = extractPhoneNumberId(change);

      if (!value) {
        events.push({
          category: 'unsupported',
          externalEventId: unsupportedEventId([entryId, field, String(changeIndex), 'novalue']),
          externalMessageId: null,
          eventType: `unsupported:${field}`,
          phoneNumberId,
          receiptMetadata: { category: 'unsupported', field },
          isInboundMessage: false,
          inboundSender: null,
          messageTimestampIso: null,
          messageType: null,
          messageTextBody: null,
        });
        continue;
      }

      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      const contactsByWaId = indexContacts(value.contacts);

      for (const messageRaw of messages) {
        const message = asRecord(messageRaw);
        const messageId = asNonEmptyString(message?.id);
        if (!messageId) continue;
        const messageType = asNonEmptyString(message?.type) ?? 'unknown';
        const messageFrom = asNonEmptyString(message?.from);
        const messageTimestampIso = parseWhatsAppMessageTimestamp(message?.timestamp);
        const textObj = asRecord(message?.text);
        const messageTextBody =
          messageType === 'text' ? asNonEmptyString(textObj?.body) : null;

        // Prefer contact matching messages[].from; else single-contact fallback when unambiguous.
        let contactWaId: string | null = null;
        let profileName: string | null = null;
        const fromKey = canonicalizeWhatsAppExternalUserId(messageFrom);
        if (fromKey && contactsByWaId.has(fromKey)) {
          const hit = contactsByWaId.get(fromKey)!;
          contactWaId = hit.waId;
          profileName = hit.profileName;
        } else if (contactsByWaId.size === 1) {
          const only = contactsByWaId.values().next().value;
          if (only) {
            contactWaId = only.waId;
            profileName = only.profileName;
          }
        }

        const inboundSender = resolveInboundSenderIdentity({
          messageFrom,
          contactWaId,
          profileName,
        });

        events.push({
          category: 'inbound_message',
          externalEventId: `message:${messageId}`,
          externalMessageId: messageId,
          eventType: `message:${messageType}`,
          phoneNumberId,
          receiptMetadata: {
            category: 'inbound_message',
            messageType,
            ...(phoneNumberId ? { phoneNumberId } : {}),
            ...(inboundSender ? { hasSender: '1' } : { hasSender: '0' }),
            ...(inboundSender?.senderAddressMismatch ? { senderMismatch: '1' } : {}),
            ...(messageTimestampIso ? { hasMessageAt: '1' } : {}),
            // Intentionally omit messageTextBody / raw body.
          },
          isInboundMessage: true,
          inboundSender,
          messageTimestampIso,
          messageType,
          messageTextBody,
        });
      }

      for (const statusRaw of statuses) {
        const status = asRecord(statusRaw);
        const statusId = asNonEmptyString(status?.id);
        const statusName = asNonEmptyString(status?.status) ?? 'unknown';
        const timestamp = asNonEmptyString(status?.timestamp) ?? '0';
        if (!statusId) continue;
        events.push({
          category: 'message_status',
          externalEventId: `status:${statusId}:${statusName}:${timestamp}`,
          externalMessageId: statusId,
          eventType: `status:${statusName}`,
          phoneNumberId,
          receiptMetadata: {
            category: 'message_status',
            status: statusName,
            ...(phoneNumberId ? { phoneNumberId } : {}),
          },
          isInboundMessage: false,
          inboundSender: null,
          messageTimestampIso: null,
          messageType: null,
          messageTextBody: null,
        });
      }

      // Field present but neither messages nor statuses → unsupported structural event.
      if (messages.length === 0 && statuses.length === 0) {
        events.push({
          category: 'unsupported',
          externalEventId: unsupportedEventId([entryId, field, String(changeIndex)]),
          externalMessageId: null,
          eventType: `unsupported:${field}`,
          phoneNumberId,
          receiptMetadata: { category: 'unsupported', field },
          isInboundMessage: false,
          inboundSender: null,
          messageTimestampIso: null,
          messageType: null,
          messageTextBody: null,
        });
      }
    }
  }

  return events;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
