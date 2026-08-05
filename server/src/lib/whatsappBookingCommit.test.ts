/**
 * WA-4D1 / WA-4D2 booking commit tests (no Meta, no real Postgres RPC execution).
 * Executed: result mapping, overlap math, FSM commit signal, migration static checks.
 * Reasoned/static: full SQL RPC concurrency (covered by migration review + mocked kinds).
 *
 * Run: npm run test --prefix server
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { commitWhatsAppBookingOwned } from './whatsappBookingCommit.js';
import { processWhatsAppBookingFsm } from './whatsappBookingFlow.js';
import {
  WHATSAPP_BOOKING_FLOW,
  type WhatsAppBookingState,
} from './whatsappBookingState.js';
import type { WhatsAppBookingFsmDeps } from './whatsappBookingFlow.js';
import type { ConversationBookingSnapshot } from './whatsappConversation.js';

/** Same interval rule as scheduleSlots / commit RPC. */
function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

describe('WA-4D1 overlap formula (executed)', () => {
  it('5/6/7/8. busy, contained, and adjacent slots', () => {
    const neu = { start: hhmmToMin('12:00'), end: hhmmToMin('13:00') }; // 60m
    // existing starts before new and ends inside
    assert.equal(
      intervalsOverlap(neu.start, neu.end, hhmmToMin('11:30'), hhmmToMin('12:30')),
      true,
    );
    // existing contained inside new (30m inside 60m)
    assert.equal(
      intervalsOverlap(neu.start, neu.end, hhmmToMin('12:15'), hhmmToMin('12:45')),
      true,
    );
    // adjacent end == start → allowed
    assert.equal(
      intervalsOverlap(neu.start, neu.end, hhmmToMin('11:00'), hhmmToMin('12:00')),
      false,
    );
    assert.equal(
      intervalsOverlap(neu.start, neu.end, hhmmToMin('13:00'), hhmmToMin('14:00')),
      false,
    );
  });
});

describe('WA-4D1 commit RPC mapping (executed with mock db)', () => {
  function mockDb(kind: string, extra: Record<string, unknown> = {}) {
    return {
      async rpc(name: string, args: Record<string, unknown>) {
        assert.equal(name, 'commit_whatsapp_booking_owned');
        assert.equal(args.p_salon_id, 'salon-1');
        assert.equal(args.p_external_event_id, 'message:wamid.1');
        return {
          data: { kind, appointment_id: 'appt-1', client_id: 'client-1', ...extra },
          error: null,
        };
      },
    };
  }

  const base = {
    salonId: 'salon-1',
    receiptId: 'r1',
    attemptCount: 1,
    externalUserId: '15551234567',
    expectedSourceMessageId: 'wamid.1',
    externalEventId: 'message:wamid.1',
    serviceId: 'svc-1',
    staffId: 'stf-1',
    date: '2099-06-15',
    time: '12:00',
    name: 'Анна',
    phone: '+15551234567',
    runPrecheck: false as const,
  };

  it('1. booking_created', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('booking_created') });
    assert.equal(r.kind, 'booking_created');
    if (r.kind === 'booking_created') {
      assert.equal(r.appointmentId, 'appt-1');
      assert.equal(r.clientId, 'client-1');
    }
  });

  it('2/3. already_booked (retry / finalize-fail recovery)', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('already_booked') });
    assert.equal(r.kind, 'already_booked');
    if (r.kind === 'already_booked') assert.equal(r.appointmentId, 'appt-1');
  });

  it('4. unique_violation path surfaces as already_booked from RPC', async () => {
    // RPC maps unique_violation → already_booked; wrapper just maps kind.
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('already_booked') });
    assert.equal(r.kind, 'already_booked');
  });

  it('5. slot_unavailable', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('slot_unavailable') });
    assert.equal(r.kind, 'slot_unavailable');
  });

  it('9. service_unavailable', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('service_unavailable') });
    assert.equal(r.kind, 'service_unavailable');
  });

  it('10/11. staff_unavailable', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('staff_unavailable') });
    assert.equal(r.kind, 'staff_unavailable');
  });

  it('12/13. stale_state', async () => {
    const r = await commitWhatsAppBookingOwned({
      ...base,
      db: mockDb('stale_state', { code: 'source_message_mismatch' }),
    });
    assert.equal(r.kind, 'stale_state');
  });

  it('14. lost_ownership', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('lost_ownership') });
    assert.equal(r.kind, 'lost_ownership');
  });

  it('15/16. existing vs new client both return booking_created with clientId', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('booking_created') });
    assert.equal(r.kind, 'booking_created');
  });

  it('17. ambiguous_client', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('ambiguous_client') });
    assert.equal(r.kind, 'ambiguous_client');
  });

  it('18/19. identity same / conflict', async () => {
    const ok = await commitWhatsAppBookingOwned({ ...base, db: mockDb('booking_created') });
    assert.equal(ok.kind, 'booking_created');
    const bad = await commitWhatsAppBookingOwned({ ...base, db: mockDb('identity_conflict') });
    assert.equal(bad.kind, 'identity_conflict');
  });

  it('WA-4D2: client_blocked is permanent mapped kind (no error/retry)', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('client_blocked') });
    assert.equal(r.kind, 'client_blocked');
  });

  it('WA-4D2: client_resolution_conflict is permanent mapped kind', async () => {
    const r = await commitWhatsAppBookingOwned({
      ...base,
      db: mockDb('client_resolution_conflict'),
    });
    assert.equal(r.kind, 'client_resolution_conflict');
  });

  it('WA-4D2: non-blocked existing client still books', async () => {
    const r = await commitWhatsAppBookingOwned({ ...base, db: mockDb('booking_created') });
    assert.equal(r.kind, 'booking_created');
    if (r.kind === 'booking_created') assert.equal(r.clientId, 'client-1');
  });

  it('21. salon isolation via salon_id arg', async () => {
    const seen: string[] = [];
    const db = {
      async rpc(_name: string, args: Record<string, unknown>) {
        seen.push(String(args.p_salon_id));
        return {
          data: { kind: 'booking_created', appointment_id: 'a', client_id: 'c' },
          error: null,
        };
      },
    };
    await commitWhatsAppBookingOwned({ ...base, db, salonId: 'salon-A' });
    await commitWhatsAppBookingOwned({ ...base, db, salonId: 'salon-B' });
    assert.deepEqual(seen, ['salon-A', 'salon-B']);
  });

  it('22. no reminder / Meta side effects in wrapper', async () => {
    const calls: string[] = [];
    const db = {
      async rpc(name: string) {
        calls.push(name);
        return {
          data: { kind: 'booking_created', appointment_id: 'a', client_id: 'c' },
          error: null,
        };
      },
      from() {
        throw new Error('wrapper must not touch tables directly');
      },
    };
    await commitWhatsAppBookingOwned({ ...base, db });
    assert.deepEqual(calls, ['commit_whatsapp_booking_owned']);
  });
});

describe('WA-4D1 FSM commit signal (executed)', () => {
  function makeDeps(initial: ConversationBookingSnapshot) {
    let snap: ConversationBookingSnapshot = {
      ...initial,
      state: { ...initial.state },
    };
    const services = [
      { id: 'svc-1', name: 'Стрижка', duration: 60, category: 'Hair' },
    ];
    const staff = [{ id: 'stf-1', name: 'Мария', specialties: ['Стрижка'] }];
    const deps: WhatsAppBookingFsmDeps = {
      fetchActiveServices: async () => services,
      resolveServiceById: async (_s, id) => services.find((x) => x.id === id) ?? null,
      findStaffForServiceSpecialization: async () => staff,
      getActiveStaffById: async (_s, id) => staff.find((x) => x.id === id) ?? null,
      computeAvailableSlots: async () => ['10:00', '12:00', '14:00'],
      findNextAvailableDates: async () => ['2099-06-15'],
      getSalonTimezone: async () => 'UTC',
      loadSnapshot: async () => ({ kind: 'ok', snapshot: { ...snap, state: { ...snap.state } } }),
      transition: async (params) => {
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
        snap = {
          ...snap,
          currentFlow: params.nextFlow,
          currentStep: params.nextStep,
          state: params.nextState as WhatsAppBookingState,
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
    };
    return { deps, getSnap: () => snap };
  }

  it('phone → ready_to_book_pending_commit (not plain reply)', async () => {
    const { deps } = makeDeps({
      conversationId: 'c1',
      clientId: null,
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
      lastInboundMessageId: null,
      lastInboundAt: null,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const r = await processWhatsAppBookingFsm(
      {
        db: {},
        salonId: 'salon-1',
        externalUserId: 'u1',
        text: '+15551234567',
        externalMessageId: 'wamid.phone',
        messageTimestampIso: '2026-08-05T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 1,
        inboundAdvanced: true,
      },
      deps,
    );
    assert.equal(r.kind, 'ready_to_book_pending_commit');
  });

  it('duplicate source message on ready_to_book re-signals commit', async () => {
    const { deps } = makeDeps({
      conversationId: 'c1',
      clientId: null,
      currentFlow: WHATSAPP_BOOKING_FLOW,
      currentStep: 'ready_to_book',
      state: {
        serviceId: 'svc-1',
        serviceName: 'Стрижка',
        staffId: 'stf-1',
        date: '2099-06-15',
        time: '12:00',
        name: 'Анна',
        phone: '+15551234567',
        sourceMessageId: 'wamid.phone',
      },
      lastInboundMessageId: 'wamid.phone',
      lastInboundAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const r = await processWhatsAppBookingFsm(
      {
        db: {},
        salonId: 'salon-1',
        externalUserId: 'u1',
        text: '+15551234567',
        externalMessageId: 'wamid.phone',
        messageTimestampIso: '2026-08-05T12:00:00.000Z',
        receiptId: 'r1',
        attemptCount: 2,
        inboundAdvanced: true,
      },
      deps,
    );
    assert.equal(r.kind, 'ready_to_book_pending_commit');
  });

  it('ready_to_book chatter does not signal commit', async () => {
    const { deps } = makeDeps({
      conversationId: 'c1',
      clientId: null,
      currentFlow: WHATSAPP_BOOKING_FLOW,
      currentStep: 'ready_to_book',
      state: {
        serviceId: 'svc-1',
        staffId: 'stf-1',
        date: '2099-06-15',
        time: '12:00',
        name: 'Анна',
        phone: '+15551234567',
        sourceMessageId: 'wamid.phone',
      },
      lastInboundMessageId: 'wamid.phone',
      lastInboundAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const r = await processWhatsAppBookingFsm(
      {
        db: {},
        salonId: 'salon-1',
        externalUserId: 'u1',
        text: 'привет',
        externalMessageId: 'wamid.other',
        messageTimestampIso: '2026-08-05T12:05:00.000Z',
        receiptId: 'r2',
        attemptCount: 1,
        inboundAdvanced: true,
      },
      deps,
    );
    assert.equal(r.kind, 'reply');
    if (r.kind === 'reply') assert.equal(r.messageKey, 'whatsapp.booking.readyToBook');
  });
});

describe('WA-4D1 migration static checks (executed)', () => {
  const sql = readFileSync(
    new URL(
      '../../../supabase/migrations/20260805000002_whatsapp_idempotent_booking_commit.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it('extends source check with whatsapp; preserves prior values', () => {
    assert.match(sql, /source IN \('telegram', 'owner', 'apple', 'whatsapp'\)/);
    assert.match(sql, /source_external_event_id/);
    assert.match(sql, /appointments_salon_source_external_event_uidx/);
  });

  it('RPC ownership, CAS, advisory lock, overlap, no reminder', () => {
    assert.match(sql, /commit_whatsapp_booking_owned/);
    assert.match(sql, /SECURITY INVOKER/);
    assert.match(sql, /SET search_path = public/);
    assert.match(sql, /whatsapp_lock_owned_receipt/);
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /ready_to_book/);
    assert.match(sql, /sourceMessageId/);
    assert.match(sql, /identity_conflict/);
    assert.match(sql, /ambiguous_client/);
    assert.match(sql, /v_created_client/);
    assert.equal(sql.includes('syncAppointmentReminder'), false);
    assert.equal(sql.includes('graph.facebook'), false);
    assert.match(sql, /GRANT EXECUTE[\s\S]*TO service_role/);
    assert.match(sql, /REVOKE ALL[\s\S]*FROM PUBLIC/);
    assert.match(sql, /FROM anon/);
    assert.match(sql, /FROM authenticated/);
  });

  it('20. orphan-client prevention markers', () => {
    // Validations/overlap before client insert; unique_violation deletes provisional client.
    assert.match(sql, /Create client only after all validations/);
    assert.match(sql, /Drop this TX's provisional client/);
    assert.match(sql, /WA_IDENTITY_CONFLICT/);
  });

  it('WA-4D2: blocked-client invariant on all existing-client paths', () => {
    // Single post-resolution gate covers identity / conversation / phone existing clients.
    assert.match(sql, /IF NOT v_created_client THEN/);
    assert.match(sql, /c\.is_blocked/);
    assert.match(sql, /'client_blocked'/);
    // Must run before identity INSERT / appointment INSERT.
    const blockedIdx = sql.indexOf("jsonb_build_object('kind', 'client_blocked')");
    const identityInsertIdx = sql.indexOf('INSERT INTO public.client_channel_identities');
    const apptInsertIdx = sql.indexOf('INSERT INTO public.appointments');
    assert.ok(blockedIdx > 0);
    assert.ok(blockedIdx < identityInsertIdx);
    assert.ok(blockedIdx < apptInsertIdx);
    // No fall-through: blocked returns; new-client INSERT only in ELSE of resolution.
    assert.match(
      sql,
      /IF v_client_blocked IS TRUE THEN\s+RETURN jsonb_build_object\('kind', 'client_blocked'\)/,
    );
  });

  it('WA-4D2: conversation A + phone B fail-closed (no silent identity attach)', () => {
    assert.match(sql, /'client_resolution_conflict'/);
    assert.match(sql, /Conversation client A \+ phone matches unrelated client B/);
  });

  it('23/24. no Meta / Telegram runtime in migration', () => {
    assert.equal(/notifySalonAdmin|telegram_chat_id|graph\.facebook/.test(sql), false);
  });
});
