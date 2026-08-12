/**
 * IG-ACTIVATE-1A: Burn OAuth state on cancel/error callback.
 * Executed HTTP mocks. No Meta. No SQL execution.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  createInstagramOAuthState,
  getInstagramOAuthStateTtlMs,
  InstagramOAuthStateError,
} from './instagramOAuthState.js';
import instagramOAuthCallbackRouter, {
  setInstagramOAuthCallbackDepsForTests,
  setInstagramOAuthFetchForTests,
} from '../routes/instagramOAuthCallback.js';
import type { InstagramVerifiedAccount } from './instagramApi.js';

const SALON = '11111111-1111-1111-1111-111111111111';

before(() => {
  if (!process.env.INSTAGRAM_APP_SECRET?.trim()) {
    process.env.INSTAGRAM_APP_SECRET = 'test-instagram-app-secret-for-unit-tests';
  }
  process.env.APP_URL = process.env.APP_URL || 'https://app.example.com';
});

afterEach(() => {
  setInstagramOAuthCallbackDepsForTests(null);
  setInstagramOAuthFetchForTests(null);
});

async function withCallbackApp(
  handler: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/integrations/instagram', instagramOAuthCallbackRouter);
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${addr.port}/api/integrations/instagram`;
  try {
    await handler(base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

function redirectParams(location: string | null): URLSearchParams {
  assert.ok(location, 'expected redirect Location');
  return new URL(location, 'https://app.example.com').searchParams;
}

function mockVerifyAccount(): InstagramVerifiedAccount {
  return {
    instagramUserId: '17841400000000001',
    username: 'test_ig',
    accountType: 'BUSINESS',
    accessToken: 'ig-token',
    tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    grantedScopes: [
      'instagram_business_basic',
      'instagram_business_manage_messages',
    ],
  };
}

describe('IG-ACTIVATE-1A cancel/error state burn (executed)', () => {
  beforeEach(() => {
    process.env.INSTAGRAM_APP_SECRET = 'test-instagram-app-secret-for-unit-tests';
  });

  it('1. access_denied + valid state → consume once; no Meta; cancelled', async () => {
    const state = createInstagramOAuthState(SALON);
    let consumeCalls = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async ({ state: s }) => {
        consumeCalls += 1;
        assert.equal(s, state);
        return { salonId: SALON, nonce: 'n1' };
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram'), 'cancelled');
      assert.equal(params.get('instagram_error'), null);
      assert.equal(params.has('state'), false);
      assert.equal(params.has('code'), false);
    });

    assert.equal(consumeCalls, 1);
    assert.equal(verifyCalls, 0);
  });

  it('2. generic Meta error + valid state → consume; no Meta; safe error', async () => {
    const state = createInstagramOAuthState(SALON);
    let consumeCalls = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        consumeCalls += 1;
        return { salonId: SALON, nonce: 'n1' };
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?error=server_error&error_description=boom&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram'), 'error');
      assert.equal(params.get('instagram_error'), 'error');
      assert.ok(!String(res.headers.get('location')).includes('boom'));
      assert.ok(!String(res.headers.get('location')).includes('server_error'));
    });

    assert.equal(consumeCalls, 1);
    assert.equal(verifyCalls, 0);
  });

  it('3. error without state → no consume; no Meta; cancelled', async () => {
    let consumeCalls = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        consumeCalls += 1;
        return { salonId: SALON, nonce: 'n1' };
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(`${base}/callback?error=access_denied`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram'), 'cancelled');
    });

    assert.equal(consumeCalls, 0);
    assert.equal(verifyCalls, 0);
  });

  it('4. tampered state + error → no durable consume success; no Meta', async () => {
    const state = createInstagramOAuthState(SALON);
    const [payload, sig] = state.split('.');
    const tampered = `${payload}.${sig.slice(0, -2)}aa`;
    let consumeCalls = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async ({ state: s }) => {
        consumeCalls += 1;
        // Real parse/consume would reject tamper; simulate app-layer failure.
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_INVALID',
          'OAuth state is invalid',
        );
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?error=access_denied&state=${encodeURIComponent(tampered)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram'), 'error');
      assert.equal(params.get('instagram_error'), 'invalid_state');
    });

    assert.equal(consumeCalls, 1);
    assert.equal(verifyCalls, 0);
  });

  it('5. expired state + error → rejected; no Meta', async () => {
    const expired = createInstagramOAuthState(
      SALON,
      Date.now() - getInstagramOAuthStateTtlMs() - 1000,
    );
    let consumeCalls = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        consumeCalls += 1;
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_EXPIRED',
          'OAuth state has expired',
        );
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?error=access_denied&state=${encodeURIComponent(expired)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram_error'), 'invalid_state');
    });

    assert.equal(consumeCalls, 1);
    assert.equal(verifyCalls, 0);
  });

  it('6. already-consumed + error → replay rejected; no Meta', async () => {
    const state = createInstagramOAuthState(SALON);
    let consumeCalls = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        consumeCalls += 1;
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_REPLAY',
          'OAuth state has already been used',
        );
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram_error'), 'invalid_state');
    });

    assert.equal(consumeCalls, 1);
    assert.equal(verifyCalls, 0);
  });

  it('7. cancel vs success same state → only one CAS winner reaches terminal use', async () => {
    const state = createInstagramOAuthState(SALON);
    let n = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        n += 1;
        if (n === 1) return { salonId: SALON, nonce: 'winner' };
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_REPLAY',
          'OAuth state has already been used',
        );
      },
      requireActiveSalon: async () => true,
      loadConfig: () => ({
        appId: 'app',
        appSecret: 'secret',
        redirectUri: 'https://app.example.com/api/integrations/instagram/callback',
      }),
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
      persistConnection: async () => ({
        ok: true,
        connectionCommitted: true,
        confirmation: 'ok',
        registrySync: 'ok',
        integration: null,
      }),
    });

    await withCallbackApp(async (base) => {
      const [cancelRes, successRes] = await Promise.all([
        fetch(
          `${base}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
          { redirect: 'manual' },
        ),
        fetch(
          `${base}/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
          { redirect: 'manual' },
        ),
      ]);
      assert.equal(cancelRes.status, 302);
      assert.equal(successRes.status, 302);
      const cancel = redirectParams(cancelRes.headers.get('location'));
      const success = redirectParams(successRes.headers.get('location'));
      const terminals = [cancel.get('instagram'), success.get('instagram')];
      // One winner: either cancelled (cancel won) or connected (success won).
      // Loser always invalid_state / error — never a second Meta/connect.
      const winners = terminals.filter((t) => t === 'cancelled' || t === 'connected');
      const losers = terminals.filter((t) => t === 'error');
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      assert.equal(verifyCalls <= 1, true);
      if (winners[0] === 'cancelled') {
        assert.equal(verifyCalls, 0);
      } else {
        assert.equal(verifyCalls, 1);
      }
    });
  });

  it('8. two cancel callbacks same state → one consume winner', async () => {
    const state = createInstagramOAuthState(SALON);
    let n = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        n += 1;
        if (n === 1) return { salonId: SALON, nonce: 'w' };
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_REPLAY',
          'OAuth state has already been used',
        );
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const results = await Promise.all([
        fetch(
          `${base}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
          { redirect: 'manual' },
        ),
        fetch(
          `${base}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
          { redirect: 'manual' },
        ),
      ]);
      const marks = results.map((r) =>
        redirectParams(r.headers.get('location')).get('instagram'),
      );
      assert.equal(marks.filter((m) => m === 'cancelled').length, 1);
      assert.equal(marks.filter((m) => m === 'error').length, 1);
    });
    assert.equal(n, 2);
    assert.equal(verifyCalls, 0);
  });

  it('9. normal success still consumes before Meta exchange', async () => {
    const state = createInstagramOAuthState(SALON);
    const order: string[] = [];
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        order.push('consume');
        return { salonId: SALON, nonce: 'n' };
      },
      requireActiveSalon: async () => true,
      loadConfig: () => ({
        appId: 'app',
        appSecret: 'secret',
        redirectUri: 'https://app.example.com/api/integrations/instagram/callback',
      }),
      verifyConnection: async () => {
        order.push('verify');
        return mockVerifyAccount();
      },
      persistConnection: async () => {
        order.push('persist');
        return {
          ok: true,
          connectionCommitted: true,
          confirmation: 'ok',
          registrySync: 'ok',
          integration: null,
        };
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram'), 'connected');
      assert.equal(params.has('code'), false);
      assert.equal(params.has('state'), false);
      assert.equal(params.has('access_token'), false);
    });
    assert.deepEqual(order, ['consume', 'verify', 'persist']);
  });

  it('10. missing code still consumes; no Meta', async () => {
    const state = createInstagramOAuthState(SALON);
    let consumeCalls = 0;
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        consumeCalls += 1;
        return { salonId: SALON, nonce: 'n' };
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram'), 'error');
      assert.equal(params.get('instagram_error'), 'error');
    });
    assert.equal(consumeCalls, 1);
    assert.equal(verifyCalls, 0);
  });

  it('11. Meta exchange failure leaves state consumed (no restore path)', async () => {
    const state = createInstagramOAuthState(SALON);
    let consumeCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        consumeCalls += 1;
        return { salonId: SALON, nonce: 'n' };
      },
      requireActiveSalon: async () => true,
      loadConfig: () => ({
        appId: 'app',
        appSecret: 'secret',
        redirectUri: 'https://app.example.com/api/integrations/instagram/callback',
      }),
      verifyConnection: async () => {
        const { InstagramApiError } = await import('./instagramApi.js');
        throw new InstagramApiError(
          'INSTAGRAM_PROVIDER_5XX',
          503,
          'provider down',
        );
      },
    });

    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(res.status, 302);
      const params = redirectParams(res.headers.get('location'));
      assert.equal(params.get('instagram_error'), 'provider_unavailable');
    });
    assert.equal(consumeCalls, 1);

    // Second callback with same state: replay, still no restore.
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        consumeCalls += 1;
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_REPLAY',
          'OAuth state has already been used',
        );
      },
      verifyConnection: async () => {
        throw new Error('should_not_verify');
      },
    });
    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(
        redirectParams(res.headers.get('location')).get('instagram_error'),
        'invalid_state',
      );
    });
    assert.equal(consumeCalls, 2);
  });

  it('12. wrong salon consume rejected; no Meta', async () => {
    const state = createInstagramOAuthState(SALON);
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_INVALID',
          'OAuth state is invalid',
        );
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });
    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(
        redirectParams(res.headers.get('location')).get('instagram_error'),
        'invalid_state',
      );
    });
    assert.equal(verifyCalls, 0);
  });

  it('13. unknown nonce rejected; no Meta', async () => {
    const state = createInstagramOAuthState(SALON);
    let verifyCalls = 0;
    setInstagramOAuthCallbackDepsForTests({
      consumeState: async () => {
        throw new InstagramOAuthStateError(
          'INSTAGRAM_OAUTH_STATE_INVALID',
          'OAuth state is invalid',
        );
      },
      verifyConnection: async () => {
        verifyCalls += 1;
        return mockVerifyAccount();
      },
    });
    await withCallbackApp(async (base) => {
      const res = await fetch(
        `${base}/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      assert.equal(
        redirectParams(res.headers.get('location')).get('instagram_error'),
        'invalid_state',
      );
    });
    assert.equal(verifyCalls, 0);
  });
});

describe('IG-ACTIVATE-1A static order', () => {
  it('error branch no longer returns before consume when state present', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src/routes/instagramOAuthCallback.ts'),
      'utf8',
    );
    const handler = src.slice(src.indexOf("router.get('/callback'"));
    // First oauthError handling in the file must not precede consumeState.
    const firstErrorIf = handler.indexOf('if (oauthError)');
    const consumeAt = handler.indexOf('callbackDeps.consumeState');
    const verifyAt = handler.indexOf('callbackDeps.verifyConnection');
    assert.ok(consumeAt >= 0);
    assert.ok(verifyAt > consumeAt);
    assert.ok(firstErrorIf > consumeAt, 'oauthError branch must follow consume attempt');
    // After consume, cancel/error is handled before Meta verify.
    const afterConsume = handler.slice(consumeAt);
    const errorAfterConsume = afterConsume.indexOf('if (oauthError)');
    const verifyRel = afterConsume.indexOf('callbackDeps.verifyConnection');
    assert.ok(errorAfterConsume >= 0 && errorAfterConsume < verifyRel);
  });
});
