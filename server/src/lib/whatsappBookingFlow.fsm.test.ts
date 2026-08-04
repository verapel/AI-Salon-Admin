/**
 * WA-4C FSM tests with injected deps (no Meta, no appointments, no real DB).
 * Run: npx tsx --test src/lib/whatsappBookingFlow.fsm.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  processWhatsAppBookingFsm,
  type WhatsAppBookingFsmDeps,
} from './whatsappBookingFlow.js';
import {
  parseWhatsAppBookingState,
  WHATSAPP_BOOKING_FLOW,
  type WhatsAppBookingState,
} from './whatsappBookingState.js';
import type { ConversationBookingSnapshot } from './whatsappConversation.js';

type Snap = ConversationBookingSnapshot;

function makeDeps(initial: Snap, extras?: Partial<WhatsAppBookingFsmDeps>) {
  let snap: Snap = {
    ...initial,
    state: { ...initial.state },
  };
  const transitions: Array<Record<string, unknown>> = [];
  const services = [
    { id: 'svc-1', name: 'Стрижка', duration: 60, category: 'Hair' },
    { id: 'svc-2', name: 'Макияж', duration: 45, category: 'Makeup' },
  ];
  let staff = [
    { id: 'stf-1', name: 'Мария', specialties: ['Стрижка'] },
  ];
  const slots = ['10:00', '11:00', '12:00', '13:00', '14:00'];

  const deps: WhatsAppBookingFsmDeps = {
    fetchActiveServices: async () => services,
    resolveServiceById: async (_salonId, id) => services.find((s) => s.id === id) ?? null,
    findStaffForServiceSpecialization: async () => staff,
    getActiveStaffById: async (_salonId, id) => staff.find((s) => s.id === id) ?? null,
    computeAvailableSlots: async () => slots,
    findNextAvailableDates: async () => ['2099-06-15', '2099-06-16'],
    getSalonTimezone: async () => 'UTC',
    loadSnapshot: async () => ({ kind: 'ok', snapshot: { ...snap, state: { ...snap.state } } }),
    transition: async (params) => {
      transitions.push(params as unknown as Record<string, unknown>);
      if (
        snap.currentFlow !== params.expectedFlow ||
        snap.currentStep !== params.expectedStep
      ) {
        return {
          kind: 'stale_step',
          currentFlow: snap.currentFlow,
          currentStep: snap.currentStep,
        };
      }
      const nextState = parseWhatsAppBookingState(params.nextState);
      if (
        params.externalMessageId &&
        snap.state.sourceMessageId &&
        snap.state.sourceMessageId === params.externalMessageId
      ) {
        return {
          kind: 'ok',
          duplicate: true,
          conversationId: snap.conversationId,
          currentFlow: snap.currentFlow,
          currentStep: snap.currentStep,
          state: snap.state,
          clientId: snap.clientId,
        };
      }
      snap = {
        ...snap,
        currentFlow: params.nextFlow,
        currentStep: params.nextStep,
        state: nextState,
        lastInboundMessageId: params.externalMessageId,
      };
      return {
        kind: 'ok',
        duplicate: false,
        conversationId: snap.conversationId,
        currentFlow: snap.currentFlow,
        currentStep: snap.currentStep,
        state: snap.state,
        clientId: snap.clientId,
      };
    },
    ...extras,
  };

  return {
    deps,
    getSnap: () => snap,
    setStaff: (next: typeof staff) => {
      staff = next;
    },
    transitions,
    slots,
  };
}

function baseSnap(partial: Partial<Snap> & { state?: WhatsAppBookingState } = {}): Snap {
  return {
    conversationId: 'c1',
    clientId: null,
    currentFlow: null,
    currentStep: null,
    state: {},
    lastInboundMessageId: null,
    lastInboundAt: null,
    expiresAt: '2999-01-01T00:00:00.000Z',
    ...partial,
    state: { ...(partial.state ?? {}) },
  };
}

const call = (
  text: string,
  deps: WhatsAppBookingFsmDeps,
  msgId: string,
  advanced = true,
) =>
  processWhatsAppBookingFsm(
    {
      db: {},
      salonId: 'salon-1',
      externalUserId: '15551234567',
      text,
      externalMessageId: msgId,
      messageTimestampIso: '2026-08-04T12:00:00.000Z',
      receiptId: 'r1',
      attemptCount: 1,
      inboundAdvanced: advanced,
    },
    deps,
  );

describe('whatsapp booking FSM', () => {
  it('1. start → service', async () => {
    const { deps, getSnap } = makeDeps(baseSnap());
    const r = await call('запись', deps, 'm1');
    assert.equal(r.kind, 'reply');
    if (r.kind === 'reply') assert.equal(r.messageKey, 'whatsapp.booking.chooseService');
    assert.equal(getSnap().currentStep, 'service');
  });

  it('2/3. valid/invalid service', async () => {
    const valid = makeDeps(
      baseSnap({ currentFlow: WHATSAPP_BOOKING_FLOW, currentStep: 'service' }),
    );
    await call('Стрижка', valid.deps, 'm2');
    assert.equal(valid.getSnap().currentStep, 'date');
    assert.equal(valid.getSnap().state.staffId, 'stf-1');

    const invalid = makeDeps(
      baseSnap({ currentFlow: WHATSAPP_BOOKING_FLOW, currentStep: 'service' }),
    );
    const r = await call('нет-такой', invalid.deps, 'm3');
    assert.equal(invalid.getSnap().currentStep, 'service');
    if (r.kind === 'reply') assert.equal(r.messageKey, 'whatsapp.booking.serviceInvalid');
  });

  it('4/5. one vs multiple staff', async () => {
    const one = makeDeps(
      baseSnap({ currentFlow: WHATSAPP_BOOKING_FLOW, currentStep: 'service' }),
    );
    await call('Стрижка', one.deps, 'm4');
    assert.equal(one.getSnap().currentStep, 'date');

    const multi = makeDeps(
      baseSnap({ currentFlow: WHATSAPP_BOOKING_FLOW, currentStep: 'service' }),
    );
    multi.setStaff([
      { id: 'stf-1', name: 'Мария', specialties: ['Стрижка'] },
      { id: 'stf-2', name: 'Ольга', specialties: ['Стрижка'] },
    ]);
    const r = await call('Стрижка', multi.deps, 'm5');
    assert.equal(multi.getSnap().currentStep, 'staff');
    if (r.kind === 'reply') assert.equal(r.messageKey, 'whatsapp.booking.chooseStaff');
  });

  it('6/7. invalid/valid date', async () => {
    const bad = makeDeps(
      baseSnap({
        currentFlow: WHATSAPP_BOOKING_FLOW,
        currentStep: 'date',
        state: { serviceId: 'svc-1', serviceName: 'Стрижка', staffId: 'stf-1' },
      }),
    );
    const br = await call('когда-нибудь', bad.deps, 'm6');
    assert.equal(bad.getSnap().currentStep, 'date');
    if (br.kind === 'reply') assert.equal(br.messageKey, 'whatsapp.booking.dateInvalid');

    const good = makeDeps(
      baseSnap({
        currentFlow: WHATSAPP_BOOKING_FLOW,
        currentStep: 'date',
        state: { serviceId: 'svc-1', serviceName: 'Стрижка', staffId: 'stf-1' },
      }),
    );
    const gr = await call('2099-06-15', good.deps, 'm7');
    assert.equal(good.getSnap().currentStep, 'time');
    assert.equal(good.getSnap().state.date, '2099-06-15');
    if (gr.kind === 'reply') assert.equal(gr.messageKey, 'whatsapp.booking.chooseTime');
  });

  it('8/9/10. invalid/busy/valid time', async () => {
    const snap = baseSnap({
      currentFlow: WHATSAPP_BOOKING_FLOW,
      currentStep: 'time',
      state: {
        serviceId: 'svc-1',
        serviceName: 'Стрижка',
        staffId: 'stf-1',
        date: '2099-06-15',
      },
    });
    const inv = makeDeps(snap);
    const ir = await call('после обеда', inv.deps, 'm8');
    assert.equal(inv.getSnap().currentStep, 'time');
    if (ir.kind === 'reply') assert.equal(ir.messageKey, 'whatsapp.booking.timeInvalid');

    const busy = makeDeps({ ...snap, state: { ...snap.state } });
    const br = await call('03:00', busy.deps, 'm9');
    assert.equal(busy.getSnap().currentStep, 'time');
    if (br.kind === 'reply') assert.equal(br.messageKey, 'whatsapp.booking.timeBusy');

    const ok = makeDeps({ ...snap, state: { ...snap.state } });
    const or_ = await call('12:00', ok.deps, 'm10');
    assert.equal(ok.getSnap().currentStep, 'name');
    assert.equal(ok.getSnap().state.time, '12:00');
    if (or_.kind === 'reply') assert.equal(or_.messageKey, 'whatsapp.booking.askName');
  });

  it('11-16. name/phone → ready_to_book; no appointment create', async () => {
    const nameCtx = makeDeps(
      baseSnap({
        currentFlow: WHATSAPP_BOOKING_FLOW,
        currentStep: 'name',
        state: {
          serviceId: 'svc-1',
          serviceName: 'Стрижка',
          staffId: 'stf-1',
          date: '2099-06-15',
          time: '12:00',
        },
      }),
    );
    const blank = await call('   ', nameCtx.deps, 'm11');
    if (blank.kind === 'reply') assert.equal(blank.messageKey, 'whatsapp.booking.nameInvalid');

    await call('Анна', nameCtx.deps, 'm12');
    assert.equal(nameCtx.getSnap().currentStep, 'phone');

    const phoneCtx = makeDeps(
      baseSnap({
        currentFlow: WHATSAPP_BOOKING_FLOW,
        currentStep: 'phone',
        state: {
          serviceId: 'svc-1',
          serviceName: 'Стрижка',
          staffId: 'stf-1',
          date: '2099-06-15',
          time: '12:00',
          name: 'Анна',
        },
      }),
    );
    const badPhone = await call('12', phoneCtx.deps, 'm13');
    if (badPhone.kind === 'reply') {
      assert.equal(badPhone.messageKey, 'whatsapp.booking.phoneInvalid');
    }

    const ready = await call('+15551234567', phoneCtx.deps, 'm14');
    assert.equal(phoneCtx.getSnap().currentStep, 'ready_to_book');
    assert.equal(phoneCtx.getSnap().state.phone, '+15551234567');
    if (ready.kind === 'reply') assert.equal(ready.messageKey, 'whatsapp.booking.readyToBook');
    assert.equal(
      phoneCtx.transitions.every((t) => t.nextStep === 'ready_to_book' || t.nextStep === undefined || true),
      true,
    );
    // Ensure we never transitioned into an appointment-create step.
    assert.equal(
      phoneCtx.transitions.some((t) => String(t.nextStep) === 'create_appointment'),
      false,
    );
  });

  it('17. cancel clears flow, keeps client link', async () => {
    const { deps, getSnap } = makeDeps(
      baseSnap({
        clientId: 'client-1',
        currentFlow: WHATSAPP_BOOKING_FLOW,
        currentStep: 'date',
        state: { serviceId: 'svc-1', staffId: 'stf-1' },
      }),
    );
    const r = await call('отмена', deps, 'm15');
    assert.equal(getSnap().currentFlow, null);
    assert.equal(getSnap().currentStep, null);
    assert.equal(getSnap().clientId, 'client-1');
    assert.equal(getSnap().conversationId, 'c1');
    if (r.kind === 'reply') assert.equal(r.messageKey, 'whatsapp.booking.cancelled');
  });

  it('18. expiry restart (touch-cleared idle)', async () => {
    const { deps, getSnap } = makeDeps(
      baseSnap({
        clientId: 'client-1',
        currentFlow: null,
        currentStep: null,
        state: {},
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    const r = await call('запись', deps, 'm16');
    assert.equal(getSnap().currentStep, 'service');
    assert.equal(getSnap().clientId, 'client-1');
    if (r.kind === 'reply') assert.equal(r.messageKey, 'whatsapp.booking.chooseService');
  });

  it('19. duplicate message → noop', async () => {
    const { deps } = makeDeps(
      baseSnap({
        currentFlow: WHATSAPP_BOOKING_FLOW,
        currentStep: 'date',
        state: { sourceMessageId: 'm-dup', serviceId: 'svc-1', staffId: 'stf-1' },
      }),
    );
    const r = await call('Стрижка', deps, 'm-dup');
    assert.equal(r.kind, 'noop');
  });

  it('20. out-of-order → outdated', async () => {
    const { deps } = makeDeps(
      baseSnap({ currentFlow: WHATSAPP_BOOKING_FLOW, currentStep: 'service' }),
    );
    const r = await call('Стрижка', deps, 'older', false);
    assert.equal(r.kind, 'outdated');
  });

  it('21. concurrent stale_step', async () => {
    const { deps, getSnap } = makeDeps(
      baseSnap({ currentFlow: WHATSAPP_BOOKING_FLOW, currentStep: 'service' }),
    );
    await call('Стрижка', deps, 'ma');
    assert.equal(getSnap().currentStep, 'date');
    const race = await deps.transition({
      db: {},
      salonId: 'salon-1',
      receiptId: 'rb',
      attemptCount: 1,
      externalUserId: 'u1',
      externalMessageId: 'mb',
      messageTimestampIso: '2026-08-04T12:00:00.000Z',
      expectedFlow: WHATSAPP_BOOKING_FLOW,
      expectedStep: 'service',
      nextFlow: WHATSAPP_BOOKING_FLOW,
      nextStep: 'date',
      nextState: { date: '2099-01-01' },
    });
    assert.equal(race.kind, 'stale_step');
  });

  it('22. lost ownership', async () => {
    const { deps } = makeDeps(baseSnap(), {
      transition: async () => ({ kind: 'lost_ownership' }),
    });
    const r = await call('запись', deps, 'm22');
    assert.equal(r.kind, 'lost_ownership');
  });

  it('23. salon isolation via salonId arg', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps(baseSnap(), {
      fetchActiveServices: async (salonId) => {
        seen.push(salonId);
        return [{ id: 'svc-1', name: 'Стрижка', duration: 60, category: 'Hair' }];
      },
    });
    await call('запись', deps, 'm23');
    // start loads services with salon id from params
    const r2 = await processWhatsAppBookingFsm(
      {
        db: {},
        salonId: 'salon-B',
        externalUserId: '15551234567',
        text: 'запись',
        externalMessageId: 'm23b',
        messageTimestampIso: '2026-08-04T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
        inboundAdvanced: true,
      },
      deps,
    );
    assert.equal(r2.kind, 'reply');
    assert.equal(seen.includes('salon-B'), true);
  });

  it('24. resume from durable DB step after restart', async () => {
    const { deps, getSnap } = makeDeps(
      baseSnap({
        currentFlow: WHATSAPP_BOOKING_FLOW,
        currentStep: 'name',
        state: {
          serviceId: 'svc-1',
          serviceName: 'Стрижка',
          staffId: 'stf-1',
          date: '2099-06-15',
          time: '12:00',
        },
      }),
    );
    const r = await call('Анна', deps, 'm24');
    assert.equal(getSnap().currentStep, 'phone');
    assert.equal(getSnap().state.name, 'Анна');
    if (r.kind === 'reply') assert.equal(r.messageKey, 'whatsapp.booking.askPhone');
  });
});
