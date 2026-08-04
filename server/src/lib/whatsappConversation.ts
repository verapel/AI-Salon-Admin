/**
 * Durable WhatsApp channel_conversations foundation (WA-4B / WA-4B1 / WA-4C).
 * Conversation-first mutations go through owned Postgres RPCs that lock the
 * receipt row FOR UPDATE before writing — no app-level SELECT-then-UPDATE.
 * Booking FSM step writes use transition_whatsapp_booking_owned.
 * No appointments or outbound messaging.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseWhatsAppBookingState,
  type WhatsAppBookingState,
} from './whatsappBookingState.js';

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

export type ConversationBookingSnapshot = {
  conversationId: string;
  clientId: string | null;
  currentFlow: string | null;
  currentStep: string | null;
  state: WhatsAppBookingState;
  lastInboundMessageId: string | null;
  lastInboundAt: string | null;
  expiresAt: string | null;
};

export type BookingTransitionResult =
  | {
      kind: 'ok';
      duplicate: boolean;
      conversationId: string;
      currentFlow: string | null;
      currentStep: string | null;
      state: WhatsAppBookingState;
      clientId: string | null;
    }
  | { kind: 'lost_ownership' }
  | { kind: 'stale_step'; currentFlow: string | null; currentStep: string | null }
  | { kind: 'outdated' }
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

/** Read-only snapshot for FSM decision (mutations remain owned RPC-only). */
export async function loadWhatsAppConversationBookingSnapshot(params: {
  db: SupabaseClient | any;
  salonId: string;
  externalUserId: string;
}): Promise<
  | { kind: 'ok'; snapshot: ConversationBookingSnapshot }
  | { kind: 'missing' }
  | { kind: 'error'; code: string }
> {
  const { data, error } = await params.db
    .from('channel_conversations')
    .select(
      'id, client_id, current_flow, current_step, state, last_inbound_message_id, last_inbound_at, expires_at'
    )
    .eq('salon_id', params.salonId)
    .eq('provider', WHATSAPP_CONVERSATION_PROVIDER)
    .eq('external_user_id', params.externalUserId)
    .maybeSingle();

  if (error) return { kind: 'error', code: 'conversation_load' };
  if (!data) return { kind: 'missing' };

  return {
    kind: 'ok',
    snapshot: {
      conversationId: String(data.id),
      clientId: data.client_id == null ? null : String(data.client_id),
      currentFlow: data.current_flow == null ? null : String(data.current_flow),
      currentStep: data.current_step == null ? null : String(data.current_step),
      state: parseWhatsAppBookingState(data.state),
      lastInboundMessageId:
        data.last_inbound_message_id == null
          ? null
          : String(data.last_inbound_message_id),
      lastInboundAt: data.last_inbound_at == null ? null : String(data.last_inbound_at),
      expiresAt: data.expires_at == null ? null : String(data.expires_at),
    },
  };
}

/**
 * Atomic expected-step booking FSM transition under receipt ownership (RPC).
 * Does not create appointments/clients. Does not send outbound messages.
 */
export async function transitionWhatsAppBookingOwned(params: {
  db: SupabaseClient | any;
  salonId: string;
  receiptId: string;
  attemptCount: number;
  externalUserId: string;
  externalMessageId: string | null;
  messageTimestampIso: string | null;
  expectedFlow: string | null;
  expectedStep: string | null;
  nextFlow: string | null;
  nextStep: string | null;
  nextState: Record<string, unknown>;
}): Promise<BookingTransitionResult> {
  const { data, error } = await params.db.rpc('transition_whatsapp_booking_owned', {
    p_salon_id: params.salonId,
    p_receipt_id: params.receiptId,
    p_attempt_count: params.attemptCount,
    p_external_user_id: params.externalUserId,
    p_external_message_id: params.externalMessageId,
    p_message_at: params.messageTimestampIso,
    p_expected_flow: params.expectedFlow,
    p_expected_step: params.expectedStep,
    p_next_flow: params.nextFlow,
    p_next_step: params.nextStep,
    p_next_state: params.nextState,
    p_inactivity_seconds: CONVERSATION_INACTIVITY_SECONDS,
  });

  if (error) {
    return { kind: 'error', code: 'booking_transition_rpc' };
  }

  const row = mapRpcKind(data);
  if (!row) return { kind: 'error', code: 'booking_transition_rpc_shape' };

  const kind = String(row.kind ?? '');
  if (kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (kind === 'outdated') return { kind: 'outdated' };
  if (kind === 'stale_step') {
    return {
      kind: 'stale_step',
      currentFlow: row.current_flow == null ? null : String(row.current_flow),
      currentStep: row.current_step == null ? null : String(row.current_step),
    };
  }
  if (kind === 'error') {
    return { kind: 'error', code: String(row.code ?? 'booking_transition_error') };
  }
  if (kind !== 'ok') return { kind: 'error', code: 'booking_transition_kind' };

  return {
    kind: 'ok',
    duplicate: Boolean(row.duplicate),
    conversationId: String(row.conversation_id),
    currentFlow: row.current_flow == null ? null : String(row.current_flow),
    currentStep: row.current_step == null ? null : String(row.current_step),
    state: parseWhatsAppBookingState(row.state),
    clientId: row.client_id == null ? null : String(row.client_id),
  };
}
