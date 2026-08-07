/**
 * IG-7: Instagram durable outbound outbox tests.
 * No Meta. No SQL execution. No real sends.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  INSTAGRAM_GRAPH_API_VERSION,
} from './instagramApi.js';
import {
  buildInstagramSendMessageUrl,
  parseInstagramMessagingOpaqueId,
  sendInstagramTextMessage,
} from './instagramMessagingApi.js';
import {
  claimInstagramOutboundMessage,
  enqueueInstagramOutboundOwned,
  finalizeInstagramOutboundFailure,
  finalizeInstagramOutboundSent,
  flushInstagramOutboundMessage,
  INSTAGRAM_OUTBOUND_BACKOFF_MINUTES,
  INSTAGRAM_OUTBOUND_MAX_ATTEMPTS,
  nextInstagramOutboundAttemptAt,
  resolveInstagramOutboundConnection,
} from './instagramOutbound.js';
import { enqueueInstagramOutboundThenFinalizeInbound } from './instagramOutboundGate.js';
import {
  INSTAGRAM_OUTBOUND_INTENT_KEYS,
  INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS,
  appendOutboundOptions,
  clampInstagramOutboundText,
  resolveInstagramOutboundIntent,
  toInstagramOutboundPayload,
} from './instagramOutboundIntent.js';
import {
  getInstagramOutboundWorkerDebugState,
  isInstagramOutboundEnabled,
  runInstagramOutboundBatch,
  startInstagramOutboundWorker,
  stopInstagramOutboundWorker,
} from './instagramOutboundWorker.js';
import {
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from './instagramWebhookProcess.js';
import { normalizeInstagramWebhookPayload } from './instagramWebhookEvents.js';
import { parseInstagramBookingState } from './instagramBookingState.js';

const SALON = '11111111-1111-1111-1111-111111111111';
const SENDER = '17841400000000099';
const LARGE_IG_ID = '17841400000000001';
const LARGE_RECIPIENT = '9007199254740993'; // > Number.MAX_SAFE_INTEGER as string digit sequence
const SOURCE = 'mid.ig7.source.1';

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

function migSql(): string {
  return readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000007_instagram_outbound.sql',
      import.meta.url,
    ),
    'utf8',
  );
}

function baseIntent(
  overrides: Partial<ReturnType<typeof resolveInstagramOutboundIntent>> = {},
) {
  return {
    kind: 'ask_service' as const,
    text: 'На какую услугу хотите записаться?',
    sourceEventId: SOURCE,
    recipientExternalUserId: SENDER,
    professionalAccountId: LARGE_IG_ID,
    ...overrides,
  };
}

describe('IG-7 migration static contract', () => {
  const mig = migSql();

  it('outbox table + unique dedupe + no token columns', () => {
    assert.match(mig, /CREATE TABLE IF NOT EXISTS public\.instagram_outbound_messages/);
    assert.match(
      mig,
      /UNIQUE \(salon_id, source_event_id, intent_key\)/,
    );
    assert.match(mig, /provider = 'instagram'/);
    assert.match(mig, /status IN \('pending', 'claimed', 'sent', 'failed'\)/);
    assert.match(mig, /provider_message_id/);
    assert.match(mig, /claim_token/);
    assert.match(mig, /attempt_count/);
    assert.match(mig, /next_attempt_at/);
    // Reject storing ciphertext columns; payload gate may mention access_token key name.
    assert.doesNotMatch(mig, /token_ciphertext|access_token_iv|access_token_auth_tag/);
    const tableBlock = mig.slice(
      mig.indexOf('CREATE TABLE IF NOT EXISTS public.instagram_outbound_messages'),
      mig.indexOf('COMMENT ON TABLE public.instagram_outbound_messages'),
    );
    assert.doesNotMatch(tableBlock, /access_token/);
  });

  it('owned enqueue + claim/finalize RPCs', () => {
    assert.match(mig, /enqueue_instagram_outbound_owned/);
    assert.match(mig, /instagram_lock_owned_receipt/);
    assert.match(mig, /claim_instagram_outbound_message/);
    assert.match(mig, /finalize_instagram_outbound_sent/);
    assert.match(mig, /finalize_instagram_outbound_failure/);
    assert.match(mig, /ON CONFLICT \(salon_id, source_event_id, intent_key\) DO NOTHING/);
    assert.match(mig, /forbidden_payload/);
    assert.match(mig, /lost_ownership/);
    assert.match(mig, /claim_token = p_claim_token/);
  });

  it('WhatsApp outbox / Telegram untouched in IG-7 migration', () => {
    assert.doesNotMatch(mig, /whatsapp_outbound_messages/);
    assert.doesNotMatch(mig, /claim_whatsapp/);
    assert.doesNotMatch(mig, /CREATE TABLE[\s\S]*telegram|ALTER TABLE[\s\S]*telegram/i);
    assert.doesNotMatch(mig, /caldav/i);
    assert.match(mig, /Does NOT send Meta messages.*Telegram\/Apple\/WhatsApp/);
  });
});

describe('IG-7 owned enqueue (executed mocks)', () => {
  it('1. current receipt owner enqueue succeeds', async () => {
    const db = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, 'enqueue_instagram_outbound_owned');
        assert.equal(args.p_salon_id, SALON);
        assert.equal(args.p_attempt_count, 2);
        assert.equal(args.p_source_event_id, SOURCE);
        assert.equal(args.p_intent_key, 'ask_service');
        assert.equal((args.p_payload as { text: string }).text.includes('услуг'), true);
        return {
          data: {
            kind: 'enqueued',
            id: 'ob-1',
            created: true,
            intent_key: 'ask_service',
            source_event_id: SOURCE,
          },
          error: null,
        };
      },
    };
    const r = await enqueueInstagramOutboundOwned({
      db,
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 2,
      intent: baseIntent(),
    });
    assert.equal(r.kind, 'enqueued');
    if (r.kind === 'enqueued') {
      assert.equal(r.created, true);
      assert.equal(r.id, 'ob-1');
    }
  });

  it('2. stale receipt owner no enqueue', async () => {
    const r = await enqueueInstagramOutboundOwned({
      db: {
        rpc: async () => ({ data: { kind: 'lost_ownership' }, error: null }),
      },
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      intent: baseIntent(),
    });
    assert.equal(r.kind, 'lost_ownership');
  });

  it('3. duplicate source event+intent dedupes', async () => {
    const r = await enqueueInstagramOutboundOwned({
      db: {
        rpc: async () => ({
          data: {
            kind: 'enqueued',
            id: 'ob-1',
            created: false,
            intent_key: 'ask_service',
            source_event_id: SOURCE,
          },
          error: null,
        }),
      },
      salonId: SALON,
      receiptId: 'r2',
      attemptCount: 2,
      intent: baseIntent(),
    });
    assert.equal(r.kind, 'enqueued');
    if (r.kind === 'enqueued') assert.equal(r.created, false);
  });

  it('4. crash after enqueue before finalize → retry one row (gate)', async () => {
    let enqueues = 0;
    let finalizes = 0;
    const intent = baseIntent({ kind: 'booked', text: 'Запись подтверждена' });
    const first = await enqueueInstagramOutboundThenFinalizeInbound({
      pendingIntent: intent,
      enqueue: async () => {
        enqueues += 1;
        return { kind: 'enqueued', id: 'ob-x', created: true, intentKey: 'booked' };
      },
      finalizeInbound: async () => {
        finalizes += 1;
        throw new Error('crash_before_ack');
      },
    }).catch((e: Error) => e);
    assert.ok(first instanceof Error);
    assert.equal(enqueues, 1);

    const second = await enqueueInstagramOutboundThenFinalizeInbound({
      pendingIntent: intent,
      enqueue: async () => {
        enqueues += 1;
        return { kind: 'enqueued', id: 'ob-x', created: false, intentKey: 'booked' };
      },
      finalizeInbound: async () => {
        finalizes += 1;
        return { ok: true as const, status: 'processed' as const };
      },
    });
    assert.equal(second.kind, 'finalized');
    if (second.kind === 'finalized') {
      assert.equal(second.created, false);
      assert.equal(second.outboxMessageId, 'ob-x');
    }
    assert.equal(enqueues, 2);
    assert.equal(finalizes, 2);
  });

  it('5. no-id / empty source event cannot enqueue', async () => {
    const r = await enqueueInstagramOutboundOwned({
      db: { rpc: async () => ({ data: null, error: null }) },
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 1,
      intent: baseIntent({ sourceEventId: '   ' }),
    });
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.equal(r.code, 'malformed_enqueue');
  });

  it('6. provider hardcoded Instagram in migration + payload', () => {
    assert.match(migSql(), /DEFAULT 'instagram'/);
    assert.match(migSql(), /VALUES \(\s*p_salon_id,\s*'instagram'/);
    const payload = toInstagramOutboundPayload(baseIntent());
    assert.deepEqual(payload, {
      text: 'На какую услугу хотите записаться?',
    });
    assert.ok(!('provider' in payload));
  });
});

describe('IG-7 outbox claim CAS (executed mocks)', () => {
  it('7. pending claim', async () => {
    const r = await claimInstagramOutboundMessage({
      db: {
        rpc: async () => ({
          data: {
            kind: 'claimed',
            id: 'ob-1',
            salon_id: SALON,
            provider: 'instagram',
            professional_account_id: LARGE_IG_ID,
            external_user_id: SENDER,
            source_event_id: SOURCE,
            inbound_receipt_id: 'r1',
            intent_key: 'ask_service',
            payload: { text: 'hi' },
            attempt_count: 1,
            claim_token: 'tok-a',
          },
          error: null,
        }),
      },
      messageId: 'ob-1',
    });
    assert.equal(r.kind, 'claimed');
    if (r.kind === 'claimed') {
      assert.equal(r.claimToken, 'tok-a');
      assert.equal(r.row.attempt_count, 1);
    }
  });

  it('8. fresh processing in-flight → not_claimable', async () => {
    const r = await claimInstagramOutboundMessage({
      db: {
        rpc: async () => ({ data: { kind: 'not_claimable' }, error: null }),
      },
      messageId: 'ob-1',
    });
    assert.equal(r.kind, 'not_claimable');
  });

  it('9. stale processing reclaim increments generation', async () => {
    const r = await claimInstagramOutboundMessage({
      db: {
        rpc: async () => ({
          data: {
            kind: 'claimed',
            id: 'ob-1',
            salon_id: SALON,
            provider: 'instagram',
            professional_account_id: LARGE_IG_ID,
            external_user_id: SENDER,
            source_event_id: SOURCE,
            inbound_receipt_id: 'r1',
            intent_key: 'ask_service',
            payload: { text: 'hi' },
            attempt_count: 3,
            claim_token: 'tok-b',
          },
          error: null,
        }),
      },
      messageId: 'ob-1',
    });
    assert.equal(r.kind, 'claimed');
    if (r.kind === 'claimed') assert.equal(r.row.attempt_count, 3);
  });

  it('10. stale worker sent finalize rejected', async () => {
    const r = await finalizeInstagramOutboundSent({
      db: {
        rpc: async () => ({ data: { kind: 'lost_claim' }, error: null }),
      },
      messageId: 'ob-1',
      claimToken: 'stale',
      providerMessageId: 'mid.out.1',
    });
    assert.equal(r, 'lost_claim');
  });

  it('11. stale worker failure rejected', async () => {
    const r = await finalizeInstagramOutboundFailure({
      db: {
        rpc: async () => ({ data: { kind: 'lost_claim' }, error: null }),
      },
      messageId: 'ob-1',
      claimToken: 'stale',
      errorCode: 'rate_limited',
      retryable: true,
      attemptCount: 2,
    });
    assert.equal(r, 'lost_claim');
  });

  it('12. current generation sent succeeds', async () => {
    const r = await finalizeInstagramOutboundSent({
      db: {
        rpc: async (_n: string, args: Record<string, unknown>) => {
          assert.equal(args.p_provider_message_id, 'mid.out.ok');
          return {
            data: { kind: 'sent', id: 'ob-1', provider_message_id: 'mid.out.ok' },
            error: null,
          };
        },
      },
      messageId: 'ob-1',
      claimToken: 'tok-a',
      providerMessageId: 'mid.out.ok',
    });
    assert.equal(r, 'sent');
  });
});

describe('IG-7 response intents', () => {
  const common = {
    sourceEventId: SOURCE,
    recipientExternalUserId: SENDER,
    professionalAccountId: LARGE_IG_ID,
  };

  it('13-18. ask_* intents', () => {
    for (const kind of [
      'ask_service',
      'ask_staff',
      'ask_date',
      'ask_time',
      'ask_name',
      'ask_phone',
    ] as const) {
      const r = resolveInstagramOutboundIntent({
        ...common,
        bookingIntent: {
          kind,
          messageKey: `k.${kind}`,
          text: `text-${kind}`,
          options:
            kind === 'ask_service'
              ? [{ id: 'service:1', label: '1. Cut' }]
              : undefined,
        },
      });
      assert.ok(r);
      assert.equal(r!.kind, kind);
      assert.match(r!.text, new RegExp(`text-${kind}`));
      if (kind === 'ask_service') assert.match(r!.text, /1\. Cut/);
    }
  });

  it('19. invalid_input keeps step text', () => {
    const r = resolveInstagramOutboundIntent({
      ...common,
      bookingIntent: {
        kind: 'invalid_input',
        messageKey: 'k',
        text: 'Некорректный телефон.',
      },
    });
    assert.equal(r?.kind, 'invalid_input');
    assert.match(r!.text, /телефон/i);
  });

  it('20. slot_unavailable', () => {
    const r = resolveInstagramOutboundIntent({
      ...common,
      bookingCommit: {
        kind: 'slot_unavailable_choose_time',
        date: '2026-08-20',
        options: [{ id: 'time:15:00', label: '15:00' }],
      },
    });
    assert.equal(r?.kind, 'slot_unavailable');
    assert.match(r!.text, /занято|время/i);
    assert.match(r!.text, /15:00/);
  });

  it('21. booked confirmation', () => {
    const r = resolveInstagramOutboundIntent({
      ...common,
      bookingIntent: {
        kind: 'ready_to_book',
        messageKey: 'k',
        text: 'ready',
        state: READY,
      },
      bookingCommit: {
        kind: 'booking_created',
        appointmentId: 'a1',
        clientId: 'c1',
      },
    });
    assert.equal(r?.kind, 'booked');
    assert.match(r!.text, /Стрижка/);
    assert.match(r!.text, /Анна/);
    assert.match(r!.text, /2026-08-20/);
    assert.match(r!.text, /14:00/);
    assert.doesNotMatch(r!.text, /\+7999|appt-1|a1|c1/);
  });

  it('22. already_booked dedupe intent key booked', () => {
    const r = resolveInstagramOutboundIntent({
      ...common,
      bookingIntent: {
        kind: 'ready_to_book',
        messageKey: 'k',
        text: 'ready',
        state: READY,
      },
      bookingCommit: {
        kind: 'already_booked',
        appointmentId: 'a1',
        clientId: 'c1',
      },
    });
    assert.equal(r?.kind, 'booked');
  });

  it('23. identity conflict generic safe message', () => {
    const r = resolveInstagramOutboundIntent({
      ...common,
      bookingCommit: { kind: 'identity_conflict' },
    });
    assert.equal(r?.kind, 'manual_review');
    assert.doesNotMatch(r!.text, /client|uuid|phone|\+7/i);
    assert.match(r!.text, /вручную|салон/i);
  });

  it('24. echo / noop → no intent', () => {
    assert.equal(
      resolveInstagramOutboundIntent({
        ...common,
        bookingIntent: { kind: 'noop', reason: 'echo' },
      }),
      null,
    );
    assert.equal(
      resolveInstagramOutboundIntent({
        ...common,
        bookingIntent: {
          kind: 'ready_to_book',
          messageKey: 'k',
          text: 'ready',
          state: READY,
        },
      }),
      null,
    );
  });

  it('intent keys stable set + clamp', () => {
    assert.deepEqual(
      [...INSTAGRAM_OUTBOUND_INTENT_KEYS].sort(),
      [
        'ask_date',
        'ask_name',
        'ask_phone',
        'ask_service',
        'ask_staff',
        'ask_time',
        'booked',
        'invalid_input',
        'manual_review',
        'slot_unavailable',
      ],
    );
    const long = 'x'.repeat(INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS + 50);
    assert.equal(clampInstagramOutboundText(long).length, INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS);
    assert.equal(appendOutboundOptions('Hi', [{ id: 'a', label: '1. A' }]), 'Hi\n1. A');
  });
});

describe('IG-7 Meta messaging client', () => {
  it('25-28. endpoint, professional account, recipient string preserved', async () => {
    let sawUrl = '';
    let sawBody: any = null;
    let sawAuth = '';
    const r = await sendInstagramTextMessage({
      accessToken: 'secret-token-value',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: LARGE_RECIPIENT,
      text: 'Привет',
      fetchImpl: async (url, init) => {
        sawUrl = String(url);
        sawAuth = String((init as RequestInit)?.headers &&
          ((init as any).headers.Authorization ?? ''));
        sawBody = JSON.parse(String((init as RequestInit).body));
        return {
          status: 200,
          json: async () => ({
            recipient_id: LARGE_RECIPIENT,
            message_id: 'mid.out.large',
          }),
        } as Response;
      },
    });
    assert.equal(r.kind, 'sent');
    if (r.kind === 'sent') assert.equal(r.providerMessageId, 'mid.out.large');
    assert.equal(
      sawUrl,
      `https://graph.instagram.com/${INSTAGRAM_GRAPH_API_VERSION}/${encodeURIComponent(LARGE_IG_ID)}/messages`,
    );
    assert.equal(sawBody.recipient.id, LARGE_RECIPIENT);
    assert.equal(typeof sawBody.recipient.id, 'string');
    assert.equal(sawBody.message.text, 'Привет');
    assert.match(sawAuth, /Bearer /);
    assert.equal(
      buildInstagramSendMessageUrl(LARGE_IG_ID),
      sawUrl,
    );
  });

  it('29. numeric recipient rejected', async () => {
    const r = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: 12345 as unknown as string,
      text: 'x',
    });
    assert.equal(r.kind, 'permanent_error');
    if (r.kind === 'permanent_error') assert.equal(r.code, 'numeric_id_rejected');
    assert.equal(parseInstagramMessagingOpaqueId(12345, 'recipient'), null);
  });

  it('30. token not logged (source static)', () => {
    const src = readFileSync(new URL('./instagramMessagingApi.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /console\.(log|info|debug|error).*accessToken/);
    assert.doesNotMatch(src, /console\.(log|info|debug).*body/);
    assert.match(src, /Never logs tokens/);
  });

  it('31-32. message id string preserved; numeric rejected', async () => {
    const ok = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: SENDER,
      text: 'x',
      fetchImpl: async () =>
        ({
          status: 200,
          json: async () => ({ message_id: 'mid.str.1' }),
        }) as Response,
    });
    assert.equal(ok.kind, 'sent');

    const bad = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: SENDER,
      text: 'x',
      fetchImpl: async () =>
        ({
          status: 200,
          json: async () => ({ message_id: 9007199254740993 }),
        }) as Response,
    });
    assert.equal(bad.kind, 'permanent_error');
    if (bad.kind === 'permanent_error') assert.equal(bad.code, 'numeric_id_rejected');
  });

  it('33-35. timeout ambiguous; 429/5xx retryable', async () => {
    const timeout = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: SENDER,
      text: 'x',
      fetchImpl: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    assert.equal(timeout.kind, 'ambiguous_outcome');
    if (timeout.kind === 'ambiguous_outcome') {
      assert.equal(timeout.code, 'timeout_post_send');
    }

    const rate = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: SENDER,
      text: 'x',
      fetchImpl: async () =>
        ({ status: 429, json: async () => ({}) }) as Response,
    });
    assert.equal(rate.kind, 'retryable_error');
    if (rate.kind === 'retryable_error') assert.equal(rate.code, 'rate_limited');

    const s5 = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: SENDER,
      text: 'x',
      fetchImpl: async () =>
        ({ status: 503, json: async () => ({}) }) as Response,
    });
    assert.equal(s5.kind, 'retryable_error');
    if (s5.kind === 'retryable_error') assert.equal(s5.code, 'provider_5xx');
  });

  it('36-37. auth permanent; malformed response safe', async () => {
    const auth = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: SENDER,
      text: 'x',
      fetchImpl: async () =>
        ({ status: 401, json: async () => ({ error: { message: 'nope' } }) }) as Response,
    });
    assert.equal(auth.kind, 'permanent_error');
    if (auth.kind === 'permanent_error') assert.equal(auth.code, 'invalid_credentials');

    const mal = await sendInstagramTextMessage({
      accessToken: 't',
      professionalAccountId: LARGE_IG_ID,
      recipientExternalUserId: SENDER,
      text: 'x',
      fetchImpl: async () =>
        ({ status: 200, json: async () => ({}) }) as Response,
    });
    assert.equal(mal.kind, 'permanent_error');
    if (mal.kind === 'permanent_error') assert.equal(mal.code, 'malformed_response');
  });
});

describe('IG-7 worker', () => {
  it('38. disabled worker sends nothing', async () => {
    stopInstagramOutboundWorker();
    assert.equal(isInstagramOutboundEnabled({} as NodeJS.ProcessEnv), false);
    const handle = startInstagramOutboundWorker({
      db: {
        from: () => {
          throw new Error('should_not_query');
        },
      },
      enabled: false,
      runImmediately: true,
    });
    assert.equal(handle.started, false);
    assert.equal(handle.enabled, false);
    assert.equal(getInstagramOutboundWorkerDebugState().hasInterval, false);
  });

  it('39. no credentials → failed terminal (no send)', async () => {
    const r = await flushInstagramOutboundMessage({
      db: {
        rpc: async (name: string) => {
          if (name === 'claim_instagram_outbound_message') {
            return {
              data: {
                kind: 'claimed',
                id: 'ob-1',
                salon_id: SALON,
                provider: 'instagram',
                professional_account_id: LARGE_IG_ID,
                external_user_id: SENDER,
                source_event_id: SOURCE,
                inbound_receipt_id: 'r1',
                intent_key: 'ask_service',
                payload: { text: 'hi' },
                attempt_count: 1,
                claim_token: 'tok',
              },
              error: null,
            };
          }
          if (name === 'finalize_instagram_outbound_failure') {
            return { data: { kind: 'failed' }, error: null };
          }
          return { data: null, error: { message: 'unexpected' } };
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      },
    });
    assert.equal(r.kind, 'failed');
    if (r.kind === 'failed') assert.equal(r.code, 'connection_missing');
  });

  it('40. claim → send → sent', async () => {
    const r = await flushInstagramOutboundMessage({
      db: {
        rpc: async (name: string) => {
          if (name === 'claim_instagram_outbound_message') {
            return {
              data: {
                kind: 'claimed',
                id: 'ob-1',
                salon_id: SALON,
                provider: 'instagram',
                professional_account_id: LARGE_IG_ID,
                external_user_id: SENDER,
                source_event_id: SOURCE,
                inbound_receipt_id: 'r1',
                intent_key: 'ask_service',
                payload: { text: 'hi' },
                attempt_count: 1,
                claim_token: 'tok',
              },
              error: null,
            };
          }
          if (name === 'finalize_instagram_outbound_sent') {
            return {
              data: { kind: 'sent', provider_message_id: 'mid.ok' },
              error: null,
            };
          }
          return { data: null, error: { message: 'unexpected' } };
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    salon_id: SALON,
                    instagram_user_id: LARGE_IG_ID,
                    status: 'connected',
                    access_token_ciphertext: 'c',
                    access_token_iv: 'i',
                    access_token_auth_tag: 'a',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      },
      sendFn: async () => ({ kind: 'sent', providerMessageId: 'mid.ok' }),
    });
    assert.equal(r.kind, 'sent');
  });

  it('41. retryable failure → retry_scheduled', async () => {
    const r = await flushInstagramOutboundMessage({
      db: {
        rpc: async (name: string) => {
          if (name === 'claim_instagram_outbound_message') {
            return {
              data: {
                kind: 'claimed',
                id: 'ob-1',
                salon_id: SALON,
                provider: 'instagram',
                professional_account_id: LARGE_IG_ID,
                external_user_id: SENDER,
                source_event_id: SOURCE,
                inbound_receipt_id: 'r1',
                intent_key: 'ask_service',
                payload: { text: 'hi' },
                attempt_count: 1,
                claim_token: 'tok',
              },
              error: null,
            };
          }
          if (name === 'finalize_instagram_outbound_failure') {
            return { data: { kind: 'retry_scheduled' }, error: null };
          }
          return { data: null, error: { message: 'unexpected' } };
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    salon_id: SALON,
                    instagram_user_id: LARGE_IG_ID,
                    status: 'connected',
                    access_token_ciphertext: 'c',
                    access_token_iv: 'i',
                    access_token_auth_tag: 'a',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      },
      sendFn: async () => ({ kind: 'retryable_error', code: 'rate_limited' }),
    });
    assert.equal(r.kind, 'retry_scheduled');
  });

  it('42. permanent failure → terminal', async () => {
    const r = await flushInstagramOutboundMessage({
      db: {
        rpc: async (name: string) => {
          if (name === 'claim_instagram_outbound_message') {
            return {
              data: {
                kind: 'claimed',
                id: 'ob-1',
                salon_id: SALON,
                provider: 'instagram',
                professional_account_id: LARGE_IG_ID,
                external_user_id: SENDER,
                source_event_id: SOURCE,
                inbound_receipt_id: 'r1',
                intent_key: 'ask_service',
                payload: { text: 'hi' },
                attempt_count: 1,
                claim_token: 'tok',
              },
              error: null,
            };
          }
          if (name === 'finalize_instagram_outbound_failure') {
            return { data: { kind: 'failed' }, error: null };
          }
          return { data: null, error: { message: 'unexpected' } };
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    salon_id: SALON,
                    instagram_user_id: LARGE_IG_ID,
                    status: 'connected',
                    access_token_ciphertext: 'c',
                    access_token_iv: 'i',
                    access_token_auth_tag: 'a',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      },
      sendFn: async () => ({
        kind: 'permanent_error',
        code: 'invalid_recipient',
      }),
    });
    assert.equal(r.kind, 'failed');
  });

  it('43. late stale worker cannot finalize', async () => {
    const r = await flushInstagramOutboundMessage({
      db: {
        rpc: async (name: string) => {
          if (name === 'claim_instagram_outbound_message') {
            return {
              data: {
                kind: 'claimed',
                id: 'ob-1',
                salon_id: SALON,
                provider: 'instagram',
                professional_account_id: LARGE_IG_ID,
                external_user_id: SENDER,
                source_event_id: SOURCE,
                inbound_receipt_id: 'r1',
                intent_key: 'ask_service',
                payload: { text: 'hi' },
                attempt_count: 2,
                claim_token: 'tok-old',
              },
              error: null,
            };
          }
          if (name === 'finalize_instagram_outbound_sent') {
            return { data: { kind: 'lost_claim' }, error: null };
          }
          return { data: null, error: { message: 'unexpected' } };
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    salon_id: SALON,
                    instagram_user_id: LARGE_IG_ID,
                    status: 'connected',
                    access_token_ciphertext: 'c',
                    access_token_iv: 'i',
                    access_token_auth_tag: 'a',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      },
      sendFn: async () => ({ kind: 'sent', providerMessageId: 'mid.late' }),
    });
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.equal(r.code, 'finalize_sent_failed');
  });

  it('44. two workers do not send same claimed generation concurrently', async () => {
    let claims = 0;
    const db = {
      rpc: async (name: string) => {
        if (name === 'claim_instagram_outbound_message') {
          claims += 1;
          if (claims === 1) {
            return {
              data: {
                kind: 'claimed',
                id: 'ob-1',
                salon_id: SALON,
                provider: 'instagram',
                professional_account_id: LARGE_IG_ID,
                external_user_id: SENDER,
                source_event_id: SOURCE,
                inbound_receipt_id: 'r1',
                intent_key: 'ask_service',
                payload: { text: 'hi' },
                attempt_count: 1,
                claim_token: 'tok-1',
              },
              error: null,
            };
          }
          return { data: { kind: 'not_claimable' }, error: null };
        }
        if (name === 'finalize_instagram_outbound_sent') {
          return {
            data: { kind: 'sent', provider_message_id: 'mid.w1' },
            error: null,
          };
        }
        return { data: null, error: { message: 'unexpected' } };
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  salon_id: SALON,
                  instagram_user_id: LARGE_IG_ID,
                  status: 'connected',
                  access_token_ciphertext: 'c',
                  access_token_iv: 'i',
                  access_token_auth_tag: 'a',
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    let sends = 0;
    const sendFn = async () => {
      sends += 1;
      return { kind: 'sent' as const, providerMessageId: 'mid.w1' };
    };
    const a = await flushInstagramOutboundMessage({ db, messageId: 'ob-1', sendFn });
    const b = await flushInstagramOutboundMessage({ db, messageId: 'ob-1', sendFn });
    assert.equal(a.kind, 'sent');
    assert.equal(b.kind, 'skipped');
    assert.equal(sends, 1);
  });

  it('backoff schedule + max attempts constants', () => {
    assert.deepEqual([...INSTAGRAM_OUTBOUND_BACKOFF_MINUTES], [1, 5, 15, 60, 360]);
    assert.equal(INSTAGRAM_OUTBOUND_MAX_ATTEMPTS, 5);
    const t0 = Date.parse('2026-08-07T00:00:00.000Z');
    assert.equal(
      nextInstagramOutboundAttemptAt(1, t0),
      new Date(t0 + 60_000).toISOString(),
    );
    assert.equal(
      nextInstagramOutboundAttemptAt(5, t0),
      new Date(t0 + 360 * 60_000).toISOString(),
    );
  });
});

describe('IG-7 pipeline integration', () => {
  function baseProcess(overrides: Partial<InstagramProcessDeps> = {}): InstagramProcessDeps {
    const enqueued: Array<{ intentKey: string; source: string; created: boolean }> = [];
    const deps: InstagramProcessDeps & {
      _enqueued: typeof enqueued;
    } = {
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
        text: 'Выберите услугу',
      }),
      enqueueOutbound: async ({ intent }) => {
        const created = !enqueued.some(
          (e) => e.source === intent.sourceEventId && e.intentKey === intent.kind,
        );
        enqueued.push({
          intentKey: intent.kind,
          source: intent.sourceEventId,
          created,
        });
        return {
          kind: 'enqueued',
          id: 'ob-pipe',
          created,
          intentKey: intent.kind,
        };
      },
      _enqueued: enqueued,
      ...overrides,
    };
    return deps;
  }

  it('45. service input → FSM ask → enqueue → finalize', async () => {
    const order: string[] = [];
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
              message: { mid: 'mid.svc', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const r = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        runBookingFsm: async () => {
          order.push('fsm');
          return {
            kind: 'ask_service',
            messageKey: 'k',
            text: 'Выберите услугу',
            options: [{ id: 'service:1', label: '1. Cut' }],
          };
        },
        enqueueOutbound: async ({ intent }) => {
          order.push('enqueue');
          assert.equal(intent.kind, 'ask_service');
          assert.equal(intent.sourceEventId, 'mid.svc');
          return {
            kind: 'enqueued',
            id: 'ob1',
            created: true,
            intentKey: 'ask_service',
          };
        },
        finalize: async () => {
          order.push('finalize');
          return { ok: true, status: 'processed' };
        },
      }),
    );
    assert.equal(r.outcome, 'processed');
    assert.deepEqual(order, ['fsm', 'enqueue', 'finalize']);
    if (r.outcome === 'processed') {
      assert.equal(r.outboundIntent?.kind, 'ask_service');
      assert.equal(r.outboxMessageId, 'ob1');
    }
  });

  it('46. phone → commit booked enqueue → finalize', async () => {
    const order: string[] = [];
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
          order.push('commit');
          return { kind: 'booking_created', appointmentId: 'a1', clientId: 'c1' };
        },
        enqueueOutbound: async ({ intent }) => {
          order.push('enqueue');
          assert.equal(intent.kind, 'booked');
          assert.match(intent.text, /Стрижка/);
          return {
            kind: 'enqueued',
            id: 'ob-booked',
            created: true,
            intentKey: 'booked',
          };
        },
        finalize: async () => {
          order.push('finalize');
          return { ok: true, status: 'processed' };
        },
      }),
    );
    assert.equal(r.outcome, 'processed');
    assert.deepEqual(order, ['commit', 'enqueue', 'finalize']);
  });

  it('47. slot stolen → slot_unavailable enqueue', async () => {
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
              message: { mid: 'mid.slot', text: '+79991234567' },
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
        commitBooking: async () => ({
          kind: 'slot_unavailable_choose_time',
          date: '2026-08-20',
          options: [{ id: 'time:15:00', label: '15:00' }],
        }),
        enqueueOutbound: async ({ intent }) => {
          assert.equal(intent.kind, 'slot_unavailable');
          return {
            kind: 'enqueued',
            id: 'ob-slot',
            created: true,
            intentKey: 'slot_unavailable',
          };
        },
      }),
    );
    assert.equal(r.outcome, 'processed');
    if (r.outcome === 'processed') {
      assert.equal(r.outboundIntent?.kind, 'slot_unavailable');
    }
  });

  it('48. crash after enqueue → inbound retry does not duplicate outbox', async () => {
    const store = new Map<string, { id: string }>();
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
              message: { mid: 'mid.crash', text: 'hi' },
            },
          ],
        },
      ],
    })[0];

    let attempt = 0;
    const deps = baseProcess({
      claim: async () => {
        attempt += 1;
        return { kind: 'claimed', receiptId: 'r1', attemptCount: attempt };
      },
      runBookingFsm: async () => ({
        kind: 'ask_staff',
        messageKey: 'k',
        text: 'Выберите мастера',
      }),
      enqueueOutbound: async ({ intent }) => {
        const key = `${intent.sourceEventId}:${intent.kind}`;
        if (store.has(key)) {
          return {
            kind: 'enqueued',
            id: store.get(key)!.id,
            created: false,
            intentKey: intent.kind,
          };
        }
        store.set(key, { id: 'ob-stable' });
        return {
          kind: 'enqueued',
          id: 'ob-stable',
          created: true,
          intentKey: intent.kind,
        };
      },
      finalize: async () => {
        if (attempt === 1) {
          return { ok: false, code: 'finalize_crash_sim' };
        }
        return { ok: true, status: 'processed' };
      },
    });

    const first = await processInstagramWebhookEvent(msg, deps);
    assert.equal(first.outcome, 'failed_transient');
    const second = await processInstagramWebhookEvent(msg, deps);
    assert.equal(second.outcome, 'processed');
    assert.equal(store.size, 1);
  });

  it('49. duplicate receipt → no new enqueue', async () => {
    let enq = 0;
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
              message: { mid: 'mid.dup', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const r = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        claim: async () => ({ kind: 'duplicate_terminal', status: 'processed' }),
        enqueueOutbound: async () => {
          enq += 1;
          return {
            kind: 'enqueued',
            id: 'x',
            created: true,
            intentKey: 'ask_service',
          };
        },
      }),
    );
    assert.equal(r.outcome, 'duplicate_terminal');
    assert.equal(enq, 0);
  });

  it('50. in_flight → no enqueue', async () => {
    let enq = 0;
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
              message: { mid: 'mid.inflight', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const r = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        claim: async () => ({ kind: 'in_flight' }),
        enqueueOutbound: async () => {
          enq += 1;
          return {
            kind: 'enqueued',
            id: 'x',
            created: true,
            intentKey: 'ask_service',
          };
        },
      }),
    );
    assert.equal(r.outcome, 'in_flight');
    assert.equal(enq, 0);
  });

  it('51. echo → no enqueue', async () => {
    let enq = 0;
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
    const r = await processInstagramWebhookEvent(
      echo,
      baseProcess({
        enqueueOutbound: async () => {
          enq += 1;
          return {
            kind: 'enqueued',
            id: 'x',
            created: true,
            intentKey: 'ask_service',
          };
        },
      }),
    );
    assert.equal(r.outcome, 'ignored');
    assert.equal(enq, 0);
  });

  it('52. unknown/disconnected → no enqueue', async () => {
    let enq = 0;
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
              message: { mid: 'mid.unk', text: 'hi' },
            },
          ],
        },
      ],
    })[0];
    const unknown = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        route: async () => ({
          kind: 'unknown',
          professionalAccountId: null,
          reason: 'unknown_account',
        }),
        enqueueOutbound: async () => {
          enq += 1;
          return {
            kind: 'enqueued',
            id: 'x',
            created: true,
            intentKey: 'ask_service',
          };
        },
      }),
    );
    assert.equal(unknown.outcome, 'ignored');
    const disconnected = await processInstagramWebhookEvent(
      msg,
      baseProcess({
        route: async () => ({
          kind: 'disconnected',
          salonId: SALON,
          professionalAccountId: LARGE_IG_ID,
          reason: 'not_connected',
        }),
        enqueueOutbound: async () => {
          enq += 1;
          return {
            kind: 'enqueued',
            id: 'x',
            created: true,
            intentKey: 'ask_service',
          };
        },
      }),
    );
    assert.equal(disconnected.outcome, 'ignored');
    assert.equal(enq, 0);
  });
});

describe('IG-7 privacy', () => {
  it('53-55. outbox payload has no inbound/postback/token', () => {
    const intent = resolveInstagramOutboundIntent({
      sourceEventId: SOURCE,
      recipientExternalUserId: SENDER,
      professionalAccountId: LARGE_IG_ID,
      bookingIntent: {
        kind: 'ask_service',
        messageKey: 'k',
        text: 'Выберите услугу',
      },
    })!;
    const payload = toInstagramOutboundPayload(intent);
    const json = JSON.stringify(payload);
    assert.equal(Object.keys(payload).join(','), 'text');
    assert.doesNotMatch(json, /access_token|inbound|postback|raw_/i);
    assert.match(migSql(), /Must NOT store raw inbound DM/);
  });

  it('56. logs no token in outbound modules', () => {
    for (const file of [
      './instagramOutbound.ts',
      './instagramOutboundWorker.ts',
      './instagramMessagingApi.ts',
      './instagramWebhookProcess.ts',
    ]) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /console\.[a-z]+\([^)]*accessToken/);
      assert.doesNotMatch(src, /console\.[a-z]+\([^)]*Bearer/);
    }
  });

  it('57. identity conflict response no client data leak', () => {
    const r = resolveInstagramOutboundIntent({
      sourceEventId: SOURCE,
      recipientExternalUserId: SENDER,
      professionalAccountId: LARGE_IG_ID,
      bookingCommit: { kind: 'identity_conflict' },
    });
    assert.equal(r?.kind, 'manual_review');
    assert.doesNotMatch(r!.text, /client_id|identity|blocked|conflict|uuid/i);
  });
});

describe('IG-7 protected runtime / activation static', () => {
  it('worker not started from index; WA worker unchanged', () => {
    const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    assert.match(indexSrc, /startWhatsAppOutboundWorker/);
    assert.doesNotMatch(indexSrc, /startInstagramOutboundWorker/);
    assert.doesNotMatch(indexSrc, /INSTAGRAM_OUTBOUND_ENABLED/);
  });

  it('WhatsApp outbound files not modified by IG-7 symbols', () => {
    const wa = readFileSync(new URL('./whatsappOutbound.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(wa, /instagram_outbound|enqueue_instagram/);
    const waWorker = readFileSync(
      new URL('./whatsappOutboundWorker.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(waWorker, /instagram/i);
  });

  it('connection resolve binds salon + professional account', async () => {
    let sawSalon = '';
    let sawProf = '';
    const r = await resolveInstagramOutboundConnection({
      salonId: SALON,
      professionalAccountId: LARGE_IG_ID,
      db: {
        from: () => ({
          select: () => ({
            eq: (_c: string, v: string) => {
              if (!sawSalon) sawSalon = v;
              return {
                eq: (_c2: string, v2: string) => {
                  sawProf = v2;
                  return {
                    maybeSingle: async () => ({
                      data: {
                        salon_id: SALON,
                        instagram_user_id: LARGE_IG_ID,
                        status: 'connected',
                        access_token_ciphertext: 'c',
                        access_token_iv: 'i',
                        access_token_auth_tag: 'a',
                      },
                      error: null,
                    }),
                  };
                },
              };
            },
          }),
        }),
      },
    });
    assert.equal(r.kind, 'ok');
    assert.equal(sawSalon, SALON);
    assert.equal(sawProf, LARGE_IG_ID);
  });

  it('batch select safe when table missing', async () => {
    const summary = await runInstagramOutboundBatch({
      db: {
        from: () => ({
          select: () => ({
            or: () => ({
              order: () => ({
                limit: async () => ({
                  data: null,
                  error: { code: '42P01', message: 'missing' },
                }),
              }),
            }),
          }),
        }),
      },
    });
    assert.equal(summary.errors, 1);
    assert.equal(summary.sent, 0);
  });

  it('env example documents INSTAGRAM_OUTBOUND_ENABLED=false', () => {
    const env = readFileSync(
      new URL('../../.env.example', import.meta.url),
      'utf8',
    );
    assert.match(env, /INSTAGRAM_OUTBOUND_ENABLED=false/);
  });
});
