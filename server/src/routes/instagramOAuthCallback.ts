/**
 * IG-2: Instagram OAuth callback (Meta browser redirect).
 * NOT under /api/developer — no Bearer auth. Security = validated OAuth state.
 * No messaging webhook here.
 */

import { Router } from 'express';
import { getPublicAppOrigin } from '../lib/publicAppUrl.js';
import {
  isInstagramApiError,
  loadInstagramAppConfig,
  verifyInstagramOAuthConnection,
  type InstagramApiErrorCode,
  type InstagramFetch,
} from '../lib/instagramApi.js';
import {
  InstagramOAuthStateError,
  consumeInstagramOAuthState,
} from '../lib/instagramOAuthState.js';
import { persistVerifiedInstagramConnection } from '../lib/instagramConnectionPersist.js';
import { supabase } from '../lib/supabase.js';

const router = Router();

/** Injectable for tests. Production uses global fetch. */
export let instagramOAuthFetch: InstagramFetch = fetch;

export function setInstagramOAuthFetchForTests(fetchImpl: InstagramFetch | null): void {
  instagramOAuthFetch = fetchImpl ?? fetch;
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
 */
router.get('/callback', async (req, res) => {
  const oauthError =
    typeof req.query.error === 'string' ? req.query.error.trim() : '';
  if (oauthError) {
    if (oauthError === 'access_denied') {
      return redirectError(res, 'INSTAGRAM_OAUTH_DENIED');
    }
    return redirectError(res, 'INSTAGRAM_PROVIDER_4XX');
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const codeRaw = typeof req.query.code === 'string' ? req.query.code : '';

  // Consume durable single-use state BEFORE Meta token exchange.
  // Replay/concurrent loser never reaches token exchange.
  // If exchange fails after consume, user must restart OAuth (nonce not restored).
  let salonId: string;
  try {
    const consumed = await consumeInstagramOAuthState({
      db: supabase as any,
      state,
    });
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

  if (!codeRaw.trim()) {
    console.error('[instagram] oauth callback missing code', {
      operation: 'oauth_callback_missing_code',
      salonId,
    });
    return redirectError(res, 'INSTAGRAM_PROVIDER_4XX');
  }

  try {
    const active = await requireActiveSalonId(salonId);
    if (!active) {
      return redirectError(res, 'INSTAGRAM_PROVIDER_4XX');
    }

    const config = loadInstagramAppConfig();
    const verified = await verifyInstagramOAuthConnection(
      {
        code: codeRaw,
        appId: config.appId,
        appSecret: config.appSecret,
        redirectUri: config.redirectUri,
      },
      instagramOAuthFetch,
    );

    const persisted = await persistVerifiedInstagramConnection(salonId, verified);
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
