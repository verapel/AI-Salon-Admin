/**
 * Developer-cabinet Instagram connection APIs (IG-1).
 * Read/list + soft disconnect foundation only.
 * No Meta connect/verify in IG-1 — status='connected' is never fabricated here.
 * Mounted under /api/developer (requireDeveloperAuth). Salon cabinet has no access.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import {
  INSTAGRAM_CONNECTION_PUBLIC_SELECT,
  INSTAGRAM_CREDENTIAL_PRESENCE_SELECT,
  isInstagramCredentialTripleStored,
  mapInstagramConnectionPublic,
  type DeveloperInstagramIntegration,
  type InstagramConnectionMetadataRow,
  type InstagramCredentialTripleRow,
} from '../lib/instagramConnectionPublic.js';

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

  const row = await loadConnectionMetadata(salon.id);
  if (!row) {
    return {
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      connected: false,
      connection: null,
    };
  }

  const isAccessTokenStored = await loadCredentialStored(salon.id);
  const connection = mapInstagramConnectionPublic(row, isAccessTokenStored);
  const connected = connection.status === 'connected' && connection.isAccessTokenStored;

  return {
    salonId: salon.id,
    salonName: salon.name,
    slug: salon.slug,
    connected,
    connection,
  };
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
 * GET /api/developer/integrations/instagram
 * All active salons with per-salon Instagram public status (no secrets).
 */
router.get('/', async (_req, res) => {
  try {
    const { data: salons, error } = await supabase
      .from('salons')
      .select('id, name, slug, active')
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
 * DELETE /api/developer/integrations/instagram/:salonId/disconnect
 * Soft disconnect: clear secrets + demote status. Does not delete clients/appointments.
 * No Meta calls.
 */
router.delete('/:salonId/disconnect', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';
  const now = new Date().toISOString();

  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'INSTAGRAM_CONNECTION_NOT_FOUND' });
    }

    const { data: existing, error: existingError } = await supabase
      .from('instagram_business_connections')
      .select('id')
      .eq('salon_id', salon.id)
      .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message);
    }

    if (existing) {
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
          updated_at: now,
        })
        .eq('salon_id', salon.id);

      if (clearError) {
        throw new Error(clearError.message);
      }
    }

    await markIntegrationNotConnected(salon.id);

    const payload = await loadPublicIntegration(salon.id);
    return res.json(payload);
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'disconnect');
  }
});

export default router;
