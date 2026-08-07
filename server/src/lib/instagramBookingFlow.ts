/**
 * Durable Instagram booking FSM (IG-5).
 * Sequence: service → staff? → date → time → name → phone → ready_to_book
 * Stops BEFORE appointment/client creation (IG-6).
 * No Meta outbound. No LLM.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeAvailableSlots,
  dateStrInTimezone,
  findNextAvailableDates,
  getSalonTimezone,
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
  parseWhatsAppAppointmentDate,
  parseWhatsAppAppointmentTime,
  parseWhatsAppBookingName,
  parseWhatsAppBookingPhone,
} from './whatsappBookingParsers.js';
import {
  INSTAGRAM_BOOKING_FLOW,
  instagramBookingStateToJson,
  isCompleteInstagramReadyState,
  isInstagramBookingStep,
  parseInstagramBookingPostbackInput,
  type InstagramBookingIntent,
  type InstagramBookingState,
} from './instagramBookingState.js';
import {
  isInstagramConversationExpired,
  loadInstagramConversationBookingSnapshot,
  transitionInstagramBookingOwned,
  type InstagramBookingTransitionResult,
  type InstagramConversationBookingSnapshot,
} from './instagramBookingConversation.js';

type ServiceRow = { id: string; name: string; duration: number; category: string };

export type InstagramBookingFsmDeps = {
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
    | { kind: 'ok'; snapshot: InstagramConversationBookingSnapshot }
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
  }) => Promise<InstagramBookingTransitionResult>;
};

const defaultDeps: InstagramBookingFsmDeps = {
  fetchActiveServices,
  resolveServiceById,
  findStaffForServiceSpecialization,
  getActiveStaffById,
  computeAvailableSlots,
  findNextAvailableDates,
  getSalonTimezone,
  loadSnapshot: loadInstagramConversationBookingSnapshot,
  transition: transitionInstagramBookingOwned,
};

function intent(
  kind: Extract<InstagramBookingIntent, { text: string }>['kind'],
  messageKey: string,
  text: string,
  options?: Array<{ id: string; label: string }>,
): InstagramBookingIntent {
  if (kind === 'ready_to_book') {
    throw new Error('use readyIntent');
  }
  return options?.length
    ? { kind, messageKey, text, options }
    : { kind, messageKey, text };
}

function normalizeKey(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function resolveInstagramBookingService(
  salonId: string,
  raw: string,
  deps: Pick<InstagramBookingFsmDeps, 'fetchActiveServices' | 'resolveServiceById'> = defaultDeps,
): Promise<
  | { kind: 'ok'; service: ServiceRow }
  | { kind: 'ambiguous'; services: ServiceRow[] }
  | { kind: 'invalid' }
  | { kind: 'empty_catalog' }
> {
  const services = await deps.fetchActiveServices(salonId);
  if (services.length === 0) return { kind: 'empty_catalog' };
  const text = parseInstagramBookingPostbackInput(raw);
  if (!text) return { kind: 'invalid' };

  const byId = await deps.resolveServiceById(salonId, text);
  if (byId) return { kind: 'ok', service: byId };

  if (/^\d{1,3}$/.test(text)) {
    const idx = Number(text) - 1;
    if (idx >= 0 && idx < services.length) return { kind: 'ok', service: services[idx] };
    return { kind: 'invalid' };
  }

  const key = normalizeKey(text);
  const exact = services.filter((s) => normalizeKey(s.name) === key);
  if (exact.length === 1) return { kind: 'ok', service: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', services: exact };

  const partial = services.filter((s) => {
    const n = normalizeKey(s.name);
    return n.includes(key) || key.includes(n);
  });
  if (partial.length === 1) return { kind: 'ok', service: partial[0] };
  if (partial.length > 1) return { kind: 'ambiguous', services: partial };
  return { kind: 'invalid' };
}

function serviceOptions(services: ServiceRow[]) {
  return services.slice(0, 20).map((s, i) => ({ id: `service:${s.id}`, label: `${i + 1}. ${s.name}` }));
}

function staffOptions(staff: StaffRow[]) {
  return staff.map((m, i) => ({ id: `staff:${m.id}`, label: `${i + 1}. ${m.name}` }));
}

async function chooseServicePrompt(
  salonId: string,
  deps: InstagramBookingFsmDeps,
): Promise<InstagramBookingIntent> {
  const services = await deps.fetchActiveServices(salonId);
  if (services.length === 0) {
    return intent(
      'invalid_input',
      'instagram.booking.noServices',
      'В салоне пока нет активных услуг.',
    );
  }
  return intent(
    'ask_service',
    'instagram.booking.chooseService',
    'На какую услугу хотите записаться? Ответьте номером или названием.',
    serviceOptions(services),
  );
}

async function datePrompt(
  salonId: string,
  staffId: string,
  durationMinutes: number,
  deps: InstagramBookingFsmDeps,
): Promise<InstagramBookingIntent> {
  const dates = await deps.findNextAvailableDates({
    salonId,
    staffId,
    durationMinutes,
    count: 4,
    maxDays: 30,
  });
  const tz = await deps.getSalonTimezone(salonId);
  const options = dates.map((iso) => ({ id: `date:${iso}`, label: iso }));
  const hint =
    dates.length > 0
      ? `Ближайшие даты: ${dates.join(', ')}. Сегодня: ${dateStrInTimezone(tz, 0)}.`
      : 'Введите дату вручную (ГГГГ-ММ-ДД).';
  return intent(
    'ask_date',
    'instagram.booking.chooseDate',
    `На какой день записаться? ${hint}`,
    options.length ? options : undefined,
  );
}

async function timePrompt(
  salonId: string,
  staffId: string,
  date: string,
  durationMinutes: number,
  deps: InstagramBookingFsmDeps,
): Promise<InstagramBookingIntent> {
  const slots = await deps.computeAvailableSlots({
    salonId,
    staffId,
    date,
    durationMinutes,
  });
  if (slots.length === 0) {
    return intent(
      'ask_date',
      'instagram.booking.noSlots',
      'На эту дату нет свободного времени. Выберите другой день.',
    );
  }
  return intent(
    'ask_time',
    'instagram.booking.chooseTime',
    'На какое время? Формат ЧЧ:ММ.',
    slots.slice(0, 24).map((s) => ({ id: `time:${s}`, label: s })),
  );
}

type TransitionMapped =
  | { kind: 'ok'; duplicate: boolean }
  | { kind: 'lost_ownership' }
  | { kind: 'stale_step' }
  | { kind: 'outdated' }
  | { kind: 'invalid_state'; reason?: string }
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
    nextState: InstagramBookingState;
  },
  deps: InstagramBookingFsmDeps,
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
    nextState: instagramBookingStateToJson(params.nextState),
  });
  if (result.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (result.kind === 'outdated') return { kind: 'outdated' };
  if (result.kind === 'invalid_state') {
    return { kind: 'invalid_state', reason: result.code ?? 'ready_to_book_incomplete' };
  }
  if (result.kind === 'stale_step') return { kind: 'stale_step' };
  if (result.kind === 'error') return { kind: 'error', code: result.code };
  return { kind: 'ok', duplicate: result.duplicate };
}

function mapFail(t: TransitionMapped): InstagramBookingIntent | null {
  if (t.kind === 'ok') {
    // RPC duplicate = this mid already committed FSM state (crash/retry).
    if (t.duplicate) return { kind: 'noop', reason: 'duplicate_message_applied' };
    return null;
  }
  if (t.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (t.kind === 'stale_step') return { kind: 'stale_step' };
  if (t.kind === 'outdated') return { kind: 'outdated' };
  if (t.kind === 'invalid_state') {
    return { kind: 'invalid_state', reason: t.reason ?? 'ready_to_book_incomplete' };
  }
  return { kind: 'error', code: t.code };
}

function resolveStaffChoice(staffMatches: StaffRow[], raw: string): StaffRow | null {
  const text = parseInstagramBookingPostbackInput(raw);
  if (!text) return null;
  const byId = staffMatches.find((m) => m.id === text);
  if (byId) return byId;
  if (/^\d{1,3}$/.test(text)) {
    const idx = Number(text) - 1;
    if (idx >= 0 && idx < staffMatches.length) return staffMatches[idx];
    return null;
  }
  const key = normalizeKey(text);
  const exact = staffMatches.filter((m) => normalizeKey(m.name) === key);
  return exact.length === 1 ? exact[0] : null;
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
  deps: InstagramBookingFsmDeps,
): Promise<InstagramBookingIntent> {
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
    const fail = mapFail(t);
    if (fail) return fail;
    return intent('invalid_input', 'instagram.booking.staffUnavailable', STAFF_UNAVAILABLE_MESSAGE);
  }
  if (staffMatches.length === 1) {
    const staff = staffMatches[0];
    const t = await runTransition(
      {
        ...params,
        nextFlow: INSTAGRAM_BOOKING_FLOW,
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
    const fail = mapFail(t);
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
      nextFlow: INSTAGRAM_BOOKING_FLOW,
      nextStep: 'staff',
      nextState: {
        serviceId: params.service.id,
        serviceName: params.service.name,
        sourceMessageId: params.externalMessageId ?? undefined,
      },
    },
    deps,
  );
  const fail = mapFail(t);
  if (fail) return fail;
  return intent(
    'ask_staff',
    'instagram.booking.chooseStaff',
    'К какому мастеру? Номер или имя.',
    staffOptions(staffMatches),
  );
}

/**
 * Process one inbound Instagram text/postback against durable booking FSM.
 * Does not call Meta, create clients, or write appointments.
 */
export async function processInstagramBookingFsm(
  params: {
    db: SupabaseClient | any;
    salonId: string;
    externalUserId: string;
    /** Ephemeral inbound text or postback payload — never persisted as-is. */
    text: string;
    externalMessageId: string | null;
    messageTimestampIso: string | null;
    receiptId: string;
    attemptCount: number;
    /** False when IG-4 transport touch marked inbound out-of-order. */
    inboundAdvanced?: boolean;
  },
  deps: InstagramBookingFsmDeps = defaultDeps,
): Promise<InstagramBookingIntent> {
  if (params.inboundAdvanced === false) return { kind: 'outdated' };

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
    if (
      snapshot.currentFlow === INSTAGRAM_BOOKING_FLOW &&
      snapshot.currentStep === 'ready_to_book' &&
      isCompleteInstagramReadyState(snapshot.state)
    ) {
      return {
        kind: 'ready_to_book',
        messageKey: 'instagram.booking.ready',
        text: 'Данные для записи собраны. Подтверждение будет в следующем этапе.',
        state: snapshot.state,
      };
    }
    return { kind: 'noop', reason: 'duplicate_message_applied' };
  }

  if (isInstagramConversationExpired(snapshot.expiresAt)) {
    snapshot = {
      ...snapshot,
      currentFlow: null,
      currentStep: null,
      state: {},
    };
  }

  // Unknown non-booking flow — do not hijack (IG-4 forward-compat).
  if (
    snapshot.currentFlow != null &&
    snapshot.currentFlow !== INSTAGRAM_BOOKING_FLOW
  ) {
    return { kind: 'noop', reason: 'foreign_flow' };
  }

  const raw = String(params.text || '').trim();
  const base = {
    db: params.db,
    salonId: params.salonId,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
    externalUserId: params.externalUserId,
    externalMessageId: params.externalMessageId,
    messageTimestampIso: params.messageTimestampIso,
  };

  // Idle → start booking. One owned transition per inbound mid (never chain two
  // writes that reuse the same sourceMessageId — RPC would no-op the second).
  // Greeting / unrecognized text → service prompt without auto-select.
  // Exact resolvable service in the first message may skip straight to staff/date.
  if (snapshot.currentFlow == null && snapshot.currentStep == null) {
    if (raw) {
      const resolved = await resolveInstagramBookingService(params.salonId, raw, deps);
      if (resolved.kind === 'ok') {
        return afterServiceSelected(
          {
            ...base,
            expectedFlow: null,
            expectedStep: null,
            service: resolved.service,
          },
          deps,
        );
      }
    }
    const t = await runTransition(
      {
        ...base,
        expectedFlow: null,
        expectedStep: null,
        nextFlow: INSTAGRAM_BOOKING_FLOW,
        nextStep: 'service',
        nextState: { sourceMessageId: params.externalMessageId ?? undefined },
      },
      deps,
    );
    const fail = mapFail(t);
    if (fail) return fail;
    return chooseServicePrompt(params.salonId, deps);
  }

  if (snapshot.currentFlow !== INSTAGRAM_BOOKING_FLOW) {
    return { kind: 'noop', reason: 'not_booking' };
  }

  const step = snapshot.currentStep;
  if (!isInstagramBookingStep(step)) {
    return { kind: 'noop', reason: 'unknown_step' };
  }

  const expectedFlow = INSTAGRAM_BOOKING_FLOW;
  const expectedStep = step;
  const state = snapshot.state;

  if (step === 'service') {
    const resolved = await resolveInstagramBookingService(params.salonId, raw, deps);
    if (resolved.kind === 'empty_catalog') {
      return intent('invalid_input', 'instagram.booking.noServices', 'Нет активных услуг.');
    }
    if (resolved.kind !== 'ok') {
      return chooseServicePrompt(params.salonId, deps);
    }
    return afterServiceSelected(
      { ...base, expectedFlow, expectedStep, service: resolved.service },
      deps,
    );
  }

  if (step === 'staff') {
    if (!state.serviceId || !state.serviceName) {
      const t = await runTransition(
        {
          ...base,
          expectedFlow,
          expectedStep,
          nextFlow: INSTAGRAM_BOOKING_FLOW,
          nextStep: 'service',
          nextState: { sourceMessageId: params.externalMessageId ?? undefined },
        },
        deps,
      );
      const fail = mapFail(t);
      if (fail) return fail;
      return chooseServicePrompt(params.salonId, deps);
    }
    const service = await deps.resolveServiceById(params.salonId, state.serviceId);
    if (!service) {
      return chooseServicePrompt(params.salonId, deps);
    }
    const staffMatches = await deps.findStaffForServiceSpecialization(
      params.salonId,
      state.serviceName,
    );
    const staff = resolveStaffChoice(staffMatches, raw);
    if (!staff) {
      return intent(
        'ask_staff',
        'instagram.booking.chooseStaff',
        'Выберите мастера номером или именем.',
        staffOptions(staffMatches),
      );
    }
    const t = await runTransition(
      {
        ...base,
        expectedFlow,
        expectedStep,
        nextFlow: INSTAGRAM_BOOKING_FLOW,
        nextStep: 'date',
        nextState: {
          serviceId: state.serviceId,
          serviceName: state.serviceName,
          staffId: staff.id,
          staffName: staff.name,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapFail(t);
    if (fail) return fail;
    return datePrompt(
      params.salonId,
      staff.id,
      service.duration > 0 ? service.duration : 60,
      deps,
    );
  }

  if (step === 'date') {
    if (!state.serviceId || !state.staffId) {
      return chooseServicePrompt(params.salonId, deps);
    }
    const service = await deps.resolveServiceById(params.salonId, state.serviceId);
    if (!service) return chooseServicePrompt(params.salonId, deps);
    const tz = await deps.getSalonTimezone(params.salonId);
    const date = parseWhatsAppAppointmentDate(parseInstagramBookingPostbackInput(raw), tz);
    if (!date) {
      return datePrompt(
        params.salonId,
        state.staffId,
        service.duration > 0 ? service.duration : 60,
        deps,
      );
    }
    const today = dateStrInTimezone(tz, 0);
    if (date < today) {
      return intent('ask_date', 'instagram.booking.pastDate', 'Дата в прошлом. Выберите другую.');
    }
    const slots = await deps.computeAvailableSlots({
      salonId: params.salonId,
      staffId: state.staffId,
      date,
      durationMinutes: service.duration > 0 ? service.duration : 60,
    });
    if (slots.length === 0) {
      return datePrompt(
        params.salonId,
        state.staffId,
        service.duration > 0 ? service.duration : 60,
        deps,
      );
    }
    const t = await runTransition(
      {
        ...base,
        expectedFlow,
        expectedStep,
        nextFlow: INSTAGRAM_BOOKING_FLOW,
        nextStep: 'time',
        nextState: {
          ...state,
          date,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapFail(t);
    if (fail) return fail;
    return timePrompt(
      params.salonId,
      state.staffId,
      date,
      service.duration > 0 ? service.duration : 60,
      deps,
    );
  }

  if (step === 'time') {
    if (!state.serviceId || !state.staffId || !state.date) {
      return chooseServicePrompt(params.salonId, deps);
    }
    const service = await deps.resolveServiceById(params.salonId, state.serviceId);
    if (!service) return chooseServicePrompt(params.salonId, deps);
    const time = parseWhatsAppAppointmentTime(parseInstagramBookingPostbackInput(raw));
    const slots = await deps.computeAvailableSlots({
      salonId: params.salonId,
      staffId: state.staffId,
      date: state.date,
      durationMinutes: service.duration > 0 ? service.duration : 60,
    });
    if (!time || !slots.includes(time)) {
      if (slots.length === 0) {
        const t = await runTransition(
          {
            ...base,
            expectedFlow,
            expectedStep,
            nextFlow: INSTAGRAM_BOOKING_FLOW,
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
        const fail = mapFail(t);
        if (fail) return fail;
        return datePrompt(
          params.salonId,
          state.staffId,
          service.duration > 0 ? service.duration : 60,
          deps,
        );
      }
      return timePrompt(
        params.salonId,
        state.staffId,
        state.date,
        service.duration > 0 ? service.duration : 60,
        deps,
      );
    }
    const t = await runTransition(
      {
        ...base,
        expectedFlow,
        expectedStep,
        nextFlow: INSTAGRAM_BOOKING_FLOW,
        nextStep: 'name',
        nextState: {
          ...state,
          time,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapFail(t);
    if (fail) return fail;
    return intent('ask_name', 'instagram.booking.askName', 'Как вас зовут?');
  }

  if (step === 'name') {
    const name = parseWhatsAppBookingName(raw);
    if (!name) {
      return intent('ask_name', 'instagram.booking.askName', 'Укажите имя (2–80 символов).');
    }
    const t = await runTransition(
      {
        ...base,
        expectedFlow,
        expectedStep,
        nextFlow: INSTAGRAM_BOOKING_FLOW,
        nextStep: 'phone',
        nextState: {
          ...state,
          name,
          sourceMessageId: params.externalMessageId ?? undefined,
        },
      },
      deps,
    );
    const fail = mapFail(t);
    if (fail) return fail;
    return intent('ask_phone', 'instagram.booking.askPhone', 'Укажите телефон для записи.');
  }

  if (step === 'phone') {
    const phone = parseWhatsAppBookingPhone(raw);
    if (!phone) {
      return intent('ask_phone', 'instagram.booking.askPhone', 'Некорректный телефон. Пример: +79991234567');
    }
    // Advisory slot recheck (IG-6 revalidates before insert).
    if (state.serviceId && state.staffId && state.date && state.time) {
      const service = await deps.resolveServiceById(params.salonId, state.serviceId);
      if (service) {
        const slots = await deps.computeAvailableSlots({
          salonId: params.salonId,
          staffId: state.staffId,
          date: state.date,
          durationMinutes: service.duration > 0 ? service.duration : 60,
        });
        if (!slots.includes(state.time)) {
          const tBack = await runTransition(
            {
              ...base,
              expectedFlow,
              expectedStep,
              nextFlow: INSTAGRAM_BOOKING_FLOW,
              nextStep: 'time',
              nextState: {
                serviceId: state.serviceId,
                serviceName: state.serviceName,
                staffId: state.staffId,
                staffName: state.staffName,
                date: state.date,
                sourceMessageId: params.externalMessageId ?? undefined,
              },
            },
            deps,
          );
          const failBack = mapFail(tBack);
          if (failBack) return failBack;
          return timePrompt(
            params.salonId,
            state.staffId,
            state.date,
            service.duration > 0 ? service.duration : 60,
            deps,
          );
        }
      }
    }
    const nextState: InstagramBookingState = {
      serviceId: state.serviceId,
      serviceName: state.serviceName,
      staffId: state.staffId,
      staffName: state.staffName,
      date: state.date,
      time: state.time,
      name: state.name,
      phone,
      sourceMessageId: params.externalMessageId ?? undefined,
    };
    // IG-5A: never request ready_to_book without the full durable contract.
    if (!isCompleteInstagramReadyState(nextState)) {
      return {
        kind: 'invalid_state',
        reason: 'ready_to_book_incomplete',
      };
    }
    const t = await runTransition(
      {
        ...base,
        expectedFlow,
        expectedStep,
        nextFlow: INSTAGRAM_BOOKING_FLOW,
        nextStep: 'ready_to_book',
        nextState,
      },
      deps,
    );
    const fail = mapFail(t);
    if (fail) return fail;
    return {
      kind: 'ready_to_book',
      messageKey: 'instagram.booking.ready',
      text: 'Данные для записи собраны. Подтверждение будет в следующем этапе.',
      state: nextState,
    };
  }

  // Already ready_to_book — IG-5 does not commit; ignore further chatter.
  if (step === 'ready_to_book') {
    return { kind: 'noop', reason: 'already_ready_to_book' };
  }

  return { kind: 'noop', reason: 'unhandled_step' };
}
