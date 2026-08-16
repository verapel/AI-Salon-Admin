/**
 * GOOGLE-CAL-FAST-1: Public Google Calendar OAuth callback (browser redirect).
 * NOT under salonAuth — security = signed + single-use OAuth state.
 * No event import. No appointment/client/reminder writes.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import {
  GoogleCalendarOAuthStateError,
  consumeGoogleCalendarOAuthState,
} from '../lib/googleCalendarOAuthState.js';
import {
  GoogleCalendarOAuthError,
  buildGoogleIntegrationsRedirectUrl,
  exchangeGoogleAuthorizationCode,
  fetchGoogleAccountEmail,
  loadGoogleCalendarAppConfig,
  mapGoogleOAuthErrorToRedirectReason,
  persistGoogleCalendarConnection,
  type GoogleFetch,
} from '../lib/googleCalendarOAuth.js';

const router = Router();

export let googleOAuthFetch: GoogleFetch = fetch;

export function setGoogleOAuthFetchForTests(fetchImpl: GoogleFetch | null): void {
  googleOAuthFetch = fetchImpl ?? fetch;
}

export type GoogleCalendarOAuthCallbackDeps = {
  consumeState: (params: {
    state: string;
  }) => Promise<{ salonId: string; nonce: string }>;
  loadConfig: () => ReturnType<typeof loadGoogleCalendarAppConfig>;
  exchangeCode: (input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }) => Promise<{
    refreshToken: string;
    accessToken: string | null;
    expiresIn: number | null;
    scope: string | null;
    tokenType: string | null;
    idToken: string | null;
  }>;
  fetchAccountEmail: (accessToken: string) => Promise<string | null>;
  persistConnection: (input: {
    salonId: string;
    refreshToken: string;
    scope: string | null;
    tokenType: string | null;
    accountEmail: string | null;
  }) => Promise<{ id: string }>;
};

function createDefaultDeps(): GoogleCalendarOAuthCallbackDeps {
  return {
    consumeState: ({ state }) =>
      consumeGoogleCalendarOAuthState({
        db: supabase as any,
        state,
      }),
    loadConfig: loadGoogleCalendarAppConfig,
    exchangeCode: (input) =>
      exchangeGoogleAuthorizationCode({ ...input, fetchImpl: googleOAuthFetch }),
    fetchAccountEmail: (accessToken) =>
      fetchGoogleAccountEmail({ accessToken, fetchImpl: googleOAuthFetch }),
    persistConnection: (input) =>
      persistGoogleCalendarConnection({
        db: supabase as any,
        salonId: input.salonId,
        refreshToken: input.refreshToken,
        scope: input.scope,
        tokenType: input.tokenType,
        accountEmail: input.accountEmail,
      }),
  };
}

let callbackDeps: GoogleCalendarOAuthCallbackDeps = createDefaultDeps();

export function setGoogleCalendarOAuthCallbackDepsForTests(
  deps: Partial<GoogleCalendarOAuthCallbackDeps> | null,
): void {
  callbackDeps = deps
    ? { ...createDefaultDeps(), ...deps }
    : createDefaultDeps();
}

function mapStateErrorReason(
  err: GoogleCalendarOAuthStateError,
): 'invalid_state' | 'expired_state' {
  if (err.code === 'GOOGLE_OAUTH_STATE_EXPIRED') return 'expired_state';
  return 'invalid_state';
}

/**
 * GET /callback  (mounted at /api/calendar/google)
 */
router.get('/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

  if (!state.trim()) {
    console.error('[google-calendar] oauth callback missing state', {
      operation: 'oauth_callback_state',
      provider: 'google',
    });
    return res.redirect(buildGoogleIntegrationsRedirectUrl('error', 'invalid_state'));
  }

  let salonId: string;
  try {
    const consumed = await callbackDeps.consumeState({ state });
    salonId = consumed.salonId;
  } catch (err) {
    if (err instanceof GoogleCalendarOAuthStateError) {
      console.error('[google-calendar] oauth callback state error', {
        operation: 'oauth_callback_state',
        provider: 'google',
        code: err.code,
      });
      return res.redirect(
        buildGoogleIntegrationsRedirectUrl('error', mapStateErrorReason(err)),
      );
    }
    console.error('[google-calendar] oauth callback state unexpected', {
      operation: 'oauth_callback_state',
      provider: 'google',
    });
    return res.redirect(buildGoogleIntegrationsRedirectUrl('error', 'invalid_state'));
  }

  if (oauthError) {
    console.error('[google-calendar] oauth denied', {
      operation: 'oauth_callback_denied',
      provider: 'google',
      salonId,
    });
    return res.redirect(buildGoogleIntegrationsRedirectUrl('error', 'oauth_denied'));
  }

  if (!code.trim()) {
    console.error('[google-calendar] oauth callback missing code', {
      operation: 'oauth_callback_missing_code',
      provider: 'google',
      salonId,
    });
    return res.redirect(
      buildGoogleIntegrationsRedirectUrl('error', 'token_exchange_failed'),
    );
  }

  try {
    const config = callbackDeps.loadConfig();
    const tokens = await callbackDeps.exchangeCode({
      code: code.trim(),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });

    let accountEmail: string | null = null;
    if (tokens.accessToken) {
      accountEmail = await callbackDeps.fetchAccountEmail(tokens.accessToken);
    }

    await callbackDeps.persistConnection({
      salonId,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
      tokenType: tokens.tokenType,
      accountEmail,
    });

    return res.redirect(buildGoogleIntegrationsRedirectUrl('connected'));
  } catch (err) {
    const reason = mapGoogleOAuthErrorToRedirectReason(err);
    if (err instanceof GoogleCalendarOAuthError) {
      console.error('[google-calendar] oauth callback exchange/save error', {
        operation: 'oauth_callback_exchange',
        provider: 'google',
        salonId,
        code: err.code,
      });
    } else {
      console.error('[google-calendar] oauth callback unexpected error', {
        operation: 'oauth_callback_exchange',
        provider: 'google',
        salonId,
      });
    }
    return res.redirect(buildGoogleIntegrationsRedirectUrl('error', reason));
  }
});

export default router;
