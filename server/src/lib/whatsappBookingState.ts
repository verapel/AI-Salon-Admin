/**
 * Durable WhatsApp booking FSM state shape (WA-4C).
 * Persist only structured resume fields — never raw message bodies / transcripts.
 */

export const WHATSAPP_BOOKING_FLOW = 'booking' as const;

export type WhatsAppBookingStep =
  | 'service'
  | 'staff'
  | 'date'
  | 'time'
  | 'name'
  | 'phone'
  | 'ready_to_book';

export type WhatsAppBookingState = {
  serviceId?: string
  serviceName?: string
  staffId?: string
  staffName?: string
  date?: string
  time?: string
  name?: string
  phone?: string
  /** Inbound Meta message id that produced the latest committed transition. */
  sourceMessageId?: string
}

export type WhatsAppBookingReply = {
  kind: 'reply'
  messageKey: string
  text: string
  options?: Array<{ id: string; label: string }>
}

export type WhatsAppBookingActionResult =
  | WhatsAppBookingReply
  | { kind: 'noop'; reason: string }
  | { kind: 'lost_ownership' }
  | { kind: 'stale_step' }
  | { kind: 'outdated' }
  | { kind: 'error'; code: string }

export function parseWhatsAppBookingState(raw: unknown): WhatsAppBookingState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  const out: WhatsAppBookingState = {}
  if (typeof o.serviceId === 'string' && o.serviceId.trim()) out.serviceId = o.serviceId.trim()
  if (typeof o.serviceName === 'string' && o.serviceName.trim()) out.serviceName = o.serviceName.trim()
  if (typeof o.staffId === 'string' && o.staffId.trim()) out.staffId = o.staffId.trim()
  if (typeof o.staffName === 'string' && o.staffName.trim()) out.staffName = o.staffName.trim()
  if (typeof o.date === 'string' && o.date.trim()) out.date = o.date.trim()
  if (typeof o.time === 'string' && o.time.trim()) out.time = o.time.trim()
  if (typeof o.name === 'string' && o.name.trim()) out.name = o.name.trim()
  if (typeof o.phone === 'string' && o.phone.trim()) out.phone = o.phone.trim()
  if (typeof o.sourceMessageId === 'string' && o.sourceMessageId.trim()) {
    out.sourceMessageId = o.sourceMessageId.trim()
  }
  return out
}

export function bookingStateToJson(state: WhatsAppBookingState): Record<string, string> {
  const out: Record<string, string> = {}
  if (state.serviceId) out.serviceId = state.serviceId
  if (state.serviceName) out.serviceName = state.serviceName
  if (state.staffId) out.staffId = state.staffId
  if (state.staffName) out.staffName = state.staffName
  if (state.date) out.date = state.date
  if (state.time) out.time = state.time
  if (state.name) out.name = state.name
  if (state.phone) out.phone = state.phone
  if (state.sourceMessageId) out.sourceMessageId = state.sourceMessageId
  return out
}

export function isWhatsAppBookingStep(value: string | null | undefined): value is WhatsAppBookingStep {
  return (
    value === 'service' ||
    value === 'staff' ||
    value === 'date' ||
    value === 'time' ||
    value === 'name' ||
    value === 'phone' ||
    value === 'ready_to_book'
  )
}
