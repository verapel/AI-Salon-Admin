/**
 * IG-2 / IG-ACTIVATE-1A: Instagram OAuth callback (Meta browser redirect).
 * NOT under /api/developer — no Bearer auth. Security = validated OAuth state.
 * No messaging webhook here.
 *
 * IG-ACTIVATE-1A: any callback that presents a valid signed state burns it once
 * (success, cancel/error, or missing code) BEFORE Meta token exchange / redirect.
 * Failed Meta exchange after consume does NOT restore the nonce.
 */

import { Router } from 'express';
import { getPublicAppOrigin } from '../lib/publicAppUrl.js';
import {
  isInstagramApiError,
  loadInstagramAppConfig,
  verifyInstagramOAuthConnection,
  type InstagramApiErrorCode,
  type InstagramAppConfig,
  type InstagramFetch,
  type InstagramVerifiedAccount,
} from '../lib/instagramApi.js';
import {
  InstagramOAuthStateError,
  consumeInstagramOAuthState,
} from '../lib/instagramOAuthState.js';
import {
  persistVerifiedInstagramConnection,
  type PersistInstagramConnectionResult,
} from '../lib/instagramConnectionPersist.js';
import { supabase } from '../lib/supabase.js';

const router = Router();

/** Injectable for tests. Production uses global fetch. */
export let instagramOAuthFetch: InstagramFetch = fetch;

export function setInstagramOAuthFetchForTests(fetchImpl: InstagramFetch | null): void {
  instagramOAuthFetch = fetchImpl ?? fetch;
}

export type InstagramOAuthCallbackDeps = {
  consumeState: (params: {
    state: string;
  }) => Promise<{ salonId: string; nonce: string }>;
  requireActiveSalon: (salonId: string) => Promise<boolean>;
  loadConfig: () => InstagramAppConfig;
  verifyConnection: (input: {
    code: string;
    appId: string;
    appSecret: string;
    redirectUri: string;
  }) => Promise<InstagramVerifiedAccount>;
  persistConnection: (
    salonId: string,
    verified: InstagramVerifiedAccount,
  ) => Promise<PersistInstagramConnectionResult>;
};

function createDefaultInstagramOAuthCallbackDeps(): InstagramOAuthCallbackDeps {
  return {
    consumeState: ({ state }) =>
      consumeInstagramOAuthState({
        db: supabase as any,
        state,
      }),
    requireActiveSalon: requireActiveSalonId,
    loadConfig: loadInstagramAppConfig,
    verifyConnection: (input) =>
      verifyInstagramOAuthConnection(input, instagramOAuthFetch),
    persistConnection: persistVerifiedInstagramConnection,
  };
}

let callbackDeps: InstagramOAuthCallbackDeps =
  createDefaultInstagramOAuthCallbackDeps();

/** Test-only dependency injection. Pass null to restore production defaults. */
export function setInstagramOAuthCallbackDepsForTests(
  deps: Partial<InstagramOAuthCallbackDeps> | null,
): void {
  callbackDeps = deps
    ? { ...createDefaultInstagramOAuthCallbackDeps(), ...deps }
    : createDefaultInstagramOAuthCallbackDeps();
}

function frontendIntegrationsUrl(params: Record<string, string>): string {
  const origin = getPublicAppOrigin() ?? '';
  const url = new URL('/developer/integrations', origin || 'http://localhost');
  url.searchParams.set('tab', 'instagram');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function mapSafeErrorCode(code: string): string {
  switch (code) {
    case 'INSTAGRAM_OAUTH_STATE_INVALID':
    case 'INSTAGRAM_OAUTH_STATE_EXPIRED':
    case 'INSTAGRAM_OAUTH_STATE_REPLAY':
      return 'invalid_state';
    case 'INSTAGRAM_MISSING_PERMISSION':
    case 'INSTAGRAM_PERMISSIONS_UNVERIFIED':
      return 'permission_denied';
    case 'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL':
      return 'not_professional';
    case 'INSTAGRAM_ACCOUNT_IN_USE':
      return 'account_in_use';
    case 'INSTAGRAM_IDENTITY_CONFLICT':
      return 'identity_conflict';
    case 'INSTAGRAM_INVALID_IDENTITY':
      return 'invalid_identity';
    case 'INSTAGRAM_INVALID_TOKEN':
    case 'INSTAGRAM_INVALID_TOKEN_EXPIRY':
      return 'invalid_token';
    case 'INSTAGRAM_TIMEOUT':
    case 'INSTAGRAM_PROVIDER_5XX':
    case 'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE':
      return 'provider_unavailable';
    case 'INSTAGRAM_NOT_CONFIGURED':
      return 'not_configured';
    case 'INSTAGRAM_OAUTH_DENIED':
      return 'cancelled';
    default:
      return 'error';
  }
}

function redirectError(res: import('express').Response, code: string) {
  const safe = mapSafeErrorCode(code);
  if (safe === 'cancelled') {
    return res.redirect(frontendIntegrationsUrl({ instagram: 'cancelled' }));
  }
  return res.redirect(
    frontendIntegrationsUrl({ instagram: 'error', instagram_error: safe }),
  );
}

async function requireActiveSalonId(salonId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('salons')
    .select('id, active')
    .eq('id', salonId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data && (data as { active: boolean }).active);
}

/**
 * GET /api/integrations/instagram/callback
 *
 * Order (IG-ACTIVATE-1A):
 *   1) If state present → durable consume exactly once (sig/TTL/CAS)
 *   2) If Meta error/cancel → safe redirect (no token exchange)
 *   3) If missing code → safe error (already consumed when state present)
 *   4) Else Meta exchange → verify → persist
 */
router.get('/callback', async (req, res) => {
  const oauthError =
    typeof req.query.error === 'string' ? req.query.error.trim() : '';
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const codeRaw = typeof req.query.code === 'string' ? req.query.code : '';

  let salonId: string | null = null;

  if (state) {
    // Burn valid signed state once before any cancel/error/success terminal handling.
    try {
      const consumed = await callbackDeps.consumeState({ state });
      salonId = consumed.salonId;
    } catch (err) {
      if (err instanceof InstagramOAuthStateError) {
        console.error('[instagram] oauth callback state error', {
          operation: 'oauth_callback_state',
          code: err.code,
        });
        return redirectError(res, err.code);
      }
      return redirectError(res, 'INSTAGRAM_OAUTH_STATE_INVALID');
    }
  } else if (oauthError) {
    // Cancel/error without state: no durable consume to attempt.
    if (oauthError === 'access_denied') {
      return redirectError(res, 'INSTAGRAM_OAUTH_DENIED');
    }
    return redirectError(res, 'INSTAGRAM_PROVIDER_4XX');
  } else {
    // Success-shaped callback requires state.
    return redirectError(res, 'INSTAGRAM_OAUTH_STATE_INVALID');
  }

  // State was present and consumed. Handle Meta cancel/error without token exchange.
  if (oauthError) {
    if (oauthError === 'access_denied') {
      return redirectError(res, 'INSTAGRAM_OAUTH_DENIED');
    }
    return redirectError(res, 'INSTAGRAM_PROVIDER_4XX');
  }

  if (!codeRaw.trim()) {
    console.error('[instagram] oauth callback missing code', {
      operation: 'oauth_callback_missing_code',
      salonId,
    });
    return redirectError(res, 'INSTAGRAM_PROVIDER_4XX');
  }

  try {
    const active = await callbackDeps.requireActiveSalon(salonId!);
    if (!active) {
      return redirectError(res, 'INSTAGRAM_PROVIDER_4XX');
    }

    const config = callbackDeps.loadConfig();
    const verified = await callbackDeps.verifyConnection({
      code: codeRaw,
      appId: config.appId,
      appSecret: config.appSecret,
      redirectUri: config.redirectUri,
    });

    const persisted = await callbackDeps.persistConnection(salonId!, verified);
    if (!persisted.ok) {
      console.error('[instagram] oauth persist failed', {
        operation: 'oauth_callback_persist',
        salonId,
        code: persisted.error.code as InstagramApiErrorCode,
      });
      return redirectError(res, persisted.error.code);
    }

    // Authoritative connection committed. Secondary lag is never instagram=error.
    const params: Record<string, string> = { instagram: 'connected' };
    if (persisted.confirmation === 'pending') {
      params.instagram_confirmation = 'pending';
    }
    if (persisted.registrySync === 'pending') {
      params.instagram_registry = 'sync_pending';
    }
    return res.redirect(frontendIntegrationsUrl(params));
  } catch (err) {
    if (isInstagramApiError(err)) {
      console.error('[instagram] oauth callback meta error', {
        operation: 'oauth_callback_meta',
        salonId,
        code: err.code,
        httpStatus: err.httpStatus,
      });
      return redirectError(res, err.code);
    }
    console.error('[instagram] oauth callback error', {
      operation: 'oauth_callback',
      salonId,
      result: 'error',
      message: err instanceof Error ? err.message : 'unknown',
    });
    return redirectError(res, 'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE');
  }
});

export default router;
