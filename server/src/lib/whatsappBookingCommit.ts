/**
 * WhatsApp idempotent booking commit (WA-4D1 / WA-4D2).
 * App precheck + owned RPC wrapper. No Meta outbound. No Telegram reminders.
 * WA-4D2: maps permanent client_blocked / client_resolution_conflict.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeAvailableSlots,
} from './scheduleSlots.js';
import {
  findStaffForServiceSpecialization,
  getActiveStaffById,
  resolveServiceById,
} from './telegramBooking.js';
import { normalizeWhatsAppAddress } from './whatsappInboundIdentity.js';
import type { WhatsAppBookingState } from './whatsappBookingState.js';

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
  | { kind: 'slot_unavailable' }
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

/**
 * Atomic owned booking commit. Correctness is enforced inside the RPC.
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
}): Promise<WhatsAppBookingCommitResult> {
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
    if (pre) return pre;
  }

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
