/**
 * WA-4F1 outbound outbox tests (no Meta, no real SQL execution).
 * Executed: renderer, enqueue/claim/flush with mocks, send classification, static migration.
 * Reasoned: HTTP-success/DB-crash duplicate window (documented, not exactly-once).
 *
 * Run: npm run test --prefix server
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  claimWhatsAppOutboundMessage,
  enqueueWhatsAppOutbound,
  flushWhatsAppOutboundMessage,
  nextWhatsAppOutboundAttemptAt,
  resolveWhatsAppOutboundConnection,
  WHATSAPP_OUTBOUND_MAX_ATTEMPTS,
  WHATSAPP_OUTBOUND_STALE_CLAIM_SECONDS,
} from './whatsappOutbound.js';
import {
  renderWhatsAppCommitOutbound,
  renderWhatsAppFsmOutbound,
} from './whatsappOutboundRenderer.js';
import { sendWhatsAppTextMessage } from './whatsappCloudApi.js';

function connectedDb(phoneNumberId = 'pn-1') {
  return {
    from(table: string) {
      if (table === 'salon_integrations') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({
            data: { id: 'i1', status: 'connected' },
            error: null,
          }),
        };
      }
      if (table === 'whatsapp_business_connections') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({
            data: {
              phone_number_id: phoneNumberId,
              access_token_ciphertext: 'x',
              access_token_iv: 'y',
              access_token_auth_tag: 'z',
            },
            error: null,
          }),
        };
      }
      throw new Error(`unexpected from ${table}`);
    },
  };
}

describe('WA-4F1 outbound renderer (executed)', () => {
  it('1. service prompt numbered', () => {
    const r = renderWhatsAppFsmOutbound({
      kind: 'reply',
      messageKey: 'whatsapp.booking.chooseService',
      text: 'Выберите услугу:',
      options: [
        { id: 'a', label: 'Стрижка' },
        { id: 'b', label: 'Окрашивание' },
      ],
    });
    assert.match(r.text, /1\. Стрижка/);
    assert.match(r.text, /2\. Окрашивание/);
    assert.match(r.text, /номером/);
  });

  it('2. staff prompt numbered', () => {
    const r = renderWhatsAppFsmOutbound({
      kind: 'reply',
      messageKey: 'whatsapp.booking.chooseStaff',
      text: 'Выберите мастера:',
      options: [{ id: 's1', label: 'Мария' }],
    });
    assert.match(r.text, /1\. Мария/);
  });

  it('3. date prompt uses labels (not implying numeric parse)', () => {
    const r = renderWhatsAppFsmOutbound({
      kind: 'reply',
      messageKey: 'whatsapp.booking.chooseDate',
      text: 'Выберите дату:',
      options: [{ id: '2099-06-15', label: '2099-06-15' }],
    });
    assert.match(r.text, /• 2099-06-15/);
    assert.match(r.text, /Напишите дату/);
    assert.equal(r.text.includes('1. '), false);
  });

  it('4. time prompt uses labels', () => {
    const r = renderWhatsAppFsmOutbound({
      kind: 'reply',
      messageKey: 'whatsapp.booking.chooseTime',
      text: 'Выберите время:',
      options: [{ id: '14:00', label: '14:00' }],
    });
    assert.match(r.text, /14:00/);
    assert.match(r.text, /Напишите время/);
  });

  it('5/6. ask name / phone', () => {
    const n = renderWhatsAppFsmOutbound({
      kind: 'reply',
      messageKey: 'whatsapp.booking.askName',
      text: 'Как вас зовут?',
    });
    assert.equal(n.text, 'Как вас зовут?');
    const p = renderWhatsAppFsmOutbound({
      kind: 'reply',
      messageKey: 'whatsapp.booking.askPhone',
      text: 'Номер телефона?',
    });
    assert.equal(p.text, 'Номер телефона?');
  });

  it('7. booking confirmation with display fields', () => {
    const r = renderWhatsAppCommitOutbound(
      { kind: 'booking_created', appointmentId: 'a', clientId: 'c' },
      {
        serviceName: 'Стрижка',
        staffName: 'Мария',
        date: '2099-06-15',
        time: '14:00',
      },
    );
    assert.ok(r);
    assert.match(r!.text, /Стрижка/);
    assert.match(r!.text, /Мария/);
    assert.match(r!.text, /2099-06-15/);
    assert.match(r!.text, /14:00/);
    assert.equal(r!.text.includes('appt'), false);
  });

  it('8. slot recovery render', () => {
    const t = renderWhatsAppCommitOutbound({
      kind: 'slot_unavailable_choose_time',
      date: '2099-06-15',
      options: [{ id: '15:00', label: '15:00' }],
    });
    assert.ok(t);
    assert.match(t!.text, /15:00/);
    const d = renderWhatsAppCommitOutbound({
      kind: 'slot_unavailable_choose_date',
      options: [{ id: '2099-06-16', label: '2099-06-16' }],
    });
    assert.ok(d);
    assert.match(d!.text, /2099-06-16/);
  });

  it('9. conflict generic safe copy (no internal codes)', () => {
    for (const kind of [
      'identity_conflict',
      'client_resolution_conflict',
      'already_booked_repair_conflict',
      'ambiguous_client',
    ] as const) {
      const r = renderWhatsAppCommitOutbound({ kind } as any);
      assert.ok(r);
      assert.equal(r!.text.includes(kind), false);
      assert.match(r!.text, /салон/i);
    }
    const blocked = renderWhatsAppCommitOutbound({ kind: 'client_blocked' });
    assert.ok(blocked);
    assert.equal(blocked!.text.includes('blocked'), false);
  });
});

describe('WA-4F1 enqueue / claim / flush (executed with mocks)', () => {
  it('10/11. enqueue once; duplicate returns same row', async () => {
    let inserts = 0;
    const row = {
      id: 'out-1',
      salon_id: 'salon-A',
      conversation_id: 'conv-1',
      inbound_receipt_id: 'rcpt-1',
      recipient_external_user_id: '15551112222',
      message_key: 'whatsapp.booking.chooseService',
      payload: { text: 'hello' },
      sequence: 0,
      status: 'pending',
      attempt_count: 0,
      claim_token: null,
      meta_message_id: null,
    };
    const db = {
      from() {
        return {
          insert() {
            inserts += 1;
            if (inserts === 1) {
              return {
                select() {
                  return {
                    maybeSingle: async () => ({ data: row, error: null }),
                  };
                },
              };
            }
            return {
              select() {
                return {
                  maybeSingle: async () => ({
                    data: null,
                    error: { code: '23505', message: 'duplicate key' },
                  }),
                };
              },
            };
          },
          select() {
            return {
              eq() {
                return this;
              },
              maybeSingle: async () => ({ data: row, error: null }),
            };
          },
        };
      },
    };
    const a = await enqueueWhatsAppOutbound({
      db,
      salonId: 'salon-A',
      conversationId: 'conv-1',
      inboundReceiptId: 'rcpt-1',
      recipientExternalUserId: '15551112222',
      messageKey: 'whatsapp.booking.chooseService',
      text: 'hello',
    });
    assert.equal(a.kind, 'enqueued');
    if (a.kind === 'enqueued') assert.equal(a.created, true);

    const b = await enqueueWhatsAppOutbound({
      db,
      salonId: 'salon-A',
      conversationId: 'conv-1',
      inboundReceiptId: 'rcpt-1',
      recipientExternalUserId: '15551112222',
      messageKey: 'whatsapp.booking.chooseService',
      text: 'hello again',
    });
    assert.equal(b.kind, 'enqueued');
    if (b.kind === 'enqueued') {
      assert.equal(b.created, false);
      assert.equal(b.row.id, 'out-1');
    }
  });

  it('12/13. claim pending; second fresh claim not_claimable', async () => {
    let claimCalls = 0;
    const db = {
      async rpc(name: string) {
        assert.equal(name, 'claim_whatsapp_outbound_message');
        claimCalls += 1;
        if (claimCalls === 1) {
          return {
            data: {
              kind: 'claimed',
              id: 'out-1',
              salon_id: 'salon-A',
              conversation_id: 'conv-1',
              inbound_receipt_id: 'rcpt-1',
              recipient_external_user_id: '15551112222',
              message_key: 'k',
              payload: { text: 'hi' },
              sequence: 0,
              attempt_count: 1,
              claim_token: 'tok-1',
            },
            error: null,
          };
        }
        return { data: { kind: 'not_claimable' }, error: null };
      },
    };
    const first = await claimWhatsAppOutboundMessage({ db, messageId: 'out-1' });
    assert.equal(first.kind, 'claimed');
    if (first.kind === 'claimed') assert.equal(first.claimToken, 'tok-1');
    const second = await claimWhatsAppOutboundMessage({ db, messageId: 'out-1' });
    assert.equal(second.kind, 'not_claimable');
  });

  it('14. stale claim reclaim returns new token (mock CAS)', async () => {
    let claimCalls = 0;
    const db = {
      async rpc(name: string, args: Record<string, unknown>) {
        assert.equal(name, 'claim_whatsapp_outbound_message');
        assert.equal(args.p_stale_seconds, WHATSAPP_OUTBOUND_STALE_CLAIM_SECONDS);
        claimCalls += 1;
        return {
          data: {
            kind: 'claimed',
            id: 'out-1',
            salon_id: 'salon-A',
            conversation_id: null,
            inbound_receipt_id: 'rcpt-1',
            recipient_external_user_id: '15551112222',
            message_key: 'k',
            payload: { text: 'hi' },
            sequence: 0,
            attempt_count: claimCalls + 1,
            claim_token: `tok-${claimCalls}`,
          },
          error: null,
        };
      },
    };
    const a = await claimWhatsAppOutboundMessage({ db, messageId: 'out-1' });
    const b = await claimWhatsAppOutboundMessage({ db, messageId: 'out-1' });
    assert.equal(a.kind, 'claimed');
    assert.equal(b.kind, 'claimed');
    if (a.kind === 'claimed' && b.kind === 'claimed') {
      assert.notEqual(a.claimToken, b.claimToken);
    }
  });

  it('15. send success → sent + meta id (injected sendFn)', async () => {
    const base = connectedDb('pn-success');
    const db = {
      ...base,
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === 'claim_whatsapp_outbound_message') {
          return {
            data: {
              kind: 'claimed',
              id: 'out-1',
              salon_id: 'salon-A',
              conversation_id: 'conv-1',
              inbound_receipt_id: 'rcpt-1',
              recipient_external_user_id: '15551112222',
              message_key: 'k',
              payload: { text: 'hi' },
              sequence: 0,
              attempt_count: 1,
              claim_token: 'tok-1',
            },
            error: null,
          };
        }
        if (name === 'finalize_whatsapp_outbound_sent') {
          assert.equal(args.p_claim_token, 'tok-1');
          assert.equal(args.p_meta_message_id, 'wamid.out.1');
          return { data: { kind: 'sent', id: 'out-1' }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    };

    const result = await flushWhatsAppOutboundMessage({
      db,
      messageId: 'out-1',
      sendFn: async () => ({ kind: 'sent', metaMessageId: 'wamid.out.1' }),
    });
    assert.equal(result.kind, 'sent');
    if (result.kind === 'sent') assert.equal(result.metaMessageId, 'wamid.out.1');
  });

  it('16/17/18/19. send helper classifies timeout/5xx/rate/4xx', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }) as typeof fetch;
      let r = await sendWhatsAppTextMessage({
        accessToken: 't',
        phoneNumberId: 'pn',
        to: '1',
        text: 'hi',
      });
      assert.equal(r.kind, 'retryable_error');
      if (r.kind === 'retryable_error') assert.equal(r.code, 'timeout');

      globalThis.fetch = (async () =>
        ({
          status: 503,
          json: async () => ({}),
        })) as typeof fetch;
      r = await sendWhatsAppTextMessage({
        accessToken: 't',
        phoneNumberId: 'pn',
        to: '1',
        text: 'hi',
      });
      assert.equal(r.kind, 'retryable_error');
      if (r.kind === 'retryable_error') assert.equal(r.code, 'provider_5xx');

      globalThis.fetch = (async () =>
        ({
          status: 429,
          json: async () => ({}),
        })) as typeof fetch;
      r = await sendWhatsAppTextMessage({
        accessToken: 't',
        phoneNumberId: 'pn',
        to: '1',
        text: 'hi',
      });
      assert.equal(r.kind, 'retryable_error');
      if (r.kind === 'retryable_error') assert.equal(r.code, 'rate_limited');

      globalThis.fetch = (async () =>
        ({
          status: 400,
          json: async () => ({}),
        })) as typeof fetch;
      r = await sendWhatsAppTextMessage({
        accessToken: 't',
        phoneNumberId: 'pn',
        to: '1',
        text: 'hi',
      });
      assert.equal(r.kind, 'permanent_error');

      globalThis.fetch = (async () =>
        ({
          status: 200,
          json: async () => ({ messages: [{ id: 'wamid.ok' }] }),
        })) as typeof fetch;
      r = await sendWhatsAppTextMessage({
        accessToken: 't',
        phoneNumberId: 'pn',
        to: '1',
        text: 'hi',
      });
      assert.deepEqual(r, { kind: 'sent', metaMessageId: 'wamid.ok' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('16b. flush timeout → retry_scheduled', async () => {
    const base = connectedDb();
    const db = {
      ...base,
      async rpc(name: string) {
        if (name === 'claim_whatsapp_outbound_message') {
          return {
            data: {
              kind: 'claimed',
              id: 'out-1',
              salon_id: 'salon-A',
              conversation_id: null,
              inbound_receipt_id: 'rcpt-1',
              recipient_external_user_id: '15551112222',
              message_key: 'k',
              payload: { text: 'hi' },
              sequence: 0,
              attempt_count: 1,
              claim_token: 'tok-1',
            },
            error: null,
          };
        }
        if (name === 'finalize_whatsapp_outbound_failure') {
          return { data: { kind: 'retry_scheduled', id: 'out-1' }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    };
    const result = await flushWhatsAppOutboundMessage({
      db,
      messageId: 'out-1',
      sendFn: async () => ({ kind: 'retryable_error', code: 'timeout' }),
    });
    assert.equal(result.kind, 'retry_scheduled');
  });

  it('19b. flush permanent 4xx → failed', async () => {
    const base = connectedDb();
    const db = {
      ...base,
      async rpc(name: string) {
        if (name === 'claim_whatsapp_outbound_message') {
          return {
            data: {
              kind: 'claimed',
              id: 'out-1',
              salon_id: 'salon-A',
              conversation_id: null,
              inbound_receipt_id: 'rcpt-1',
              recipient_external_user_id: '15551112222',
              message_key: 'k',
              payload: { text: 'hi' },
              sequence: 0,
              attempt_count: 1,
              claim_token: 'tok-1',
            },
            error: null,
          };
        }
        if (name === 'finalize_whatsapp_outbound_failure') {
          return { data: { kind: 'failed', id: 'out-1' }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    };
    const result = await flushWhatsAppOutboundMessage({
      db,
      messageId: 'out-1',
      sendFn: async () => ({ kind: 'permanent_error', code: 'invalid_recipient' }),
    });
    assert.equal(result.kind, 'failed');
  });

  it('20. connection missing safe failure', async () => {
    const db = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    };
    const r = await resolveWhatsAppOutboundConnection({ db, salonId: 'salon-X' });
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.equal(r.code, 'connection_missing');
  });

  it('21. token decrypt failure safe (no injected sendFn)', async () => {
    const prev = process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY;
    try {
      const base = connectedDb();
      const db = {
        ...base,
        async rpc(name: string, args: Record<string, unknown>) {
          if (name === 'claim_whatsapp_outbound_message') {
            return {
              data: {
                kind: 'claimed',
                id: 'out-1',
                salon_id: 'salon-A',
                conversation_id: null,
                inbound_receipt_id: 'rcpt-1',
                recipient_external_user_id: '15551112222',
                message_key: 'k',
                payload: { text: 'hi' },
                sequence: 0,
                attempt_count: 1,
                claim_token: 'tok-1',
              },
              error: null,
            };
          }
          if (name === 'finalize_whatsapp_outbound_failure') {
            assert.equal(args.p_error_code, 'crypto_invalid');
            assert.equal(args.p_retryable, false);
            return { data: { kind: 'failed', id: 'out-1' }, error: null };
          }
          throw new Error(`unexpected rpc ${name}`);
        },
      };
      const result = await flushWhatsAppOutboundMessage({
        db,
        messageId: 'out-1',
        // intentionally no sendFn → real decrypt path
      });
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.code, 'crypto_invalid');
    } finally {
      if (prev === undefined) delete process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY;
      else process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY = prev;
    }
  });

  it('22. same recipient two salons resolves separately', async () => {
    const seen: string[] = [];
    const db = {
      from(table: string) {
        return {
          select() {
            return this;
          },
          eq(_col: string, val: string) {
            if (_col === 'salon_id') seen.push(`${table}:${val}`);
            return this;
          },
          maybeSingle: async () => {
            if (table === 'salon_integrations') {
              return { data: { id: 'i', status: 'connected' }, error: null };
            }
            return {
              data: {
                phone_number_id: `pn-${seen[seen.length - 1]}`,
                access_token_ciphertext: 'c',
                access_token_iv: 'i',
                access_token_auth_tag: 'a',
              },
              error: null,
            };
          },
        };
      },
    };
    const a = await resolveWhatsAppOutboundConnection({ db, salonId: 'salon-A' });
    const b = await resolveWhatsAppOutboundConnection({ db, salonId: 'salon-B' });
    assert.equal(a.kind, 'ok');
    assert.equal(b.kind, 'ok');
    if (a.kind === 'ok' && b.kind === 'ok') {
      assert.notEqual(a.phoneNumberId, b.phoneNumberId);
    }
  });

  it('backoff helper deterministic', () => {
    const t0 = Date.parse('2026-08-05T12:00:00.000Z');
    const a = nextWhatsAppOutboundAttemptAt(1, t0);
    const b = nextWhatsAppOutboundAttemptAt(2, t0);
    assert.ok(Date.parse(b) > Date.parse(a));
    assert.equal(WHATSAPP_OUTBOUND_MAX_ATTEMPTS, 5);
  });
});

describe('WA-4F1 migration / ordering / safety (executed static)', () => {
  const sql = readFileSync(
    new URL(
      '../../../supabase/migrations/20260805000004_whatsapp_outbound_outbox.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const webhook = readFileSync(
    new URL('../routes/whatsappWebhook.ts', import.meta.url),
    'utf8',
  );
  const outbound = readFileSync(
    new URL('./whatsappOutbound.ts', import.meta.url),
    'utf8',
  );
  const worker = readFileSync(
    new URL('./whatsappOutboundWorker.ts', import.meta.url),
    'utf8',
  );
  const cloudApi = readFileSync(
    new URL('./whatsappCloudApi.ts', import.meta.url),
    'utf8',
  );
  const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

  it('outbox unique + status + claim RPCs', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.whatsapp_outbound_messages/);
    assert.match(sql, /UNIQUE \(salon_id, inbound_receipt_id, sequence\)/);
    assert.match(sql, /pending.*claimed.*sent.*failed/s);
    assert.match(sql, /claim_whatsapp_outbound_message/);
    assert.match(sql, /finalize_whatsapp_outbound_sent/);
    assert.match(sql, /finalize_whatsapp_outbound_failure/);
    assert.match(sql, /SECURITY INVOKER/);
    assert.match(sql, /SET search_path = public/);
    assert.match(sql, /GRANT EXECUTE[\s\S]*TO service_role/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /claimed_at < \(v_now - v_stale\)/);
    assert.equal(sql.includes('graph.facebook'), false);
    assert.equal(sql.includes('syncAppointmentReminder'), false);
  });

  it('23. enqueue-before-finalize route ordering', () => {
    assert.match(webhook, /enqueue durable outbound BEFORE inbound finalize/);
    // Use call-site markers (not import lines).
    const enqueueIdx = webhook.indexOf('const enqueued = await enqueueWhatsAppOutbound');
    const finalizeIdx = webhook.indexOf(
      'const finalized = await finalizeWhatsAppEventReceipt',
    );
    const flushIdx = webhook.indexOf(
      'const flushed = await flushWhatsAppOutboundMessage',
    );
    assert.ok(enqueueIdx > 0, 'enqueue call site');
    assert.ok(finalizeIdx > enqueueIdx, 'finalize after enqueue');
    assert.ok(flushIdx > finalizeIdx, 'flush after finalize');
  });

  it('24. inline send failure does not reopen inbound receipt', () => {
    assert.match(webhook, /Best-effort inline flush AFTER finalize/);
    assert.match(webhook, /Send failure must not reopen inbound/);
    // Flush failures must not call mark-failed for the inbound receipt.
    const flushBlock = webhook.slice(
      webhook.indexOf('Best-effort inline flush AFTER finalize'),
      webhook.indexOf("return finalized.status === 'ignored'"),
    );
    assert.ok(flushBlock.length > 0);
    assert.equal(flushBlock.includes('markWhatsAppEventReceiptFailed'), false);
  });

  it('25. no outbound for status/noop (static)', () => {
    assert.match(webhook, /No outbound for noop \/ outdated \/ stale_step/);
    assert.equal(/pendingOutbound[\s\S]*status callback/.test(webhook), false);
    // Status/non-inbound path never sets pendingOutbound outside isInboundMessage.
    assert.match(webhook, /if \(params\.event\.isInboundMessage\)/);
  });

  it('26. no secret logging', () => {
    for (const src of [outbound, worker, cloudApi, webhook]) {
      assert.equal(/console\.(log|error|warn).*accessToken/.test(src), false);
      assert.equal(/console\.(log|error|warn).*access_token/.test(src), false);
      assert.equal(src.includes('graph.facebook.com') && /console\.(log|error).*body/.test(src), false);
    }
    assert.match(cloudApi, /does not log secrets\/bodies/);
  });

  it('27. Telegram untouched in outbound modules', () => {
    assert.equal(
      /TelegramBotManager|startTelegramPolling|syncAppointmentReminder/.test(outbound),
      false,
    );
    assert.equal(/TelegramBotManager|startTelegramPolling/.test(worker), false);
  });

  it('worker not bootstrapped in index', () => {
    assert.equal(indexSrc.includes('runWhatsAppOutboundBatch'), false);
    assert.equal(indexSrc.includes('whatsappOutboundWorker'), false);
  });

  it('N. residual crash-window documented (reasoned)', () => {
    assert.match(
      outbound,
      /Residual risk: Meta HTTP success then crash before finalize_sent may duplicate on reclaim/,
    );
  });
});
