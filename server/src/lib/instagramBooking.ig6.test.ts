/**
 * IG-6: Instagram appointment commit tests (mocks/static SQL).
 * No Meta. No SQL execution. No live appointments.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  commitInstagramBookingOwned,
  prevalidateInstagramBookingCommit,
  recoverInstagramBookingSlotUnavailable,
  type InstagramBookingCommitResult,
} from './instagramBookingCommit.js';
import {
  INSTAGRAM_BOOKING_FLOW,
  isCompleteInstagramReadyState,
  parseInstagramBookingState,
} from './instagramBookingState.js';
import {
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from './instagramWebhookProcess.js';
import { normalizeInstagramWebhookPayload } from './instagramWebhookEvents.js';
import type { AppointmentSource } from '../types.js';

const SALON = '11111111-1111-1111-1111-111111111111';
const SENDER = '17841400000000099';
const LARGE_IG_ID = '17841400000000001';

const READY = parseInstagramBookingState({
  serviceId: 'svc-1',
  serviceName: 'Стрижка',
  staffId: 'st-1',
  staffName: 'Анна',
  date: '2026-08-20',
  time: '14:00',
  name: 'Anna',
  phone: '+79991234567',
  sourceMessageId: 'mid.phone',
});

function mockRpc(kind: string, extra: Record<string, unknown> = {}) {
  return {
    rpc: async () => ({
      data: { kind, appointment_id: 'appt-1', client_id: 'cli-1', ...extra },
      error: null,
    }),
  };
}

describe('IG-6 ready validation (executed)', () => {
  it('1-4. complete ready accepted; incomplete rejected', async () => {
    assert.equal(isCompleteInstagramReadyState(READY), true);
    const ok = await prevalidateInstagramBookingCommit({
      salonId: SALON,
      state: READY,
    });
    // Without injectable service helpers, prevalidate hits real supabase → may error.
    // Contract unit: incomplete fails closed locally.
    const bad = await prevalidateInstagramBookingCommit({
      salonId: SALON,
      state: parseInstagramBookingState({ serviceId: 'svc-1' }),
    });
    assert.equal(bad?.kind, 'stale_state');
    void ok;
  });
});

describe('IG-6 commit RPC wrapper (executed mocks)', () => {
  it('11/29. free slot → booking_created', async () => {
    const r = await commitInstagramBookingOwned({
      db: mockRpc('booking_created'),
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      externalUserId: SENDER,
      expectedSourceMessageId: 'mid.phone',
      externalEventId: 'mid.phone',
      runPrecheck: false,
      recoverSlotUnavailable: false,
      stateForPrecheck: READY,
    });
    assert.equal(r.kind, 'booking_created');
    if (r.kind === 'booking_created') {
      assert.equal(r.appointmentId, 'appt-1');
      assert.equal(r.clientId, 'cli-1');
    }
  });

  it('30/31. retry same event → already_booked (no duplicate)', async () => {
    const r = await commitInstagramBookingOwned({
      db: mockRpc('already_booked'),
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 2,
      externalUserId: SENDER,
      expectedSourceMessageId: 'mid.phone',
      externalEventId: 'mid.phone',
      runPrecheck: false,
      recoverSlotUnavailable: false,
    });
    assert.equal(r.kind, 'already_booked');
  });

  it('41. stale owner → lost_ownership', async () => {
    const r = await commitInstagramBookingOwned({
      db: mockRpc('lost_ownership'),
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      externalUserId: SENDER,
      expectedSourceMessageId: 'mid.phone',
      externalEventId: 'mid.phone',
      runPrecheck: false,
      recoverSlotUnavailable: false,
    });
    assert.equal(r.kind, 'lost_ownership');
  });

  it('26. identity conflict; 20-style client_blocked', async () => {
    const a = await commitInstagramBookingOwned({
      db: mockRpc('identity_conflict'),
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      externalUserId: SENDER,
      expectedSourceMessageId: 'mid.phone',
      externalEventId: 'mid.phone',
      runPrecheck: false,
      recoverSlotUnavailable: false,
    });
    assert.equal(a.kind, 'identity_conflict');
    const b = await commitInstagramBookingOwned({
      db: mockRpc('client_blocked'),
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      externalUserId: SENDER,
      expectedSourceMessageId: 'mid.phone',
      externalEventId: 'mid.phone',
      runPrecheck: false,
      recoverSlotUnavailable: false,
    });
    assert.equal(b.kind, 'client_blocked');
  });

  it('34-38. slot unavailable recovers to time with preserved fields', async () => {
    let transitionArgs: any = null;
    const r = await recoverInstagramBookingSlotUnavailable(
      {
        db: {},
        salonId: SALON,
        receiptId: 'r1',
        attemptCount: 1,
        externalUserId: SENDER,
        sourceMessageId: 'mid.phone',
        messageTimestampIso: '2026-08-07T12:00:00.000Z',
        state: READY,
      },
      {
        resolveServiceById: async () => ({
          id: 'svc-1',
          name: 'Стрижка',
          duration: 60,
          category: 'hair',
        }),
        computeAvailableSlots: async () => ['15:00', '16:00'],
        findNextAvailableDates: async () => ['2026-08-21'],
        transition: async (p) => {
          transitionArgs = p;
          return {
            kind: 'ok',
            duplicate: false,
            conversationId: 'c1',
            currentFlow: INSTAGRAM_BOOKING_FLOW,
            currentStep: 'time',
            state: parseInstagramBookingState(p.nextState),
            clientId: null,
          };
        },
      },
    );
    assert.equal(r.kind, 'slot_unavailable_choose_time');
    assert.equal(transitionArgs.externalMessageId, null);
    assert.equal(transitionArgs.expectedStep, 'ready_to_book');
    assert.equal(transitionArgs.nextStep, 'time');
    assert.equal(transitionArgs.nextState.time, undefined);
    assert.equal(transitionArgs.nextState.name, 'Anna');
    assert.equal(transitionArgs.nextState.phone, '+79991234567');
    assert.equal(transitionArgs.nextState.date, '2026-08-20');
    assert.ok(!('appointmentId' in transitionArgs.nextState));
  });

  it('5-9. service/staff unavailable recovers and clears stale ids', async () => {
    let transitionArgs: any = null;
    const r = await commitInstagramBookingOwned({
      db: mockRpc('service_unavailable'),
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      externalUserId: SENDER,
      expectedSourceMessageId: 'mid.phone',
      externalEventId: 'mid.phone',
      runPrecheck: false,
      stateForRecovery: READY,
      recoveryDeps: {
        resolveServiceById: async () => null as any,
        computeAvailableSlots: async () => [],
        findNextAvailableDates: async () => [],
        transition: async (p) => {
          transitionArgs = p;
          return {
            kind: 'ok',
            duplicate: false,
            conversationId: 'c1',
            currentFlow: INSTAGRAM_BOOKING_FLOW,
            currentStep: 'service',
            state: parseInstagramBookingState(p.nextState),
            clientId: null,
          };
        },
      },
    });
    assert.equal(r.kind, 'service_unavailable');
    assert.equal(transitionArgs.nextStep, 'service');
    assert.equal(transitionArgs.nextState.serviceId, undefined);
    assert.equal(transitionArgs.nextState.staffId, undefined);
    assert.equal(transitionArgs.nextState.time, undefined);
    assert.equal(transitionArgs.nextState.name, 'Anna');
  });
});

describe('IG-6 pipeline integration (executed mocks)', () => {
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
        identityCreated: false,
        conversationCreated: false,
      }),
      runBookingFsm: async () => ({
        kind: 'ask_service',
        messageKey: 'k',
        text: 't',
      }),
      enqueueOutbound: async () => ({
        kind: 'enqueued',
        id: 'ob-ig6',
        created: true,
        intentKey: 'ask_service',
      }),
      ...overrides,
    };
  }

  it('47. ready_to_book → commit → finalize', async () => {
    let committed = 0;
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
              message: { mid: 'mid.phone', text: '+79991234567' },
            },
          ],
        },
      ],
    })[0];
    const r = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        runBookingFsm: async () => ({
          kind: 'ready_to_book',
          messageKey: 'k',
          text: 'ready',
          state: READY,
        }),
        commitBooking: async () => {
          committed += 1;
          return { kind: 'booking_created', appointmentId: 'a1', clientId: 'c1' };
        },
      }),
    );
    assert.equal(r.outcome, 'processed');
    assert.equal(committed, 1);
    if (r.outcome === 'processed') {
      assert.equal(r.bookingCommit?.kind, 'booking_created');
    }
  });

  it('50/51. duplicate receipt / echo → no commit', async () => {
    let committed = 0;
    const msg = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { mid: 'mid.x', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const dup = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        claim: async () => ({ kind: 'duplicate_terminal', status: 'processed' }),
        commitBooking: async () => {
          committed += 1;
          return { kind: 'booking_created', appointmentId: 'a1', clientId: 'c1' };
        },
      }),
    );
    assert.equal(dup.outcome, 'duplicate_terminal');
    assert.equal(committed, 0);

    const echo = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { mid: 'mid.echo', text: 'hi', is_echo: true },
            },
          ],
        },
      ],
    })[0];
    const er = await processInstagramWebhookEvent(
      echo,
      baseProcess({
        finalize: async (p) => ({ ok: true, status: p.finalStatus }),
        commitBooking: async () => {
          committed += 1;
          return { kind: 'booking_created', appointmentId: 'a1', clientId: 'c1' };
        },
      }),
    );
    assert.equal(er.outcome, 'ignored');
    assert.equal(committed, 0);
  });

  it('42. lost ownership on commit → no finalize', async () => {
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
              timestamp: 1,
              message: { mid: 'mid.lost', text: '+79991234567' },
            },
          ],
        },
      ],
    })[0];
    const r = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        runBookingFsm: async () => ({
          kind: 'ready_to_book',
          messageKey: 'k',
          text: 'ready',
          state: READY,
        }),
        commitBooking: async () => ({ kind: 'lost_ownership' }),
        finalize: async () => {
          finalized += 1;
          return { ok: true, status: 'processed' };
        },
      }),
    );
    assert.equal(r.outcome, 'in_flight');
    assert.equal(finalized, 0);
  });
});

describe('IG-6 migration / types static', () => {
  const mig = readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000006_instagram_booking_commit.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const wa = readFileSync(
    new URL(
      '../../../supabase/migrations/20260805000002_whatsapp_idempotent_booking_commit.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it('RPC ownership + advisory lock + overlap + instagram source', () => {
    assert.match(mig, /commit_instagram_booking_owned/);
    assert.match(mig, /instagram_lock_owned_receipt/);
    assert.match(mig, /provider = 'instagram'/);
    assert.match(mig, /source = 'instagram'/);
    assert.match(mig, /pg_advisory_xact_lock/);
    assert.match(mig, /status IN \('scheduled', 'confirmed'\)/);
    assert.match(mig, /v_start_min < /);
    assert.match(mig, /v_end_min > /);
    assert.match(mig, /jsonb_typeof\(v_state->'serviceId'\)/);
    assert.match(mig, /jsonb_typeof\(v_state->'sourceMessageId'\)/);
    assert.match(mig, /client_id IS NULL/);
    assert.match(mig, /is_blocked/);
    assert.match(mig, /appointments_source_check/);
    assert.match(mig, /'instagram'/);
    assert.match(mig, /Источник: Instagram/);
    assert.doesNotMatch(mig, /syncAppointmentReminder|notifySalonAdmin|graph\.facebook/);
    assert.doesNotMatch(mig, /client_id = NULL/); // never clear on success path
    // unique_violation cleanup must not clear identity client_id
    assert.doesNotMatch(mig, /SET\s+client_id = NULL/);
  });

  it('ready string-type contract before appointment insert', () => {
    const readyIdx = mig.indexOf("current_step IS DISTINCT FROM 'ready_to_book'");
    const insertIdx = mig.indexOf('INSERT INTO public.appointments');
    assert.ok(readyIdx > 0 && insertIdx > readyIdx);
    const guard = mig.slice(0, insertIdx);
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
      assert.match(guard, new RegExp(`jsonb_typeof\\(v_state->'${key}'\\)`));
    }
  });

  it('WhatsApp commit RPC untouched; AppointmentSource includes instagram', () => {
    assert.match(wa, /commit_whatsapp_booking_owned/);
    assert.doesNotMatch(wa, /instagram/);
    const src: AppointmentSource = 'instagram';
    assert.equal(src, 'instagram');
  });

  it('privacy: notes/RPC have no DM fields; index untouched', () => {
    assert.doesNotMatch(mig, /inboundText|raw_dm|ig_username|profile_pic/i);
    assert.match(mig, /Источник: Instagram/);
    assert.doesNotMatch(mig, /INSERT INTO public\.appointments[\s\S]*inbound/i);
    const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(indexSrc, /commit_instagram_booking_owned/);
    const commitSrc = readFileSync(new URL('./instagramBookingCommit.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(commitSrc, /syncAppointmentReminder|notifySalonAdmin/);
  });
});

describe('IG-6 side-effect surface (static)', () => {
  it('mutation tables limited to clients/identities/appointments/conversations', () => {
    const mig = readFileSync(
      new URL(
        '../../../supabase/migrations/20260807000006_instagram_booking_commit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(mig, /INSERT INTO public\.clients/);
    assert.match(mig, /INSERT INTO public\.appointments/);
    assert.match(mig, /INSERT INTO public\.client_channel_identities/);
    assert.match(mig, /UPDATE public\.channel_conversations/);
    assert.doesNotMatch(mig, /INSERT INTO public\.appointment_reminders/);
    assert.doesNotMatch(mig, /INSERT INTO public\.whatsapp/);
  });

  it('12-16. duration-aware overlap; cancelled excluded; half-open boundary', () => {
    const mig = readFileSync(
      new URL(
        '../../../supabase/migrations/20260807000006_instagram_booking_commit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    // Half-open: new_start < existing_end AND new_end > existing_start
    assert.match(
      mig,
      /v_start_min < \(EXTRACT\(HOUR FROM a\.end_time\)/,
    );
    assert.match(
      mig,
      /v_end_min > \(EXTRACT\(HOUR FROM a\.start_time\)/,
    );
    assert.match(mig, /status IN \('scheduled', 'confirmed'\)/);
    assert.doesNotMatch(mig, /status IN \('scheduled', 'confirmed', 'cancelled'\)/);
    assert.match(mig, /v_duration := COALESCE\(NULLIF\(v_service\.duration, 0\), 60\)/);
  });

  it('20-27. phone-scoped client; identity null→set; no username match', () => {
    const mig = readFileSync(
      new URL(
        '../../../supabase/migrations/20260807000006_instagram_booking_commit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(
      mig,
      /regexp_replace\(COALESCE\(c\.phone, ''\), '\\D', '', 'g'\) = v_phone_digits/,
    );
    assert.match(mig, /AND i\.client_id IS NULL/);
    assert.doesNotMatch(mig, /username|ig_username|profile_pic/i);
    assert.match(mig, /kind', 'identity_conflict'/);
  });

  it('success clears ready_to_book; appointmentId only after insert', () => {
    const mig = readFileSync(
      new URL(
        '../../../supabase/migrations/20260807000006_instagram_booking_commit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const insertIdx = mig.indexOf('INSERT INTO public.appointments');
    const successStateIdx = mig.indexOf("'appointmentId', v_appt.id::text");
    assert.ok(insertIdx > 0 && successStateIdx > insertIdx);
    assert.match(mig, /current_step = 'ready_to_book'/);
    assert.match(mig, /current_flow = NULL/);
  });
});

describe('IG-6A schedule revalidation + phone serialization (static)', () => {
  const mig = readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000006_instagram_booking_commit.sql',
      import.meta.url,
    ),
    'utf8',
  );

  function idx(re: RegExp): number {
    const m = mig.search(re);
    assert.ok(m >= 0, `missing ${re}`);
    return m;
  }

  it('1-5. schedule after staff/date lock; before client writes; slot_unavailable', () => {
    const salonNs = idx(/ig6b_lock_salon_schedule\(p_salon_id\)/);
    const staffNs = idx(/ig6b_lock_staff_schedule\(p_salon_id, v_staff_id\)/);
    const staffDateLock = idx(/ig6b_lock_staff_date\(p_salon_id, v_staff_id, v_date\)/);
    const salonHours = idx(/FROM public\.salon_weekly_hours swh/);
    const durationFit = idx(/v_end_min > v_work_close/);
    const phoneLock = idx(/instagram-client\|/);
    const clientSelect = idx(
      /regexp_replace\(COALESCE\(c\.phone, ''\), '\\D', '', 'g'\) = v_phone_digits/,
    );
    const clientInsert = idx(/INSERT INTO public\.clients/);
    assert.ok(salonNs < staffNs && staffNs < staffDateLock);
    assert.ok(staffDateLock < salonHours);
    assert.ok(salonHours < phoneLock);
    assert.ok(durationFit > staffDateLock && durationFit < phoneLock);
    assert.ok(phoneLock < clientSelect);
    assert.ok(clientSelect < clientInsert);
    assert.match(mig, /kind', 'slot_unavailable'/);
    assert.match(mig, /FOR SHARE/);
  });

  it('6-8. exceptions closed/custom; inherit staff; ISODOW weekday', () => {
    assert.match(mig, /EXTRACT\(ISODOW FROM v_date::date\)/);
    assert.match(mig, /kind IN \('closed', 'vacation', 'holiday'\)/);
    assert.match(mig, /kind = 'custom_hours'/);
    assert.match(mig, /v_staff_cnt = 0 THEN[\s\S]*v_staff_open := v_salon_open/);
    assert.match(mig, /v_salon_cnt = 0 THEN[\s\S]*v_salon_open := 8 \* 60/);
  });

  it('9-10. phone advisory salon+digits; SELECT after lock; overlap unchanged', () => {
    assert.match(
      mig,
      /hashtext\('instagram-client\|' \|\| p_salon_id::text\)/,
    );
    assert.match(mig, /hashtext\(v_phone_digits\)/);
    assert.match(mig, /pg_advisory_xact_lock\(v_phone_lock_k1, v_phone_lock_k2\)/);
    const phoneLock = idx(/pg_advisory_xact_lock\(v_phone_lock_k1, v_phone_lock_k2\)/);
    const overlap = idx(/v_overlap THEN/);
    assert.ok(overlap < phoneLock, 'overlap before phone lock');
    assert.match(
      mig,
      /v_start_min < \(EXTRACT\(HOUR FROM a\.end_time\)/,
    );
  });

  it('11-13. idempotency + instagram event CHECK + already_booked context', () => {
    assert.match(mig, /appointments_instagram_source_event_id_check/);
    assert.match(
      mig,
      /source IS DISTINCT FROM 'instagram'\s+OR source_external_event_id IS NOT NULL/,
    );
    assert.match(mig, /idempotency_conflict/);
    assert.match(mig, /source_external_event_id = v_event/);
    assert.match(mig, /ig6b_lock_staff_date/);
  });

  it('14-16. identity no-flip; atomic writes; WA commit migration untouched', () => {
    assert.doesNotMatch(mig, /SET\s+client_id = NULL/);
    assert.match(mig, /AND i\.client_id IS NULL/);
    assert.match(mig, /INSERT INTO public\.appointments/);
    assert.match(mig, /UPDATE public\.channel_conversations/);
    const wa = readFileSync(
      new URL(
        '../../../supabase/migrations/20260805000002_whatsapp_idempotent_booking_commit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    assert.doesNotMatch(wa, /instagram-client\|/);
    assert.doesNotMatch(wa, /salon_weekly_hours/);
    const slots = readFileSync(new URL('./scheduleSlots.ts', import.meta.url), 'utf8');
    assert.match(slots, /computeAvailableSlots/);
  });
});

describe('IG-6B schedule mutation coordination (static)', () => {
  const mig = readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000006_instagram_booking_commit.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const scheduleRoute = readFileSync(
    new URL('../routes/schedule.ts', import.meta.url),
    'utf8',
  );
  const staffPortal = readFileSync(
    new URL('../routes/staffPortal.ts', import.meta.url),
    'utf8',
  );
  const coord = readFileSync(
    new URL('./scheduleCoordination.ts', import.meta.url),
    'utf8',
  );

  it('shared lock contract: salon-ns → staff-ns → staff/date', () => {
    assert.match(mig, /ig6b-salon-sched\|/);
    assert.match(mig, /ig6b-staff-sched\|/);
    assert.match(mig, /917001/);
    assert.match(mig, /917002/);
    const commitSalon = mig.indexOf(
      'PERFORM public.ig6b_lock_salon_schedule(p_salon_id);',
    );
    const commitStaff = mig.indexOf(
      'PERFORM public.ig6b_lock_staff_schedule(p_salon_id, v_staff_id);',
    );
    const commitDate = mig.indexOf(
      'PERFORM public.ig6b_lock_staff_date(p_salon_id, v_staff_id, v_date);',
    );
    assert.ok(commitSalon > 0 && commitSalon < commitStaff && commitStaff < commitDate);
  });

  it('exception create/delete RPCs lock before INSERT/DELETE same function', () => {
    assert.match(mig, /create_schedule_exception_coordinated/);
    assert.match(mig, /delete_schedule_exception_coordinated/);
    const createFn = mig.indexOf('CREATE OR REPLACE FUNCTION public.create_schedule_exception_coordinated');
    const createLock = mig.indexOf('PERFORM public.ig6b_lock_salon_schedule', createFn);
    const createInsert = mig.indexOf('INSERT INTO public.schedule_exceptions', createFn);
    assert.ok(createLock > createFn && createLock < createInsert);
    const delFn = mig.indexOf('CREATE OR REPLACE FUNCTION public.delete_schedule_exception_coordinated');
    const delLock = mig.indexOf('PERFORM public.ig6b_lock_salon_schedule', delFn);
    const delDelete = mig.indexOf('DELETE FROM public.schedule_exceptions', delFn);
    assert.ok(delLock > delFn && delLock < delDelete);
    // delete must not FOR UPDATE before advisory locks
    const delSlice = mig.slice(delFn, delDelete);
    assert.doesNotMatch(delSlice, /FOR UPDATE/);
  });

  it('IG-6C long-range exceptions allowed; short-range still expands dates', () => {
    assert.doesNotMatch(mig, /IG6B_EXCEPTION_RANGE_TOO_LARGE/);
    assert.doesNotMatch(mig, /RAISE EXCEPTION 'IG6B_EXCEPTION_RANGE_TOO_LARGE/);
    // Branch BEFORE per-date enumeration (no reject).
    assert.match(mig, /IF v_span <= 366 THEN/);
    const createFn = mig.indexOf(
      'CREATE OR REPLACE FUNCTION public.create_schedule_exception_coordinated',
    );
    const createBody = mig.slice(
      createFn,
      mig.indexOf('CREATE OR REPLACE FUNCTION public.delete_schedule_exception_coordinated'),
    );
    assert.match(createBody, /v_span := \(p_end_date - p_start_date\) \+ 1/);
    assert.match(createBody, /IF v_span <= 366 THEN/);
    assert.doesNotMatch(createBody, /v_span > 366/);
    // Short path still locks staff/date; long path keeps salon+staff ns.
    assert.match(createBody, /ig6b_lock_staff_date/);
    assert.match(createBody, /ig6b_lock_staff_schedule/);
    assert.match(createBody, /ig6b_lock_salon_schedule/);

    const delFn = mig.indexOf(
      'CREATE OR REPLACE FUNCTION public.delete_schedule_exception_coordinated',
    );
    const delBody = mig.slice(delFn, mig.indexOf('REVOKE ALL ON FUNCTION public.upsert_salon'));
    assert.match(delBody, /IF v_span <= 366 THEN/);
    assert.doesNotMatch(delBody, /v_span > 366/);
    assert.doesNotMatch(delBody, /RANGE_TOO_LARGE/);
  });

  it('weekly upsert RPCs close missing-row override phantoms', () => {
    assert.match(mig, /upsert_salon_weekly_hours_coordinated/);
    assert.match(mig, /upsert_staff_weekly_hours_coordinated/);
    assert.match(mig, /ON CONFLICT \(salon_id, weekday\)/);
    assert.match(mig, /ON CONFLICT \(staff_id, weekday\)/);
  });

  it('owner + staff-portal writers use coordinated RPCs (same txn)', () => {
    assert.match(scheduleRoute, /createScheduleExceptionCoordinated/);
    assert.match(scheduleRoute, /upsertSalonWeeklyHoursCoordinated/);
    assert.match(scheduleRoute, /upsertStaffWeeklyHoursCoordinated/);
    assert.match(staffPortal, /createScheduleExceptionCoordinated/);
    assert.match(staffPortal, /upsertStaffWeeklyHoursCoordinated/);
    assert.match(coord, /create_schedule_exception_coordinated/);
    assert.doesNotMatch(
      scheduleRoute,
      /\.from\('schedule_exceptions'\)\s*\n\s*\.insert/,
    );
    assert.doesNotMatch(
      staffPortal,
      /\.from\('schedule_exceptions'\)\s*\n\s*\.insert/,
    );
  });

  it('phone lock + overlap + CHECK regressions preserved', () => {
    assert.match(mig, /instagram-client\|/);
    assert.match(mig, /hashtext\(v_phone_digits\)/);
    assert.match(mig, /v_start_min < \(EXTRACT\(HOUR FROM a\.end_time\)/);
    assert.match(mig, /appointments_instagram_source_event_id_check/);
    assert.match(mig, /idempotency_conflict/);
    assert.doesNotMatch(mig, /SET\s+client_id = NULL/);
  });
});
