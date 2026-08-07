/**
 * IG-5: Instagram durable booking FSM tests (mocks/static SQL).
 * No Meta. No SQL execution. No appointment/client writes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  processInstagramBookingFsm,
  resolveInstagramBookingService,
  type InstagramBookingFsmDeps,
} from './instagramBookingFlow.js';
import {
  INSTAGRAM_BOOKING_FLOW,
  instagramBookingStateToJson,
  isCompleteInstagramReadyState,
  parseInstagramBookingPostbackInput,
  parseInstagramBookingState,
} from './instagramBookingState.js';
import {
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from './instagramWebhookProcess.js';
import { normalizeInstagramWebhookPayload } from './instagramWebhookEvents.js';

const SALON = '11111111-1111-1111-1111-111111111111';
const SENDER = '17841400000000099';
const LARGE_IG_ID = '17841400000000001';

const SERVICES = [
  { id: 'svc-1', name: 'Стрижка', duration: 60, category: 'hair' },
  { id: 'svc-2', name: 'Окрашивание', duration: 90, category: 'hair' },
];
const STAFF = [
  { id: 'st-1', name: 'Анна', specialization: 'Стрижка' },
  { id: 'st-2', name: 'Мария', specialization: 'Окрашивание' },
];

function fsmDeps(overrides: Partial<InstagramBookingFsmDeps> = {}): InstagramBookingFsmDeps {
  let snap = {
    conversationId: 'c1',
    clientId: null as string | null,
    currentFlow: null as string | null,
    currentStep: null as string | null,
    state: {} as Record<string, string>,
    lastInboundMessageId: null as string | null,
    lastInboundAt: null as string | null,
    expiresAt: null as string | null,
  };

  const base: InstagramBookingFsmDeps = {
    fetchActiveServices: async () => SERVICES,
    resolveServiceById: async (_s, id) => SERVICES.find((x) => x.id === id) ?? null,
    findStaffForServiceSpecialization: async (_s, name) =>
      name === 'Стрижка' ? [STAFF[0]] : name === 'Окрашивание' ? STAFF : [STAFF[0]],
    getActiveStaffById: async (_s, id) => STAFF.find((x) => x.id === id) ?? null,
    computeAvailableSlots: async () => ['10:00', '11:00', '12:00'],
    findNextAvailableDates: async () => ['2026-08-10', '2026-08-11'],
    getSalonTimezone: async () => 'Europe/Moscow',
    loadSnapshot: async () => ({
      kind: 'ok',
      snapshot: {
        ...snap,
        state: parseInstagramBookingState(snap.state),
      },
    }),
    transition: async (p) => {
      if (p.expectedFlow !== snap.currentFlow || p.expectedStep !== snap.currentStep) {
        return {
          kind: 'stale_step',
          currentFlow: snap.currentFlow,
          currentStep: snap.currentStep,
        };
      }
      if (
        p.externalMessageId &&
        snap.state.sourceMessageId &&
        snap.state.sourceMessageId === p.externalMessageId
      ) {
        return {
          kind: 'ok',
          duplicate: true,
          conversationId: snap.conversationId,
          currentFlow: snap.currentFlow,
          currentStep: snap.currentStep,
          state: parseInstagramBookingState(snap.state),
          clientId: snap.clientId,
        };
      }
      // Mirror IG-5A SQL ready_to_book completeness guard (no conversation update).
      if (p.nextStep === 'ready_to_book' && !isCompleteInstagramReadyState(p.nextState)) {
        return { kind: 'invalid_state', code: 'ready_to_book_incomplete' };
      }
      snap = {
        ...snap,
        currentFlow: p.nextFlow,
        currentStep: p.nextStep,
        state: { ...(p.nextState as Record<string, string>) },
        lastInboundMessageId: p.externalMessageId,
      };
      return {
        kind: 'ok',
        duplicate: false,
        conversationId: snap.conversationId,
        currentFlow: snap.currentFlow,
        currentStep: snap.currentStep,
        state: parseInstagramBookingState(snap.state),
        clientId: snap.clientId,
      };
    },
  };
  return { ...base, ...overrides, __snap: snap } as any;
}

describe('IG-5 state helpers (executed)', () => {
  it('state parse/serialize; postback grammar', () => {
    const s = parseInstagramBookingState({
      serviceId: 'svc-1',
      phone: '+79991234567',
      junk: 'x',
    });
    assert.equal(s.serviceId, 'svc-1');
    assert.equal((s as any).junk, undefined);
    assert.deepEqual(instagramBookingStateToJson(s).serviceId, 'svc-1');
    assert.equal(parseInstagramBookingPostbackInput('service:abc'), 'abc');
    assert.equal(parseInstagramBookingPostbackInput('10:00'), '10:00');
  });

  it('IG-5A ready completeness contract', () => {
    const complete = {
      serviceId: 'svc-1',
      serviceName: 'Стрижка',
      staffId: 'st-1',
      staffName: 'Анна',
      date: '2026-08-20',
      time: '14:00',
      name: 'Anna',
      phone: '+37499111222',
      sourceMessageId: 'mid.ok',
    };
    assert.equal(isCompleteInstagramReadyState(complete), true);
    assert.equal(isCompleteInstagramReadyState({ ...complete, serviceId: '  ' }), false);
    assert.equal(isCompleteInstagramReadyState({ ...complete, staffId: undefined }), false);
    assert.equal(isCompleteInstagramReadyState({ ...complete, sourceMessageId: '' }), false);
    assert.equal(isCompleteInstagramReadyState({ serviceId: 'svc-1' }), false);
    // App/SQL parity: non-string JSON types rejected (SQL uses jsonb_typeof='string').
    assert.equal(isCompleteInstagramReadyState({ ...complete, serviceId: 123 as any }), false);
    assert.equal(isCompleteInstagramReadyState({ ...complete, staffId: true as any }), false);
    assert.equal(isCompleteInstagramReadyState({ ...complete, date: { x: 1 } as any }), false);
    assert.equal(isCompleteInstagramReadyState({ ...complete, phone: ['+1'] as any }), false);
    // String edge: numeric-looking / space-padded strings are type-valid completeness.
    assert.equal(isCompleteInstagramReadyState({ ...complete, serviceId: '123' }), true);
    assert.equal(isCompleteInstagramReadyState({ ...complete, name: ' true ' }), true);
  });
});

describe('IG-5 service/staff/date/time/name/phone (executed mocks)', () => {
  it('1. idle greeting starts service without selecting service', async () => {
    const deps = fsmDeps({
      findStaffForServiceSpecialization: async () => [STAFF[0], STAFF[1]],
    });
    const r = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Привет',
        externalMessageId: 'mid.start',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    assert.equal(r.kind, 'ask_service');
    // "Привет" must not resolve as a service
    const resolved = await resolveInstagramBookingService(SALON, 'Привет', deps);
    assert.equal(resolved.kind, 'invalid');
  });

  it('1b. idle + resolvable service name advances in one transition', async () => {
    const deps = fsmDeps({
      findStaffForServiceSpecialization: async () => [STAFF[0]],
    });
    const r = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Стрижка',
        externalMessageId: 'mid.svc1',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    assert.equal(r.kind, 'ask_date');
    const dup = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Стрижка',
        externalMessageId: 'mid.svc1',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    assert.equal(dup.kind, 'noop');
  });

  it('2/3/6. valid service; invalid remains; duplicate mid no double advance', async () => {
    const deps = fsmDeps({
      findStaffForServiceSpecialization: async () => [STAFF[0]],
    });
    // start
    await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'запись',
        externalMessageId: 'mid.a',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    const ok = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Стрижка',
        externalMessageId: 'mid.b',
        messageTimestampIso: '2026-08-07T12:01:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    // one staff auto → date
    assert.equal(ok.kind, 'ask_date');

    const dup = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Стрижка',
        externalMessageId: 'mid.b',
        messageTimestampIso: '2026-08-07T12:01:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    assert.equal(dup.kind, 'noop');
  });

  it('30-35. complete flow reaches ready_to_book; no appointment fields', async () => {
    const deps = fsmDeps({
      findStaffForServiceSpecialization: async () => [STAFF[0]],
    });
    const steps: Array<{ text: string; mid: string }> = [
      { text: 'hi', mid: 'm1' },
      { text: 'Стрижка', mid: 'm2' },
      { text: '2026-08-10', mid: 'm3' },
      { text: '10:00', mid: 'm4' },
      { text: 'Иван', mid: 'm5' },
      { text: '+79991234567', mid: 'm6' },
    ];
    let last: Awaited<ReturnType<typeof processInstagramBookingFsm>> | null = null;
    for (const s of steps) {
      last = await processInstagramBookingFsm(
        {
          db: {},
          salonId: SALON,
          externalUserId: SENDER,
          text: s.text,
          externalMessageId: s.mid,
          messageTimestampIso: '2026-08-07T12:00:00.000Z',
          receiptId: 'r1',
          attemptCount: 1,
        },
        deps,
      );
    }
    assert.equal(last!.kind, 'ready_to_book');
    if (last!.kind === 'ready_to_book') {
      assert.equal(isCompleteInstagramReadyState(last.state), true);
      assert.equal(last.state.serviceId, 'svc-1');
      assert.equal(last.state.serviceName, 'Стрижка');
      assert.equal(last.state.staffId, 'st-1');
      assert.equal(last.state.staffName, 'Анна');
      assert.equal(last.state.date, '2026-08-10');
      assert.equal(last.state.time, '10:00');
      assert.equal(last.state.name, 'Иван');
      assert.equal(last.state.phone, '+79991234567');
      assert.equal(last.state.sourceMessageId, 'm6');
      assert.ok(!('appointmentId' in last.state));
      assert.ok(!('inboundText' in last.state));
      assert.ok(!('inboundPostbackPayload' in last.state));
      const blob = JSON.stringify(last.state);
      assert.ok(!blob.includes('hi'));
      assert.ok(!blob.includes('Стрижка') || last.state.serviceName === 'Стрижка');
    }
  });

  it('17/18. strict time; substring rejected', async () => {
    const deps = fsmDeps({
      findStaffForServiceSpecialization: async () => [STAFF[0]],
    });
    // drive to time step
    for (const [text, mid] of [
      ['x', 't1'],
      ['Стрижка', 't2'],
      ['2026-08-10', 't3'],
    ] as const) {
      await processInstagramBookingFsm(
        {
          db: {},
          salonId: SALON,
          externalUserId: SENDER,
          text,
          externalMessageId: mid,
          messageTimestampIso: '2026-08-07T12:00:00.000Z',
          receiptId: 'r1',
          attemptCount: 1,
        },
        deps,
      );
    }
    const bad = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'around 10ish',
        externalMessageId: 't4',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    assert.equal(bad.kind, 'ask_time');
  });

  it('23/26/28. name/phone; no client side effects in FSM', async () => {
    const deps = fsmDeps({
      findStaffForServiceSpecialization: async () => [STAFF[0]],
    });
    for (const [text, mid] of [
      ['x', 'n1'],
      ['Стрижка', 'n2'],
      ['2026-08-10', 'n3'],
      ['10:00', 'n4'],
    ] as const) {
      await processInstagramBookingFsm(
        {
          db: {},
          salonId: SALON,
          externalUserId: SENDER,
          text,
          externalMessageId: mid,
          messageTimestampIso: '2026-08-07T12:00:00.000Z',
          receiptId: 'r1',
          attemptCount: 1,
        },
        deps,
      );
    }
    const blank = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: ' ',
        externalMessageId: 'n5',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    assert.equal(blank.kind, 'ask_name');
    const src = readFileSync(new URL('./instagramBookingFlow.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\(['"]clients['"]\)/);
    assert.doesNotMatch(src, /from\(['"]appointments['"]\)/);
    assert.doesNotMatch(src, /\.insert\(/);
    assert.doesNotMatch(src, /client_id\s*=/);
    assert.doesNotMatch(src, /syncAppointmentReminder|notifyAdmin/i);
  });

  it('40/47. stale expected-step; foreign flow not hijacked', async () => {
    const deps = fsmDeps({
      loadSnapshot: async () => ({
        kind: 'ok',
        snapshot: {
          conversationId: 'c1',
          clientId: null,
          currentFlow: 'manage',
          currentStep: 'menu',
          state: parseInstagramBookingState({ serviceId: 'keep' }),
          lastInboundMessageId: null,
          lastInboundAt: null,
          expiresAt: null,
        },
      }),
    });
    const r = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Стрижка',
        externalMessageId: 'fx1',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      deps,
    );
    assert.equal(r.kind, 'noop');
    if (r.kind === 'noop') assert.equal(r.reason, 'foreign_flow');
  });

  it('IG-5A. incomplete phone state never requests ready_to_book', async () => {
    const missingFields = [
      'serviceId',
      'serviceName',
      'staffId',
      'staffName',
      'date',
      'time',
      'name',
    ] as const;
    for (const field of missingFields) {
      let transitionCalls = 0;
      const baseState = {
        serviceId: 'svc-1',
        serviceName: 'Стрижка',
        staffId: 'st-1',
        staffName: 'Анна',
        date: '2026-08-10',
        time: '10:00',
        name: 'Иван',
      };
      delete (baseState as any)[field];
      const deps = fsmDeps({
        loadSnapshot: async () => ({
          kind: 'ok',
          snapshot: {
            conversationId: 'c1',
            clientId: null,
            currentFlow: INSTAGRAM_BOOKING_FLOW,
            currentStep: 'phone',
            state: parseInstagramBookingState(baseState),
            lastInboundMessageId: null,
            lastInboundAt: null,
            expiresAt: null,
          },
        }),
        transition: async () => {
          transitionCalls += 1;
          return { kind: 'error', code: 'should_not_transition' };
        },
      });
      const r = await processInstagramBookingFsm(
        {
          db: {},
          salonId: SALON,
          externalUserId: SENDER,
          text: '+79991234567',
          externalMessageId: `mid.miss.${field}`,
          messageTimestampIso: '2026-08-07T12:00:00.000Z',
          receiptId: 'r1',
          attemptCount: 1,
        },
        deps,
      );
      assert.equal(r.kind, 'invalid_state', `missing ${field}`);
      assert.equal(transitionCalls, 0, `missing ${field} must not call transition`);
    }

    // Missing sourceMessageId (null mid) → no ready transition.
    let midCalls = 0;
    const noMid = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: '+79991234567',
        externalMessageId: null,
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      fsmDeps({
        loadSnapshot: async () => ({
          kind: 'ok',
          snapshot: {
            conversationId: 'c1',
            clientId: null,
            currentFlow: INSTAGRAM_BOOKING_FLOW,
            currentStep: 'phone',
            state: parseInstagramBookingState({
              serviceId: 'svc-1',
              serviceName: 'Стрижка',
              staffId: 'st-1',
              staffName: 'Анна',
              date: '2026-08-10',
              time: '10:00',
              name: 'Иван',
            }),
            lastInboundMessageId: null,
            lastInboundAt: null,
            expiresAt: null,
          },
        }),
        transition: async () => {
          midCalls += 1;
          return { kind: 'error', code: 'should_not_transition' };
        },
      }),
    );
    assert.equal(noMid.kind, 'invalid_state');
    assert.equal(midCalls, 0);

    // Blank/invalid phone stays on phone (ask_phone), no transition.
    let phoneCalls = 0;
    const blankPhone = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'not-a-phone',
        externalMessageId: 'mid.badphone',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      fsmDeps({
        loadSnapshot: async () => ({
          kind: 'ok',
          snapshot: {
            conversationId: 'c1',
            clientId: null,
            currentFlow: INSTAGRAM_BOOKING_FLOW,
            currentStep: 'phone',
            state: parseInstagramBookingState({
              serviceId: 'svc-1',
              serviceName: 'Стрижка',
              staffId: 'st-1',
              staffName: 'Анна',
              date: '2026-08-10',
              time: '10:00',
              name: 'Иван',
            }),
            lastInboundMessageId: null,
            lastInboundAt: null,
            expiresAt: null,
          },
        }),
        transition: async () => {
          phoneCalls += 1;
          return { kind: 'error', code: 'should_not_transition' };
        },
      }),
    );
    assert.equal(blankPhone.kind, 'ask_phone');
    assert.equal(phoneCalls, 0);
  });

  it('IG-5A. durable mock rejects incomplete ready_to_book without update', async () => {
    const deps = fsmDeps();
    const before = await deps.loadSnapshot({
      db: {},
      salonId: SALON,
      externalUserId: SENDER,
    });
    assert.equal(before.kind, 'ok');
    const rejected = await deps.transition({
      db: {},
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      externalUserId: SENDER,
      externalMessageId: 'mid.incomplete',
      messageTimestampIso: '2026-08-07T12:00:00.000Z',
      expectedFlow: null,
      expectedStep: null,
      nextFlow: INSTAGRAM_BOOKING_FLOW,
      nextStep: 'ready_to_book',
      nextState: {
        serviceId: 'svc-1',
        // missing remaining ready fields
        sourceMessageId: 'mid.incomplete',
      },
    });
    assert.equal(rejected.kind, 'invalid_state');
    const after = await deps.loadSnapshot({
      db: {},
      salonId: SALON,
      externalUserId: SENDER,
    });
    assert.equal(after.kind, 'ok');
    if (after.kind === 'ok' && before.kind === 'ok') {
      assert.equal(after.snapshot.currentStep, before.snapshot.currentStep);
      assert.deepEqual(after.snapshot.state, before.snapshot.state);
    }
  });

  it('IG-5B. ready_to_book + new inbound → noop no transition', async () => {
    let transitionCalls = 0;
    const readyState = {
      serviceId: 'svc-1',
      serviceName: 'Стрижка',
      staffId: 'st-1',
      staffName: 'Анна',
      date: '2026-08-10',
      time: '10:00',
      name: 'Иван',
      phone: '+79991234567',
      sourceMessageId: 'mid.ready',
    };
    const r = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'еще раз',
        externalMessageId: 'mid.after.ready',
        messageTimestampIso: '2026-08-07T12:05:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      fsmDeps({
        loadSnapshot: async () => ({
          kind: 'ok',
          snapshot: {
            conversationId: 'c1',
            clientId: null,
            currentFlow: INSTAGRAM_BOOKING_FLOW,
            currentStep: 'ready_to_book',
            state: parseInstagramBookingState(readyState),
            lastInboundMessageId: 'mid.ready',
            lastInboundAt: '2026-08-07T12:00:00.000Z',
            expiresAt: null,
          },
        }),
        transition: async () => {
          transitionCalls += 1;
          return { kind: 'error', code: 'should_not_transition' };
        },
      }),
    );
    assert.equal(r.kind, 'noop');
    if (r.kind === 'noop') assert.equal(r.reason, 'already_ready_to_book');
    assert.equal(transitionCalls, 0);
  });

  it('IG-5A. complete phone state reaches ready_to_book', async () => {
    const full = fsmDeps({
      findStaffForServiceSpecialization: async () => [STAFF[0]],
    });
    for (const [text, mid] of [
      ['hi', 'r1'],
      ['Стрижка', 'r2'],
      ['2026-08-10', 'r3'],
      ['10:00', 'r4'],
      ['Иван', 'r5'],
    ] as const) {
      await processInstagramBookingFsm(
        {
          db: {},
          salonId: SALON,
          externalUserId: SENDER,
          text,
          externalMessageId: mid,
          messageTimestampIso: '2026-08-07T12:00:00.000Z',
          receiptId: 'r1',
          attemptCount: 1,
        },
        full,
      );
    }
    const ready = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: '+79991234567',
        externalMessageId: 'r6',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      full,
    );
    assert.equal(ready.kind, 'ready_to_book');
    if (ready.kind === 'ready_to_book') {
      assert.equal(isCompleteInstagramReadyState(ready.state), true);
    }
  });

  it('36/37/41. ownership / OOO / inboundAdvanced=false', async () => {
    const lost = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Привет',
        externalMessageId: 'own1',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      fsmDeps({
        transition: async () => ({ kind: 'lost_ownership' }),
      }),
    );
    assert.equal(lost.kind, 'lost_ownership');

    const outdated = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Привет',
        externalMessageId: 'old1',
        messageTimestampIso: '2026-08-07T11:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
        inboundAdvanced: false,
      },
      fsmDeps(),
    );
    assert.equal(outdated.kind, 'outdated');

    const stale = await processInstagramBookingFsm(
      {
        db: {},
        salonId: SALON,
        externalUserId: SENDER,
        text: 'Стрижка',
        externalMessageId: 'stale1',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
      },
      fsmDeps({
        loadSnapshot: async () => ({
          kind: 'ok',
          snapshot: {
            conversationId: 'c1',
            clientId: null,
            currentFlow: INSTAGRAM_BOOKING_FLOW,
            currentStep: 'service',
            state: {},
            lastInboundMessageId: null,
            lastInboundAt: null,
            expiresAt: null,
          },
        }),
        transition: async () => ({
          kind: 'stale_step',
          currentFlow: INSTAGRAM_BOOKING_FLOW,
          currentStep: 'date',
        }),
      }),
    );
    assert.equal(stale.kind, 'stale_step');
  });
});

describe('IG-5 pipeline integration (executed mocks)', () => {
  function baseProcess(overrides: Partial<InstagramProcessDeps> = {}): InstagramProcessDeps {
    return {
      route: async () => ({
        kind: 'connected',
        salonId: SALON,
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async () => ({ kind: 'claimed', receiptId: 'r1', attemptCount: 1 }),
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: async () => ({
        kind: 'ok',
        identityId: 'i1',
        conversationId: 'c1',
        clientId: null,
        advanced: true,
        identityCreated: true,
        conversationCreated: true,
      }),
      runBookingFsm: async () => ({
        kind: 'ask_service',
        messageKey: 'instagram.booking.chooseService',
        text: 'choose',
      }),
      enqueueOutbound: async () => ({
        kind: 'enqueued',
        id: 'ob-ig5',
        created: true,
        intentKey: 'ask_service',
      }),
      ...overrides,
    };
  }

  it('53/55. message runs FSM; echo skips FSM', async () => {
    let fsm = 0;
    const msg = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1_700_000_000_000,
              message: { mid: 'mid.fsm', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const r = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        runBookingFsm: async () => {
          fsm += 1;
          return { kind: 'ask_service', messageKey: 'k', text: 't' };
        },
      }),
    );
    assert.equal(r.outcome, 'processed');
    assert.equal(fsm, 1);

    const echo = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1_700_000_000_000,
              message: { mid: 'mid.echo2', text: 'hi', is_echo: true },
            },
          ],
        },
      ],
    })[0];
    fsm = 0;
    const er = await processInstagramWebhookEvent(
      echo,
      baseProcess({
        runBookingFsm: async () => {
          fsm += 1;
          return { kind: 'ask_service', messageKey: 'k', text: 't' };
        },
        finalize: async (p) => ({ ok: true, status: p.finalStatus }),
      }),
    );
    assert.equal(er.outcome, 'ignored');
    assert.equal(fsm, 0);
  });

  it('58. lost ownership between RPCs → no stale finalize', async () => {
    let finalized = 0;
    const msg = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1_700_000_000_000,
              message: { mid: 'mid.lost', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const r = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        runBookingFsm: async () => ({ kind: 'lost_ownership' }),
        finalize: async () => {
          finalized += 1;
          return { ok: true, status: 'processed' };
        },
      }),
    );
    assert.equal(r.outcome, 'in_flight');
    assert.equal(finalized, 0);
  });

  it('56/59. duplicate receipt no FSM; FSM error marks failed', async () => {
    let fsm = 0;
    let failed = 0;
    const msg = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1_700_000_000_000,
              message: { mid: 'mid.dup', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const dup = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        claim: async () => ({ kind: 'duplicate_terminal', status: 'processed' }),
        runBookingFsm: async () => {
          fsm += 1;
          return { kind: 'ask_service', messageKey: 'k', text: 't' };
        },
      }),
    );
    assert.equal(dup.outcome, 'duplicate_terminal');
    assert.equal(fsm, 0);

    const err = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        runBookingFsm: async () => ({ kind: 'error', code: 'booking_transition_rpc' }),
        markFailed: async () => {
          failed += 1;
          return { ok: true };
        },
        finalize: async () => {
          throw new Error('no finalize');
        },
      }),
    );
    assert.equal(err.outcome, 'failed_transient');
    assert.equal(failed, 1);
  });

  it('49-52. raw DM not in receipt metadata; FSM does not persist raw text', () => {
    const events = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { mid: 'mid.p', text: 'SECRET_DM_TEXT' },
            },
          ],
        },
      ],
    });
    assert.ok(!JSON.stringify(events[0].receiptMetadata).includes('SECRET_DM_TEXT'));
    assert.equal(events[0].inboundText, 'SECRET_DM_TEXT');
    const flowSrc = readFileSync(new URL('./instagramBookingFlow.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(flowSrc, /rawText|messageBody|transcript/i);
    assert.match(flowSrc, /sourceMessageId/);
  });
});

describe('IG-5 migration / RPC static (static)', () => {
  const mig = readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000005_instagram_booking_fsm.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const wa = readFileSync(
    new URL(
      '../../../supabase/migrations/20260805000001_whatsapp_booking_transition_owned.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it('RPC ownership + duplicate + CAS + instagram provider', () => {
    assert.match(mig, /transition_instagram_booking_owned/);
    assert.match(mig, /instagram_lock_owned_receipt/);
    assert.match(mig, /provider = 'instagram'/);
    assert.match(mig, /sourceMessageId/);
    assert.match(mig, /stale_step/);
    assert.match(mig, /p_message_at < v_conv\.last_inbound_at/);
    assert.match(mig, /SECURITY INVOKER/);
    assert.match(mig, /GRANT EXECUTE[\s\S]*service_role/);
    assert.doesNotMatch(mig, /INSERT INTO public\.appointments/);
    assert.doesNotMatch(mig, /INSERT INTO public\.clients/);
    assert.doesNotMatch(mig, /client_id\s*=/);
  });

  it('IG-5A SQL ready_to_book completeness guard before UPDATE', () => {
    assert.match(mig, /v_next_step = 'ready_to_book'/);
    assert.match(mig, /ready_to_book_incomplete/);
    assert.match(mig, /'kind', 'invalid_state'/);
    for (const key of [
      'serviceId',
      'serviceName',
      'staffId',
      'staffName',
      'date',
      'time',
      'name',
      'phone',
      'sourceMessageId',
    ]) {
      assert.match(mig, new RegExp(`v_state->>'${key}'`));
    }
    // Completeness check must appear before the conversation UPDATE.
    const readyIdx = mig.indexOf("v_next_step = 'ready_to_book'");
    const updateIdx = mig.indexOf('UPDATE public.channel_conversations');
    assert.ok(readyIdx > 0 && updateIdx > readyIdx);
    // Intermediate steps are not forced through full ready completeness
    // (guard is gated on ready_to_book only).
    assert.match(mig, /only ready_to_book is fully gated/i);
  });

  it('IG-5B SQL ready fields require jsonb string type (not ->> coercion)', () => {
    const keys = [
      'serviceId',
      'serviceName',
      'staffId',
      'staffName',
      'date',
      'time',
      'name',
      'phone',
      'sourceMessageId',
    ] as const;
    // Include IG-5B comment + ready_to_book guard through UPDATE (guard must precede UPDATE).
    const blockStart = mig.indexOf('IG-5A/B: ready_to_book requires complete');
    const updateIdx = mig.indexOf('UPDATE public.channel_conversations');
    assert.ok(blockStart > 0 && updateIdx > blockStart);
    const guard = mig.slice(blockStart, updateIdx);
    assert.match(guard, /jsonb_typeof/);
    assert.match(guard, /->> alone would coerce/i);
    assert.match(guard, /number\/boolean\/object\/array/i);
    for (const key of keys) {
      assert.match(
        guard,
        new RegExp(`jsonb_typeof\\(v_state->'${key}'\\) IS DISTINCT FROM 'string'`),
        `missing jsonb_typeof string check for ${key}`,
      );
      assert.match(
        guard,
        new RegExp(`btrim\\(v_state->>'${key}'\\) = ''`),
        `missing trimmed non-empty check for ${key}`,
      );
    }
    // Non-string JSON values fail typeof even when ->> text is non-empty (static contract).
    // e.g. serviceId:123 / staffId:true / date:{} / phone:[] → invalid_state, no UPDATE.
  });

  it('WhatsApp transition RPC untouched', () => {
    assert.match(wa, /transition_whatsapp_booking_owned/);
    assert.doesNotMatch(wa, /instagram/);
  });

  it('index.ts unchanged by IG-5; no Meta send', () => {
    const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const flow = readFileSync(new URL('./instagramBookingFlow.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(flow, /graph\.facebook|subscribed_apps|sendMessage/);
    assert.doesNotMatch(indexSrc, /transition_instagram_booking_owned/);
  });
});
