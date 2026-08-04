/**
 * Durable WhatsApp channel_conversations foundation (WA-4B / WA-4B1).
 * Conversation-first mutations go through owned Postgres RPCs that lock the
 * receipt row FOR UPDATE before writing — no app-level SELECT-then-UPDATE.
 * No appointments, FSM decisions, or outbound messaging.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const WHATSAPP_CONVERSATION_PROVIDER = 'whatsapp' as const;

/** Conservative inactivity timeout before flow/state reset (identity/client preserved). */
export const CONVERSATION_INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const CONVERSATION_INACTIVITY_SECONDS = 24 * 60 * 60;

export type ConversationTouchResult =
  | {
      kind: 'ok';
      conversationId: string;
      clientId: string | null;
      expiredReset: boolean;
      advanced: boolean;
    }
  | { kind: 'lost_ownership' }
  | { kind: 'error'; code: string };

export type ConversationClientLinkResult =
  | { kind: 'ok'; conversationId: string; clientId: string }
  | { kind: 'conflict'; code: 'conversation_client_mismatch' | 'identity_client_missing' }
  | { kind: 'lost_ownership' }
  | { kind: 'error'; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapRpcKind(data: unknown): Record<string, unknown> | null {
  return asRecord(data);
}

/**
 * Atomic conversation create/touch under receipt ownership (RPC).
 * Idle convention: current_flow=null, current_step=null, state={}.
 * Expired reset (flow/step/state) happens inside the same owned transaction.
 * Out-of-order older messages do not regress last_inbound_*.
 */
export async function touchWhatsAppConversation(params: {
  db: SupabaseClient | any;
  salonId: string;
  externalUserId: string;
  externalMessageId: string | null;
  messageTimestampIso: string | null;
  receiptId: string;
  attemptCount: number;
  /** Non-authoritative profile hint only; never used to create clients. */
  profileNameHint?: string | null;
}): Promise<ConversationTouchResult> {
  const { data, error } = await params.db.rpc('apply_whatsapp_conversation_event_owned', {
    p_salon_id: params.salonId,
    p_receipt_id: params.receiptId,
    p_attempt_count: params.attemptCount,
    p_external_user_id: params.externalUserId,
    p_external_message_id: params.externalMessageId,
    p_message_at: params.messageTimestampIso,
    p_profile_name_hint: params.profileNameHint ?? null,
    p_inactivity_seconds: CONVERSATION_INACTIVITY_SECONDS,
  });

  if (error) {
    return { kind: 'error', code: 'conversation_rpc' };
  }

  const row = mapRpcKind(data);
  if (!row) return { kind: 'error', code: 'conversation_rpc_shape' };

  const kind = String(row.kind ?? '');
  if (kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (kind === 'error') {
    return { kind: 'error', code: String(row.code ?? 'conversation_rpc_error') };
  }
  if (kind !== 'ok') return { kind: 'error', code: 'conversation_rpc_kind' };

  return {
    kind: 'ok',
    conversationId: String(row.conversation_id),
    clientId: row.client_id == null ? null : String(row.client_id),
    expiredReset: Boolean(row.expired_reset),
    advanced: Boolean(row.advanced),
  };
}

/**
 * Atomic conversation.client_id link under receipt ownership (RPC).
 * Null → set; same client → idempotent; different client → conflict.
 */
export async function linkWhatsAppConversationClient(params: {
  db: SupabaseClient | any;
  salonId: string;
  externalUserId: string;
  clientId: string;
  receiptId: string;
  attemptCount: number;
}): Promise<ConversationClientLinkResult> {
  const { data, error } = await params.db.rpc('link_whatsapp_conversation_client_owned', {
    p_salon_id: params.salonId,
    p_receipt_id: params.receiptId,
    p_attempt_count: params.attemptCount,
    p_external_user_id: params.externalUserId,
    p_client_id: params.clientId,
  });

  if (error) {
    return { kind: 'error', code: 'conversation_link_rpc' };
  }

  const row = mapRpcKind(data);
  if (!row) return { kind: 'error', code: 'conversation_link_rpc_shape' };

  const kind = String(row.kind ?? '');
  if (kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (kind === 'conflict') {
    const code = String(row.code ?? 'conversation_client_mismatch');
    if (code === 'identity_client_missing') {
      return { kind: 'conflict', code: 'identity_client_missing' };
    }
    return { kind: 'conflict', code: 'conversation_client_mismatch' };
  }
  if (kind === 'error') {
    return { kind: 'error', code: String(row.code ?? 'conversation_link_rpc_error') };
  }
  if (kind !== 'ok') return { kind: 'error', code: 'conversation_link_rpc_kind' };

  return {
    kind: 'ok',
    conversationId: String(row.conversation_id),
    clientId: String(row.client_id),
  };
}

/** Pure helper retained for local/unit reasoning of expiry policy. */
export function isConversationExpired(
  conversation: { expires_at: string | null },
  nowMs: number = Date.now()
): boolean {
  if (!conversation.expires_at) return false;
  const expiresMs = Date.parse(conversation.expires_at);
  if (!Number.isFinite(expiresMs)) return false;
  return nowMs >= expiresMs;
}
