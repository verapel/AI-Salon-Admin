/**
 * IG-5: Load Instagram conversation booking snapshot + owned FSM transition RPC.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  INSTAGRAM_CHANNEL_PROVIDER,
  INSTAGRAM_CONVERSATION_INACTIVITY_SECONDS,
} from './instagramIdentityConversation.js';
import {
  isInstagramBookingStep,
  parseInstagramBookingState,
  type InstagramBookingState,
  type InstagramBookingStep,
} from './instagramBookingState.js';

export type InstagramConversationBookingSnapshot = {
  conversationId: string;
  clientId: string | null;
  currentFlow: string | null;
  currentStep: string | null;
  state: InstagramBookingState;
  lastInboundMessageId: string | null;
  lastInboundAt: string | null;
  expiresAt: string | null;
};

export type InstagramBookingTransitionResult =
  | {
      kind: 'ok';
      duplicate: boolean;
      conversationId: string;
      currentFlow: string | null;
      currentStep: string | null;
      state: InstagramBookingState;
      clientId: string | null;
    }
  | { kind: 'lost_ownership' }
  | { kind: 'stale_step'; currentFlow: string | null; currentStep: string | null }
  | { kind: 'outdated' }
  | { kind: 'invalid_state'; code?: string }
  | { kind: 'error'; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isInstagramConversationExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false;
  return ms <= Date.now();
}

export async function loadInstagramConversationBookingSnapshot(params: {
  db: SupabaseClient | any;
  salonId: string;
  externalUserId: string;
}): Promise<
  | { kind: 'ok'; snapshot: InstagramConversationBookingSnapshot }
  | { kind: 'missing' }
  | { kind: 'error'; code: string }
> {
  const { data, error } = await params.db
    .from('channel_conversations')
    .select(
      'id, client_id, current_flow, current_step, state, last_inbound_message_id, last_inbound_at, expires_at',
    )
    .eq('salon_id', params.salonId)
    .eq('provider', INSTAGRAM_CHANNEL_PROVIDER)
    .eq('external_user_id', params.externalUserId)
    .maybeSingle();

  if (error) return { kind: 'error', code: 'conversation_load' };
  if (!data) return { kind: 'missing' };

  const stepRaw = data.current_step == null ? null : String(data.current_step);
  return {
    kind: 'ok',
    snapshot: {
      conversationId: String(data.id),
      clientId: data.client_id == null ? null : String(data.client_id),
      currentFlow: data.current_flow == null ? null : String(data.current_flow),
      currentStep: isInstagramBookingStep(stepRaw) ? (stepRaw as InstagramBookingStep) : stepRaw,
      state: parseInstagramBookingState(data.state),
      lastInboundMessageId:
        data.last_inbound_message_id == null ? null : String(data.last_inbound_message_id),
      lastInboundAt: data.last_inbound_at == null ? null : String(data.last_inbound_at),
      expiresAt: data.expires_at == null ? null : String(data.expires_at),
    },
  };
}

export async function transitionInstagramBookingOwned(params: {
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
}): Promise<InstagramBookingTransitionResult> {
  const { data, error } = await params.db.rpc('transition_instagram_booking_owned', {
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
    p_inactivity_seconds: INSTAGRAM_CONVERSATION_INACTIVITY_SECONDS,
  });

  if (error) return { kind: 'error', code: 'booking_transition_rpc' };
  const row = asRecord(data);
  if (!row) return { kind: 'error', code: 'booking_transition_rpc_shape' };

  const kind = String(row.kind ?? '');
  if (kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (kind === 'outdated') return { kind: 'outdated' };
  if (kind === 'invalid_state') {
    return {
      kind: 'invalid_state',
      code: row.code == null ? undefined : String(row.code),
    };
  }
  if (kind === 'stale_step') {
    return {
      kind: 'stale_step',
      currentFlow: row.current_flow == null ? null : String(row.current_flow),
      currentStep: row.current_step == null ? null : String(row.current_step),
    };
  }
  if (kind === 'error') {
    return { kind: 'error', code: String(row.code ?? 'booking_transition_rpc_error') };
  }
  if (kind !== 'ok') return { kind: 'error', code: 'booking_transition_rpc_kind' };

  return {
    kind: 'ok',
    duplicate: Boolean(row.duplicate),
    conversationId: String(row.conversation_id),
    currentFlow: row.current_flow == null ? null : String(row.current_flow),
    currentStep: row.current_step == null ? null : String(row.current_step),
    state: parseInstagramBookingState(row.state),
    clientId: row.client_id == null ? null : String(row.client_id),
  };
}
