/**
 * WhatsApp Cloud webhook event classification + deterministic external IDs (WA-3B).
 * No booking/AI/identity/conversation side effects.
 */

import { createHash } from 'node:crypto';

export type WhatsAppWebhookEventCategory = 'inbound_message' | 'message_status' | 'unsupported';

export interface ClassifiedWhatsAppWebhookEvent {
  category: WhatsAppWebhookEventCategory;
  externalEventId: string;
  externalMessageId: string | null;
  eventType: string;
  phoneNumberId: string | null;
  /** Minimal non-secret metadata for receipt row only. */
  receiptMetadata: Record<string, string>;
  isInboundMessage: boolean;
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

function unsupportedEventId(parts: string[]): string {
  const material = parts.join('|');
  const digest = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
  return `unsupported:${digest}`;
}

/**
 * Extract classified events from a parsed Meta WhatsApp webhook payload.
 * Does not inspect message text for business logic.
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
        });
        continue;
      }

      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];

      for (const messageRaw of messages) {
        const message = asRecord(messageRaw);
        const messageId = asNonEmptyString(message?.id);
        if (!messageId) continue;
        const messageType = asNonEmptyString(message?.type) ?? 'unknown';
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
          },
          isInboundMessage: true,
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
        });
      }
    }
  }

  return events;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
