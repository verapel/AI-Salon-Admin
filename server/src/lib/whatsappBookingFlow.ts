/**
 * Durable WhatsApp booking FSM foundation (WA-4C).
 *
 * Sequence (from stable Telegram product behavior):
 *   service → staff? → date → time → name → phone → ready_to_book
 *
 * Stops BEFORE appointment/client creation (WA-4D).
 * All durable step writes go through transition_whatsapp_booking_owned.
 * No Meta outbound, no in-memory Maps.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeAvailableSlots,
  findNextAvailableDates,
  getSalonTimezone,
  dateStrInTimezone,
} from './scheduleSlots.js';
import {
  fetchActiveServices,
  findStaffForServiceSpecialization,
  getActiveStaffById,
  resolveServiceById,
  STAFF_UNAVAILABLE_MESSAGE,
  type StaffRow,
} from './telegramBooking.js';
import {
  isWhatsAppCancelCommand,
  isWhatsAppStartCommand,
} from './whatsappInboundText.js';
import {
  parseWhatsAppAppointmentDate,
  parseWhatsAppAppointmentTime,
  parseWhatsAppBookingName,
  parseWhatsAppBookingPhone,
} from './whatsappBookingParsers.js';
import {
  bookingStateToJson,
  isWhatsAppBookingStep,
  WHATSAPP_BOOKING_FLOW,
  type WhatsAppBookingActionResult,
  type WhatsAppBookingReply,
  type WhatsAppBookingState,
  type WhatsAppBookingStep,
} from './whatsappBookingState.js';
import {
  isConversationExpired,
  loadWhatsAppConversationBookingSnapshot,
  transitionWhatsAppBookingOwned,
  type BookingTransitionResult,
  type ConversationBookingSnapshot,
} from './whatsappConversation.js';

type ServiceRow = { id: string; name: string; duration: number; category: string };

/** Optional overrides for unit tests (production uses Telegram/schedule helpers + owned RPCs). */
export type WhatsAppBookingFsmDeps = {
  fetchActiveServices: (salonId: string) => Promise<ServiceRow[]>;
  resolveServiceById: (salonId: string, serviceId: string) => Promise<ServiceRow | null>;
  findStaffForServiceSpecialization: (salonId: string, serviceName: string) => Promise<StaffRow[]>;
  getActiveStaffById: (salonId: string, staffId: string) => Promise<StaffRow | null>;
  computeAvailableSlots: typeof computeAvailableSlots;
  findNextAvailableDates: typeof findNextAvailableDates;
  getSalonTimezone: (salonId: string) => Promise<string>;
  loadSnapshot: (params: {
    db: SupabaseClient | any;
    salonId: string;
    externalUserId: string;
  }) => Promise<
    | { kind: 'ok'; snapshot: ConversationBookingSnapshot }
    | { kind: 'missing' }
    | { kind: 'error'; code: string }
  >;
  transition: (params: {
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
  }) => Promise<BookingTransitionResult>;
};

const defaultDeps: WhatsAppBookingFsmDeps = {
  fetchActiveServices,
  resolveServiceById,
  findStaffForServiceSpecialization,
  getActiveStaffById,
  computeAvailableSlots,
  findNextAvailableDates,
  getSalonTimezone,
  loadSnapshot: loadWhatsAppConversationBookingSnapshot,
  transition: transitionWhatsAppBookingOwned,
};

function reply(
  messageKey: string,
  text: string,
  options?: WhatsAppBookingReply['options'],
): WhatsAppBookingReply {
  return options?.length
    ? { kind: 'reply', messageKey, text, options }
    : { kind: 'reply', messageKey, text };
}

function normalizeServiceKey(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Salon-scoped service resolve: id, numeric index, or exact normalized name. Never creates services. */
export async function resolveWhatsAppBookingService(
  salonId: string,
  raw: string,
  deps: Pick<
    WhatsAppBookingFsmDeps,
    'fetchActiveServices' | 'resolveServiceById'
  > = defaultDeps,
): Promise<
  | { kind: 'ok'; service: ServiceRow }
  | { kind: 'ambiguous'; services: ServiceRow[] }
  | { kind: 'invalid' }
  | { kind: 'empty_catalog' }
> {
  const services = await deps.fetchActiveServices(salonId);
  if (services.length === 0) return { kind: 'empty_catalog' };

  const text = raw.trim();
  if (!text) return { kind: 'invalid' };

  const byId = await deps.resolveServiceById(salonId, text);
  if (byId) return { kind: 'ok', service: byId };

  if (/^\d{1,3}$/.test(text)) {
    const idx = Number(text) - 1;
    if (idx >= 0 && idx < services.length) {
      return { kind: 'ok', service: services[idx] };
    }
    return { kind: 'invalid' };
  }

  const key = normalizeServiceKey(text);
  const exact = services.filter((s) => normalizeServiceKey(s.name) === key);
  if (exact.length === 1) return { kind: 'ok', service: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', services: exact };

  const partial = services.filter((s) => {
    const n = normalizeServiceKey(s.name);
    return n.includes(key) || key.includes(n);
  });
  if (partial.length === 1) return { kind: 'ok', service: partial[0] };
  if (partial.length > 1) return { kind: 'ambiguous', services: partial };

  return { kind: 'invalid' };
}

function serviceOptions(services: ServiceRow[]): WhatsAppBookingReply['options'] {
  return services.slice(0, 20).map((s, i) => ({
    id: s.id,
    label: `${i + 1}. ${s.name}`,
  }));
}

function staffOptions(staff: StaffRow[]): WhatsAppBookingReply['options'] {
  return staff.map((m, i) => ({
    id: m.id,
    label: `${i + 1}. ${m.name}`,
  }));
}

async function chooseServicePrompt(
  salonId: string,
  deps: WhatsAppBookingFsmDeps,
): Promise<WhatsAppBookingReply> {
  const services = await deps.fetchActiveServices(salonId);
  if (services.length === 0) {
    return reply(
      'whatsapp.booking.noServices',
      'В салоне пока нет активных услуг. Добавьте услуги в панели администратора.',
    );
  }
  return reply(
    'whatsapp.booking.chooseService',
    'На какую услугу хотите записаться? Ответьте номером или точным названием.',
    serviceOptions(services),
  );
}

async function datePrompt(
  salonId: string,
  staffId: string,
  durationMinutes: number,
  deps: WhatsAppBookingFsmDeps,
): Promise<WhatsAppBookingReply> {
  const dates = await deps.findNextAvailableDates({
    salonId,
    staffId,
    durationMinutes,
    count: 4,
    maxDays: 30,
  });
  const tz = await deps.getSalonTimezone(salonId);
  const options = dates.map((iso) => ({ id: iso, label: iso }));
  const hint =
    dates.length > 0
      ? `Ближайшие даты: ${dates.join(', ')}. Сегодня в салоне: ${dateStrInTimezone(tz, 0)}.`
      : 'В ближайшие 30 дней свободных дат не найдено — введите дату вручную (ГГГГ-ММ-ДД).';
  return reply(
    'whatsapp.booking.chooseDate',
    `На какой день вы хотите записаться? ${hint}`,
    options.length ? options : undefined,
  );
}

async function timePrompt(
  salonId: string,
  staffId: string,
  date: string,
  durationMinutes: number,
  deps: WhatsAppBookingFsmDeps,
): Promise<WhatsAppBookingReply> {
  const slots = await deps.computeAvailableSlots({
    salonId,
    staffId,
    date,
    durationMinutes,
  });
  if (slots.length === 0) {
    return reply(
      'whatsapp.booking.noSlots',
      'К сожалению, на выбранную дату нет свободного времени. Выберите другой день.',
    );
  }
  return reply(
    'whatsapp.booking.chooseTime',
    'На какое время вам удобно записаться? Введите время в формате ЧЧ:ММ.',
    slots.slice(0, 24).map((s) => ({ id: s, label: s })),
  );
}

type TransitionMapped =
  | { kind: 'ok'; duplicate: boolean }
  | { kind: 'lost_ownership' }
  | { kind: 'stale_step' }
  | { kind: 'outdated' }
  | { kind: 'error'; code: string };

async function runTransition(
  params: {
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
    nextState: WhatsAppBookingState;
  },
  deps: WhatsAppBookingFsmDeps,
): Promise<TransitionMapped> {
  const result = await deps.transition({
    db: params.db,
    salonId: params.salonId,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
    externalUserId: params.externalUserId,
    externalMessageId: params.externalMessageId,
    messageTimestampIso: params.messageTimestampIso,
    expectedFlow: params.expectedFlow,
    expectedStep: params.expectedStep,
    nextFlow: params.nextFlow,
    nextStep: params.nextStep,
    nextState: bookingStateToJson(params.nextState),
  });

  if (result.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (result.kind === 'outdated') return { kind: 'outdated' };
  if (result.kind === 'stale_step') return { kind: 'stale_step' };
  if (result.kind === 'error') return { kind: 'error', code: result.code };
  return { kind: 'ok', duplicate: result.duplicate };
}

function mapTransitionFailure(t: TransitionMapped): WhatsAppBookingActionResult | null {
  if (t.kind === 'ok') return null;
  if (t.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (t.kind === 'stale_step') return { kind: 'stale_step' };
  if (t.kind === 'outdated') return { kind: 'outdated' };
  return { kind: 'error', code: t.code };
}

function resolveStaffChoice(staffMatches: StaffRow[], raw: string): StaffRow | null {
  const text = raw.trim();
  if (!text) return null;
  const byId = staffMatches.find((m) => m.id === text);
  if (byId) return byId;
  if (/^\d{1,3}$/.test(text)) {
    const idx = Number(text) - 1;
    if (idx >= 0 && idx < staffMatches.length) return staffMatches[idx];
    return null;
  }
  const key = normalizeServiceKey(text);
  const exact = staffMatches.filter((m) => normalizeServiceKey(m.name) === key);
  if (exact.length === 1) return exact[0];
  return null;
}

async function afterServiceSelected(
  params: {
    db: SupabaseClient | any;
    salonId: string;
    receiptId: string;
    attemptCount: number;
    externalUserId: string;
    externalMessageId: string | null;
    messageTimestampIso: string | null;
    expectedFlow: string | null;
    expectedStep: string | null;
    service: ServiceRow;
  },
  deps: WhatsAppBookingFsmDeps,
): Promise<WhatsAppBookingActionResult> {
  const staffMatches = await deps.findStaffForServiceSpecialization(
    params.salonId,
    params.service.name,
  );

  if (staffMatches.length === 0) {
    const t = await runTransition(
      {
        ...params,
        nextFlow: null,
        nextStep: null,
        nextState: { sourceMessageId: params.externalMessageId ?? undefined },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return reply('whatsapp.booking.staffUnavailable', STAFF_UNAVAILABLE_MESSAGE);
  }

  if (staffMatches.length === 1) {
    const staff = staffMatches[0];
    const t = await runTransition(
      {
        ...params,
        nextFlow: WHATSAPP_BOOKING_FLOW,
        nextStep: 'date',
        nextState: {
          serviceId: params.service.id,
          serviceName: params.service.name,
          staffId: staff.id,
          staffName: staff.name,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return datePrompt(
      params.salonId,
      staff.id,
      params.service.duration > 0 ? params.service.duration : 60,
      deps,
    );
  }

  const t = await runTransition(
    {
      ...params,
      nextFlow: WHATSAPP_BOOKING_FLOW,
      nextStep: 'staff',
      nextState: {
        serviceId: params.service.id,
        serviceName: params.service.name,
        sourceMessageId: params.externalMessageId ?? undefined,
      },
    },
    deps,
  );
  const fail = mapTransitionFailure(t);
  if (fail) return fail;
  return reply(
    'whatsapp.booking.chooseStaff',
    'К какому мастеру хотите записаться? Ответьте номером или именем.',
    staffOptions(staffMatches),
  );
}

/**
 * Process one inbound text against durable conversation booking FSM.
 * Produces an internal reply/action result — does not call Meta.
 */
export async function processWhatsAppBookingFsm(
  params: {
    db: SupabaseClient | any;
    salonId: string;
    externalUserId: string;
    text: string;
    externalMessageId: string | null;
    messageTimestampIso: string | null;
    receiptId: string;
    attemptCount: number;
    /** When false, inbound was out-of-order at touch — do not interpret. */
    inboundAdvanced?: boolean;
  },
  deps: WhatsAppBookingFsmDeps = defaultDeps,
): Promise<WhatsAppBookingActionResult> {
  if (params.inboundAdvanced === false) {
    return { kind: 'outdated' };
  }

  const loaded = await deps.loadSnapshot({
    db: params.db,
    salonId: params.salonId,
    externalUserId: params.externalUserId,
  });
  if (loaded.kind === 'error') return { kind: 'error', code: loaded.code };
  if (loaded.kind === 'missing') return { kind: 'error', code: 'conversation_missing' };

  let { snapshot } = loaded;

  if (
    params.externalMessageId &&
    snapshot.state.sourceMessageId &&
    snapshot.state.sourceMessageId === params.externalMessageId
  ) {
    // Retry of the phone→ready_to_book source message: re-signal commit (idempotent RPC).
    if (
      snapshot.currentFlow === WHATSAPP_BOOKING_FLOW &&
      snapshot.currentStep === 'ready_to_book' &&
      snapshot.state.serviceId &&
      snapshot.state.staffId &&
      snapshot.state.date &&
      snapshot.state.time &&
      snapshot.state.name &&
      snapshot.state.phone
    ) {
      return {
        kind: 'ready_to_book_pending_commit',
        messageKey: 'whatsapp.booking.readyToBook',
        text: 'Данные собраны. Запись будет создана на следующем этапе.',
        state: { ...snapshot.state },
      };
    }
    return { kind: 'noop', reason: 'duplicate_message_applied' };
  }

  if (isConversationExpired({ expires_at: snapshot.expiresAt })) {
    snapshot = {
      ...snapshot,
      currentFlow: null,
      currentStep: null,
      state: {},
    };
  }

  const text = params.text.trim();
  const common = {
    db: params.db,
    salonId: params.salonId,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
    externalUserId: params.externalUserId,
    externalMessageId: params.externalMessageId,
    messageTimestampIso: params.messageTimestampIso,
  };

  if (isWhatsAppCancelCommand(text)) {
    const t = await runTransition(
      {
        ...common,
        expectedFlow: snapshot.currentFlow,
        expectedStep: snapshot.currentStep,
        nextFlow: null,
        nextStep: null,
        nextState: { sourceMessageId: params.externalMessageId ?? undefined },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return reply(
      'whatsapp.booking.cancelled',
      'Запись отменена. Напишите «запись», чтобы начать снова.',
    );
  }

  const inBooking =
    snapshot.currentFlow === WHATSAPP_BOOKING_FLOW &&
    isWhatsAppBookingStep(snapshot.currentStep);

  if (isWhatsAppStartCommand(text)) {
    const t = await runTransition(
      {
        ...common,
        expectedFlow: snapshot.currentFlow,
        expectedStep: snapshot.currentStep,
        nextFlow: WHATSAPP_BOOKING_FLOW,
        nextStep: 'service',
        nextState: { sourceMessageId: params.externalMessageId ?? undefined },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return chooseServicePrompt(params.salonId, deps);
  }

  if (!inBooking) {
    return reply(
      'whatsapp.booking.promptStart',
      'Чтобы записаться, напишите «запись» или «начать».',
    );
  }

  const step = snapshot.currentStep as WhatsAppBookingStep;
  const state = snapshot.state;

  if (step === 'ready_to_book') {
    return reply(
      'whatsapp.booking.readyToBook',
      'Данные для записи собраны. Подтверждение будет на следующем этапе. Напишите «отмена», чтобы сбросить, или «запись», чтобы начать заново.',
    );
  }

  if (step === 'service') {
    const resolved = await resolveWhatsAppBookingService(params.salonId, text, deps);
    if (resolved.kind === 'empty_catalog') {
      return reply(
        'whatsapp.booking.noServices',
        'В салоне пока нет активных услуг. Добавьте услуги в панели администратора.',
      );
    }
    if (resolved.kind === 'ambiguous') {
      return reply(
        'whatsapp.booking.serviceAmbiguous',
        'Нашлось несколько услуг. Уточните название или выберите номер.',
        serviceOptions(resolved.services),
      );
    }
    if (resolved.kind === 'invalid') {
      const prompt = await chooseServicePrompt(params.salonId, deps);
      return reply(
        'whatsapp.booking.serviceInvalid',
        `Не удалось распознать услугу. ${prompt.text}`,
        prompt.options,
      );
    }
    return afterServiceSelected(
      {
        ...common,
        expectedFlow: WHATSAPP_BOOKING_FLOW,
        expectedStep: 'service',
        service: resolved.service,
      },
      deps,
    );
  }

  if (step === 'staff') {
    if (!state.serviceId || !state.serviceName) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'staff',
          nextFlow: WHATSAPP_BOOKING_FLOW,
          nextStep: 'service',
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      return chooseServicePrompt(params.salonId, deps);
    }
    const service = await deps.resolveServiceById(params.salonId, state.serviceId);
    if (!service) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'staff',
          nextFlow: WHATSAPP_BOOKING_FLOW,
          nextStep: 'service',
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      return chooseServicePrompt(params.salonId, deps);
    }
    const staffMatches = await deps.findStaffForServiceSpecialization(
      params.salonId,
      service.name,
    );
    if (staffMatches.length === 0) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'staff',
          nextFlow: null,
          nextStep: null,
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      return reply('whatsapp.booking.staffUnavailable', STAFF_UNAVAILABLE_MESSAGE);
    }
    const chosen = resolveStaffChoice(staffMatches, text);
    if (!chosen) {
      return reply(
        'whatsapp.booking.staffInvalid',
        'Не удалось распознать мастера. Выберите номер или имя из списка.',
        staffOptions(staffMatches),
      );
    }
    const t = await runTransition(
      {
        ...common,
        expectedFlow: WHATSAPP_BOOKING_FLOW,
        expectedStep: 'staff',
        nextFlow: WHATSAPP_BOOKING_FLOW,
        nextStep: 'date',
        nextState: {
          serviceId: service.id,
          serviceName: service.name,
          staffId: chosen.id,
          staffName: chosen.name,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return datePrompt(
      params.salonId,
      chosen.id,
      service.duration > 0 ? service.duration : 60,
      deps,
    );
  }

  if (step === 'date') {
    if (!state.staffId || !state.serviceId) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'date',
          nextFlow: WHATSAPP_BOOKING_FLOW,
          nextStep: 'service',
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      return chooseServicePrompt(params.salonId, deps);
    }
    const staff = await deps.getActiveStaffById(params.salonId, state.staffId);
    if (!staff) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'date',
          nextFlow: null,
          nextStep: null,
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      return reply('whatsapp.booking.staffUnavailable', STAFF_UNAVAILABLE_MESSAGE);
    }
    const service = await deps.resolveServiceById(params.salonId, state.serviceId);
    const duration = service && service.duration > 0 ? service.duration : 60;
    const tz = await deps.getSalonTimezone(params.salonId);
    const parsedDate = parseWhatsAppAppointmentDate(text, tz);
    if (!parsedDate) {
      const prompt = await datePrompt(params.salonId, state.staffId, duration, deps);
      return reply(
        'whatsapp.booking.dateInvalid',
        `Не удалось распознать дату. ${prompt.text}`,
        prompt.options,
      );
    }
    const today = dateStrInTimezone(tz, 0);
    if (parsedDate < today) {
      const prompt = await datePrompt(params.salonId, state.staffId, duration, deps);
      return reply(
        'whatsapp.booking.datePast',
        `Эта дата уже в прошлом. ${prompt.text}`,
        prompt.options,
      );
    }
    const slots = await deps.computeAvailableSlots({
      salonId: params.salonId,
      staffId: state.staffId,
      date: parsedDate,
      durationMinutes: duration,
    });
    if (slots.length === 0) {
      const prompt = await datePrompt(params.salonId, state.staffId, duration, deps);
      return reply(
        'whatsapp.booking.noSlots',
        `К сожалению, на выбранную дату нет свободного времени. ${prompt.text}`,
        prompt.options,
      );
    }
    const t = await runTransition(
      {
        ...common,
        expectedFlow: WHATSAPP_BOOKING_FLOW,
        expectedStep: 'date',
        nextFlow: WHATSAPP_BOOKING_FLOW,
        nextStep: 'time',
        nextState: {
          serviceId: state.serviceId,
          serviceName: state.serviceName,
          staffId: state.staffId,
          staffName: state.staffName,
          date: parsedDate,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return timePrompt(params.salonId, state.staffId, parsedDate, duration, deps);
  }

  if (step === 'time') {
    if (!state.staffId || !state.serviceId || !state.date) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'time',
          nextFlow: WHATSAPP_BOOKING_FLOW,
          nextStep: 'service',
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      return chooseServicePrompt(params.salonId, deps);
    }
    const service = await deps.resolveServiceById(params.salonId, state.serviceId);
    const duration = service && service.duration > 0 ? service.duration : 60;
    const appointmentTime = parseWhatsAppAppointmentTime(text);
    const freeSlots = await deps.computeAvailableSlots({
      salonId: params.salonId,
      staffId: state.staffId,
      date: state.date,
      durationMinutes: duration,
    });

    if (!appointmentTime) {
      if (freeSlots.length === 0) {
        const t = await runTransition(
          {
            ...common,
            expectedFlow: WHATSAPP_BOOKING_FLOW,
            expectedStep: 'time',
            nextFlow: WHATSAPP_BOOKING_FLOW,
            nextStep: 'date',
            nextState: {
              serviceId: state.serviceId,
              serviceName: state.serviceName,
              staffId: state.staffId,
              staffName: state.staffName,
              sourceMessageId: params.externalMessageId ?? undefined,
            },
          },
          deps,
        );
        const fail = mapTransitionFailure(t);
        if (fail) return fail;
        return datePrompt(params.salonId, state.staffId, duration, deps);
      }
      return reply(
        'whatsapp.booking.timeInvalid',
        'Пожалуйста, введите время в формате ЧЧ:ММ, например 12:00.',
        freeSlots.slice(0, 24).map((s) => ({ id: s, label: s })),
      );
    }

    if (!freeSlots.includes(appointmentTime)) {
      if (freeSlots.length === 0) {
        const t = await runTransition(
          {
            ...common,
            expectedFlow: WHATSAPP_BOOKING_FLOW,
            expectedStep: 'time',
            nextFlow: WHATSAPP_BOOKING_FLOW,
            nextStep: 'date',
            nextState: {
              serviceId: state.serviceId,
              serviceName: state.serviceName,
              staffId: state.staffId,
              staffName: state.staffName,
              sourceMessageId: params.externalMessageId ?? undefined,
            },
          },
          deps,
        );
        const fail = mapTransitionFailure(t);
        if (fail) return fail;
        return datePrompt(params.salonId, state.staffId, duration, deps);
      }
      return reply(
        'whatsapp.booking.timeBusy',
        `К сожалению, это время уже занято. Доступное время на ${state.date}:`,
        freeSlots.slice(0, 24).map((s) => ({ id: s, label: s })),
      );
    }

    const t = await runTransition(
      {
        ...common,
        expectedFlow: WHATSAPP_BOOKING_FLOW,
        expectedStep: 'time',
        nextFlow: WHATSAPP_BOOKING_FLOW,
        nextStep: 'name',
        nextState: {
          serviceId: state.serviceId,
          serviceName: state.serviceName,
          staffId: state.staffId,
          staffName: state.staffName,
          date: state.date,
          time: appointmentTime,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return reply('whatsapp.booking.askName', 'Отлично, записываю. Подскажите, как вас зовут?');
  }

  if (step === 'name') {
    const name = parseWhatsAppBookingName(text);
    if (!name) {
      return reply(
        'whatsapp.booking.nameInvalid',
        'Пожалуйста, укажите имя (не оставляйте пустым).',
      );
    }
    const t = await runTransition(
      {
        ...common,
        expectedFlow: WHATSAPP_BOOKING_FLOW,
        expectedStep: 'name',
        nextFlow: WHATSAPP_BOOKING_FLOW,
        nextStep: 'phone',
        nextState: {
          serviceId: state.serviceId,
          serviceName: state.serviceName,
          staffId: state.staffId,
          staffName: state.staffName,
          date: state.date,
          time: state.time,
          name,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;
    return reply(
      'whatsapp.booking.askPhone',
      'И оставьте, пожалуйста, номер телефона для связи.',
    );
  }

  if (step === 'phone') {
    const phone = parseWhatsAppBookingPhone(text);
    if (!phone) {
      return reply(
        'whatsapp.booking.phoneInvalid',
        'Не удалось распознать телефон. Укажите номер цифрами (10–15), можно с +.',
      );
    }
    if (!state.serviceId || !state.staffId || !state.date || !state.time || !state.name) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'phone',
          nextFlow: WHATSAPP_BOOKING_FLOW,
          nextStep: 'service',
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      return chooseServicePrompt(params.salonId, deps);
    }

    const service = await deps.resolveServiceById(params.salonId, state.serviceId);
    const duration = service && service.duration > 0 ? service.duration : 60;
    const freeSlots = await deps.computeAvailableSlots({
      salonId: params.salonId,
      staffId: state.staffId,
      date: state.date,
      durationMinutes: duration,
    });
    if (!freeSlots.includes(state.time)) {
      const t = await runTransition(
        {
          ...common,
          expectedFlow: WHATSAPP_BOOKING_FLOW,
          expectedStep: 'phone',
          nextFlow: WHATSAPP_BOOKING_FLOW,
          nextStep: freeSlots.length === 0 ? 'date' : 'time',
          nextState: {
            serviceId: state.serviceId,
            serviceName: state.serviceName,
            staffId: state.staffId,
            staffName: state.staffName,
            ...(freeSlots.length === 0 ? {} : { date: state.date }),
            sourceMessageId: params.externalMessageId ?? undefined,
          },
        },
        deps,
      );
      const fail = mapTransitionFailure(t);
      if (fail) return fail;
      if (freeSlots.length === 0) {
        return datePrompt(params.salonId, state.staffId, duration, deps);
      }
      return reply(
        'whatsapp.booking.timeBusy',
        `К сожалению, это время уже занято. Доступное время на ${state.date}:`,
        freeSlots.slice(0, 24).map((s) => ({ id: s, label: s })),
      );
    }

    const t = await runTransition(
      {
        ...common,
        expectedFlow: WHATSAPP_BOOKING_FLOW,
        expectedStep: 'phone',
        nextFlow: WHATSAPP_BOOKING_FLOW,
        nextStep: 'ready_to_book',
        nextState: {
          serviceId: state.serviceId,
          serviceName: state.serviceName,
          staffId: state.staffId,
          staffName: state.staffName,
          date: state.date,
          time: state.time,
          name: state.name,
          phone,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapTransitionFailure(t);
    if (fail) return fail;

    // WA-4D1: signal webhook to invoke owned booking commit for THIS message only.
    return {
      kind: 'ready_to_book_pending_commit',
      messageKey: 'whatsapp.booking.readyToBook',
      text: `Данные собраны: ${state.serviceName}, ${state.date} ${state.time}, ${state.name}, ${phone}. Запись будет создана.`,
      state: {
        serviceId: state.serviceId,
        serviceName: state.serviceName,
        staffId: state.staffId,
        staffName: state.staffName,
        date: state.date,
        time: state.time,
        name: state.name,
        phone,
        sourceMessageId: params.externalMessageId ?? undefined,
      },
    };
  }

  return { kind: 'noop', reason: 'unhandled_step' };
}
