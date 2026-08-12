/**
 * Developer-cabinet Instagram connection APIs (IG-1 + IG-2 connect/start).
 * OAuth callback lives outside this router (no developer Bearer on Meta redirect).
 * Mounted under /api/developer (requireDeveloperAuth). Salon cabinet has no access.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import {
  INSTAGRAM_CONNECTION_PUBLIC_SELECT,
  INSTAGRAM_CREDENTIAL_PRESENCE_SELECT,
  isInstagramCredentialTripleStored,
  isMeaningfulInstagramConnectionPresence,
  mapInstagramConnectionPublic,
  type DeveloperInstagramIntegration,
  type InstagramConnectionMetadataRow,
  type InstagramCredentialTripleRow,
} from '../lib/instagramConnectionPublic.js';
import {
  assertInstagramCredentialsEncryptionKeyConfigured,
  isInstagramCredentialCryptoError,
} from '../lib/instagramCredentialsCrypto.js';
import {
  buildInstagramAuthorizeUrl,
  isInstagramApiError,
  loadInstagramAppConfig,
} from '../lib/instagramApi.js';
import {
  createPersistedInstagramOAuthState,
  InstagramOAuthStateError,
} from '../lib/instagramOAuthState.js';
import { isInstagramOutboundEnabled } from '../lib/instagramOutboundWorker.js';
import { ensureInstagramIntegrationRow } from '../lib/instagramConnectionPersist.js';

const router = Router();
const INSTAGRAM_PROVIDER = 'instagram' as const;

type SalonLookupRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
};

async function requireActiveSalon(salonId: string): Promise<SalonLookupRow | { error: string }> {
  const trimmed = salonId.trim();
  if (!trimmed) {
    return { error: 'salonId is required' };
  }

  const { data, error } = await supabase
    .from('salons')
    .select('id, name, slug, active')
    .eq('id', trimmed)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data || !(data as SalonLookupRow).active) {
    return { error: 'Salon not found' };
  }
  return data as SalonLookupRow;
}

async function hasInstagramIntegrationRow(salonId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('salon_integrations')
    .select('id')
    .eq('salon_id', salonId)
    .eq('provider', INSTAGRAM_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

async function loadCredentialStored(salonId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('instagram_business_connections')
    .select(INSTAGRAM_CREDENTIAL_PRESENCE_SELECT)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const row = data as InstagramCredentialTripleRow | null;
  if (!row) return false;
  return isInstagramCredentialTripleStored(
    row.access_token_ciphertext,
    row.access_token_iv,
    row.access_token_auth_tag,
  );
}

async function loadConnectionMetadata(
  salonId: string,
): Promise<InstagramConnectionMetadataRow | null> {
  const { data, error } = await supabase
    .from('instagram_business_connections')
    .select(INSTAGRAM_CONNECTION_PUBLIC_SELECT)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return (data as InstagramConnectionMetadataRow | null) ?? null;
}

async function loadPublicIntegration(salonId: string): Promise<DeveloperInstagramIntegration> {
  const salon = await requireActiveSalon(salonId);
  if ('error' in salon) {
    throw new Error(salon.error);
  }

  const outboundEnabled = isInstagramOutboundEnabled();
  const registryPresent = await hasInstagramIntegrationRow(salon.id);
  const row = await loadConnectionMetadata(salon.id);
  if (!row) {
    return {
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      integrationAdded: registryPresent,
      connected: false,
      connection: null,
      requiresRemoveConfirmation: false,
      outboundEnabled,
    };
  }

  const isAccessTokenStored = await loadCredentialStored(salon.id);
  const connection = mapInstagramConnectionPublic(row, isAccessTokenStored);
  const connected = connection.status === 'connected' && connection.isAccessTokenStored;
  const meaningful = isMeaningfulInstagramConnectionPresence(connection, isAccessTokenStored);

  return {
    salonId: salon.id,
    salonName: salon.name,
    slug: salon.slug,
    integrationAdded: registryPresent || meaningful,
    connected,
    connection,
    requiresRemoveConfirmation: isAccessTokenStored,
    outboundEnabled,
  };
}

/** Soft-clear Instagram connection secrets for salon. Never deletes salon/business data. */
async function clearInstagramConnectionSecrets(salonId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await supabase
    .from('instagram_business_connections')
    .select('id')
    .eq('salon_id', salonId)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (!existing) return;

  const { error: clearError } = await supabase
    .from('instagram_business_connections')
    .update({
      access_token_ciphertext: null,
      access_token_iv: null,
      access_token_auth_tag: null,
      instagram_user_id: null,
      instagram_username: null,
      status: 'not_connected',
      connected_at: null,
      last_error: null,
      token_expires_at: null,
      updated_at: now,
    })
    .eq('salon_id', salonId);

  if (clearError) {
    throw new Error(clearError.message);
  }
}

async function markIntegrationNotConnected(salonId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('salon_integrations')
    .update({
      status: 'not_connected',
      health: 'unknown',
      last_error: null,
      updated_at: now,
      token_ciphertext: null,
    })
    .eq('salon_id', salonId)
    .eq('provider', INSTAGRAM_PROVIDER);

  if (error) {
    throw new Error(error.message);
  }
}

function handleRouteError(
  res: import('express').Response,
  err: unknown,
  salonId: string | null,
  operation: string,
) {
  const message = err instanceof Error ? err.message : 'unknown';
  console.error('[instagram] developer route error', {
    provider: INSTAGRAM_PROVIDER,
    salonId,
    operation,
    result: 'error',
    // Never log secrets — message is DB/system text only.
    message,
  });
  return res.status(500).json({ error: 'Instagram integration request failed' });
}

/**
 * POST /api/developer/integrations/instagram/:salonId/connect/start
 * Developer-only OAuth start. Returns authorization URL. No Meta calls yet.
 * Route salonId is authoritative — body salonId is ignored/rejected.
 */
router.post('/:salonId/connect/start', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';

  if (req.body && typeof req.body === 'object') {
    const raw = req.body as Record<string, unknown>;
    if ('salonId' in raw || 'salon_id' in raw) {
      return res.status(400).json({
        error: 'salonId must not be provided in the request body',
        code: 'INSTAGRAM_INVALID_REQUEST',
      });
    }
  }

  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'INSTAGRAM_CONNECTION_NOT_FOUND' });
    }

    try {
      assertInstagramCredentialsEncryptionKeyConfigured();
    } catch (err) {
      if (isInstagramCredentialCryptoError(err)) {
        return res.status(503).json({
          error: 'Instagram credential encryption is not configured',
          code: 'INSTAGRAM_NOT_CONFIGURED',
        });
      }
      throw err;
    }

    let config;
    try {
      config = loadInstagramAppConfig();
    } catch (err) {
      if (isInstagramApiError(err)) {
        return res.status(err.httpStatus).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    let state: string;
    try {
      // IG-ACTIVATE-1: durable single-use nonce before redirecting to Meta.
      state = await createPersistedInstagramOAuthState({
        db: supabase as any,
        salonId: salon.id,
      });
    } catch (err) {
      if (err instanceof InstagramOAuthStateError) {
        const status =
          err.code === 'INSTAGRAM_OAUTH_NOT_CONFIGURED' ||
          err.code === 'INSTAGRAM_OAUTH_STATE_PERSIST_FAILED'
            ? 503
            : 400;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    const authorizationUrl = buildInstagramAuthorizeUrl({
      appId: config.appId,
      redirectUri: config.redirectUri,
      state,
    });

    return res.json({
      salonId: salon.id,
      authorizationUrl,
    });
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'connect_start');
  }
});

/**
 * GET /api/developer/integrations/instagram
 * Active salons with Instagram registry OR a meaningful connection (orphan-safe).
 */
router.get('/', async (_req, res) => {
  try {
    const { data: registryRows, error: registryError } = await supabase
      .from('salon_integrations')
      .select('salon_id')
      .eq('provider', INSTAGRAM_PROVIDER);

    if (registryError) {
      throw new Error(registryError.message);
    }

    const salonIdSet = new Set<string>(
      ((registryRows ?? []) as Array<{ salon_id: string }>)
        .map((row) => row.salon_id)
        .filter((id) => typeof id === 'string' && id.trim().length > 0),
    );

    // Non-mutating orphan compatibility: include salons with meaningful connection rows.
    const { data: connectionRows, error: connectionError } = await supabase
      .from('instagram_business_connections')
      .select(
        [
          'id',
          'salon_id',
          'instagram_user_id',
          'instagram_username',
          'status',
          'connected_at',
          'last_webhook_at',
          'last_error',
          'token_expires_at',
          'created_at',
          'updated_at',
          'access_token_ciphertext',
          'access_token_iv',
          'access_token_auth_tag',
        ].join(','),
      );

    if (connectionError) {
      throw new Error(connectionError.message);
    }

    for (const raw of ((connectionRows ?? []) as unknown as Array<
      InstagramConnectionMetadataRow & InstagramCredentialTripleRow
    >)) {
      const stored = isInstagramCredentialTripleStored(
        raw.access_token_ciphertext,
        raw.access_token_iv,
        raw.access_token_auth_tag,
      );
      const connection = mapInstagramConnectionPublic(raw, stored);
      if (isMeaningfulInstagramConnectionPresence(connection, stored)) {
        salonIdSet.add(raw.salon_id);
      }
    }

    const salonIds = [...salonIdSet];
    if (salonIds.length === 0) {
      return res.json([]);
    }

    const { data: salons, error } = await supabase
      .from('salons')
      .select('id, name, slug, active')
      .in('id', salonIds)
      .eq('active', true)
      .order('name');

    if (error) {
      throw new Error(error.message);
    }

    const rows = (salons ?? []) as SalonLookupRow[];
    const result: DeveloperInstagramIntegration[] = [];
    for (const salon of rows) {
      result.push(await loadPublicIntegration(salon.id));
    }
    return res.json(result);
  } catch (err) {
    return handleRouteError(res, err, null, 'developer_list');
  }
});

/**
 * GET /api/developer/integrations/instagram/:salonId
 * Route salonId only — request body cannot retarget.
 * Returns integrationAdded=false when Instagram is not in salon_integrations.
 */
router.get('/:salonId', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';
  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'INSTAGRAM_CONNECTION_NOT_FOUND' });
    }
    const payload = await loadPublicIntegration(salon.id);
    return res.json(payload);
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'developer_get');
  }
});

/**
 * POST /api/developer/integrations/instagram/:salonId/prepare
 * Add Instagram to salon Integrations list (salon_integrations only).
 * No credentials, no Meta calls, no business-data mutation.
 * Idempotent when already added.
 */
router.post('/:salonId/prepare', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';

  if (req.body && typeof req.body === 'object') {
    const raw = req.body as Record<string, unknown>;
    if ('salonId' in raw || 'salon_id' in raw) {
      return res.status(400).json({
        error: 'salonId must not be provided in the request body',
        code: 'INSTAGRAM_INVALID_REQUEST',
      });
    }
  }

  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'INSTAGRAM_CONNECTION_NOT_FOUND' });
    }

    await ensureInstagramIntegrationRow(salon.id);
    const payload = await loadPublicIntegration(salon.id);
    return res.json(payload);
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'prepare');
  }
});

/**
 * DELETE /api/developer/integrations/instagram/:salonId/disconnect
 * Soft disconnect: clear secrets + demote registry status. Keeps Instagram card.
 * Does not delete clients/appointments/salon. No Meta calls.
 */
router.delete('/:salonId/disconnect', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';

  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'INSTAGRAM_CONNECTION_NOT_FOUND' });
    }

    await clearInstagramConnectionSecrets(salon.id);
    await markIntegrationNotConnected(salon.id);

    const payload = await loadPublicIntegration(salon.id);
    return res.json(payload);
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'disconnect');
  }
});

/**
 * DELETE /api/developer/integrations/instagram/:salonId/remove
 * Atomic remove via remove_instagram_integration_owned RPC:
 * - soft-clear Instagram credentials for this salon
 * - delete salon_integrations row for provider=instagram
 * NEVER deletes salon / clients / staff / services / appointments
 * NEVER touches Telegram / WhatsApp / Apple
 * Idempotent. No Meta calls.
 * If stored credentials exist, requires confirmConnected=true.
 */
router.delete('/:salonId/remove', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  if ('salonId' in body || 'salon_id' in body) {
    return res.status(400).json({
      error: 'salonId must not be provided in the request body',
      code: 'INSTAGRAM_INVALID_REQUEST',
    });
  }

  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'INSTAGRAM_CONNECTION_NOT_FOUND' });
    }

    const current = await loadPublicIntegration(salon.id);
    if (current.requiresRemoveConfirmation && body.confirmConnected !== true) {
      return res.status(409).json({
        error: 'Confirm Instagram credential clear before removing the integration',
        code: 'INSTAGRAM_REMOVE_REQUIRES_CONFIRM',
      });
    }

    const db = supabase as any;
    const { data: rpcData, error: rpcError } = await db.rpc(
      'remove_instagram_integration_owned',
      { p_salon_id: salon.id },
    );

    if (rpcError) {
      throw new Error(rpcError.message);
    }

    // Never delete from `salons` or other providers.
    const payload = await loadPublicIntegration(salon.id);
    return res.json({
      ...payload,
      integrationAdded: false,
      removed: true,
      atomic: true,
      rpc: rpcData ?? null,
    });
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'remove');
  }
});

export default router;
