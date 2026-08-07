/**
 * IG-7: Durable Instagram outbound outbox helpers.
 * Owned enqueue / claim / flush. No Telegram/WhatsApp/Apple mutations.
 * Meta HTTP only via injectable sendInstagramTextMessage.
 *
 * Delivery guarantee (honest):
 * - Enqueue idempotency: exactly-once logical row per (salon, source_event, intent).
 * - Send: at-least-once residual if crash after Meta accept before finalize_sent.
 * - Ambiguous timeout after dispatch: at-most-once (terminal, no blind retry).
 * Booking exactly-once does NOT imply message exactly-once.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decryptInstagramCredential,
  isInstagramCredentialCryptoError,
} from './instagramCredentialsCrypto.js';
import {
  sendInstagramTextMessage,
  type InstagramSendTextFn,
  type InstagramSendTextResult,
} from './instagramMessagingApi.js';
import {
  toInstagramOutboundPayload,
  type InstagramOutboundIntent,
} from './instagramOutboundIntent.js';

export const INSTAGRAM_OUTBOUND_MAX_ATTEMPTS = 5;
export const INSTAGRAM_OUTBOUND_STALE_CLAIM_SECONDS = 5 * 60;
/** Backoff minutes by attempt_count after failure (1-based after increment). */
export const INSTAGRAM_OUTBOUND_BACKOFF_MINUTES = [1, 5, 15, 60, 360] as const;

export type InstagramOutboundRow = {
  id: string;
  salon_id: string;
  provider: 'instagram';
  professional_account_id: string;
  external_user_id: string;
  source_event_id: string;
  inbound_receipt_id: string;
  intent_key: string;
  payload: { text?: string };
  status: 'pending' | 'claimed' | 'sent' | 'failed';
  attempt_count: number;
  claim_token: string | null;
  provider_message_id: string | null;
};

export type EnqueueInstagramOutboundResult =
  | { kind: 'enqueued'; id: string; created: boolean; intentKey: string }
  | { kind: 'lost_ownership' }
  | { kind: 'error'; code: string };

export type FlushInstagramOutboundResult =
  | { kind: 'sent'; providerMessageId: string }
  | { kind: 'retry_scheduled'; code: string }
  | { kind: 'failed'; code: string }
  | { kind: 'skipped'; code: string }
  | { kind: 'error'; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapOutboundRow(raw: Record<string, unknown>): InstagramOutboundRow {
  const payloadRaw = asRecord(raw.payload) ?? {};
  return {
    id: String(raw.id),
    salon_id: String(raw.salon_id),
    provider: 'instagram',
    professional_account_id: String(raw.professional_account_id),
    external_user_id: String(raw.external_user_id),
    source_event_id: String(raw.source_event_id),
    inbound_receipt_id: String(raw.inbound_receipt_id),
    intent_key: String(raw.intent_key),
    payload: payloadRaw as InstagramOutboundRow['payload'],
    status: String(raw.status) as InstagramOutboundRow['status'],
    attempt_count: Number(raw.attempt_count ?? 0),
    claim_token: raw.claim_token == null ? null : String(raw.claim_token),
    provider_message_id:
      raw.provider_message_id == null ? null : String(raw.provider_message_id),
  };
}

export function nextInstagramOutboundAttemptAt(
  attemptCount: number,
  nowMs: number = Date.now(),
): string {
  const idx = Math.min(
    Math.max(attemptCount - 1, 0),
    INSTAGRAM_OUTBOUND_BACKOFF_MINUTES.length - 1,
  );
  const minutes = INSTAGRAM_OUTBOUND_BACKOFF_MINUTES[idx];
  return new Date(nowMs + minutes * 60_000).toISOString();
}

export type ResolvedInstagramOutboundConnection =
  | {
      kind: 'ok';
      professionalAccountId: string;
      accessTokenCipher: { ciphertext: string; iv: string; authTag: string };
    }
  | {
      kind: 'error';
      code:
        | 'connection_missing'
        | 'not_connected'
        | 'account_mismatch'
        | 'token_missing';
    };

/**
 * Resolve connected Instagram credentials for salon + professional account.
 * No username routing. No pilot/default salon fallback.
 */
export async function resolveInstagramOutboundConnection(params: {
  db: SupabaseClient | any;
  salonId: string;
  professionalAccountId: string;
}): Promise<ResolvedInstagramOutboundConnection> {
  const professionalAccountId = params.professionalAccountId.trim();
  if (!professionalAccountId) {
    return { kind: 'error', code: 'connection_missing' };
  }

  const { data: conn, error } = await params.db
    .from('instagram_business_connections')
    .select(
      'salon_id, instagram_user_id, status, access_token_ciphertext, access_token_iv, access_token_auth_tag',
    )
    .eq('salon_id', params.salonId)
    .eq('instagram_user_id', professionalAccountId)
    .maybeSingle();

  if (error || !conn) return { kind: 'error', code: 'connection_missing' };

  if (String(conn.instagram_user_id ?? '') !== professionalAccountId) {
    return { kind: 'error', code: 'account_mismatch' };
  }
  if (String(conn.status) !== 'connected') {
    return { kind: 'error', code: 'not_connected' };
  }

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
    professionalAccountId,
    accessTokenCipher: {
      ciphertext: ciphertext.trim(),
      iv: iv.trim(),
      authTag: authTag.trim(),
    },
  };
}

/**
 * Receipt-owned idempotent enqueue via RPC.
 * Stale receipt owner → lost_ownership (no insert).
 */
export async function enqueueInstagramOutboundOwned(params: {
  db: SupabaseClient | any;
  salonId: string;
  receiptId: string;
  attemptCount: number;
  intent: InstagramOutboundIntent;
}): Promise<EnqueueInstagramOutboundResult> {
  const intent = params.intent;
  const sourceEventId = intent.sourceEventId.trim();
  const recipient = intent.recipientExternalUserId.trim();
  const professionalAccountId = intent.professionalAccountId.trim();
  const intentKey = intent.kind.trim();
  const payload = toInstagramOutboundPayload(intent);

  if (
    !sourceEventId ||
    !recipient ||
    !professionalAccountId ||
    !intentKey ||
    !payload.text
  ) {
    return { kind: 'error', code: 'malformed_enqueue' };
  }

  const { data, error } = await params.db.rpc('enqueue_instagram_outbound_owned', {
    p_salon_id: params.salonId,
    p_receipt_id: params.receiptId,
    p_attempt_count: params.attemptCount,
    p_professional_account_id: professionalAccountId,
    p_external_user_id: recipient,
    p_source_event_id: sourceEventId,
    p_intent_key: intentKey,
    p_payload: payload,
  });

  if (error) return { kind: 'error', code: 'enqueue_rpc_error' };
  const row = asRecord(data);
  if (!row) return { kind: 'error', code: 'enqueue_rpc_shape' };
  const kind = String(row.kind ?? '');
  if (kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (kind === 'error') {
    return { kind: 'error', code: String(row.code ?? 'enqueue_error') };
  }
  if (kind !== 'enqueued') return { kind: 'error', code: 'enqueue_rpc_kind' };
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return { kind: 'error', code: 'enqueue_id_missing' };
  return {
    kind: 'enqueued',
    id,
    created: Boolean(row.created),
    intentKey: String(row.intent_key ?? intentKey),
  };
}

export async function claimInstagramOutboundMessage(params: {
  db: SupabaseClient | any;
  messageId: string;
  staleSeconds?: number;
}): Promise<
  | { kind: 'claimed'; row: InstagramOutboundRow; claimToken: string }
  | { kind: 'not_claimable' }
  | { kind: 'exhausted'; attemptCount?: number }
  | { kind: 'error'; code: string }
> {
  const { data, error } = await params.db.rpc('claim_instagram_outbound_message', {
    p_message_id: params.messageId,
    p_stale_seconds: params.staleSeconds ?? INSTAGRAM_OUTBOUND_STALE_CLAIM_SECONDS,
  });
  if (error) return { kind: 'error', code: 'claim_rpc_error' };
  const row = asRecord(data);
  if (!row) return { kind: 'error', code: 'claim_rpc_shape' };
  const kind = String(row.kind ?? '');
  if (kind === 'not_claimable') return { kind: 'not_claimable' };
  if (kind === 'exhausted') {
    return {
      kind: 'exhausted',
      attemptCount:
        row.attempt_count == null ? undefined : Number(row.attempt_count),
    };
  }
  if (kind !== 'claimed') return { kind: 'error', code: 'claim_rpc_kind' };
  const claimToken = String(row.claim_token ?? '');
  if (!claimToken) return { kind: 'error', code: 'claim_token_missing' };
  return {
    kind: 'claimed',
    claimToken,
    row: mapOutboundRow(row),
  };
}

export async function finalizeInstagramOutboundSent(params: {
  db: SupabaseClient | any;
  messageId: string;
  claimToken: string;
  providerMessageId: string;
}): Promise<'sent' | 'lost_claim' | 'error'> {
  const { data, error } = await params.db.rpc('finalize_instagram_outbound_sent', {
    p_message_id: params.messageId,
    p_claim_token: params.claimToken,
    p_provider_message_id: params.providerMessageId,
  });
  if (error) return 'error';
  const row = asRecord(data);
  if (!row) return 'error';
  const kind = String(row.kind ?? '');
  if (kind === 'sent') return 'sent';
  if (kind === 'lost_claim') return 'lost_claim';
  return 'error';
}

export async function finalizeInstagramOutboundFailure(params: {
  db: SupabaseClient | any;
  messageId: string;
  claimToken: string;
  errorCode: string;
  retryable: boolean;
  attemptCount: number;
}): Promise<'retry_scheduled' | 'failed' | 'lost_claim' | 'error'> {
  const nextAttemptAt = params.retryable
    ? nextInstagramOutboundAttemptAt(params.attemptCount)
    : null;
  const { data, error } = await params.db.rpc(
    'finalize_instagram_outbound_failure',
    {
      p_message_id: params.messageId,
      p_claim_token: params.claimToken,
      p_error_code: params.errorCode,
      p_retryable: params.retryable,
      p_next_attempt_at: nextAttemptAt,
      p_max_attempts: INSTAGRAM_OUTBOUND_MAX_ATTEMPTS,
    },
  );
  if (error) return 'error';
  const row = asRecord(data);
  if (!row) return 'error';
  const kind = String(row.kind ?? '');
  if (kind === 'retry_scheduled') return 'retry_scheduled';
  if (kind === 'failed') return 'failed';
  if (kind === 'lost_claim') return 'lost_claim';
  return 'error';
}

function classifySendForOutbox(result: InstagramSendTextResult): {
  retryable: boolean;
  code: string;
  providerMessageId?: string;
  ambiguous?: boolean;
} {
  if (result.kind === 'sent') {
    return {
      retryable: false,
      code: 'sent',
      providerMessageId: result.providerMessageId,
    };
  }
  if (result.kind === 'ambiguous_outcome') {
    return { retryable: false, code: result.code, ambiguous: true };
  }
  if (result.kind === 'retryable_error') {
    return { retryable: true, code: result.code };
  }
  return { retryable: false, code: result.code };
}

/**
 * Claim → resolve connection → decrypt → send → finalize.
 * Ambiguous Meta outcomes finalize as terminal failed (no blind retry).
 */
export async function flushInstagramOutboundMessage(params: {
  db: SupabaseClient | any;
  messageId: string;
  /**
   * Injected Meta sender for tests. When provided, credential decrypt is skipped
   * (production omit this and always decrypt just-in-time).
   */
  sendFn?: InstagramSendTextFn;
}): Promise<FlushInstagramOutboundResult> {
  const usingInjectedSend = typeof params.sendFn === 'function';
  const sendFn = params.sendFn ?? sendInstagramTextMessage;

  const claimed = await claimInstagramOutboundMessage({
    db: params.db,
    messageId: params.messageId,
  });
  if (claimed.kind === 'not_claimable') {
    return { kind: 'skipped', code: 'not_claimable' };
  }
  if (claimed.kind === 'exhausted') {
    return { kind: 'failed', code: 'exhausted' };
  }
  if (claimed.kind === 'error') {
    return { kind: 'error', code: claimed.code };
  }

  const text =
    typeof claimed.row.payload?.text === 'string'
      ? claimed.row.payload.text.trim()
      : '';
  if (!text) {
    await finalizeInstagramOutboundFailure({
      db: params.db,
      messageId: claimed.row.id,
      claimToken: claimed.claimToken,
      errorCode: 'empty_payload_text',
      retryable: false,
      attemptCount: claimed.row.attempt_count,
    });
    return { kind: 'failed', code: 'empty_payload_text' };
  }

  const resolved = await resolveInstagramOutboundConnection({
    db: params.db,
    salonId: claimed.row.salon_id,
    professionalAccountId: claimed.row.professional_account_id,
  });
  if (resolved.kind === 'error') {
    await finalizeInstagramOutboundFailure({
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
      accessToken = decryptInstagramCredential(resolved.accessTokenCipher);
    } catch (err) {
      const code = isInstagramCredentialCryptoError(err)
        ? 'crypto_invalid'
        : 'crypto_error';
      await finalizeInstagramOutboundFailure({
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

  let sendResult: InstagramSendTextResult;
  try {
    sendResult = await sendFn({
      accessToken,
      professionalAccountId: resolved.professionalAccountId,
      recipientExternalUserId: claimed.row.external_user_id,
      text,
    });
  } finally {
    accessToken = '';
  }

  const classified = classifySendForOutbox(sendResult);
  if (sendResult.kind === 'sent' && classified.providerMessageId) {
    const fin = await finalizeInstagramOutboundSent({
      db: params.db,
      messageId: claimed.row.id,
      claimToken: claimed.claimToken,
      providerMessageId: classified.providerMessageId,
    });
    if (fin === 'sent') {
      return { kind: 'sent', providerMessageId: classified.providerMessageId };
    }
    return { kind: 'error', code: 'finalize_sent_failed' };
  }

  const fin = await finalizeInstagramOutboundFailure({
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
