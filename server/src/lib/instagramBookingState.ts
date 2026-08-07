/**
 * Durable Instagram booking FSM state (IG-5).
 * Persist only structured resume fields — never raw DM / postback bodies.
 */

export const INSTAGRAM_BOOKING_FLOW = 'booking' as const;

export type InstagramBookingStep =
  | 'service'
  | 'staff'
  | 'date'
  | 'time'
  | 'name'
  | 'phone'
  | 'ready_to_book';

export type InstagramBookingState = {
  serviceId?: string;
  serviceName?: string;
  staffId?: string;
  staffName?: string;
  date?: string;
  time?: string;
  name?: string;
  phone?: string;
  /** Inbound Meta mid that produced the latest committed FSM transition. */
  sourceMessageId?: string;
};

/** Provider-neutral response intent — never sent by IG-5. */
export type InstagramBookingIntent =
  | {
      kind: 'ask_service' | 'ask_staff' | 'ask_date' | 'ask_time' | 'ask_name' | 'ask_phone' | 'invalid_input';
      messageKey: string;
      text: string;
      options?: Array<{ id: string; label: string }>;
    }
  | {
      kind: 'ready_to_book';
      messageKey: string;
      text: string;
      state: InstagramBookingState;
    }
  | { kind: 'noop'; reason: string }
  | { kind: 'lost_ownership' }
  | { kind: 'stale_step' }
  | { kind: 'outdated' }
  | { kind: 'invalid_state'; reason?: string }
  | { kind: 'error'; code: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseInstagramBookingState(raw: unknown): InstagramBookingState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: InstagramBookingState = {};
  if (nonEmptyString(o.serviceId)) out.serviceId = o.serviceId.trim();
  if (nonEmptyString(o.serviceName)) out.serviceName = o.serviceName.trim();
  if (nonEmptyString(o.staffId)) out.staffId = o.staffId.trim();
  if (nonEmptyString(o.staffName)) out.staffName = o.staffName.trim();
  if (nonEmptyString(o.date)) out.date = o.date.trim();
  if (nonEmptyString(o.time)) out.time = o.time.trim();
  if (nonEmptyString(o.name)) out.name = o.name.trim();
  if (nonEmptyString(o.phone)) out.phone = o.phone.trim();
  if (nonEmptyString(o.sourceMessageId)) out.sourceMessageId = o.sourceMessageId.trim();
  return out;
}

/**
 * Full ready_to_book contract (IG-5A). Intermediate booking steps may be partial;
 * only ready_to_book requires every field.
 */
export function isCompleteInstagramReadyState(
  state: InstagramBookingState | Record<string, unknown> | null | undefined,
): boolean {
  if (!state || typeof state !== 'object') return false;
  return (
    nonEmptyString(state.serviceId) &&
    nonEmptyString(state.serviceName) &&
    nonEmptyString(state.staffId) &&
    nonEmptyString(state.staffName) &&
    nonEmptyString(state.date) &&
    nonEmptyString(state.time) &&
    nonEmptyString(state.name) &&
    nonEmptyString(state.phone) &&
    nonEmptyString(state.sourceMessageId)
  );
}

export function instagramBookingStateToJson(
  state: InstagramBookingState,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (state.serviceId) out.serviceId = state.serviceId;
  if (state.serviceName) out.serviceName = state.serviceName;
  if (state.staffId) out.staffId = state.staffId;
  if (state.staffName) out.staffName = state.staffName;
  if (state.date) out.date = state.date;
  if (state.time) out.time = state.time;
  if (state.name) out.name = state.name;
  if (state.phone) out.phone = state.phone;
  if (state.sourceMessageId) out.sourceMessageId = state.sourceMessageId;
  return out;
}

export function isInstagramBookingStep(
  value: string | null | undefined,
): value is InstagramBookingStep {
  return (
    value === 'service' ||
    value === 'staff' ||
    value === 'date' ||
    value === 'time' ||
    value === 'name' ||
    value === 'phone' ||
    value === 'ready_to_book'
  );
}

/** Strip postback grammar prefixes for deterministic ID selection. */
export function parseInstagramBookingPostbackInput(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(service|staff|date|time):(.+)$/i);
  if (!m) return trimmed;
  return m[2].trim();
}
