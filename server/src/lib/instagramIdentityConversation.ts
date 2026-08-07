/**
 * IG-4: Instagram sender identity + durable conversation foundation.
 * Mutations go through apply_instagram_inbound_identity_conversation_owned
 * (receipt FOR UPDATE + attempt_count generation) — no SELECT-then-UPDATE.
 * No booking, outbound, Meta profile lookup, or client creation.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const INSTAGRAM_CHANNEL_PROVIDER = 'instagram' as const;

/**
 * Application conversation inactivity TTL (seconds).
 * Internal state expiry only — NOT the Meta Send API messaging window.
 */
export const INSTAGRAM_CONVERSATION_INACTIVITY_SECONDS = 24 * 60 * 60;

export type InstagramIdentityConversationResult =
  | {
      kind: 'ok';
      identityId: string;
      conversationId: string;
      clientId: string | null;
      advanced: boolean;
      identityCreated: boolean;
      conversationCreated: boolean;
    }
  | { kind: 'lost_ownership' }
  | { kind: 'error'; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse Instagram messaging timestamp to ISO.
 * Accepts finite unix seconds or milliseconds; rejects non-positive / non-finite / absurd range.
 */
export function parseInstagramMessageTimestamp(value: unknown): string | null {
  let ms: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      ms = trimmed.length <= 10 ? n * 1000 : n;
    } else {
      const d = new Date(trimmed);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  // Reject absurd timestamps (before 2000-01-01 or > 24h into the future).
  if (ms < 946_684_800_000 || ms > Date.now() + 24 * 60 * 60 * 1000) return null;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Atomic identity + conversation create/touch under Instagram receipt ownership.
 */
export async function applyInstagramInboundIdentityConversationOwned(params: {
  db: SupabaseClient | any;
  salonId: string;
  receiptId: string;
  attemptCount: number;
  externalUserId: string;
  externalMessageId: string | null;
  messageTimestampIso: string | null;
}): Promise<InstagramIdentityConversationResult> {
  const { data, error } = await params.db.rpc(
    'apply_instagram_inbound_identity_conversation_owned',
    {
      p_salon_id: params.salonId,
      p_receipt_id: params.receiptId,
      p_attempt_count: params.attemptCount,
      p_external_user_id: params.externalUserId,
      p_external_message_id: params.externalMessageId,
      p_message_at: params.messageTimestampIso,
      p_inactivity_seconds: INSTAGRAM_CONVERSATION_INACTIVITY_SECONDS,
    },
  );

  if (error) {
    return { kind: 'error', code: 'identity_conversation_rpc' };
  }

  const row = asRecord(data);
  if (!row) return { kind: 'error', code: 'identity_conversation_rpc_shape' };

  const kind = String(row.kind ?? '');
  if (kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (kind === 'error' || kind === 'conflict') {
    return { kind: 'error', code: String(row.code ?? 'identity_conversation_rpc_error') };
  }
  if (kind !== 'ok') return { kind: 'error', code: 'identity_conversation_rpc_kind' };

  return {
    kind: 'ok',
    identityId: String(row.identity_id),
    conversationId: String(row.conversation_id),
    clientId: row.client_id == null ? null : String(row.client_id),
    advanced: Boolean(row.advanced),
    identityCreated: Boolean(row.identity_created),
    conversationCreated: Boolean(row.conversation_created),
  };
}
