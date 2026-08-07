/**
 * Instagram idempotent booking commit (IG-6).
 * App precheck + owned RPC wrapper + slot-unavailable recovery.
 * No Meta outbound. No Telegram reminders / admin notify.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeAvailableSlots,
  findNextAvailableDates,
} from './scheduleSlots.js';
import {
  findStaffForServiceSpecialization,
  getActiveStaffById,
  resolveServiceById,
} from './telegramBooking.js';
import {
  INSTAGRAM_BOOKING_FLOW,
  isCompleteInstagramReadyState,
  type InstagramBookingState,
} from './instagramBookingState.js';
import { transitionInstagramBookingOwned } from './instagramBookingConversation.js';
import { parseWhatsAppBookingPhone } from './whatsappBookingParsers.js';

export type InstagramBookingCommitResult =
  | {
      kind: 'booking_created';
      appointmentId: string;
      clientId: string;
    }
  | {
      kind: 'already_booked';
      appointmentId: string;
      clientId: string;
    }
  | { kind: 'slot_unavailable' }
  | {
      kind: 'slot_unavailable_choose_time';
      options: Array<{ id: string; label: string }>;
      date: string;
    }
  | {
      kind: 'slot_unavailable_choose_date';
      options: Array<{ id: string; label: string }>;
    }
  | { kind: 'service_unavailable' }
  | { kind: 'staff_unavailable' }
  | { kind: 'ambiguous_client' }
  | { kind: 'identity_conflict' }
  | { kind: 'client_blocked' }
  | { kind: 'client_resolution_conflict' }
  | { kind: 'stale_state'; code?: string }
  | { kind: 'lost_ownership' }
  | { kind: 'error'; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapCommitRpcRow(row: Record<string, unknown>): InstagramBookingCommitResult {
  const kind = String(row.kind ?? '');
  switch (kind) {
    case 'booking_created':
      return {
        kind: 'booking_created',
        appointmentId: String(row.appointment_id),
        clientId: String(row.client_id),
      };
    case 'already_booked':
      return {
        kind: 'already_booked',
        appointmentId: String(row.appointment_id),
        clientId: String(row.client_id),
      };
    case 'slot_unavailable':
      return { kind: 'slot_unavailable' };
    case 'service_unavailable':
      return { kind: 'service_unavailable' };
    case 'staff_unavailable':
      return { kind: 'staff_unavailable' };
    case 'ambiguous_client':
      return { kind: 'ambiguous_client' };
    case 'identity_conflict':
      return { kind: 'identity_conflict' };
    case 'client_blocked':
      return { kind: 'client_blocked' };
    case 'client_resolution_conflict':
      return { kind: 'client_resolution_conflict' };
    case 'stale_state':
      return {
        kind: 'stale_state',
        code: row.code == null ? undefined : String(row.code),
      };
    case 'lost_ownership':
      return { kind: 'lost_ownership' };
    case 'error':
      return { kind: 'error', code: String(row.code ?? 'db_error') };
    default:
      return { kind: 'error', code: 'booking_commit_kind' };
  }
}

/**
 * Optional app-side prevalidation (not the concurrency/ownership barrier).
 * Returns null when precheck passes.
 */
export async function prevalidateInstagramBookingCommit(params: {
  salonId: string;
  state: InstagramBookingState;
}): Promise<InstagramBookingCommitResult | null> {
  const { state, salonId } = params;
  if (!isCompleteInstagramReadyState(state)) {
    return { kind: 'stale_state', code: 'incomplete_state' };
  }

  const service = await resolveServiceById(salonId, state.serviceId!);
  if (!service) return { kind: 'service_unavailable' };

  const staff = await getActiveStaffById(salonId, state.staffId!);
  if (!staff) return { kind: 'staff_unavailable' };

  const compatible = await findStaffForServiceSpecialization(salonId, service.name);
  if (!compatible.some((m) => m.id === staff.id)) {
    return { kind: 'staff_unavailable' };
  }

  const duration = service.duration > 0 ? service.duration : 60;
  const slots = await computeAvailableSlots({
    salonId,
    staffId: staff.id,
    date: state.date!,
    durationMinutes: duration,
  });
  if (!slots.includes(state.time!)) {
    return { kind: 'slot_unavailable' };
  }

  if (!parseWhatsAppBookingPhone(state.phone!)) {
    return { kind: 'error', code: 'invalid_phone' };
  }

  return null;
}

export type InstagramSlotRecoveryDeps = {
  resolveServiceById: typeof resolveServiceById;
  computeAvailableSlots: typeof computeAvailableSlots;
  findNextAvailableDates: typeof findNextAvailableDates;
  transition: typeof transitionInstagramBookingOwned;
};

const defaultSlotRecoveryDeps: InstagramSlotRecoveryDeps = {
  resolveServiceById,
  computeAvailableSlots,
  findNextAvailableDates,
  transition: transitionInstagramBookingOwned,
};

/**
 * After service/staff invalid: recover ready_to_book → service|staff.
 * Clears stale IDs; keeps name/phone when present. No appointment.
 */
export async function recoverInstagramBookingInvalidEntity(
  params: {
    db: SupabaseClient | any;
    salonId: string;
    receiptId: string;
    attemptCount: number;
    externalUserId: string;
    sourceMessageId: string;
    messageTimestampIso: string | null;
    state: InstagramBookingState;
    target: 'service' | 'staff';
  },
  transition: InstagramSlotRecoveryDeps['transition'] = transitionInstagramBookingOwned,
): Promise<InstagramBookingCommitResult> {
  const nextState: Record<string, string> = {
    sourceMessageId: params.sourceMessageId,
  };
  if (params.target === 'staff' && params.state.serviceId && params.state.serviceName) {
    nextState.serviceId = params.state.serviceId;
    nextState.serviceName = params.state.serviceName;
  }
  if (params.state.name) nextState.name = params.state.name;
  if (params.state.phone) nextState.phone = params.state.phone;

  const t = await transition({
    db: params.db,
    salonId: params.salonId,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
    externalUserId: params.externalUserId,
    externalMessageId: null,
    messageTimestampIso: params.messageTimestampIso,
    expectedFlow: INSTAGRAM_BOOKING_FLOW,
    expectedStep: 'ready_to_book',
    nextFlow: INSTAGRAM_BOOKING_FLOW,
    nextStep: params.target,
    nextState,
  });

  if (t.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (t.kind === 'outdated') return { kind: 'stale_state', code: 'recovery_outdated' };
  if (t.kind === 'stale_step') return { kind: 'stale_state', code: 'recovery_stale_step' };
  if (t.kind === 'invalid_state') return { kind: 'stale_state', code: 'recovery_invalid_state' };
  if (t.kind === 'error') return { kind: 'error', code: t.code };
  if (t.kind === 'ok' && t.duplicate) {
    return { kind: 'stale_state', code: 'recovery_duplicate' };
  }

  return params.target === 'service'
    ? { kind: 'service_unavailable' }
    : { kind: 'staff_unavailable' };
}

/**
 * After slot_unavailable: recover ready_to_book → time|date via owned transition.
 * Pass externalMessageId=null so transition does not treat phone mid as FSM duplicate.
 * Preserves name/phone for later steps.
 */
export async function recoverInstagramBookingSlotUnavailable(
  params: {
    db: SupabaseClient | any;
    salonId: string;
    receiptId: string;
    attemptCount: number;
    externalUserId: string;
    sourceMessageId: string;
    messageTimestampIso: string | null;
    state: InstagramBookingState;
  },
  deps: InstagramSlotRecoveryDeps = defaultSlotRecoveryDeps,
): Promise<InstagramBookingCommitResult> {
  const { state } = params;
  if (!state.serviceId || !state.staffId || !state.date || !state.serviceName || !state.staffName) {
    return { kind: 'stale_state', code: 'incomplete_recovery_state' };
  }

  const service = await deps.resolveServiceById(params.salonId, state.serviceId);
  if (!service) return { kind: 'service_unavailable' };
  const duration = service.duration > 0 ? service.duration : 60;

  const freeSlots = await deps.computeAvailableSlots({
    salonId: params.salonId,
    staffId: state.staffId,
    date: state.date,
    durationMinutes: duration,
  });

  const recoverToTime = freeSlots.length > 0;
  const nextStep = recoverToTime ? 'time' : 'date';
  const nextState: Record<string, string> = {
    serviceId: state.serviceId,
    serviceName: state.serviceName,
    staffId: state.staffId,
    staffName: state.staffName,
    sourceMessageId: params.sourceMessageId,
  };
  if (state.name) nextState.name = state.name;
  if (state.phone) nextState.phone = state.phone;
  if (recoverToTime) {
    nextState.date = state.date;
  }

  const t = await deps.transition({
    db: params.db,
    salonId: params.salonId,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
    externalUserId: params.externalUserId,
    externalMessageId: null,
    messageTimestampIso: params.messageTimestampIso,
    expectedFlow: INSTAGRAM_BOOKING_FLOW,
    expectedStep: 'ready_to_book',
    nextFlow: INSTAGRAM_BOOKING_FLOW,
    nextStep,
    nextState,
  });

  if (t.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (t.kind === 'outdated') return { kind: 'stale_state', code: 'recovery_outdated' };
  if (t.kind === 'stale_step') return { kind: 'stale_state', code: 'recovery_stale_step' };
  if (t.kind === 'invalid_state') return { kind: 'stale_state', code: 'recovery_invalid_state' };
  if (t.kind === 'error') return { kind: 'error', code: t.code };
  if (t.kind === 'ok' && t.duplicate) {
    return { kind: 'stale_state', code: 'recovery_duplicate' };
  }

  if (recoverToTime) {
    return {
      kind: 'slot_unavailable_choose_time',
      date: state.date,
      options: freeSlots.slice(0, 24).map((s) => ({ id: s, label: s })),
    };
  }

  const dates = await deps.findNextAvailableDates({
    salonId: params.salonId,
    staffId: state.staffId,
    durationMinutes: duration,
    count: 7,
  });
  return {
    kind: 'slot_unavailable_choose_date',
    options: dates.map((d) => ({ id: d, label: d })),
  };
}

/**
 * Atomic owned Instagram booking commit.
 * RPC reads ready state from conversation; app precheck is advisory only.
 */
export async function commitInstagramBookingOwned(params: {
  db: SupabaseClient | any;
  salonId: string;
  receiptId: string;
  attemptCount: number;
  externalUserId: string;
  expectedSourceMessageId: string;
  externalEventId: string;
  runPrecheck?: boolean;
  stateForPrecheck?: InstagramBookingState;
  recoverSlotUnavailable?: boolean;
  messageTimestampIso?: string | null;
  stateForRecovery?: InstagramBookingState;
  recoveryDeps?: InstagramSlotRecoveryDeps;
}): Promise<InstagramBookingCommitResult> {
  let slotUnavailable = false;
  let entityUnavailable: 'service' | 'staff' | null = null;

  if (params.runPrecheck !== false) {
    if (!params.stateForPrecheck || !isCompleteInstagramReadyState(params.stateForPrecheck)) {
      return { kind: 'stale_state', code: 'incomplete_state' };
    }
    const pre = await prevalidateInstagramBookingCommit({
      salonId: params.salonId,
      state: params.stateForPrecheck,
    });
    if (pre) {
      if (pre.kind === 'service_unavailable') entityUnavailable = 'service';
      else if (pre.kind === 'staff_unavailable') entityUnavailable = 'staff';
      else if (pre.kind === 'slot_unavailable') slotUnavailable = true;
      else return pre;
    }
  }

  if (!slotUnavailable && !entityUnavailable) {
    const { data, error } = await params.db.rpc('commit_instagram_booking_owned', {
      p_salon_id: params.salonId,
      p_receipt_id: params.receiptId,
      p_attempt_count: params.attemptCount,
      p_external_user_id: params.externalUserId,
      p_expected_source_message_id: params.expectedSourceMessageId,
      p_external_event_id: params.externalEventId,
    });

    if (error) {
      return { kind: 'error', code: 'booking_commit_rpc' };
    }

    const row = asRecord(data);
    if (!row) return { kind: 'error', code: 'booking_commit_rpc_shape' };

    const mapped = mapCommitRpcRow(row);
    if (mapped.kind === 'service_unavailable') entityUnavailable = 'service';
    else if (mapped.kind === 'staff_unavailable') entityUnavailable = 'staff';
    else if (mapped.kind === 'slot_unavailable') slotUnavailable = true;
    else return mapped;
  }

  const recoveryState = params.stateForRecovery ?? params.stateForPrecheck;

  if (entityUnavailable) {
    if (params.recoverSlotUnavailable === false || !recoveryState) {
      return entityUnavailable === 'service'
        ? { kind: 'service_unavailable' }
        : { kind: 'staff_unavailable' };
    }
    return recoverInstagramBookingInvalidEntity(
      {
        db: params.db,
        salonId: params.salonId,
        receiptId: params.receiptId,
        attemptCount: params.attemptCount,
        externalUserId: params.externalUserId,
        sourceMessageId: params.expectedSourceMessageId,
        messageTimestampIso: params.messageTimestampIso ?? null,
        state: recoveryState,
        target: entityUnavailable,
      },
      params.recoveryDeps?.transition,
    );
  }

  if (params.recoverSlotUnavailable === false) {
    return { kind: 'slot_unavailable' };
  }

  if (!recoveryState) {
    return { kind: 'slot_unavailable' };
  }

  return recoverInstagramBookingSlotUnavailable(
    {
      db: params.db,
      salonId: params.salonId,
      receiptId: params.receiptId,
      attemptCount: params.attemptCount,
      externalUserId: params.externalUserId,
      sourceMessageId: params.expectedSourceMessageId,
      messageTimestampIso: params.messageTimestampIso ?? null,
      state: recoveryState,
    },
    params.recoveryDeps,
  );
}
