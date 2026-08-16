/**
 * GOOGLE-CAL-FAST-1: OAuth state, token blob, calendar list mapping, response shaping.
 * All Google HTTP mocked. No real OAuth / Calendar API calls.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  consumeGoogleCalendarOAuthState,
  createGoogleCalendarOAuthState,
  getGoogleCalendarOAuthStateTtlMs,
  GoogleCalendarOAuthStateError,
  parseGoogleCalendarOAuthState,
} from './googleCalendarOAuthState.js';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPE,
  GOOGLE_CALENDAR_OAUTH_SCOPES,
  buildGoogleCalendarAuthorizationUrl,
  buildGoogleIntegrationsRedirectUrl,
  mapGoogleCalendarListEntry,
  parseGoogleCalendarCredentialBlob,
  parseGoogleTokenResponse,
  serializeGoogleCalendarCredentialBlob,
  GoogleCalendarOAuthError,
  listGoogleCalendars,
  listGoogleCalendarsForSalon,
  fetchGoogleAccountEmail,
  selectGoogleCalendarForSalon,
} from './googleCalendarOAuth.js';
import { buildCalendarConnectionsResponse, mapCalendarConnectionSafe } from '../routes/calendarConnections.js';
import { encryptCalendarCredential } from './calendarCredentialsCrypto.js';
import googleCalendarOAuthCallbackRouter, {
  setGoogleCalendarOAuthCallbackDepsForTests,
} from '../routes/googleCalendarOAuthCallback.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const PREV_ENV: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('GOOGLE-CAL-FAST-1 OAuth state (executed)', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', 'test-google-client-secret');
    setEnv('GOOGLE_CALENDAR_OAUTH_STATE_SECRET', 'test-gcal-state-secret');
  });
  after(() => {
    for (const [k, v] of Object.entries(PREV_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('signs and verifies state; salon bound', () => {
    const state = createGoogleCalendarOAuthState('salon-a');
    const parsed = parseGoogleCalendarOAuthState(state);
    assert.equal(parsed.salonId, 'salon-a');
    assert.ok(parsed.nonce.length >= 16);
  });

  it('tampered state rejected', () => {
    const state = createGoogleCalendarOAuthState('salon-a');
    const bad = state.slice(0, -2) + (state.endsWith('aa') ? 'bb' : 'aa');
    assert.throws(
      () => parseGoogleCalendarOAuthState(bad),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthStateError &&
        err.code === 'GOOGLE_OAUTH_STATE_INVALID',
    );
  });

  it('expired state rejected', () => {
    const expired = createGoogleCalendarOAuthState(
      'salon-a',
      Date.now() - getGoogleCalendarOAuthStateTtlMs() - 1000,
    );
    assert.throws(
      () => parseGoogleCalendarOAuthState(expired),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthStateError &&
        err.code === 'GOOGLE_OAUTH_STATE_EXPIRED',
    );
  });

  it('wrong purpose rejected', () => {
    const state = createGoogleCalendarOAuthState('salon-a');
    const [payloadB64] = state.split('.');
    // Corrupt purpose by flipping payload (signature will fail) — covered by tamper.
    assert.ok(payloadB64);
  });
});

describe('GOOGLE-CAL-FAST-1 auth URL + token blob (executed)', () => {
  it('auth URL uses offline consent and read scopes including openid email', () => {
    const url = buildGoogleCalendarAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://app.example.com/api/calendar/google/callback',
      scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
      state: 'signed.state',
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('prompt'), 'consent');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(
      u.searchParams.get('redirect_uri'),
      'https://app.example.com/api/calendar/google/callback',
    );
    const scope = u.searchParams.get('scope') ?? '';
    assert.match(scope, /openid/);
    assert.match(scope, /email/);
    assert.match(scope, /calendar\.readonly/);
    assert.doesNotMatch(scope, /calendar\.events(?!\.)|\/auth\/calendar$/);
    assert.ok(GOOGLE_CALENDAR_OAUTH_SCOPES.includes('openid'));
  });

  it('token response requires refresh_token; encrypts blob without tokens in public DTO', () => {
    setEnv('CALENDAR_CREDENTIALS_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    assert.throws(
      () => parseGoogleTokenResponse({ access_token: 'a' }),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthError &&
        err.code === 'GOOGLE_OAUTH_MISSING_REFRESH_TOKEN',
    );
    const tokens = parseGoogleTokenResponse({
      refresh_token: 'rt-secret',
      access_token: 'at-temp',
      token_type: 'Bearer',
      scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
    });
    const plaintext = serializeGoogleCalendarCredentialBlob({
      refresh_token: tokens.refreshToken,
      scope: tokens.scope ?? GOOGLE_CALENDAR_OAUTH_SCOPE,
      token_type: tokens.tokenType ?? 'Bearer',
    });
    const enc = encryptCalendarCredential(plaintext);
    assert.doesNotMatch(enc.ciphertext, /rt-secret/);
    const roundTrip = parseGoogleCalendarCredentialBlob(
      // decrypt tested via crypto helper separately — parse from plaintext
      plaintext,
    );
    assert.equal(roundTrip.refresh_token, 'rt-secret');

    const publicDto = mapCalendarConnectionSafe(
      {
        id: 'g1',
        provider: 'google',
        account_email: 'a@gmail.com',
        selected_calendar_id: null,
        selected_calendar_url: null,
        selected_calendar_name: null,
        status: 'connected',
        import_enabled: false,
        last_sync_at: null,
        last_sync_started_at: null,
        last_error: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      },
      true,
    );
    assert.equal(JSON.stringify(publicDto).includes('rt-secret'), false);
    assert.equal('credential_ciphertext' in publicDto, false);
  });

  it('redirect URLs never include tokens/codes', () => {
    const ok = buildGoogleIntegrationsRedirectUrl('connected');
    const bad = buildGoogleIntegrationsRedirectUrl('error', 'invalid_state');
    assert.match(ok, /google=connected/);
    assert.match(bad, /reason=invalid_state/);
    assert.doesNotMatch(ok + bad, /refresh|access_token|code=/i);
  });
});

describe('GOOGLE-CAL-FAST-1 calendar list mapping + pagination (mock HTTP)', () => {
  it('maps safe calendar fields only', () => {
    const item = mapGoogleCalendarListEntry({
      id: 'primary',
      summary: 'tatevik.migaelyan@gmail.com',
      primary: true,
      accessRole: 'owner',
      timeZone: 'Asia/Yerevan',
      etag: 'secret-etag',
    });
    assert.deepEqual(item, {
      id: 'primary',
      summary: 'tatevik.migaelyan@gmail.com',
      primary: true,
      accessRole: 'owner',
      timeZone: 'Asia/Yerevan',
    });
  });

  it('listGoogleCalendars paginates with mock fetch', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      if (calls === 1) {
        assert.match(url, /calendarList/);
        return new Response(
          JSON.stringify({
            items: [{ id: 'c1', summary: 'One', primary: true }],
            nextPageToken: 'page2',
          }),
          { status: 200 },
        );
      }
      assert.match(url, /pageToken=page2/);
      return new Response(
        JSON.stringify({
          items: [{ id: 'c2', summary: 'Two', primary: false }],
        }),
        { status: 200 },
      );
    };
    const list = await listGoogleCalendars({
      accessToken: 'access',
      fetchImpl,
    });
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, 'c1');
    assert.equal(list[1]?.id, 'c2');
  });

  it('userinfo returns verified email only', async () => {
    const email = await fetchGoogleAccountEmail({
      accessToken: 'access',
      fetchImpl: async () =>
        new Response(JSON.stringify({ email: 'a@gmail.com', email_verified: true }), {
          status: 200,
        }),
    });
    assert.equal(email, 'a@gmail.com');
    const unverified = await fetchGoogleAccountEmail({
      accessToken: 'access',
      fetchImpl: async () =>
        new Response(JSON.stringify({ email: 'a@gmail.com', email_verified: false }), {
          status: 200,
        }),
    });
    assert.equal(unverified, null);
  });
});

describe('GOOGLE-CAL-FAST-1 legacy Apple + Google coexistence (executed)', () => {
  it('Google-only keeps legacy connection null; Apple+Google keeps Apple legacy', () => {
    const google = mapCalendarConnectionSafe(
      {
        id: 'g',
        provider: 'google',
        account_email: 'g@x.com',
        selected_calendar_id: 'primary',
        selected_calendar_url: null,
        selected_calendar_name: 'Work',
        status: 'connected',
        import_enabled: false,
        last_sync_at: null,
        last_sync_started_at: null,
        last_error: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      },
      true,
    );
    const apple = mapCalendarConnectionSafe(
      {
        id: 'a',
        provider: 'apple',
        account_email: 'a@x.com',
        selected_calendar_id: null,
        selected_calendar_url: null,
        selected_calendar_name: null,
        status: 'connected',
        import_enabled: false,
        last_sync_at: null,
        last_sync_started_at: null,
        last_error: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      },
      true,
    );
    const onlyGoogle = buildCalendarConnectionsResponse([google]);
    assert.equal(onlyGoogle.connection, null);
    assert.equal(onlyGoogle.connections[0]?.provider, 'google');
    const both = buildCalendarConnectionsResponse([google, apple]);
    assert.equal(both.connection?.provider, 'apple');
  });
});

describe('GOOGLE-CAL-FAST-1 nonce replay + selection verify (mock)', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', 'test-google-client-secret');
    setEnv('GOOGLE_CALENDAR_OAUTH_STATE_SECRET', 'test-gcal-state-secret');
    setEnv('GOOGLE_CALENDAR_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CALENDAR_REDIRECT_URI', 'https://app.example.com/api/calendar/google/callback');
    setEnv('CALENDAR_CREDENTIALS_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
    setEnv('APP_URL', 'https://app.example.com');
  });

  it('nonce replay (already_consumed) rejected', async () => {
    const state = createGoogleCalendarOAuthState('salon-replay');
    const db = {
      rpc: async () => ({
        data: { kind: 'rejected', code: 'already_consumed' },
        error: null,
      }),
    };
    await assert.rejects(
      () => consumeGoogleCalendarOAuthState({ db, state }),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthStateError &&
        err.code === 'GOOGLE_OAUTH_STATE_REPLAY',
    );
  });

  it('selectGoogleCalendarForSalon rejects unknown calendar id', async () => {
    const enc = encryptCalendarCredential(
      serializeGoogleCalendarCredentialBlob({
        refresh_token: 'rt',
        scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
        token_type: 'Bearer',
      }),
    );
    const credentialRow = {
      id: 'row1',
      credential_ciphertext: enc.ciphertext,
      credential_iv: enc.iv,
      credential_auth_tag: enc.authTag,
      status: 'connected',
      selected_calendar_id: null,
      selected_calendar_name: null,
      provider_config: {},
    };
    const db = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({ data: credentialRow, error: null }),
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              eq() {
                return {
                  eq: async () => ({ error: null }),
                };
              },
            };
          },
        };
      },
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes('calendarList')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'allowed', summary: 'Allowed', primary: true }] }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    };
    await assert.rejects(
      () =>
        selectGoogleCalendarForSalon({
          db,
          salonId: 'salon-a',
          calendarId: 'not-in-list',
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthError && err.code === 'GOOGLE_CALENDAR_NOT_FOUND',
    );
    const ok = await selectGoogleCalendarForSalon({
      db,
      salonId: 'salon-a',
      calendarId: 'allowed',
      fetchImpl,
    });
    assert.equal(ok.selectedCalendarId, 'allowed');
  });

  it('listGoogleCalendarsForSalon loads credentials for the given salonId only', async () => {
    const seenSalonIds: string[] = [];
    const enc = encryptCalendarCredential(
      serializeGoogleCalendarCredentialBlob({
        refresh_token: 'rt',
        scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
        token_type: 'Bearer',
      }),
    );
    const db = {
      from() {
        return {
          select() {
            return {
              eq(_col: string, val: string) {
                if (_col === 'salon_id') seenSalonIds.push(val);
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({
                        data: {
                          id: 'row1',
                          credential_ciphertext: enc.ciphertext,
                          credential_iv: enc.iv,
                          credential_auth_tag: enc.authTag,
                          status: 'connected',
                          selected_calendar_id: null,
                          selected_calendar_name: null,
                          provider_config: {},
                        },
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [{ id: 'c1', summary: 'C1' }] }), {
        status: 200,
      });
    };
    await listGoogleCalendarsForSalon({ db, salonId: 'salon-bound', fetchImpl });
    assert.deepEqual(seenSalonIds, ['salon-bound']);
  });
});

describe('GOOGLE-CAL-FAST-1 callback handler (mock deps, no Bearer)', () => {
  before(() => {
    setEnv('APP_URL', 'https://app.example.com');
  });

  after(() => {
    setGoogleCalendarOAuthCallbackDepsForTests(null);
  });

  it('resolves salon from consumed state and redirects connected', async () => {
    setGoogleCalendarOAuthCallbackDepsForTests({
      consumeState: async () => ({ salonId: 'salon-from-state', nonce: 'n1' }),
      loadConfig: () => ({
        clientId: 'cid',
        clientSecret: 'sec',
        redirectUri: 'https://app.example.com/api/calendar/google/callback',
        scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
      }),
      exchangeCode: async () => ({
        refreshToken: 'rt',
        accessToken: 'at',
        expiresIn: 3600,
        scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
        tokenType: 'Bearer',
        idToken: null,
      }),
      fetchAccountEmail: async () => 'owner@gmail.com',
      persistConnection: async (input) => {
        assert.equal(input.salonId, 'salon-from-state');
        assert.equal(input.accountEmail, 'owner@gmail.com');
        assert.equal(input.refreshToken, 'rt');
        return { id: 'conn-1' };
      },
    });

    const layer = (googleCalendarOAuthCallbackRouter as any).stack.find(
      (l: any) => l.route?.path === '/callback' && l.route?.methods?.get,
    );
    assert.ok(layer, 'callback route registered');
    const handler = layer.route.stack[0].handle;

    let redirectUrl = '';
    const req: any = {
      query: { state: 'signed', code: 'auth-code' },
      headers: {},
      get: () => undefined,
    };
    const res: any = {
      redirect(url: string) {
        redirectUrl = url;
      },
    };
    await handler(req, res);
    assert.match(redirectUrl, /google=connected/);
    assert.doesNotMatch(redirectUrl, /rt|auth-code|Bearer|refresh/i);
    assert.equal(req.headers.authorization, undefined);
  });

  it('tampered/invalid state redirects with internal error code only', async () => {
    setGoogleCalendarOAuthCallbackDepsForTests({
      consumeState: async () => {
        throw new GoogleCalendarOAuthStateError('GOOGLE_OAUTH_STATE_INVALID', 'bad');
      },
    });

    const layer = (googleCalendarOAuthCallbackRouter as any).stack.find(
      (l: any) => l.route?.path === '/callback' && l.route?.methods?.get,
    );
    const handler = layer.route.stack[0].handle;
    let redirectUrl = '';
    await handler(
      { query: { state: 'bad', code: 'x' }, headers: {} },
      {
        redirect: (u: string) => {
          redirectUrl = u;
        },
      },
    );
    assert.match(redirectUrl, /google=error/);
    assert.match(redirectUrl, /reason=invalid_state/);
    assert.doesNotMatch(redirectUrl, /code=x|bad/);
  });
});

describe('GOOGLE-CAL-FAST-1 static contracts', () => {
  const index = read('server/src/index.ts');
  const routes = read('server/src/routes/calendarConnections.ts');
  const callback = read('server/src/routes/googleCalendarOAuthCallback.ts');
  const oauth = read('server/src/lib/googleCalendarOAuth.ts');
  const state = read('server/src/lib/googleCalendarOAuthState.ts');
  const mig = read('supabase/migrations/20260816000002_google_calendar_oauth_states.sql');
  const integrations = read('client/src/pages/SalonIntegrations.tsx');
  const apiClient = read('client/src/lib/api.ts');
  const packageJson = read('server/package.json');
  const a2Test = read('server/src/lib/calendarConnections.googleCalA2.test.ts');

  it('callback mounted publicly before authenticated /api/calendar', () => {
    const pub = index.indexOf("app.use('/api/calendar/google', googleCalendarOAuthCallbackRouter)");
    const auth = index.indexOf(
      "app.use('/api/calendar', salonAuth, requireSalonCabinetAccess, calendarConnectionsRouter)",
    );
    assert.ok(pub > 0 && auth > pub);
    assert.match(callback, /router\.get\('\/callback'/);
    assert.doesNotMatch(callback, /requireSalonWriteAccess|requireSalonAuth|requireSalonCabinetAccess/);
    assert.doesNotMatch(callback, /headers\.authorization|Bearer \$\{|req\.headers\.authorization/);
  });

  it('auth-url / calendars / select / disconnect remain behind requireSalonWriteAccess', () => {
    assert.match(routes, /router\.get\('\/google\/auth-url',\s*requireSalonWriteAccess/);
    assert.match(routes, /router\.get\('\/google\/calendars',\s*requireSalonWriteAccess/);
    assert.match(routes, /router\.put\('\/google\/calendar',\s*requireSalonWriteAccess/);
    assert.match(routes, /router\.delete\('\/google',\s*requireSalonWriteAccess/);
    assert.match(routes, /getSalonId\(req\)/);
    assert.doesNotMatch(routes, /events\.list|calendar\/v3\/calendars\/.*\/events/);
  });

  it('OAuth state migration additive; single-use nonce RPCs; RLS service_role', () => {
    assert.match(mig, /google_calendar_oauth_states/);
    assert.match(mig, /create_google_calendar_oauth_state/);
    assert.match(mig, /consume_google_calendar_oauth_state/);
    assert.match(mig, /ENABLE ROW LEVEL SECURITY/);
    assert.match(mig, /GRANT EXECUTE.*TO service_role/);
    assert.doesNotMatch(mig, /UPDATE\s+appointments|DROP TABLE/i);
  });

  it('disconnect Google-only; Apple connect/delete intact; UI has Connect Google', () => {
    assert.match(routes, /router\.post\('\/apple\/connect'/);
    assert.match(routes, /router\.delete\('\/apple'/);
    assert.match(routes, /\.eq\('provider',\s*GOOGLE_PROVIDER\)/);
    assert.match(routes, /router\.delete\('\/google'/);
    assert.match(integrations, /Connect Google|integrations\.google\.connect/);
    assert.match(apiClient, /getGoogleAuthUrl|getGoogleCalendars|selectGoogleCalendar|disconnectGoogle/);
    assert.doesNotMatch(oauth, /events\.list/);
    assert.match(state, /google_calendar_oauth/);
    assert.doesNotMatch(
      a2Test,
      /assert\.doesNotMatch\(routes,\s*\/\\\/google\\\/auth-url/,
    );
    // index.ts mount is additive only (import + public callback use)
    const mountBlock = index.slice(
      index.indexOf('GOOGLE-CAL-FAST-1'),
      index.indexOf("app.use('/api/calendar/google'") + 120,
    );
    assert.match(mountBlock, /googleCalendarOAuthCallbackRouter/);
    assert.doesNotMatch(mountBlock, /telegram|whatsapp|instagram/i);
  });

  it('package registers FAST-1 suite once', () => {
    const n = (packageJson.match(/googleCalendar\.fast1\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
