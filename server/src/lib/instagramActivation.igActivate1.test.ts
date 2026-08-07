/**
 * IG-ACTIVATE-1: Pre-production activation hardening tests.
 * No Meta. No SQL execution. No migrations applied.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, before } from 'node:test';
import {
  createDefaultInstagramProcessDeps,
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from './instagramWebhookProcess.js';
import { normalizeInstagramWebhookPayload } from './instagramWebhookEvents.js';
import {
  consumeInstagramOAuthState,
  createInstagramOAuthState,
  createPersistedInstagramOAuthState,
  getInstagramOAuthStateTtlMs,
  InstagramOAuthStateError,
  parseInstagramOAuthState,
} from './instagramOAuthState.js';
import { INSTAGRAM_REQUIRED_SCOPES } from './instagramApi.js';

const SALON = '11111111-1111-1111-1111-111111111111';
const SENDER = '17841400000000099';
const LARGE_IG_ID = '17841400000000001';

before(() => {
  if (!process.env.INSTAGRAM_APP_SECRET?.trim()) {
    process.env.INSTAGRAM_APP_SECRET = 'test-instagram-app-secret-for-unit-tests';
  }
});

function mig08(): string {
  return readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000008_instagram_activation_hardening.sql',
      import.meta.url,
    ),
    'utf8',
  );
}

function messageEvent(mid = 'mid.act1') {
  return normalizeInstagramWebhookPayload({
    object: 'instagram',
    entry: [
      {
        id: LARGE_IG_ID,
        messaging: [
          {
            sender: { id: SENDER },
            recipient: { id: LARGE_IG_ID },
            timestamp: 1,
            message: { mid, text: 'hi' },
          },
        ],
      },
    ],
  })[0];
}

describe('IG-ACTIVATE-1 enqueue hardening', () => {
  it('1. production default always has enqueue', () => {
    const deps = createDefaultInstagramProcessDeps();
    assert.equal(typeof deps.enqueueOutbound, 'function');
  });

  it('2-3. missing injected enqueue + response intent -> hard fallback (not silent skip)', async () => {
    let finalizeCalls = 0;
    let fallbackRpc = 0;
    const deps: InstagramProcessDeps = {
      route: async () => ({
        kind: 'connected',
        salonId: SALON,
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async () => ({ kind: 'claimed', receiptId: 'r1', attemptCount: 1 }),
      finalize: async () => {
        finalizeCalls += 1;
        return { ok: true, status: 'processed' };
      },
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
      // enqueueOutbound intentionally omitted — must fall back, not skip.
      db: {
        rpc: async (name: string) => {
          if (name === 'enqueue_instagram_outbound_owned') {
            fallbackRpc += 1;
            return {
              data: {
                kind: 'enqueued',
                id: 'ob-fallback',
                created: true,
                intent_key: 'ask_service',
              },
              error: null,
            };
          }
          return { data: null, error: { message: 'unexpected' } };
        },
      },
    };

    const r = await processInstagramWebhookEvent(messageEvent('mid.fallback'), deps);
    assert.equal(r.outcome, 'processed');
    assert.equal(fallbackRpc, 1);
    assert.equal(finalizeCalls, 1);
    if (r.outcome === 'processed') {
      assert.equal(r.outboxMessageId, 'ob-fallback');
    }
  });

  it('3b. explicit mock enqueue still works', async () => {
    let mockEnq = 0;
    const r = await processInstagramWebhookEvent(messageEvent('mid.mock'), {
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
        kind: 'ask_staff',
        messageKey: 'k',
        text: 'Выберите мастера',
      }),
      enqueueOutbound: async () => {
        mockEnq += 1;
        return {
          kind: 'enqueued',
          id: 'ob-mock',
          created: true,
          intentKey: 'ask_staff',
        };
      },
    });
    assert.equal(r.outcome, 'processed');
    assert.equal(mockEnq, 1);
  });

  it('4. no-intent paths do not require enqueue', async () => {
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
    const r = await processInstagramWebhookEvent(echo, {
      route: async () => ({
        kind: 'connected',
        salonId: SALON,
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async () => ({ kind: 'claimed', receiptId: 'r1', attemptCount: 1 }),
      finalize: async () => ({ ok: true, status: 'ignored' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: async () => {
        throw new Error('should_not_touch');
      },
      enqueueOutbound: async () => {
        enq += 1;
        return {
          kind: 'enqueued',
          id: 'x',
          created: true,
          intentKey: 'ask_service',
        };
      },
    });
    assert.equal(r.outcome, 'ignored');
    assert.equal(enq, 0);
  });

  it('5. enqueue error blocks finalize', async () => {
    let finalizeCalls = 0;
    let failed = 0;
    const r = await processInstagramWebhookEvent(messageEvent('mid.enqfail'), {
      route: async () => ({
        kind: 'connected',
        salonId: SALON,
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async () => ({ kind: 'claimed', receiptId: 'r1', attemptCount: 1 }),
      finalize: async () => {
        finalizeCalls += 1;
        return { ok: true, status: 'processed' };
      },
      markFailed: async () => {
        failed += 1;
        return { ok: true };
      },
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
      enqueueOutbound: async () => ({ kind: 'error', code: 'enqueue_rpc_error' }),
    });
    assert.equal(r.outcome, 'failed_transient');
    assert.equal(finalizeCalls, 0);
    assert.equal(failed, 1);
  });
});

describe('IG-ACTIVATE-1 OAuth single-use (executed mocks)', () => {
  it('5/13. create persist + opaque random nonce; parse binds salon', async () => {
    let persistedNonce = '';
    const state = await createPersistedInstagramOAuthState({
      salonId: SALON,
      db: {
        rpc: async (_n: string, args: Record<string, unknown>) => {
          persistedNonce = String(args.p_nonce ?? '');
          assert.equal(args.p_salon_id, SALON);
          assert.ok(typeof args.p_expires_at === 'string');
          return {
            data: {
              kind: 'created',
              id: 'st1',
              nonce: persistedNonce,
              salon_id: SALON,
            },
            error: null,
          };
        },
      },
    });
    assert.match(persistedNonce, /^[0-9a-f]{32}$/);
    const parsed = parseInstagramOAuthState(state);
    assert.equal(parsed.salonId, SALON);
    assert.equal(parsed.nonce, persistedNonce);
  });

  it('5-6. valid consume once; second rejected', async () => {
    const state = createInstagramOAuthState(SALON);
    const parsed = parseInstagramOAuthState(state);
    let consumes = 0;
    const db = {
      rpc: async () => {
        consumes += 1;
        if (consumes === 1) {
          return {
            data: {
              kind: 'consumed',
              id: 'st1',
              nonce: parsed.nonce,
              salon_id: SALON,
            },
            error: null,
          };
        }
        return {
          data: { kind: 'rejected', code: 'already_consumed' },
          error: null,
        };
      },
    };
    const first = await consumeInstagramOAuthState({ db, state });
    assert.equal(first.salonId, SALON);
    await assert.rejects(
      () => consumeInstagramOAuthState({ db, state }),
      (err: unknown) =>
        err instanceof InstagramOAuthStateError &&
        err.code === 'INSTAGRAM_OAUTH_STATE_REPLAY',
    );
  });

  it('7. expired rejected', async () => {
    const expired = createInstagramOAuthState(
      SALON,
      Date.now() - getInstagramOAuthStateTtlMs() - 1000,
    );
    assert.throws(
      () => parseInstagramOAuthState(expired),
      (err: unknown) =>
        err instanceof InstagramOAuthStateError &&
        err.code === 'INSTAGRAM_OAUTH_STATE_EXPIRED',
    );
  });

  it('8. tampered signature rejected', () => {
    const state = createInstagramOAuthState(SALON);
    const [payload, sig] = state.split('.');
    assert.throws(
      () => parseInstagramOAuthState(`${payload}.${sig.slice(0, -2)}aa`),
      (err: unknown) =>
        err instanceof InstagramOAuthStateError &&
        err.code === 'INSTAGRAM_OAUTH_STATE_INVALID',
    );
  });

  it('9. wrong salon rejected', async () => {
    const state = createInstagramOAuthState(SALON);
    await assert.rejects(
      () =>
        consumeInstagramOAuthState({
          state,
          db: {
            rpc: async () => ({
              data: { kind: 'rejected', code: 'salon_mismatch' },
              error: null,
            }),
          },
        }),
      (err: unknown) =>
        err instanceof InstagramOAuthStateError &&
        err.code === 'INSTAGRAM_OAUTH_STATE_INVALID',
    );
  });

  it('10. unknown nonce rejected', async () => {
    const state = createInstagramOAuthState(SALON);
    await assert.rejects(
      () =>
        consumeInstagramOAuthState({
          state,
          db: {
            rpc: async () => ({
              data: { kind: 'rejected', code: 'unknown_nonce' },
              error: null,
            }),
          },
        }),
      (err: unknown) =>
        err instanceof InstagramOAuthStateError &&
        err.code === 'INSTAGRAM_OAUTH_STATE_INVALID',
    );
  });

  it('11. two concurrent consume attempts -> one winner (mock CAS)', async () => {
    const state = createInstagramOAuthState(SALON);
    let n = 0;
    const db = {
      rpc: async () => {
        n += 1;
        if (n === 1) {
          return {
            data: { kind: 'consumed', id: 'w', salon_id: SALON },
            error: null,
          };
        }
        return {
          data: { kind: 'rejected', code: 'already_consumed' },
          error: null,
        };
      },
    };
    const results = await Promise.allSettled([
      consumeInstagramOAuthState({ db, state }),
      consumeInstagramOAuthState({ db, state }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.ok(
      bad[0].status === 'rejected' &&
        bad[0].reason instanceof InstagramOAuthStateError &&
        bad[0].reason.code === 'INSTAGRAM_OAUTH_STATE_REPLAY',
    );
  });

  it('12. callback consumes durable state before token exchange', () => {
    const callback = readFileSync(
      join(process.cwd(), 'src/routes/instagramOAuthCallback.ts'),
      'utf8',
    );
    // Compare call sites inside the route handler (skip import lines).
    const handler = callback.slice(callback.indexOf("router.get('/callback'"));
    const consumeIdx = handler.indexOf('consumeInstagramOAuthState');
    const verifyIdx = handler.indexOf('verifyInstagramOAuthConnection');
    assert.ok(consumeIdx >= 0, 'consume call missing in callback handler');
    assert.ok(verifyIdx > consumeIdx, 'token exchange must follow consume');
    assert.equal(callback.includes('unconsume'), false);
    assert.equal(callback.includes('restoreOAuth'), false);
    const sql = mig08();
    assert.ok(sql.includes('Never cleared on Meta failure'));
  });

  it('14. oauth state table stores no secrets', () => {
    const sql = mig08();
    assert.ok(!sql.includes('access_token_ciphertext'));
    assert.ok(!sql.includes('app_secret'));
    assert.ok(!sql.includes('authorization_code'));
    assert.ok(sql.includes('No tokens/secrets'));
  });
});

describe('IG-ACTIVATE-1 migration static', () => {
  it('15-21. additive OAuth state table + atomic consume + grants', () => {
    const sql = mig08();
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.instagram_oauth_states'));
    assert.ok(sql.includes('UNIQUE (nonce)'));
    assert.ok(sql.includes('consumed_at'));
    assert.ok(sql.includes('instagram_oauth_states_expires_at_idx'));
    assert.ok(sql.includes('consume_instagram_oauth_state'));
    assert.ok(sql.includes('consumed_at IS NULL'));
    assert.ok(sql.includes('SECURITY INVOKER'));
    assert.ok(sql.includes('SET search_path = public'));
    assert.ok(sql.includes('TO service_role'));
    assert.ok(sql.includes('FROM anon'));
    assert.ok(sql.includes('FROM authenticated'));
    assert.ok(!sql.includes('whatsapp_outbound_messages'));
  });
});

describe('IG-ACTIVATE-1 activation audit static', () => {
  it('scopes remain Instagram Login messaging pair', () => {
    assert.deepEqual([...INSTAGRAM_REQUIRED_SCOPES], [
      'instagram_business_basic',
      'instagram_business_manage_messages',
    ]);
  });

  it('worker still not bootstrapped; outbound flag default off', () => {
    const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    assert.equal(indexSrc.includes('startInstagramOutboundWorker'), false);
    const env = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    assert.ok(env.includes('INSTAGRAM_OUTBOUND_ENABLED=false'));
  });

  it('connect/start persists durable state', () => {
    const routes = readFileSync(
      new URL('../routes/instagramIntegrations.ts', import.meta.url),
      'utf8',
    );
    assert.ok(routes.includes('createPersistedInstagramOAuthState'));
  });

  it('IG-1 to IG-7 migrations untouched; 00008 additive only', () => {
    const sql = mig08();
    assert.ok(sql.includes('IG-ACTIVATE-1'));
    assert.equal(sql.includes('instagram_outbound_messages'), false);
    assert.equal(sql.includes('commit_instagram_booking'), false);
  });
});
