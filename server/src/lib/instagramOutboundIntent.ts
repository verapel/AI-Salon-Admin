/**
 * IG-7: Deterministic Instagram outbound response intents (no LLM).
 * Separates durable business intent from provider transport payload.
 *
 * Privacy:
 * - Outbound text is generated system content and MAY be persisted for delivery.
 * - Must NEVER include raw inbound DM, postback payload, access tokens, or
 *   another client's private data.
 */

import type { InstagramBookingCommitResult } from './instagramBookingCommit.js';
import type { InstagramBookingIntent } from './instagramBookingState.js';

/** Stable intent keys persisted in outbox dedupe key. */
export const INSTAGRAM_OUTBOUND_INTENT_KEYS = [
  'ask_service',
  'ask_staff',
  'ask_date',
  'ask_time',
  'ask_name',
  'ask_phone',
  'invalid_input',
  'slot_unavailable',
  'booked',
  'manual_review',
] as const;

export type InstagramOutboundIntentKey =
  (typeof INSTAGRAM_OUTBOUND_INTENT_KEYS)[number];

/** Meta Instagram Messaging text limit (characters). */
export const INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS = 1000;

export type InstagramOutboundIntent = {
  kind: InstagramOutboundIntentKey;
  text: string;
  sourceEventId: string;
  recipientExternalUserId: string;
  professionalAccountId: string;
  /** Optional quick-reply candidates; IG-7 persists text-only (options folded into text). */
  quickReplies?: Array<{ id: string; label: string }>;
};

const MANUAL_REVIEW_TEXT =
  'Не удалось завершить запись автоматически. Напишите нам в директ или позвоните в салон — поможем вручную.';

const BOOKED_FALLBACK_TEXT = 'Запись подтверждена. Ждём вас!';

const SLOT_UNAVAILABLE_TEXT =
  'Это время уже занято. Выберите другое время или дату.';

function asNonBlank(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

export function isInstagramOutboundIntentKey(
  value: unknown,
): value is InstagramOutboundIntentKey {
  return (
    typeof value === 'string' &&
    (INSTAGRAM_OUTBOUND_INTENT_KEYS as readonly string[]).includes(value)
  );
}

/** Truncate safely for Meta text limit; prefer not splitting (ordering/idempotency). */
export function clampInstagramOutboundText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS) return trimmed;
  if (INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS <= 1) return '…';
  return `${trimmed.slice(0, INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS - 1)}…`;
}

export function appendOutboundOptions(
  text: string,
  options?: Array<{ id: string; label: string }>,
): string {
  const base = text.trim();
  if (!options?.length) return base;
  const lines = options
    .map((o) => (typeof o.label === 'string' ? o.label.trim() : ''))
    .filter(Boolean);
  if (!lines.length) return base;
  // Avoid duplicating if labels already present in body.
  if (lines.every((l) => base.includes(l))) return base;
  return `${base}\n${lines.join('\n')}`;
}

function bookedConfirmationText(state?: {
  serviceName?: string;
  staffName?: string;
  date?: string;
  time?: string;
  name?: string;
}): string {
  const service = asNonBlank(state?.serviceName);
  const staff = asNonBlank(state?.staffName);
  const date = asNonBlank(state?.date);
  const time = asNonBlank(state?.time);
  const name = asNonBlank(state?.name);
  if (!service || !staff || !date || !time) return BOOKED_FALLBACK_TEXT;
  const who = name ? `, ${name}` : '';
  return `Запись подтверждена${who}: ${service}, мастер ${staff}, ${date} в ${time}.`;
}

/**
 * Map FSM + commit outcomes to a single outbound intent (or null = no reply).
 * Commit result wins over ready_to_book FSM text.
 */
export function resolveInstagramOutboundIntent(params: {
  sourceEventId: string;
  recipientExternalUserId: string | null | undefined;
  professionalAccountId: string;
  bookingIntent?: InstagramBookingIntent;
  bookingCommit?: InstagramBookingCommitResult;
}): InstagramOutboundIntent | null {
  const sourceEventId = asNonBlank(params.sourceEventId);
  const recipient = asNonBlank(params.recipientExternalUserId);
  const professionalAccountId = asNonBlank(params.professionalAccountId);
  if (!sourceEventId || !recipient || !professionalAccountId) return null;

  const base = {
    sourceEventId,
    recipientExternalUserId: recipient,
    professionalAccountId,
  };

  const commit = params.bookingCommit;
  if (commit) {
    if (commit.kind === 'lost_ownership' || commit.kind === 'error') return null;

    if (commit.kind === 'booking_created' || commit.kind === 'already_booked') {
      const state =
        params.bookingIntent?.kind === 'ready_to_book'
          ? params.bookingIntent.state
          : undefined;
      return {
        ...base,
        kind: 'booked',
        text: clampInstagramOutboundText(bookedConfirmationText(state)),
      };
    }

    if (
      commit.kind === 'slot_unavailable' ||
      commit.kind === 'slot_unavailable_choose_time' ||
      commit.kind === 'slot_unavailable_choose_date'
    ) {
      const options =
        commit.kind === 'slot_unavailable'
          ? undefined
          : commit.options;
      const hint =
        commit.kind === 'slot_unavailable_choose_time'
          ? 'Выберите другое время.'
          : commit.kind === 'slot_unavailable_choose_date'
            ? 'Выберите другую дату.'
            : SLOT_UNAVAILABLE_TEXT;
      const text =
        commit.kind === 'slot_unavailable'
          ? SLOT_UNAVAILABLE_TEXT
          : appendOutboundOptions(`${SLOT_UNAVAILABLE_TEXT} ${hint}`, options);
      return {
        ...base,
        kind: 'slot_unavailable',
        text: clampInstagramOutboundText(text),
        ...(options?.length ? { quickReplies: options } : {}),
      };
    }

    if (
      commit.kind === 'identity_conflict' ||
      commit.kind === 'ambiguous_client' ||
      commit.kind === 'client_blocked' ||
      commit.kind === 'client_resolution_conflict'
    ) {
      return {
        ...base,
        kind: 'manual_review',
        text: MANUAL_REVIEW_TEXT,
      };
    }

    if (
      commit.kind === 'service_unavailable' ||
      commit.kind === 'staff_unavailable' ||
      commit.kind === 'stale_state'
    ) {
      return {
        ...base,
        kind: 'invalid_input',
        text: clampInstagramOutboundText(
          commit.kind === 'service_unavailable'
            ? 'Услуга недоступна. Выберите другую услугу или напишите номер из списка.'
            : commit.kind === 'staff_unavailable'
              ? 'Мастер недоступен. Выберите другого мастера или начните запись заново.'
              : 'Не удалось подтвердить запись. Напишите ещё раз, пожалуйста.',
        ),
      };
    }
  }

  const intent = params.bookingIntent;
  if (!intent) return null;

  if (
    intent.kind === 'noop' ||
    intent.kind === 'lost_ownership' ||
    intent.kind === 'error' ||
    intent.kind === 'invalid_state' ||
    intent.kind === 'ready_to_book'
  ) {
    // ready_to_book without commit result: no outbound (commit path owns confirmation).
    return null;
  }

  if (
    intent.kind === 'ask_service' ||
    intent.kind === 'ask_staff' ||
    intent.kind === 'ask_date' ||
    intent.kind === 'ask_time' ||
    intent.kind === 'ask_name' ||
    intent.kind === 'ask_phone' ||
    intent.kind === 'invalid_input'
  ) {
    const text = clampInstagramOutboundText(
      appendOutboundOptions(intent.text, intent.options),
    );
    if (!text) return null;
    return {
      ...base,
      kind: intent.kind,
      text,
      ...(intent.options?.length ? { quickReplies: intent.options } : {}),
    };
  }

  return null;
}

/** Durable outbox payload: generated text only. */
export function toInstagramOutboundPayload(intent: InstagramOutboundIntent): {
  text: string;
} {
  return { text: clampInstagramOutboundText(intent.text) };
}
