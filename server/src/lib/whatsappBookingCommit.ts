/**
 * WhatsApp idempotent booking commit (WA-4D / WA-4E1).
 * App precheck + owned RPC wrapper + slot-unavailable recovery.
 * No Meta outbound. No Telegram reminders.
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
import { normalizeWhatsAppAddress } from './whatsappInboundIdentity.js';
import {
  WHATSAPP_BOOKING_FLOW,
  type WhatsAppBookingState,
} from './whatsappBookingState.js';
import { transitionWhatsAppBookingOwned } from './whatsappConversation.js';

export type WhatsAppBookingCommitResult =
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
  | {
      kind: 'already_booked_no_repair';
      appointmentId: string;
      clientId: string;
    }
  | {
      kind: 'already_booked_repair_conflict';
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

function mapCommitRpcRow(row: Record<string, unknown>): WhatsAppBookingCommitResult {
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
    case 'already_booked_no_repair':
      return {
        kind: 'already_booked_no_repair',
        appointmentId: String(row.appointment_id),
        clientId: String(row.client_id),
      };
    case 'already_booked_repair_conflict':
      return {
        kind: 'already_booked_repair_conflict',
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
export async function prevalidateWhatsAppBookingCommit(params: {
  salonId: string;
  state: WhatsAppBookingState;
}): Promise<WhatsAppBookingCommitResult | null> {
  const { state, salonId } = params;
  if (!state.serviceId || !state.staffId || !state.date || !state.time || !state.name || !state.phone) {
    return { kind: 'stale_state', code: 'incomplete_state' };
  }

  const service = await resolveServiceById(salonId, state.serviceId);
  if (!service) return { kind: 'service_unavailable' };

  const staff = await getActiveStaffById(salonId, state.staffId);
  if (!staff) return { kind: 'staff_unavailable' };

  const compatible = await findStaffForServiceSpecialization(salonId, service.name);
  if (!compatible.some((m) => m.id === staff.id)) {
    return { kind: 'staff_unavailable' };
  }

  const duration = service.duration > 0 ? service.duration : 60;
  const slots = await computeAvailableSlots({
    salonId,
    staffId: staff.id,
    date: state.date,
    durationMinutes: duration,
  });
  if (!slots.includes(state.time)) {
    return { kind: 'slot_unavailable' };
  }

  if (!normalizeWhatsAppAddress(state.phone)) {
    return { kind: 'error', code: 'invalid_phone' };
  }

  return null;
}

export type WhatsAppSlotRecoveryDeps = {
  resolveServiceById: typeof resolveServiceById;
  computeAvailableSlots: typeof computeAvailableSlots;
  findNextAvailableDates: typeof findNextAvailableDates;
  transition: typeof transitionWhatsAppBookingOwned;
};

const defaultSlotRecoveryDeps: WhatsAppSlotRecoveryDeps = {
  resolveServiceById,
  computeAvailableSlots,
  findNextAvailableDates,
  transition: transitionWhatsAppBookingOwned,
};

/**
 * WA-4E1: after slot_unavailable, recover conversation to time/date via owned transition.
 *
 * Critical: pass externalMessageId=null so transition RPC does not treat the phone→ready
 * sourceMessageId as a duplicate no-op. nextState.sourceMessageId stays the current event.
 */
export async function recoverWhatsAppBookingSlotUnavailable(
  params: {
    db: SupabaseClient | any;
    salonId: string;
    receiptId: string;
    attemptCount: number;
    externalUserId: string;
    /** Current phone/commit Meta message id — stored in nextState only. */
    sourceMessageId: string;
    messageTimestampIso: string | null;
    state: WhatsAppBookingState;
  },
  deps: WhatsAppSlotRecoveryDeps = defaultSlotRecoveryDeps,
): Promise<WhatsAppBookingCommitResult> {
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
  if (recoverToTime) {
    nextState.date = state.date;
  }

  const t = await deps.transition({
    db: params.db,
    salonId: params.salonId,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
    externalUserId: params.externalUserId,
    // Deliberate: bypass FSM duplicate short-circuit for same phone message id.
    externalMessageId: null,
    messageTimestampIso: params.messageTimestampIso,
    expectedFlow: WHATSAPP_BOOKING_FLOW,
    expectedStep: 'ready_to_book',
    nextFlow: WHATSAPP_BOOKING_FLOW,
    nextStep,
    nextState,
  });

  if (t.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (t.kind === 'outdated') {
    return { kind: 'stale_state', code: 'recovery_outdated' };
  }
  if (t.kind === 'stale_step') {
    return { kind: 'stale_state', code: 'recovery_stale_step' };
  }
  if (t.kind === 'error') {
    return { kind: 'error', code: t.code };
  }
  if (t.kind === 'ok' && t.duplicate) {
    // Should not happen with externalMessageId=null; treat as no overwrite.
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
 * Atomic owned booking commit. Correctness is enforced inside the RPC.
 * When slot_unavailable, optionally runs owned recovery (WA-4E1) before returning.
 */
export async function commitWhatsAppBookingOwned(params: {
  db: SupabaseClient | any;
  salonId: string;
  receiptId: string;
  attemptCount: number;
  externalUserId: string;
  expectedSourceMessageId: string;
  externalEventId: string;
  serviceId: string;
  staffId: string;
  date: string;
  time: string;
  name: string;
  phone: string;
  /** When true (default), run transport-neutral precheck first. */
  runPrecheck?: boolean;
  stateForPrecheck?: WhatsAppBookingState;
  /**
   * When true (default), after slot_unavailable recover ready_to_book → time|date
   * under the same receipt ownership before returning.
   */
  recoverSlotUnavailable?: boolean;
  messageTimestampIso?: string | null;
  /** Full booking state for recovery (serviceName/staffName required). */
  stateForRecovery?: WhatsAppBookingState;
  /** Test seam for slot recovery helpers / owned transition. */
  recoveryDeps?: WhatsAppSlotRecoveryDeps;
}): Promise<WhatsAppBookingCommitResult> {
  let slotUnavailable = false;

  if (params.runPrecheck !== false) {
    const pre = await prevalidateWhatsAppBookingCommit({
      salonId: params.salonId,
      state: params.stateForPrecheck ?? {
        serviceId: params.serviceId,
        staffId: params.staffId,
        date: params.date,
        time: params.time,
        name: params.name,
        phone: params.phone,
      },
    });
    if (pre) {
      if (pre.kind !== 'slot_unavailable') return pre;
      slotUnavailable = true;
    }
  }

  if (!slotUnavailable) {
    const { data, error } = await params.db.rpc('commit_whatsapp_booking_owned', {
      p_salon_id: params.salonId,
      p_receipt_id: params.receiptId,
      p_attempt_count: params.attemptCount,
      p_external_user_id: params.externalUserId,
      p_expected_source_message_id: params.expectedSourceMessageId,
      p_external_event_id: params.externalEventId,
      p_service_id: params.serviceId,
      p_staff_id: params.staffId,
      p_date: params.date,
      p_time: params.time,
      p_name: params.name,
      p_phone: params.phone,
    });

    if (error) {
      return { kind: 'error', code: 'booking_commit_rpc' };
    }

    const row = asRecord(data);
    if (!row) return { kind: 'error', code: 'booking_commit_rpc_shape' };

    const mapped = mapCommitRpcRow(row);
    if (mapped.kind !== 'slot_unavailable') return mapped;
    slotUnavailable = true;
  }

  if (params.recoverSlotUnavailable === false) {
    return { kind: 'slot_unavailable' };
  }

  const recoveryState: WhatsAppBookingState = params.stateForRecovery ??
    params.stateForPrecheck ?? {
      serviceId: params.serviceId,
      staffId: params.staffId,
      date: params.date,
      time: params.time,
      name: params.name,
      phone: params.phone,
    };

  return recoverWhatsAppBookingSlotUnavailable(
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
