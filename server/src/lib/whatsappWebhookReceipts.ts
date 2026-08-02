/**
 * WhatsApp webhook receipt claim / reclaim (WA-3C).
 * Status-aware, race-aware idempotency for channel_event_receipts.
 * No booking/FSM/message content handling.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelEventProcessingStatus } from '../types/database.js';

export const WHATSAPP_RECEIPT_PROVIDER = 'whatsapp' as const;

/** Stale threshold for reclaiming rows stuck in processing. */
export const RECEIPT_PROCESSING_STALE_MS = 5 * 60 * 1000;

export type ReceiptClaimDecision =
  | 'duplicate_processed'
  | 'duplicate_ignored'
  | 'reclaim_retryable'
  | 'reclaim_stale_processing'
  | 'in_flight'
  | 'unknown_status';

export type ReceiptClaimKind =
  | 'claimed'
  | 'duplicate_terminal'
  | 'in_flight'
  | 'failed_transient'
  | 'cross_salon_conflict';

export type ReceiptClaimResult =
  | { kind: 'claimed'; receiptId: string; attemptCount: number }
  | { kind: 'duplicate_terminal'; status: 'processed' | 'ignored' }
  | { kind: 'in_flight' }
  | { kind: 'failed_transient'; code: string }
  | { kind: 'cross_salon_conflict' };

export type ReceiptFinalizeResult =
  | { ok: true; status: 'processed' | 'ignored' }
  | { ok: false; code: string };

export type ExistingReceiptSnapshot = {
  id: string;
  salon_id: string;
  processing_status: string;
  attempt_count: number;
  updated_at: string;
};

export function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '23505') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('duplicate key') || msg.includes('unique');
}

/**
 * Pure decision for an existing same-salon receipt.
 * Does not mutate state — caller performs atomic conditional UPDATE.
 */
export function classifyExistingReceiptForClaim(
  receipt: Pick<ExistingReceiptSnapshot, 'processing_status' | 'updated_at'>,
  nowMs: number = Date.now(),
  staleMs: number = RECEIPT_PROCESSING_STALE_MS
): ReceiptClaimDecision {
  const status = receipt.processing_status;

  if (status === 'processed') return 'duplicate_processed';
  if (status === 'ignored') return 'duplicate_ignored';
  if (status === 'received' || status === 'failed') return 'reclaim_retryable';

  if (status === 'processing') {
    const updatedMs = Date.parse(receipt.updated_at);
    if (!Number.isFinite(updatedMs)) {
      // Unparseable timestamp → treat as stale so retries are not suppressed forever.
      return 'reclaim_stale_processing';
    }
    if (nowMs - updatedMs >= staleMs) {
      return 'reclaim_stale_processing';
    }
    return 'in_flight';
  }

  return 'unknown_status';
}

export function staleCutoffIso(
  nowMs: number = Date.now(),
  staleMs: number = RECEIPT_PROCESSING_STALE_MS
): string {
  return new Date(nowMs - staleMs).toISOString();
}

type ReceiptInsertInput = {
  salonId: string;
  externalEventId: string;
  externalMessageId: string | null;
  eventType: string;
  payloadHash: string | null;
  metadata: Record<string, string>;
};

/**
 * Claim a receipt for processing (new insert as processing, or atomic reclaim).
 * Lookup/reclaim always scoped by salon_id + provider + external_event_id.
 */
export async function claimWhatsAppEventReceipt(
  db: SupabaseClient | any,
  input: ReceiptInsertInput
): Promise<ReceiptClaimResult> {
  const now = new Date().toISOString();

  const { data: inserted, error: insertError } = await db
    .from('channel_event_receipts')
    .insert({
      salon_id: input.salonId,
      provider: WHATSAPP_RECEIPT_PROVIDER,
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

  // Unique conflict: load same-salon row only.
  return reclaimExistingWhatsAppEventReceipt(db, {
    salonId: input.salonId,
    externalEventId: input.externalEventId,
  });
}

async function loadSameSalonReceipt(
  db: SupabaseClient | any,
  salonId: string,
  externalEventId: string
): Promise<
  | { ok: true; receipt: ExistingReceiptSnapshot | null }
  | { ok: false; code: string }
> {
  const { data, error } = await db
    .from('channel_event_receipts')
    .select('id, salon_id, processing_status, attempt_count, updated_at')
    .eq('provider', WHATSAPP_RECEIPT_PROVIDER)
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
  }
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
    .eq('provider', WHATSAPP_RECEIPT_PROVIDER);

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

  // Lost race — re-read and classify only (no recursive reclaim loop).
  return classifyAfterLostReclaimRace(db, params.salonId, params.receiptId);
}

async function classifyAfterLostReclaimRace(
  db: SupabaseClient | any,
  salonId: string,
  receiptId: string
): Promise<ReceiptClaimResult> {
  const { data, error } = await db
    .from('channel_event_receipts')
    .select('id, salon_id, processing_status, attempt_count, updated_at')
    .eq('id', receiptId)
    .eq('salon_id', salonId)
    .eq('provider', WHATSAPP_RECEIPT_PROVIDER)
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

  // Still retryable/stale but this worker lost the conditional UPDATE.
  // Return transient so Meta retries; do not loop reclaim here.
  return { kind: 'failed_transient', code: 'receipt_reclaim_race' };
}

/**
 * Load, classify, and atomically reclaim an existing same-salon receipt
 * after a unique-constraint conflict on insert.
 */
export async function reclaimExistingWhatsAppEventReceipt(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    externalEventId: string;
  }
): Promise<ReceiptClaimResult> {
  const loaded = await loadSameSalonReceipt(db, params.salonId, params.externalEventId);
  if (!loaded.ok) {
    return { kind: 'failed_transient', code: loaded.code };
  }

  const receipt = loaded.receipt;
  if (!receipt) {
    // Unique conflict under global (provider, external_event_id) but no same-salon row.
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

  // reclaim_stale_processing
  return atomicReclaimReceipt(db, {
    salonId: params.salonId,
    receiptId: receipt.id,
    previousAttemptCount: receipt.attempt_count,
    mode: 'stale_processing',
    staleBeforeIso: staleCutoffIso(),
  });
}

export async function finalizeWhatsAppEventReceipt(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    receiptId: string;
    finalStatus: 'processed' | 'ignored';
  }
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
    .eq('provider', WHATSAPP_RECEIPT_PROVIDER)
    .eq('processing_status', 'processing')
    .select('id')
    .maybeSingle();

  if (error) {
    return { ok: false, code: 'receipt_finalize' };
  }
  if (!data?.id) {
    return { ok: false, code: 'receipt_finalize_race' };
  }
  return { ok: true, status: params.finalStatus };
}

/**
 * Mark a claimed receipt as failed with a safe internal error code only.
 */
export async function markWhatsAppEventReceiptFailed(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    receiptId: string;
    errorCode: string;
  }
): Promise<boolean> {
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
    .eq('provider', WHATSAPP_RECEIPT_PROVIDER)
    .eq('processing_status', 'processing')
    .select('id')
    .maybeSingle();

  if (error || !data?.id) {
    return false;
  }
  return true;
}
