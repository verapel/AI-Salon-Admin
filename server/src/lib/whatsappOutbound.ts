/**
 * WA-4F1: Durable WhatsApp outbound outbox helpers.
 * Enqueue / claim / flush. No Telegram. No reminders/templates.
 * Meta HTTP goes through injectable sendWhatsAppTextMessage.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decryptWhatsAppCredential,
  isWhatsAppCredentialCryptoError,
} from './whatsappCredentialsCrypto.js';
import {
  sendWhatsAppTextMessage,
  type WhatsAppSendTextResult,
} from './whatsappCloudApi.js';

export const WHATSAPP_OUTBOUND_MAX_ATTEMPTS = 5;
export const WHATSAPP_OUTBOUND_STALE_CLAIM_SECONDS = 5 * 60;
/** Backoff minutes by attempt_count after failure (1-based after increment). */
export const WHATSAPP_OUTBOUND_BACKOFF_MINUTES = [1, 5, 15, 60, 180] as const;

export type WhatsAppOutboundRow = {
  id: string;
  salon_id: string;
  conversation_id: string | null;
  inbound_receipt_id: string;
  recipient_external_user_id: string;
  message_key: string;
  payload: { text?: string; options?: unknown };
  sequence: number;
  status: 'pending' | 'claimed' | 'sent' | 'failed';
  attempt_count: number;
  claim_token: string | null;
  meta_message_id: string | null;
};

export type EnqueueWhatsAppOutboundResult =
  | { kind: 'enqueued'; row: WhatsAppOutboundRow; created: boolean }
  | { kind: 'error'; code: string };

export type FlushWhatsAppOutboundResult =
  | { kind: 'sent'; metaMessageId: string }
  | { kind: 'retry_scheduled'; code: string }
  | { kind: 'failed'; code: string }
  | { kind: 'skipped'; code: string }
  | { kind: 'error'; code: string };

export type WhatsAppOutboundSendFn = typeof sendWhatsAppTextMessage;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapOutboundRow(raw: Record<string, unknown>): WhatsAppOutboundRow {
  const payloadRaw = asRecord(raw.payload) ?? {};
  return {
    id: String(raw.id),
    salon_id: String(raw.salon_id),
    conversation_id: raw.conversation_id == null ? null : String(raw.conversation_id),
    inbound_receipt_id: String(raw.inbound_receipt_id),
    recipient_external_user_id: String(raw.recipient_external_user_id),
    message_key: String(raw.message_key),
    payload: payloadRaw as WhatsAppOutboundRow['payload'],
    sequence: Number(raw.sequence ?? 0),
    status: String(raw.status) as WhatsAppOutboundRow['status'],
    attempt_count: Number(raw.attempt_count ?? 0),
    claim_token: raw.claim_token == null ? null : String(raw.claim_token),
    meta_message_id: raw.meta_message_id == null ? null : String(raw.meta_message_id),
  };
}

export function nextWhatsAppOutboundAttemptAt(
  attemptCount: number,
  nowMs: number = Date.now(),
): string {
  const idx = Math.min(
    Math.max(attemptCount - 1, 0),
    WHATSAPP_OUTBOUND_BACKOFF_MINUTES.length - 1,
  );
  const minutes = WHATSAPP_OUTBOUND_BACKOFF_MINUTES[idx];
  return new Date(nowMs + minutes * 60_000).toISOString();
}

export type ResolvedWhatsAppOutboundConnection =
  | {
      kind: 'ok';
      phoneNumberId: string;
      accessTokenCipher: { ciphertext: string; iv: string; authTag: string };
    }
  | {
      kind: 'error';
      code:
        | 'connection_missing'
        | 'not_connected'
        | 'phone_number_missing'
        | 'token_missing';
    };

/** Salon-scoped connection resolution. No default-salon fallback. */
export async function resolveWhatsAppOutboundConnection(params: {
  db: SupabaseClient | any;
  salonId: string;
}): Promise<ResolvedWhatsAppOutboundConnection> {
  const { data: integ, error: integErr } = await params.db
    .from('salon_integrations')
    .select('id, status')
    .eq('salon_id', params.salonId)
    .eq('provider', 'whatsapp')
    .maybeSingle();

  if (integErr) return { kind: 'error', code: 'connection_missing' };
  if (!integ) return { kind: 'error', code: 'connection_missing' };
  if (String(integ.status) !== 'connected') {
    return { kind: 'error', code: 'not_connected' };
  }

  const { data: conn, error: connErr } = await params.db
    .from('whatsapp_business_connections')
    .select(
      'phone_number_id, access_token_ciphertext, access_token_iv, access_token_auth_tag',
    )
    .eq('salon_id', params.salonId)
    .maybeSingle();

  if (connErr || !conn) return { kind: 'error', code: 'connection_missing' };

  const phoneNumberId =
    typeof conn.phone_number_id === 'string' ? conn.phone_number_id.trim() : '';
  if (!phoneNumberId) return { kind: 'error', code: 'phone_number_missing' };

  const ciphertext = conn.access_token_ciphertext;
  const iv = conn.access_token_iv;
  const authTag = conn.access_token_auth_tag;
  if (
    typeof ciphertext !== 'string' ||
    !ciphertext.trim() ||
    typeof iv !== 'string' ||
    !iv.trim() ||
    typeof authTag !== 'string' ||
    !authTag.trim()
  ) {
    return { kind: 'error', code: 'token_missing' };
  }

  return {
    kind: 'ok',
    phoneNumberId,
    accessTokenCipher: {
      ciphertext: ciphertext.trim(),
      iv: iv.trim(),
      authTag: authTag.trim(),
    },
  };
}

/**
 * Idempotent enqueue: UNIQUE (salon_id, inbound_receipt_id, sequence).
 * Duplicate → return existing row. No Meta call.
 */
export async function enqueueWhatsAppOutbound(params: {
  db: SupabaseClient | any;
  salonId: string;
  conversationId: string | null;
  inboundReceiptId: string;
  recipientExternalUserId: string;
  messageKey: string;
  text: string;
  sequence?: number;
}): Promise<EnqueueWhatsAppOutboundResult> {
  const sequence = params.sequence ?? 0;
  const recipient = params.recipientExternalUserId.trim();
  const messageKey = params.messageKey.trim();
  const text = params.text.trim();
  if (!recipient || !messageKey || !text) {
    return { kind: 'error', code: 'malformed_enqueue' };
  }

  const insertPayload = {
    salon_id: params.salonId,
    conversation_id: params.conversationId,
    inbound_receipt_id: params.inboundReceiptId,
    recipient_external_user_id: recipient,
    message_key: messageKey,
    payload: { text },
    sequence,
    status: 'pending',
    attempt_count: 0,
  };

  const { data, error } = await params.db
    .from('whatsapp_outbound_messages')
    .insert(insertPayload)
    .select(
      'id, salon_id, conversation_id, inbound_receipt_id, recipient_external_user_id, message_key, payload, sequence, status, attempt_count, claim_token, meta_message_id',
    )
    .maybeSingle();

  if (!error && data) {
    return { kind: 'enqueued', row: mapOutboundRow(data), created: true };
  }

  // Unique conflict → re-read existing.
  const code = error?.code;
  const msg = String(error?.message ?? '').toLowerCase();
  const unique =
    code === '23505' || msg.includes('duplicate') || msg.includes('unique');
  if (!unique) {
    return { kind: 'error', code: 'enqueue_db_error' };
  }

  const { data: existing, error: readErr } = await params.db
    .from('whatsapp_outbound_messages')
    .select(
      'id, salon_id, conversation_id, inbound_receipt_id, recipient_external_user_id, message_key, payload, sequence, status, attempt_count, claim_token, meta_message_id',
    )
    .eq('salon_id', params.salonId)
    .eq('inbound_receipt_id', params.inboundReceiptId)
    .eq('sequence', sequence)
    .maybeSingle();

  if (readErr || !existing) {
    return { kind: 'error', code: 'enqueue_reread_error' };
  }
  return { kind: 'enqueued', row: mapOutboundRow(existing), created: false };
}

export async function claimWhatsAppOutboundMessage(params: {
  db: SupabaseClient | any;
  messageId: string;
  staleSeconds?: number;
}): Promise<
  | { kind: 'claimed'; row: WhatsAppOutboundRow; claimToken: string }
  | { kind: 'not_claimable' }
  | { kind: 'error'; code: string }
> {
  const { data, error } = await params.db.rpc('claim_whatsapp_outbound_message', {
    p_message_id: params.messageId,
    p_stale_seconds: params.staleSeconds ?? WHATSAPP_OUTBOUND_STALE_CLAIM_SECONDS,
  });
  if (error) return { kind: 'error', code: 'claim_rpc_error' };
  const row = asRecord(data);
  if (!row) return { kind: 'error', code: 'claim_rpc_shape' };
  const kind = String(row.kind ?? '');
  if (kind === 'not_claimable') return { kind: 'not_claimable' };
  if (kind !== 'claimed') return { kind: 'error', code: 'claim_rpc_kind' };
  const claimToken = String(row.claim_token ?? '');
  if (!claimToken) return { kind: 'error', code: 'claim_token_missing' };
  return {
    kind: 'claimed',
    claimToken,
    row: mapOutboundRow(row),
  };
}

async function finalizeSent(params: {
  db: SupabaseClient | any;
  messageId: string;
  claimToken: string;
  metaMessageId: string;
}): Promise<'sent' | 'lost_claim' | 'error'> {
  const { data, error } = await params.db.rpc('finalize_whatsapp_outbound_sent', {
    p_message_id: params.messageId,
    p_claim_token: params.claimToken,
    p_meta_message_id: params.metaMessageId,
  });
  if (error) return 'error';
  const row = asRecord(data);
  if (!row) return 'error';
  const kind = String(row.kind ?? '');
  if (kind === 'sent') return 'sent';
  if (kind === 'lost_claim') return 'lost_claim';
  return 'error';
}

async function finalizeFailure(params: {
  db: SupabaseClient | any;
  messageId: string;
  claimToken: string;
  errorCode: string;
  retryable: boolean;
  attemptCount: number;
}): Promise<'retry_scheduled' | 'failed' | 'lost_claim' | 'error'> {
  const nextAttemptAt = params.retryable
    ? nextWhatsAppOutboundAttemptAt(params.attemptCount)
    : null;
  const { data, error } = await params.db.rpc('finalize_whatsapp_outbound_failure', {
    p_message_id: params.messageId,
    p_claim_token: params.claimToken,
    p_error_code: params.errorCode,
    p_retryable: params.retryable,
    p_next_attempt_at: nextAttemptAt,
    p_max_attempts: WHATSAPP_OUTBOUND_MAX_ATTEMPTS,
  });
  if (error) return 'error';
  const row = asRecord(data);
  if (!row) return 'error';
  const kind = String(row.kind ?? '');
  if (kind === 'retry_scheduled') return 'retry_scheduled';
  if (kind === 'failed') return 'failed';
  if (kind === 'lost_claim') return 'lost_claim';
  return 'error';
}

function classifySendForOutbox(result: WhatsAppSendTextResult): {
  retryable: boolean;
  code: string;
  metaMessageId?: string;
} {
  if (result.kind === 'sent') {
    return { retryable: false, code: 'sent', metaMessageId: result.metaMessageId };
  }
  if (result.kind === 'retryable_error') {
    return { retryable: true, code: result.code };
  }
  return { retryable: false, code: result.code };
}

/**
 * Claim → resolve connection → decrypt → send → finalize.
 * Residual risk: Meta HTTP success then crash before finalize_sent may duplicate on reclaim.
 */
export async function flushWhatsAppOutboundMessage(params: {
  db: SupabaseClient | any;
  messageId: string;
  /**
   * Injected Meta sender for tests. When provided, credential decrypt is skipped
   * (production webhook/worker omit this and always decrypt just-in-time).
   */
  sendFn?: WhatsAppOutboundSendFn;
}): Promise<FlushWhatsAppOutboundResult> {
  const usingInjectedSend = typeof params.sendFn === 'function';
  const sendFn = params.sendFn ?? sendWhatsAppTextMessage;

  const claimed = await claimWhatsAppOutboundMessage({
    db: params.db,
    messageId: params.messageId,
  });
  if (claimed.kind === 'not_claimable') {
    return { kind: 'skipped', code: 'not_claimable' };
  }
  if (claimed.kind === 'error') {
    return { kind: 'error', code: claimed.code };
  }

  const text =
    typeof claimed.row.payload?.text === 'string' ? claimed.row.payload.text.trim() : '';
  if (!text) {
    await finalizeFailure({
      db: params.db,
      messageId: claimed.row.id,
      claimToken: claimed.claimToken,
      errorCode: 'empty_payload_text',
      retryable: false,
      attemptCount: claimed.row.attempt_count,
    });
    return { kind: 'failed', code: 'empty_payload_text' };
  }

  const resolved = await resolveWhatsAppOutboundConnection({
    db: params.db,
    salonId: claimed.row.salon_id,
  });
  if (resolved.kind === 'error') {
    await finalizeFailure({
      db: params.db,
      messageId: claimed.row.id,
      claimToken: claimed.claimToken,
      errorCode: resolved.code,
      retryable: false,
      attemptCount: claimed.row.attempt_count,
    });
    return { kind: 'failed', code: resolved.code };
  }

  let accessToken = '';
  if (!usingInjectedSend) {
    try {
      accessToken = decryptWhatsAppCredential(resolved.accessTokenCipher);
    } catch (err) {
      const code = isWhatsAppCredentialCryptoError(err)
        ? 'crypto_invalid'
        : 'crypto_error';
      await finalizeFailure({
        db: params.db,
        messageId: claimed.row.id,
        claimToken: claimed.claimToken,
        errorCode: code,
        retryable: false,
        attemptCount: claimed.row.attempt_count,
      });
      return { kind: 'failed', code };
    }
  }

  let sendResult: WhatsAppSendTextResult;
  try {
    sendResult = await sendFn({
      accessToken,
      phoneNumberId: resolved.phoneNumberId,
      to: claimed.row.recipient_external_user_id,
      text,
    });
  } finally {
    accessToken = '';
  }

  const classified = classifySendForOutbox(sendResult);
  if (sendResult.kind === 'sent' && classified.metaMessageId) {
    const fin = await finalizeSent({
      db: params.db,
      messageId: claimed.row.id,
      claimToken: claimed.claimToken,
      metaMessageId: classified.metaMessageId,
    });
    if (fin === 'sent') {
      return { kind: 'sent', metaMessageId: classified.metaMessageId };
    }
    // HTTP succeeded but claim finalize failed — residual duplicate risk on reclaim.
    return { kind: 'error', code: 'finalize_sent_failed' };
  }

  const fin = await finalizeFailure({
    db: params.db,
    messageId: claimed.row.id,
    claimToken: claimed.claimToken,
    errorCode: classified.code,
    retryable: classified.retryable,
    attemptCount: claimed.row.attempt_count,
  });
  if (fin === 'retry_scheduled') {
    return { kind: 'retry_scheduled', code: classified.code };
  }
  if (fin === 'failed') return { kind: 'failed', code: classified.code };
  return { kind: 'error', code: 'finalize_failure_failed' };
}
