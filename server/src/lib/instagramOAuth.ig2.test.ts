/**
 * IG-2 / IG-2A / IG-2B: Instagram Meta OAuth connect tests (mocked Meta HTTP).
 * No real Meta. No SQL execution. No real credentials.
 *
 * Legend:
 * - (executed) unit/mock tests run by npm test
 * - (static) source-presence checks
 * - (reasoned) DB failure cases inferred from control flow (no live DB)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  assertIdentityConsistency,
  assertProfessionalAccountType,
  assertRequiredPermissions,
  buildInstagramAuthorizeUrl,
  exchangeInstagramAuthorizationCode,
  fetchInstagramProfessionalProfile,
  INSTAGRAM_REQUIRED_SCOPES,
  isInstagramApiError,
  loadInstagramAppConfig,
  normalizePermissionsField,
  parseOptionalInstagramOpaqueId,
  parsePositiveExpiresIn,
  parseRequiredInstagramOpaqueId,
  requireVerifiedPermissions,
  verifyInstagramOAuthConnection,
  type InstagramVerifiedAccount,
} from './instagramApi.js';
import {
  buildAuthoritativeInstagramConnectionMutation,
  classifyPostAuthoritativePersistOutcome,
  persistVerifiedInstagramConnection,
  type PersistInstagramDeps,
} from './instagramConnectionPersist.js';
import {
  createInstagramOAuthState,
  getInstagramOAuthStateTtlMs,
  parseInstagramOAuthState,
  InstagramOAuthStateError,
} from './instagramOAuthState.js';
import { encryptInstagramCredential } from './instagramCredentialsCrypto.js';

/** Larger than Number.MAX_SAFE_INTEGER — must stay exact as opaque string. */
const LARGE_IG_ID = '17841400000000001';
const LARGE_IG_ID_OTHER = '17841400000000000';

const ENV_KEYS = [
  'INSTAGRAM_APP_ID',
  'INSTAGRAM_APP_SECRET',
  'INSTAGRAM_REDIRECT_URI',
  'INSTAGRAM_CREDENTIALS_ENCRYPTION_KEY',
  'APP_URL',
] as const;

const previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    previousEnv[key] = process.env[key];
  }
  process.env.INSTAGRAM_APP_ID = 'ig-app-id';
  process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret';
  process.env.INSTAGRAM_REDIRECT_URI = 'https://app.example.com/api/integrations/instagram/callback';
  process.env.INSTAGRAM_CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.APP_URL = 'https://app.example.com';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockMetaPipeline(opts: {
  permissions?: unknown;
  omitPermissions?: boolean;
  exchangeUserId?: unknown;
  omitExchangeUserId?: boolean;
  meUserId?: unknown;
  omitMeUserId?: boolean;
  username?: string;
  accountType?: unknown;
  omitAccountType?: boolean;
  expiresIn?: unknown;
  omitExpiresIn?: boolean;
}): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('api.instagram.com/oauth/access_token')) {
      assert.equal(init?.method, 'POST');
      const body: Record<string, unknown> = {
        access_token: 'SHORT_TOKEN',
      };
      if (!opts.omitExchangeUserId) {
        body.user_id = opts.exchangeUserId === undefined ? LARGE_IG_ID : opts.exchangeUserId;
      }
      if (!opts.omitPermissions) {
        body.permissions =
          opts.permissions === undefined ? [...INSTAGRAM_REQUIRED_SCOPES] : opts.permissions;
      }
      return jsonResponse(200, body);
    }
    if (url.includes('graph.instagram.com/access_token')) {
      const body: Record<string, unknown> = {
        access_token: 'LONG_TOKEN_VALUE',
        token_type: 'bearer',
      };
      if (!opts.omitExpiresIn) {
        body.expires_in = opts.expiresIn === undefined ? 5184000 : opts.expiresIn;
      }
      return jsonResponse(200, body);
    }
    if (url.includes('/me')) {
      const body: Record<string, unknown> = {
        username: opts.username ?? 'salon_demo',
      };
      if (!opts.omitMeUserId) {
        body.user_id = opts.meUserId === undefined ? LARGE_IG_ID : opts.meUserId;
      }
      if (!opts.omitAccountType) {
        body.account_type = opts.accountType === undefined ? 'BUSINESS' : opts.accountType;
      }
      return jsonResponse(200, body);
    }
    return jsonResponse(404, {});
  };
}

describe('IG-2A permissions fail-closed (executed)', () => {
  it('1. permissions absent → INSTAGRAM_PERMISSIONS_UNVERIFIED', async () => {
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          mockMetaPipeline({ omitPermissions: true }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_PERMISSIONS_UNVERIFIED',
    );
  });

  it('2. permissions null → INSTAGRAM_PERMISSIONS_UNVERIFIED', async () => {
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          mockMetaPipeline({ permissions: null }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_PERMISSIONS_UNVERIFIED',
    );
  });

  it('3. permissions empty → INSTAGRAM_PERMISSIONS_UNVERIFIED', async () => {
    assert.equal(normalizePermissionsField([])?.length, 0);
    assert.throws(
      () => requireVerifiedPermissions([]),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_PERMISSIONS_UNVERIFIED',
    );
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          mockMetaPipeline({ permissions: [] }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_PERMISSIONS_UNVERIFIED',
    );
  });

  it('4. basic only → INSTAGRAM_MISSING_PERMISSION', async () => {
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          mockMetaPipeline({ permissions: ['instagram_business_basic'] }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_MISSING_PERMISSION',
    );
  });

  it('5. manage_messages only → INSTAGRAM_MISSING_PERMISSION', async () => {
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          mockMetaPipeline({ permissions: ['instagram_business_manage_messages'] }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_MISSING_PERMISSION',
    );
  });

  it('6. both required → success path continues', async () => {
    const verified = await verifyInstagramOAuthConnection(
      {
        code: 'AUTH_CODE',
        appId: 'ig-app-id',
        appSecret: 'ig-app-secret',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
      },
      mockMetaPipeline({
        permissions: [...INSTAGRAM_REQUIRED_SCOPES],
        exchangeUserId: '17841400000000001',
        meUserId: '17841400000000001',
      }),
    );
    assert.equal(verified.instagramUserId, '17841400000000001');
    assert.equal(verified.accessToken, 'LONG_TOKEN_VALUE');
  });

  it('7/8. grantedScopes from verified permissions only — never fabricated', async () => {
    const verified = await verifyInstagramOAuthConnection(
      {
        code: 'AUTH_CODE',
        appId: 'ig-app-id',
        appSecret: 'ig-app-secret',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
      },
      mockMetaPipeline({
        permissions: [
          'instagram_business_basic',
          'instagram_business_manage_messages',
          'instagram_business_manage_comments',
        ],
        exchangeUserId: '1',
        meUserId: '1',
      }),
    );
    assert.deepEqual(verified.grantedScopes, [
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
    ]);
    // Fabrication would force-insert only required scopes when Meta omitted them.
    assert.throws(
      () => assertRequiredPermissions([]),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_PERMISSIONS_UNVERIFIED',
    );
    assert.equal(normalizePermissionsField(undefined), null);
    assert.equal(normalizePermissionsField({}), null);
  });
});

describe('IG-2B opaque Instagram IDs (executed)', () => {
  it('large string IDs match → success; exact preservation on verified result', async () => {
    assert.ok(BigInt(LARGE_IG_ID) > BigInt(Number.MAX_SAFE_INTEGER));
    const verified = await verifyInstagramOAuthConnection(
      {
        code: 'AUTH_CODE',
        appId: 'ig-app-id',
        appSecret: 'ig-app-secret',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
      },
      mockMetaPipeline({
        exchangeUserId: LARGE_IG_ID,
        meUserId: LARGE_IG_ID,
      }),
    );
    assert.equal(verified.instagramUserId, LARGE_IG_ID);
    assert.notEqual(verified.instagramUserId, LARGE_IG_ID_OTHER);
  });

  it('large string IDs mismatch → INSTAGRAM_IDENTITY_CONFLICT', async () => {
    await assert.rejects(
      () =>
        verifyInstagramOAuthConnection(
          {
            code: 'AUTH_CODE',
            appId: 'ig-app-id',
            appSecret: 'ig-app-secret',
            redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
          },
          mockMetaPipeline({
            exchangeUserId: LARGE_IG_ID,
            meUserId: LARGE_IG_ID_OTHER,
          }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_IDENTITY_CONFLICT',
    );
  });

  it('exchange numeric user_id → INSTAGRAM_INVALID_IDENTITY (fail closed)', async () => {
    // Literal may already be IEEE-rounded; we only assert numeric type is rejected.
    const numericId = Number(LARGE_IG_ID);
    assert.equal(typeof numericId, 'number');
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          mockMetaPipeline({ exchangeUserId: numericId }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_IDENTITY',
    );
    assert.throws(
      () => parseOptionalInstagramOpaqueId(numericId),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_IDENTITY',
    );
  });

  it('/me numeric user_id → INSTAGRAM_INVALID_IDENTITY', async () => {
    const numericId = Number(LARGE_IG_ID);
    await assert.rejects(
      () =>
        fetchInstagramProfessionalProfile(
          'tok',
          async () =>
            jsonResponse(200, {
              user_id: numericId,
              username: 'x',
              account_type: 'BUSINESS',
            }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_IDENTITY',
    );
  });

  it('/me missing user_id → INSTAGRAM_INVALID_IDENTITY', async () => {
    await assert.rejects(
      () =>
        verifyInstagramOAuthConnection(
          {
            code: 'AUTH_CODE',
            appId: 'ig-app-id',
            appSecret: 'ig-app-secret',
            redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
          },
          mockMetaPipeline({ omitExchangeUserId: true, omitMeUserId: true }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_IDENTITY',
    );
    assert.throws(
      () => parseRequiredInstagramOpaqueId(undefined),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_IDENTITY',
    );
    assert.throws(
      () => parseRequiredInstagramOpaqueId(null),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_IDENTITY',
    );
    assert.throws(
      () => parseRequiredInstagramOpaqueId(''),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_IDENTITY',
    );
  });

  it('opaque string ID reaches persistence mutation unchanged', () => {
    const verified: InstagramVerifiedAccount = {
      instagramUserId: LARGE_IG_ID,
      username: 'salon_demo',
      accountType: 'business',
      accessToken: 'LONG_TOKEN_VALUE',
      tokenExpiresAt: null,
      grantedScopes: [...INSTAGRAM_REQUIRED_SCOPES],
    };
    const enc = encryptInstagramCredential(verified.accessToken);
    const mutation = buildAuthoritativeInstagramConnectionMutation(
      'salon-1',
      verified,
      enc,
      new Date().toISOString(),
    );
    assert.equal(mutation.instagram_user_id, LARGE_IG_ID);
    assert.equal(mutation.instagram_user_id, verified.instagramUserId);
  });

  it('leading/trailing whitespace trimmed; opaque compare exact after trim', () => {
    assert.equal(parseRequiredInstagramOpaqueId(`  ${LARGE_IG_ID}  `), LARGE_IG_ID);
    assert.throws(
      () => assertIdentityConsistency(LARGE_IG_ID, LARGE_IG_ID_OTHER),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_IDENTITY_CONFLICT',
    );
    assert.doesNotThrow(() => assertIdentityConsistency(LARGE_IG_ID, LARGE_IG_ID));
    // Opaque: leading-zero difference is a conflict if both present as distinct strings.
    assert.throws(
      () => assertIdentityConsistency('001234', '1234'),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_IDENTITY_CONFLICT',
    );
  });
});

describe('IG-2A identity consistency (executed)', () => {
  it('exchange ID == /me ID (string) → success', async () => {
    const verified = await verifyInstagramOAuthConnection(
      {
        code: 'AUTH_CODE',
        appId: 'ig-app-id',
        appSecret: 'ig-app-secret',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
      },
      mockMetaPipeline({
        exchangeUserId: '17841499',
        meUserId: '17841499',
      }),
    );
    assert.equal(verified.instagramUserId, '17841499');
  });

  it('exchange ID != /me ID → INSTAGRAM_IDENTITY_CONFLICT', async () => {
    await assert.rejects(
      () =>
        verifyInstagramOAuthConnection(
          {
            code: 'AUTH_CODE',
            appId: 'ig-app-id',
            appSecret: 'ig-app-secret',
            redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
          },
          mockMetaPipeline({
            exchangeUserId: '999',
            meUserId: LARGE_IG_ID,
          }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_IDENTITY_CONFLICT',
    );
  });

  it('mismatch → no persistence (verify throws before persist)', async () => {
    await assert.rejects(
      () =>
        verifyInstagramOAuthConnection(
          {
            code: 'AUTH_CODE',
            appId: 'ig-app-id',
            appSecret: 'ig-app-secret',
            redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
          },
          mockMetaPipeline({
            exchangeUserId: 'aaa',
            meUserId: 'bbb',
          }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_IDENTITY_CONFLICT',
    );
  });

  it('exchange ID absent + valid /me ID → allow', async () => {
    const verified = await verifyInstagramOAuthConnection(
      {
        code: 'AUTH_CODE',
        appId: 'ig-app-id',
        appSecret: 'ig-app-secret',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
      },
      mockMetaPipeline({
        omitExchangeUserId: true,
        meUserId: '17841499',
      }),
    );
    assert.equal(verified.instagramUserId, '17841499');
    assert.doesNotThrow(() => assertIdentityConsistency(null, '17841499'));
  });
});

describe('IG-2A professional account validation (executed)', () => {
  it('13. BUSINESS accepted', () => {
    assert.equal(assertProfessionalAccountType('BUSINESS'), 'business');
    assert.equal(assertProfessionalAccountType('business'), 'business');
  });

  it('14. creator + media_creator accepted (current allowlist)', () => {
    assert.equal(assertProfessionalAccountType('Creator'), 'creator');
    assert.equal(assertProfessionalAccountType('media_creator'), 'media_creator');
    assert.equal(assertProfessionalAccountType('Media_Creator'), 'media_creator');
  });

  it('15. PERSONAL rejected', () => {
    assert.throws(
      () => assertProfessionalAccountType('PERSONAL'),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL',
    );
  });

  it('16. null / undefined / empty / unknown rejected', () => {
    for (const value of [null, undefined, '', '   ', 'unknown', 'PERSONAL_ACCOUNT']) {
      assert.throws(
        () => assertProfessionalAccountType(value),
        (err: unknown) =>
          isInstagramApiError(err) && err.code === 'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL',
      );
    }
  });

  it('17. /me personal fails closed', async () => {
    await assert.rejects(
      () =>
        fetchInstagramProfessionalProfile(
          'tok',
          async () =>
            jsonResponse(200, {
              user_id: '1',
              username: 'personal',
              account_type: 'PERSONAL',
            }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL',
    );
  });

  it('18. /me null account_type fails closed', async () => {
    await assert.rejects(
      () =>
        verifyInstagramOAuthConnection(
          {
            code: 'AUTH_CODE',
            appId: 'ig-app-id',
            appSecret: 'ig-app-secret',
            redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
          },
          mockMetaPipeline({ accountType: null }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL',
    );
  });
});

describe('IG-2A token expiry hardening (executed)', () => {
  it('19. positive expires_in works', async () => {
    assert.equal(parsePositiveExpiresIn(5184000), 5184000);
    assert.equal(parsePositiveExpiresIn('3600'), 3600);
    const verified = await verifyInstagramOAuthConnection(
      {
        code: 'AUTH_CODE',
        appId: 'ig-app-id',
        appSecret: 'ig-app-secret',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
      },
      mockMetaPipeline({ expiresIn: 5184000 }),
    );
    assert.ok(verified.tokenExpiresAt);
  });

  it('20. zero / negative / invalid expires_in fail', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '', true, {}]) {
      assert.throws(
        () => parsePositiveExpiresIn(value),
        (err: unknown) =>
          isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_TOKEN_EXPIRY',
      );
    }
  });

  it('21. omitted expires_in → nullable expiry (documented Meta omission)', async () => {
    assert.equal(parsePositiveExpiresIn(undefined), null);
    assert.equal(parsePositiveExpiresIn(null), null);
    const verified = await verifyInstagramOAuthConnection(
      {
        code: 'AUTH_CODE',
        appId: 'ig-app-id',
        appSecret: 'ig-app-secret',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
      },
      mockMetaPipeline({ omitExpiresIn: true }),
    );
    assert.equal(verified.tokenExpiresAt, null);
  });

  it('22. zero expires_in rejects full verify path', async () => {
    await assert.rejects(
      () =>
        verifyInstagramOAuthConnection(
          {
            code: 'AUTH_CODE',
            appId: 'ig-app-id',
            appSecret: 'ig-app-secret',
            redirectUri: process.env.INSTAGRAM_REDIRECT_URI!,
          },
          mockMetaPipeline({ expiresIn: 0 }),
        ),
      (err: unknown) =>
        isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_TOKEN_EXPIRY',
    );
  });
});

describe('IG-2 OAuth state (executed)', () => {
  it('OAuth state generated binds salonId', () => {
    const state = createInstagramOAuthState('salon-aaa');
    const parsed = parseInstagramOAuthState(state);
    assert.equal(parsed.salonId, 'salon-aaa');
    assert.ok(state.includes('.'));
  });

  it('invalid and expired/tampered state rejected', () => {
    assert.throws(() => parseInstagramOAuthState('not-a-state'), InstagramOAuthStateError);
    const state = createInstagramOAuthState('salon-bbb');
    const [payload, sig] = state.split('.');
    assert.throws(
      () => parseInstagramOAuthState(`${payload}.${sig.slice(0, -2)}aa`),
      (err: unknown) =>
        err instanceof InstagramOAuthStateError && err.code === 'INSTAGRAM_OAUTH_STATE_INVALID',
    );
    const expired = createInstagramOAuthState(
      'salon-ccc',
      Date.now() - getInstagramOAuthStateTtlMs() - 1000,
    );
    assert.throws(
      () => parseInstagramOAuthState(expired),
      (err: unknown) =>
        err instanceof InstagramOAuthStateError && err.code === 'INSTAGRAM_OAUTH_STATE_EXPIRED',
    );
  });
});

describe('IG-2 Meta client mocks (executed)', () => {
  it('Meta exchange timeout', async () => {
    const fetchImpl: typeof fetch = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          fetchImpl,
        ),
      (err: unknown) => isInstagramApiError(err) && err.code === 'INSTAGRAM_TIMEOUT',
    );
  });

  it('Meta 4xx / 5xx / invalid token safe classification', async () => {
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          async () => jsonResponse(400, { error: 'bad' }),
        ),
      (err: unknown) => isInstagramApiError(err) && err.code === 'INSTAGRAM_PROVIDER_4XX',
    );
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode(
          {
            code: 'x',
            appId: 'a',
            appSecret: 'b',
            redirectUri: 'https://example.com/cb',
          },
          async () => jsonResponse(503, { error: 'down' }),
        ),
      (err: unknown) => isInstagramApiError(err) && err.code === 'INSTAGRAM_PROVIDER_5XX',
    );
    await assert.rejects(
      () => fetchInstagramProfessionalProfile('bad', async () => jsonResponse(401, {})),
      (err: unknown) => isInstagramApiError(err) && err.code === 'INSTAGRAM_INVALID_TOKEN',
    );
  });

  it('token encrypted; plaintext absent from ciphertext material', () => {
    const plaintext = 'LONG_TOKEN_PLAINTEXT_SECRET';
    const enc = encryptInstagramCredential(plaintext);
    assert.notEqual(enc.ciphertext, plaintext);
    assert.ok(!enc.ciphertext.includes(plaintext));
    assert.ok(!JSON.stringify(enc).includes(plaintext));
  });

  it('loads config and builds authorize URL with required scopes + state', () => {
    const cfg = loadInstagramAppConfig();
    assert.equal(cfg.appId, 'ig-app-id');
    const url = buildInstagramAuthorizeUrl({
      appId: cfg.appId,
      redirectUri: cfg.redirectUri,
      state: 'STATE123',
    });
    assert.ok(url.startsWith('https://www.instagram.com/oauth/authorize'));
    assert.ok(url.includes('client_id=ig-app-id'));
    assert.ok(url.includes('state=STATE123'));
    assert.ok(url.includes('instagram_business_basic'));
    assert.ok(url.includes('instagram_business_manage_messages'));
    assert.ok(!url.includes('instagram_business_manage_comments'));
    assert.ok(!url.includes('content_publish'));
  });

  it('blank code rejected', async () => {
    await assert.rejects(
      () =>
        exchangeInstagramAuthorizationCode({
          code: '   ',
          appId: 'a',
          appSecret: 'b',
          redirectUri: 'https://example.com/cb',
        }),
      (err: unknown) => isInstagramApiError(err),
    );
  });
});

describe('IG-2B persistence semantics (executed mocks)', () => {
  const verified: InstagramVerifiedAccount = {
    instagramUserId: LARGE_IG_ID,
    username: 'salon_demo',
    accountType: 'business',
    accessToken: 'LONG_TOKEN_PLAINTEXT_SECRET',
    tokenExpiresAt: null,
    grantedScopes: [...INSTAGRAM_REQUIRED_SCOPES],
  };

  const connectedIntegration = {
    salonId: 'salon-1',
    salonName: 'Demo',
    slug: 'demo',
    connected: true,
    connection: {
      id: 'row-1',
      salonId: 'salon-1',
      status: 'connected' as const,
      instagramUserId: LARGE_IG_ID,
      instagramUsername: 'salon_demo',
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastWebhookAt: null,
      lastError: null,
      tokenExpiresAt: null,
      isAccessTokenStored: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  function deps(overrides: Partial<PersistInstagramDeps> = {}): PersistInstagramDeps {
    return {
      findCrossSalonAccount: async () => ({ otherSalon: false, storageError: false }),
      upsertConnection: async () => ({ uniqueViolation: false, error: false }),
      markRegistryConnected: async () => true,
      loadPublicIntegration: async () => connectedIntegration,
      ...overrides,
    };
  }

  it('authoritative upsert fails → ok:false (old remains / no connected marker)', async () => {
    const result = await persistVerifiedInstagramConnection(
      'salon-1',
      verified,
      deps({
        upsertConnection: async () => ({ uniqueViolation: false, error: true }),
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE');
    }
  });

  it('upsert ok + read-back ok + registry ok → normal success', async () => {
    const result = await persistVerifiedInstagramConnection('salon-1', verified, deps());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.connectionCommitted, true);
      assert.equal(result.confirmation, 'ok');
      assert.equal(result.registrySync, 'ok');
      assert.equal(result.integration?.connection?.instagramUserId, LARGE_IG_ID);
    }
  });

  it('upsert ok + read-back fails → connected + confirmation pending (NOT error)', async () => {
    const result = await persistVerifiedInstagramConnection(
      'salon-1',
      verified,
      deps({
        loadPublicIntegration: async () => {
          throw new Error('transient read failure');
        },
      }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.connectionCommitted, true);
      assert.equal(result.confirmation, 'pending');
      assert.equal(result.registrySync, 'ok');
    }
  });

  it('upsert ok + registry fails → connected + registry pending', async () => {
    const result = await persistVerifiedInstagramConnection(
      'salon-1',
      verified,
      deps({
        markRegistryConnected: async () => false,
      }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.confirmation, 'ok');
      assert.equal(result.registrySync, 'pending');
    }
  });

  it('upsert ok + read-back and registry both fail → still connected + pending markers', async () => {
    const result = await persistVerifiedInstagramConnection(
      'salon-1',
      verified,
      deps({
        loadPublicIntegration: async () => null,
        markRegistryConnected: async () => false,
      }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.connectionCommitted, true);
      assert.equal(result.confirmation, 'pending');
      assert.equal(result.registrySync, 'pending');
    }
    const classified = classifyPostAuthoritativePersistOutcome({
      readBackConnected: false,
      registryMarked: false,
    });
    assert.deepEqual(classified, { confirmation: 'pending', registrySync: 'pending' });
  });

  it('no raw DB error strings in persist success/error public messages', async () => {
    const fail = await persistVerifiedInstagramConnection(
      'salon-1',
      verified,
      deps({
        upsertConnection: async () => ({ uniqueViolation: false, error: true }),
      }),
    );
    assert.equal(fail.ok, false);
    if (!fail.ok) {
      assert.doesNotMatch(fail.error.message, /42P01|SQL|postgres|supabase/i);
    }
  });
});

describe('IG-2A/B persistence / reconnect / security (static + reasoned)', () => {
  const igRoutes = readFileSync(new URL('../routes/instagramIntegrations.ts', import.meta.url), 'utf8');
  const callback = readFileSync(new URL('../routes/instagramOAuthCallback.ts', import.meta.url), 'utf8');
  const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const persist = readFileSync(new URL('./instagramConnectionPersist.ts', import.meta.url), 'utf8');
  const apiSrc = readFileSync(new URL('./instagramApi.ts', import.meta.url), 'utf8');
  const stateSrc = readFileSync(new URL('./instagramOAuthState.ts', import.meta.url), 'utf8');
  const uiTab = readFileSync(
    new URL('../../../client/src/components/developer/InstagramIntegrationsTab.tsx', import.meta.url),
    'utf8',
  );
  const uiCard = readFileSync(
    new URL('../../../client/src/components/developer/SalonInstagramCard.tsx', import.meta.url),
    'utf8',
  );
  const mig2 = readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000002_instagram_token_expires_at.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it('connection write failure → no success (static)', () => {
    assert.match(persist, /upsert\.error/);
    assert.match(persist, /ok: false/);
  });

  it('post-authoritative read-back/registry pending — never ok:false after upsert (static)', () => {
    assert.match(persist, /Authoritative record: instagram_business_connections/);
    assert.match(persist, /Authoritative connection committed/);
    assert.match(persist, /confirmation: 'ok' \| 'pending'/);
    assert.match(persist, /registrySync: 'ok' \| 'pending'/);
    assert.match(persist, /classifyPostAuthoritativePersistOutcome/);
    assert.match(callback, /instagram_confirmation/);
    assert.match(callback, /instagram_registry/);
    assert.match(callback, /instagram: 'connected'/);
    assert.doesNotMatch(persist, /could not be confirmed/);
  });

  it('opaque ID parsers reject numbers; no String\(number\) identity coercion (static)', () => {
    assert.match(apiSrc, /parseRequiredInstagramOpaqueId/);
    assert.match(apiSrc, /INSTAGRAM_INVALID_IDENTITY/);
    assert.doesNotMatch(apiSrc, /typeof value === 'number' && Number\.isFinite/);
    assert.doesNotMatch(apiSrc, /String\(value\)/);
    assert.match(uiTab, /instagram_confirmation/);
    assert.match(uiTab, /oauthConnectedPending/);
  });

  it('reconnect: verification failures occur before persist (static + reasoned)', () => {
    const verifyIdx = callback.indexOf('verifyInstagramOAuthConnection');
    const persistIdx = callback.indexOf('persistVerifiedInstagramConnection');
    assert.ok(verifyIdx >= 0 && persistIdx > verifyIdx);
    assert.match(apiSrc, /assertIdentityConsistency/);
    assert.doesNotMatch(persist, /access_token_ciphertext:\s*null/);
  });

  it('callback/error safety — no secrets in redirect markers', () => {
    assert.match(callback, /mapSafeErrorCode/);
    assert.match(callback, /invalid_identity/);
    assert.match(callback, /identity_conflict/);
    assert.doesNotMatch(callback, /access_token=/);
    assert.doesNotMatch(callback, /searchParams\.set\('code'/);
  });

  it('OAuth state is durable single-use; callback consumes before token verify', () => {
    assert.ok(stateSrc.includes('createPersistedInstagramOAuthState'));
    assert.ok(callback.includes('consumeInstagramOAuthState'));
    // Compare call sites inside the route handler (imports list verify first).
    const handler = callback.slice(callback.indexOf("router.get('/callback'"));
    const consumeIdx = handler.indexOf('callbackDeps.consumeState');
    const verifyIdx = handler.indexOf('callbackDeps.verifyConnection');
    assert.ok(consumeIdx >= 0 && verifyIdx > consumeIdx);
    // Cancel/error with state burns via the same consume (IG-ACTIVATE-1A).
    assert.ok(handler.indexOf('if (oauthError)') > consumeIdx);
  });

  it('connect/start developer-mounted; callback outside Bearer', () => {
    assert.match(igRoutes, /router\.post\('\/:salonId\/connect\/start'/);
    assert.match(
      indexSrc,
      /app\.use\('\/api\/integrations\/instagram',\s*instagramOAuthCallbackRouter\)/,
    );
    assert.doesNotMatch(callback, /requireDeveloperAuth/);
  });

  it('frontend Connect has no credential fields; markers cleared', () => {
    assert.match(uiTab, /startInstagramConnect/);
    assert.match(uiTab, /delete\('instagram_confirmation'\)/);
    assert.match(uiTab, /delete\('instagram_registry'\)/);
    assert.doesNotMatch(uiTab, /accessToken|appSecret|password|type=\"password\"/);
    assert.doesNotMatch(uiCard, /accessToken|appSecret|type=\"password\"/);
  });

  it('Telegram / Apple / WhatsApp runtime unchanged (static presence)', () => {
    const wa = readFileSync(new URL('../routes/whatsappWebhook.ts', import.meta.url), 'utf8');
    assert.match(wa, /whatsapp/);
    const tg = readFileSync(new URL('./telegramBotManager.ts', import.meta.url), 'utf8');
    assert.match(tg, /telegram/i);
    const apple = readFileSync(new URL('./calendarCredentialsCrypto.ts', import.meta.url), 'utf8');
    assert.match(apple, /CALENDAR_CREDENTIALS_ENCRYPTION_KEY/);
  });

  it('schema additive token_expires_at only; grantedScopes not fabricated', () => {
    assert.match(mig2, /ADD COLUMN IF NOT EXISTS token_expires_at/);
    // IG-3 mounts messaging webhook separately from IG-2 OAuth callback.
    assert.match(indexSrc, /\/api\/webhooks\/instagram/);
    assert.match(indexSrc, /\/api\/integrations\/instagram/);
    assert.doesNotMatch(
      apiSrc,
      /grantedScopes:\s*\[\s*\.\.\.INSTAGRAM_REQUIRED_SCOPES/,
    );
    assert.match(apiSrc, /grantedScopes: \[\.\.\.shortLived\.permissions\]/);
  });
});
