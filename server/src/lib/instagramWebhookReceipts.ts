/**
 * IG-3: Instagram webhook receipt claim / reclaim / finalize.
 * Mirrors proven WhatsApp CAS/ownership semantics on channel_event_receipts
 * with provider hardcoded to 'instagram' (code-controlled — never from payload).
 *
 * Decision: Instagram-specific wrapper (not a WhatsApp big-bang refactor) to
 * keep WA runtime regression risk minimal. Pure classifiers reused from WA module.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelEventProcessingStatus } from '../types/database.js';
import {
  classifyExistingReceiptForClaim,
  isUniqueViolation,
  staleCutoffIso,
  type ExistingReceiptSnapshot,
  type ReceiptClaimResult,
  type ReceiptFinalizeResult,
  type ReceiptMarkFailedResult,
} from './whatsappWebhookReceipts.js';

export const INSTAGRAM_RECEIPT_PROVIDER = 'instagram' as const;

export type InstagramReceiptInsertInput = {
  salonId: string;
  externalEventId: string;
  externalMessageId: string | null;
  eventType: string;
  payloadHash: string | null;
  metadata: Record<string, string>;
};

export async function claimInstagramEventReceipt(
  db: SupabaseClient | any,
  input: InstagramReceiptInsertInput,
): Promise<ReceiptClaimResult> {
  const now = new Date().toISOString();

  const { data: inserted, error: insertError } = await db
    .from('channel_event_receipts')
    .insert({
      salon_id: input.salonId,
      provider: INSTAGRAM_RECEIPT_PROVIDER,
      external_event_id: input.externalEventId,
      external_message_id: input.externalMessageId,
      event_type: input.eventType,
      payload_hash: input.payloadHash,
      processing_status: 'processing' satisfies ChannelEventProcessingStatus,
      received_at: now,
      attempt_count: 1,
      metadata: input.metadata,
      last_error: null,
      processed_at: null,
      updated_at: now,
    })
    .select('id, attempt_count')
    .maybeSingle();

  if (!insertError && inserted?.id) {
    return {
      kind: 'claimed',
      receiptId: inserted.id as string,
      attemptCount: Number(inserted.attempt_count ?? 1),
    };
  }

  if (insertError && !isUniqueViolation(insertError)) {
    return { kind: 'failed_transient', code: 'receipt_insert' };
  }

  return reclaimExistingInstagramEventReceipt(db, {
    salonId: input.salonId,
    externalEventId: input.externalEventId,
  });
}

async function loadSameSalonReceipt(
  db: SupabaseClient | any,
  salonId: string,
  externalEventId: string,
): Promise<
  | { ok: true; receipt: ExistingReceiptSnapshot | null }
  | { ok: false; code: string }
> {
  const { data, error } = await db
    .from('channel_event_receipts')
    .select('id, salon_id, processing_status, attempt_count, updated_at')
    .eq('provider', INSTAGRAM_RECEIPT_PROVIDER)
    .eq('external_event_id', externalEventId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    return { ok: false, code: 'receipt_load' };
  }
  if (!data) {
    return { ok: true, receipt: null };
  }
  return {
    ok: true,
    receipt: {
      id: data.id as string,
      salon_id: data.salon_id as string,
      processing_status: String(data.processing_status),
      attempt_count: Number(data.attempt_count ?? 0),
      updated_at: String(data.updated_at),
    },
  };
}

async function atomicReclaimReceipt(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    receiptId: string;
    previousAttemptCount: number;
    mode: 'retryable' | 'stale_processing';
    staleBeforeIso?: string;
  },
): Promise<ReceiptClaimResult> {
  const now = new Date().toISOString();
  const nextAttempt = params.previousAttemptCount + 1;

  let query = db
    .from('channel_event_receipts')
    .update({
      processing_status: 'processing' satisfies ChannelEventProcessingStatus,
      attempt_count: nextAttempt,
      last_error: null,
      processed_at: null,
      updated_at: now,
    })
    .eq('id', params.receiptId)
    .eq('salon_id', params.salonId)
    .eq('provider', INSTAGRAM_RECEIPT_PROVIDER)
    .eq('attempt_count', params.previousAttemptCount);

  if (params.mode === 'retryable') {
    query = query.in('processing_status', ['received', 'failed']);
  } else {
    query = query
      .eq('processing_status', 'processing')
      .lt('updated_at', params.staleBeforeIso ?? staleCutoffIso());
  }

  const { data: claimed, error } = await query.select('id, attempt_count').maybeSingle();

  if (error) {
    return { kind: 'failed_transient', code: 'receipt_reclaim' };
  }
  if (claimed?.id) {
    return {
      kind: 'claimed',
      receiptId: claimed.id as string,
      attemptCount: Number(claimed.attempt_count ?? nextAttempt),
    };
  }

  return classifyAfterLostReclaimRace(db, params.salonId, params.receiptId);
}

async function classifyAfterLostReclaimRace(
  db: SupabaseClient | any,
  salonId: string,
  receiptId: string,
): Promise<ReceiptClaimResult> {
  const { data, error } = await db
    .from('channel_event_receipts')
    .select('id, salon_id, processing_status, attempt_count, updated_at')
    .eq('id', receiptId)
    .eq('salon_id', salonId)
    .eq('provider', INSTAGRAM_RECEIPT_PROVIDER)
    .maybeSingle();

  if (error) {
    return { kind: 'failed_transient', code: 'receipt_load' };
  }
  if (!data) {
    return { kind: 'failed_transient', code: 'receipt_reclaim_race' };
  }

  const receipt: ExistingReceiptSnapshot = {
    id: data.id as string,
    salon_id: data.salon_id as string,
    processing_status: String(data.processing_status),
    attempt_count: Number(data.attempt_count ?? 0),
    updated_at: String(data.updated_at),
  };

  const decision = classifyExistingReceiptForClaim(receipt);
  if (decision === 'duplicate_processed') {
    return { kind: 'duplicate_terminal', status: 'processed' };
  }
  if (decision === 'duplicate_ignored') {
    return { kind: 'duplicate_terminal', status: 'ignored' };
  }
  if (decision === 'in_flight') {
    return { kind: 'in_flight' };
  }
  if (decision === 'unknown_status') {
    return { kind: 'failed_transient', code: 'receipt_unknown_status' };
  }

  return { kind: 'failed_transient', code: 'receipt_reclaim_race' };
}

export async function reclaimExistingInstagramEventReceipt(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    externalEventId: string;
  },
): Promise<ReceiptClaimResult> {
  const loaded = await loadSameSalonReceipt(db, params.salonId, params.externalEventId);
  if (!loaded.ok) {
    return { kind: 'failed_transient', code: loaded.code };
  }

  const receipt = loaded.receipt;
  if (!receipt) {
    return { kind: 'cross_salon_conflict' };
  }

  if (receipt.salon_id !== params.salonId) {
    return { kind: 'cross_salon_conflict' };
  }

  const decision = classifyExistingReceiptForClaim(receipt);

  if (decision === 'duplicate_processed') {
    return { kind: 'duplicate_terminal', status: 'processed' };
  }
  if (decision === 'duplicate_ignored') {
    return { kind: 'duplicate_terminal', status: 'ignored' };
  }
  if (decision === 'in_flight') {
    return { kind: 'in_flight' };
  }
  if (decision === 'unknown_status') {
    return { kind: 'failed_transient', code: 'receipt_unknown_status' };
  }

  if (decision === 'reclaim_retryable') {
    return atomicReclaimReceipt(db, {
      salonId: params.salonId,
      receiptId: receipt.id,
      previousAttemptCount: receipt.attempt_count,
      mode: 'retryable',
    });
  }

  return atomicReclaimReceipt(db, {
    salonId: params.salonId,
    receiptId: receipt.id,
    previousAttemptCount: receipt.attempt_count,
    mode: 'stale_processing',
    staleBeforeIso: staleCutoffIso(),
  });
}

export async function finalizeInstagramEventReceipt(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    receiptId: string;
    attemptCount: number;
    finalStatus: 'processed' | 'ignored';
  },
): Promise<ReceiptFinalizeResult> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('channel_event_receipts')
    .update({
      processing_status: params.finalStatus,
      processed_at: now,
      updated_at: now,
      last_error: null,
    })
    .eq('id', params.receiptId)
    .eq('salon_id', params.salonId)
    .eq('provider', INSTAGRAM_RECEIPT_PROVIDER)
    .eq('processing_status', 'processing')
    .eq('attempt_count', params.attemptCount)
    .select('id')
    .maybeSingle();

  if (error) {
    return { ok: false, code: 'finalize_db_error' };
  }
  if (!data?.id) {
    return { ok: false, code: 'finalize_lost_ownership' };
  }
  return { ok: true, status: params.finalStatus };
}

export async function markInstagramEventReceiptFailed(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    receiptId: string;
    attemptCount: number;
    errorCode: string;
  },
): Promise<ReceiptMarkFailedResult> {
  const safeCode =
    typeof params.errorCode === 'string' && params.errorCode.trim().length > 0
      ? params.errorCode.trim().slice(0, 120)
      : 'receipt_failed';

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('channel_event_receipts')
    .update({
      processing_status: 'failed' satisfies ChannelEventProcessingStatus,
      last_error: safeCode,
      updated_at: now,
    })
    .eq('id', params.receiptId)
    .eq('salon_id', params.salonId)
    .eq('provider', INSTAGRAM_RECEIPT_PROVIDER)
    .eq('processing_status', 'processing')
    .eq('attempt_count', params.attemptCount)
    .select('id')
    .maybeSingle();

  if (error) {
    return { ok: false, code: 'mark_failed_db_error' };
  }
  if (!data?.id) {
    return { ok: false, code: 'mark_failed_lost_ownership' };
  }
  return { ok: true };
}
