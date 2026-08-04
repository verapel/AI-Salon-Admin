/**
 * Developer-cabinet WhatsApp Cloud connection APIs (WA-2E).
 * Connection setup only: verify + encrypt + store. No webhooks/messaging/FSM.
 * Mounted under /api/developer (requireDeveloperAuth). Salon cabinet has no access.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import {
  assertWhatsAppCredentialsEncryptionKeyConfigured,
  encryptWhatsAppCredential,
  isWhatsAppCredentialCryptoError,
} from '../lib/whatsappCredentialsCrypto.js';
import {
  isWhatsAppAppError,
  verifyWhatsAppCloudConnection,
  WhatsAppAppError,
  type WhatsAppErrorCode,
} from '../lib/whatsappCloudApi.js';
import type {
  WhatsAppBusinessConnectionPublic,
  WhatsAppCloudProvider,
  WhatsAppConnectRequest,
  WhatsAppIntegrationResponse,
} from '../types.js';
import { buildWhatsAppWebhookCallbackUrl } from '../lib/publicAppUrl.js';

const router = Router();

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

const WHATSAPP_PROVIDER = 'whatsapp' as const;
const CLOUD_PROVIDER: WhatsAppCloudProvider = 'meta_cloud';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Public metadata only — never select credential_* columns into the response path. */
const CONNECTION_METADATA_SELECT = `
  id,
  salon_id,
  integration_id,
  provider,
  business_account_id,
  phone_number_id,
  display_phone_number,
  verified_name,
  webhook_key,
  token_expires_at,
  last_webhook_at,
  last_inbound_at,
  last_outbound_at,
  quality_rating,
  messaging_limit_tier,
  created_at,
  updated_at
`.replace(/\s+/g, ' ').trim();

type ConnectionMetadataRow = {
  id: string;
  salon_id: string;
  integration_id: string;
  provider: WhatsAppCloudProvider;
  business_account_id: string | null;
  phone_number_id: string | null;
  display_phone_number: string | null;
  verified_name: string | null;
  webhook_key: string | null;
  token_expires_at: string | null;
  last_webhook_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  created_at: string;
  updated_at: string;
};

type CredentialTripleRow = {
  access_token_ciphertext: string | null;
  access_token_iv: string | null;
  access_token_auth_tag: string | null;
  app_secret_ciphertext: string | null;
  app_secret_iv: string | null;
  app_secret_auth_tag: string | null;
  verify_token_ciphertext: string | null;
  verify_token_iv: string | null;
  verify_token_auth_tag: string | null;
};

type IntegrationRow = {
  id: string;
  salon_id: string;
  provider: string;
  status: string;
};

function isCredentialTripleStored(
  ciphertext: string | null,
  iv: string | null,
  authTag: string | null
): boolean {
  return (
    typeof ciphertext === 'string' &&
    ciphertext.trim().length > 0 &&
    typeof iv === 'string' &&
    iv.trim().length > 0 &&
    typeof authTag === 'string' &&
    authTag.trim().length > 0
  );
}

function mapConnectionPublic(
  row: ConnectionMetadataRow,
  flags: {
    isAccessTokenStored: boolean;
    isAppSecretStored: boolean;
    isVerifyTokenStored: boolean;
  }
): WhatsAppBusinessConnectionPublic {
  const webhookKey =
    typeof row.webhook_key === 'string' && row.webhook_key.trim().length > 0
      ? row.webhook_key.trim()
      : null;

  return {
    id: row.id,
    salonId: row.salon_id,
    integrationId: row.integration_id,
    provider: row.provider,
    businessAccountId: row.business_account_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    tokenExpiresAt: row.token_expires_at,
    lastWebhookAt: row.last_webhook_at,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    qualityRating: row.quality_rating,
    messagingLimitTier: row.messaging_limit_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isAccessTokenStored: flags.isAccessTokenStored,
    isAppSecretStored: flags.isAppSecretStored,
    isVerifyTokenStored: flags.isVerifyTokenStored,
    webhookKey,
    webhookCallbackUrl: webhookKey ? buildWhatsAppWebhookCallbackUrl(webhookKey) : null,
  };
}

function parseConnectBody(body: unknown): WhatsAppConnectRequest | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid request body' };
  }
  const raw = body as Record<string, unknown>;

  if ('salonId' in raw || 'salon_id' in raw) {
    return { error: 'salonId must not be provided in the request body' };
  }

  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken.trim() : '';
  const appSecret = typeof raw.appSecret === 'string' ? raw.appSecret.trim() : '';
  const verifyToken = typeof raw.verifyToken === 'string' ? raw.verifyToken.trim() : '';
  const businessAccountId =
    typeof raw.businessAccountId === 'string' ? raw.businessAccountId.trim() : '';
  const phoneNumberId = typeof raw.phoneNumberId === 'string' ? raw.phoneNumberId.trim() : '';

  if (!accessToken) return { error: 'accessToken is required' };
  if (!appSecret) return { error: 'appSecret is required' };
  if (!verifyToken) return { error: 'verifyToken is required' };
  if (!businessAccountId) return { error: 'businessAccountId is required' };
  if (!phoneNumberId) return { error: 'phoneNumberId is required' };

  return {
    accessToken,
    appSecret,
    verifyToken,
    businessAccountId,
    phoneNumberId,
  };
}

function sendWhatsAppError(
  res: import('express').Response,
  code: WhatsAppErrorCode,
  status: number,
  message: string
) {
  return res.status(status).json({ error: message, code });
}

function handleRouteError(
  res: import('express').Response,
  err: unknown,
  salonId: string | null,
  operation: string
) {
  if (isWhatsAppAppError(err)) {
    console.error('[whatsapp] operation failed', {
      salonId,
      operation,
      code: err.code,
    });
    return sendWhatsAppError(res, err.code, err.httpStatus, err.message);
  }

  if (isWhatsAppCredentialCryptoError(err)) {
    console.error('[whatsapp] encryption unavailable', {
      salonId,
      operation,
    });
    return sendWhatsAppError(
      res,
      'WHATSAPP_ENCRYPTION_KEY_MISSING',
      503,
      'WhatsApp credential storage is not configured'
    );
  }

  console.error('[whatsapp] unexpected failure', {
    salonId,
    operation,
  });
  return sendWhatsAppError(
    res,
    'WHATSAPP_NOT_CONFIGURED',
    503,
    'WhatsApp connection storage is unavailable'
  );
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '23505') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('duplicate key') || msg.includes('unique');
}

/**
 * Map connection-upsert 23505 to PHONE_NUMBER_IN_USE only when evidence points at
 * whatsapp_business_connections_phone_number_id_unique. Never return raw DB text.
 */
function isPhoneNumberIdUniqueConflict(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
} | null): boolean {
  if (!error || error.code !== '23505') return false;
  const hay = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();
  return (
    hay.includes('whatsapp_business_connections_phone_number_id_unique') ||
    (hay.includes('phone_number_id') &&
      (hay.includes('already exists') || hay.includes('duplicate')))
  );
}

const STATUS_MARK_MAX_ATTEMPTS = 3;
const PUBLIC_LOAD_MAX_ATTEMPTS = 3;

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCredentialFlags(salonId: string): Promise<{
  isAccessTokenStored: boolean;
  isAppSecretStored: boolean;
  isVerifyTokenStored: boolean;
}> {
  const { data, error } = await supabase
    .from('whatsapp_business_connections')
    .select(
      `
      access_token_ciphertext,
      access_token_iv,
      access_token_auth_tag,
      app_secret_ciphertext,
      app_secret_iv,
      app_secret_auth_tag,
      verify_token_ciphertext,
      verify_token_iv,
      verify_token_auth_tag
    `
    )
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const row = data as CredentialTripleRow | null;
  if (!row) {
    return {
      isAccessTokenStored: false,
      isAppSecretStored: false,
      isVerifyTokenStored: false,
    };
  }

  return {
    isAccessTokenStored: isCredentialTripleStored(
      row.access_token_ciphertext,
      row.access_token_iv,
      row.access_token_auth_tag
    ),
    isAppSecretStored: isCredentialTripleStored(
      row.app_secret_ciphertext,
      row.app_secret_iv,
      row.app_secret_auth_tag
    ),
    isVerifyTokenStored: isCredentialTripleStored(
      row.verify_token_ciphertext,
      row.verify_token_iv,
      row.verify_token_auth_tag
    ),
  };
}

async function loadIntegrationStatus(salonId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('salon_integrations')
    .select('status')
    .eq('salon_id', salonId)
    .eq('provider', WHATSAPP_PROVIDER)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as { status: string } | null)?.status ?? null;
}

async function loadPublicIntegration(salonId: string): Promise<WhatsAppIntegrationResponse> {
  const { data, error } = await supabase
    .from('whatsapp_business_connections')
    .select(CONNECTION_METADATA_SELECT)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return { connected: false, connection: null };
  }

  const row = data as unknown as ConnectionMetadataRow;
  const flags = await loadCredentialFlags(salonId);
  const integrationStatus = await loadIntegrationStatus(salonId);
  const connection = mapConnectionPublic(row, flags);
  const connected =
    integrationStatus === 'connected' &&
    flags.isAccessTokenStored &&
    flags.isAppSecretStored &&
    flags.isVerifyTokenStored;

  return { connected, connection };
}

/**
 * Ensure a whatsapp salon_integrations row exists for this salon.
 * Never marks connected here — connection write must succeed first.
 * Never writes token_ciphertext.
 */
async function ensureWhatsAppIntegrationRow(salonId: string): Promise<IntegrationRow> {
  const { data: existing, error: existingError } = await supabase
    .from('salon_integrations')
    .select('id, salon_id, provider, status')
    .eq('salon_id', salonId)
    .eq('provider', WHATSAPP_PROVIDER)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existing) {
    const row = existing as IntegrationRow;
    if (row.salon_id !== salonId || row.provider !== WHATSAPP_PROVIDER) {
      throw new WhatsAppAppError(
        'WHATSAPP_FORBIDDEN',
        403,
        'Write access required'
      );
    }
    return row;
  }

  const now = new Date().toISOString();
  const { data: created, error: createError } = await supabase
    .from('salon_integrations')
    .insert({
      salon_id: salonId,
      provider: WHATSAPP_PROVIDER,
      status: 'not_connected',
      health: 'unknown',
      last_error: null,
      // Explicit: WhatsApp secrets never use this Telegram plaintext column.
      token_ciphertext: null,
      updated_at: now,
    })
    .select('id, salon_id, provider, status')
    .single();

  if (createError || !created) {
    // Race: another request inserted — re-read.
    if (isUniqueViolation(createError)) {
      const { data: raced, error: raceError } = await supabase
        .from('salon_integrations')
        .select('id, salon_id, provider, status')
        .eq('salon_id', salonId)
        .eq('provider', WHATSAPP_PROVIDER)
        .maybeSingle();
      if (raceError || !raced) {
        throw new Error(raceError?.message ?? createError?.message ?? 'Could not create integration');
      }
      return raced as IntegrationRow;
    }
    throw new Error(createError?.message ?? 'Could not create integration');
  }

  const row = created as IntegrationRow;
  if (row.salon_id !== salonId || row.provider !== WHATSAPP_PROVIDER) {
    throw new WhatsAppAppError('WHATSAPP_FORBIDDEN', 403, 'Write access required');
  }
  return row;
}

async function markIntegrationConnected(salonId: string, integrationId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('salon_integrations')
    .update({
      status: 'connected',
      health: 'healthy',
      last_error: null,
      connected_at: now,
      last_checked_at: now,
      updated_at: now,
      // Never store WhatsApp secrets here.
      token_ciphertext: null,
    })
    .eq('id', integrationId)
    .eq('salon_id', salonId)
    .eq('provider', WHATSAPP_PROVIDER)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw new Error('WhatsApp integration row missing after connection write');
  }
}

/** Bounded retries for post-upsert status=connected. Never demotes status. */
async function markIntegrationConnectedWithRetry(
  salonId: string,
  integrationId: string
): Promise<boolean> {
  for (let attempt = 1; attempt <= STATUS_MARK_MAX_ATTEMPTS; attempt++) {
    try {
      await markIntegrationConnected(salonId, integrationId);
      return true;
    } catch {
      console.error('[whatsapp] mark connected attempt failed', {
        salonId,
        operation: 'mark_connected_retry',
        attempt,
      });
      if (attempt < STATUS_MARK_MAX_ATTEMPTS) {
        await sleepMs(40 * attempt);
      }
    }
  }
  return false;
}

async function loadPublicIntegrationWithRetry(
  salonId: string
): Promise<WhatsAppIntegrationResponse | null> {
  for (let attempt = 1; attempt <= PUBLIC_LOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await loadPublicIntegration(salonId);
    } catch {
      console.error('[whatsapp] public load attempt failed', {
        salonId,
        operation: 'load_public_retry',
        attempt,
      });
      if (attempt < PUBLIC_LOAD_MAX_ATTEMPTS) {
        await sleepMs(40 * attempt);
      }
    }
  }
  return null;
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
    .eq('provider', WHATSAPP_PROVIDER);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Capture pre-mutation connection usability for reconnect preservation.
 * Never used to demote status after a successful secret upsert.
 */
async function capturePriorConnectionState(salonId: string): Promise<{
  priorStatus: string | null;
  wasUsablyConnected: boolean;
}> {
  const priorStatus = await loadIntegrationStatus(salonId);
  const flags = await loadCredentialFlags(salonId);
  const wasUsablyConnected =
    priorStatus === 'connected' &&
    flags.isAccessTokenStored &&
    flags.isAppSecretStored &&
    flags.isVerifyTokenStored;
  return { priorStatus, wasUsablyConnected };
}

/**
 * GET /api/developer/integrations/whatsapp
 * All active salons with per-salon WhatsApp public status (no secrets).
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
    const result = [];
    for (const salon of rows) {
      const payload = await loadPublicIntegration(salon.id);
      result.push({
        salonId: salon.id,
        salonName: salon.name,
        slug: salon.slug,
        connected: payload.connected,
        connection: payload.connection,
      });
    }
    return res.json(result);
  } catch (err) {
    return handleRouteError(res, err, null, 'developer_list');
  }
});

/**
 * GET /api/developer/integrations/whatsapp/:salonId
 */
router.get('/:salonId', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';
  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'WHATSAPP_CONNECTION_NOT_FOUND' });
    }
    const payload = await loadPublicIntegration(salon.id);
    return res.json({
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      connected: payload.connected,
      connection: payload.connection,
    });
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'developer_get');
  }
});

/**
 * POST /api/developer/integrations/whatsapp/:salonId/prepare
 *
 * Create minimal not_connected WhatsApp connection row so webhook_key / callback URL
 * exist before Meta credentials are available. No secrets, no Meta calls, no connect.
 *
 * INSERT-only when missing. Never upsert null credentials. Idempotent.
 */
router.post('/:salonId/prepare', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';

  if (!salonId || !isUuid(salonId)) {
    return res.status(404).json({ error: 'Salon not found', code: 'WHATSAPP_CONNECTION_NOT_FOUND' });
  }

  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'WHATSAPP_CONNECTION_NOT_FOUND' });
    }

    // Ensure salon_integrations row (whatsapp / not_connected if new). Never demotes connected.
    const integration = await ensureWhatsAppIntegrationRow(salon.id);

    const { data: existing, error: existingError } = await supabase
      .from('whatsapp_business_connections')
      .select('id')
      .eq('salon_id', salon.id)
      .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message);
    }

    if (!existing) {
      const now = new Date().toISOString();
      // Minimal INSERT only — DB defaults generate id + webhook_key.
      // Do NOT write null credential/Meta columns (never wipe via upsert).
      const { error: insertError } = await supabase.from('whatsapp_business_connections').insert({
        salon_id: salon.id,
        integration_id: integration.id,
        provider: CLOUD_PROVIDER,
        updated_at: now,
      });

      if (insertError) {
        if (!isUniqueViolation(insertError)) {
          throw new Error(insertError.message);
        }

        // Concurrent prepare won the insert — re-read same-salon row only.
        const { data: raced, error: raceError } = await supabase
          .from('whatsapp_business_connections')
          .select('id')
          .eq('salon_id', salon.id)
          .maybeSingle();

        if (raceError) {
          throw new Error(raceError.message);
        }
        if (!raced) {
          console.error('[whatsapp] prepare unique conflict without same-salon row', {
            salonId: salon.id,
            operation: 'prepare_race_missing',
          });
          return sendWhatsAppError(
            res,
            'WHATSAPP_NOT_CONFIGURED',
            500,
            'WhatsApp connection storage is unavailable'
          );
        }
      }
    }

    const payload = await loadPublicIntegration(salon.id);
    if (!payload.connection) {
      console.error('[whatsapp] prepare completed but public connection missing', {
        salonId: salon.id,
        operation: 'prepare_public_missing',
      });
      return sendWhatsAppError(
        res,
        'WHATSAPP_NOT_CONFIGURED',
        500,
        'WhatsApp connection storage is unavailable'
      );
    }

    return res.status(200).json({
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      connected: payload.connected,
      connection: payload.connection,
    });
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'prepare');
  }
});

/**
 * POST /api/developer/integrations/whatsapp/:salonId/connect
 *
 * State machine (WA-2D preserved):
 * - Meta verify + encrypt before secret write
 * - Never demote a previously usable connection as compensation
 * - HTTP 200 only after DB-confirmed public read (connected + connection)
 */
router.post('/:salonId/connect', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';

  let salon: SalonLookupRow;
  try {
    const looked = await requireActiveSalon(salonId);
    if ('error' in looked) {
      return res.status(404).json({ error: looked.error, code: 'WHATSAPP_CONNECTION_NOT_FOUND' });
    }
    salon = looked;
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'developer_connect_salon');
  }

  const parsed = parseConnectBody(req.body);
  if ('error' in parsed) {
    return res.status(400).json({ error: parsed.error, code: 'WHATSAPP_INVALID_CREDENTIALS' });
  }

  try {
    assertWhatsAppCredentialsEncryptionKeyConfigured();
  } catch (err) {
    return handleRouteError(res, err, salon.id, 'connect_key_check');
  }

  let phoneMeta;
  try {
    phoneMeta = await verifyWhatsAppCloudConnection({
      accessToken: parsed.accessToken,
      businessAccountId: parsed.businessAccountId,
      phoneNumberId: parsed.phoneNumberId,
    });
  } catch (err) {
    return handleRouteError(res, err, salon.id, 'connect_meta_verify');
  }

  let accessEnc;
  let appSecretEnc;
  let verifyEnc;
  try {
    accessEnc = encryptWhatsAppCredential(parsed.accessToken);
    appSecretEnc = encryptWhatsAppCredential(parsed.appSecret);
    verifyEnc = encryptWhatsAppCredential(parsed.verifyToken);
  } catch (err) {
    return handleRouteError(res, err, salon.id, 'connect_encrypt');
  }

  let wasUsablyConnected = false;
  try {
    const prior = await capturePriorConnectionState(salon.id);
    wasUsablyConnected = prior.wasUsablyConnected;
  } catch (err) {
    return handleRouteError(res, err, salon.id, 'connect_prior_state');
  }

  try {
    const integration = await ensureWhatsAppIntegrationRow(salon.id);
    const now = new Date().toISOString();

    const { error: upsertError } = await supabase.from('whatsapp_business_connections').upsert(
      {
        salon_id: salon.id,
        integration_id: integration.id,
        provider: CLOUD_PROVIDER,
        business_account_id: parsed.businessAccountId,
        phone_number_id: parsed.phoneNumberId,
        display_phone_number: phoneMeta.displayPhoneNumber,
        verified_name: phoneMeta.verifiedName,
        access_token_ciphertext: accessEnc.ciphertext,
        access_token_iv: accessEnc.iv,
        access_token_auth_tag: accessEnc.authTag,
        app_secret_ciphertext: appSecretEnc.ciphertext,
        app_secret_iv: appSecretEnc.iv,
        app_secret_auth_tag: appSecretEnc.authTag,
        verify_token_ciphertext: verifyEnc.ciphertext,
        verify_token_iv: verifyEnc.iv,
        verify_token_auth_tag: verifyEnc.authTag,
        token_expires_at: null,
        quality_rating: phoneMeta.qualityRating,
        messaging_limit_tier: phoneMeta.messagingLimitTier,
        updated_at: now,
      },
      { onConflict: 'salon_id' }
    );

    if (upsertError) {
      if (isPhoneNumberIdUniqueConflict(upsertError)) {
        throw new WhatsAppAppError(
          'WHATSAPP_PHONE_NUMBER_IN_USE',
          409,
          'This phone number is already connected to another salon'
        );
      }
      throw new Error('WhatsApp connection storage write failed');
    }

    const marked = await markIntegrationConnectedWithRetry(salon.id, integration.id);

    if (!marked) {
      if (wasUsablyConnected) {
        console.error('[whatsapp] reconnect status mark failed; preserving connected', {
          salonId: salon.id,
          operation: 'connect_mark_after_reconnect',
        });
      } else {
        console.error('[whatsapp] first-time status mark failed; leaving not_connected', {
          salonId: salon.id,
          operation: 'connect_mark_first_time',
        });
        return sendWhatsAppError(
          res,
          'WHATSAPP_NOT_CONFIGURED',
          503,
          'WhatsApp connection storage is unavailable'
        );
      }
    }

    let payload = await loadPublicIntegrationWithRetry(salon.id);

    if (payload && wasUsablyConnected && !payload.connected) {
      console.error('[whatsapp] reconnect public load unexpected disconnected; not demoting', {
        salonId: salon.id,
        operation: 'connect_public_load_reconnect',
      });
      await markIntegrationConnectedWithRetry(salon.id, integration.id);
      payload = await loadPublicIntegrationWithRetry(salon.id);
    }

    if (payload?.connected && payload.connection) {
      return res.status(200).json({
        salonId: salon.id,
        salonName: salon.name,
        slug: salon.slug,
        connected: payload.connected,
        connection: payload.connection,
      });
    }

    console.error('[whatsapp] public load unconfirmed after write; not demoting', {
      salonId: salon.id,
      operation: 'connect_public_load_unconfirmed',
      marked,
      wasUsablyConnected,
    });
    return sendWhatsAppError(
      res,
      'WHATSAPP_NOT_CONFIGURED',
      503,
      'WhatsApp connection storage is unavailable'
    );
  } catch (err) {
    return handleRouteError(res, err, salon.id, 'connect_persist');
  }
});

/**
 * DELETE /api/developer/integrations/whatsapp/:salonId/disconnect
 * Soft disconnect only.
 */
router.delete('/:salonId/disconnect', async (req, res) => {
  const salonId = typeof req.params.salonId === 'string' ? req.params.salonId.trim() : '';
  const now = new Date().toISOString();

  try {
    const salon = await requireActiveSalon(salonId);
    if ('error' in salon) {
      return res.status(404).json({ error: salon.error, code: 'WHATSAPP_CONNECTION_NOT_FOUND' });
    }

    const { data: existing, error: existingError } = await supabase
      .from('whatsapp_business_connections')
      .select('id')
      .eq('salon_id', salon.id)
      .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message);
    }

    if (existing) {
      const { error: clearError } = await supabase
        .from('whatsapp_business_connections')
        .update({
          access_token_ciphertext: null,
          access_token_iv: null,
          access_token_auth_tag: null,
          app_secret_ciphertext: null,
          app_secret_iv: null,
          app_secret_auth_tag: null,
          verify_token_ciphertext: null,
          verify_token_iv: null,
          verify_token_auth_tag: null,
          phone_number_id: null,
          display_phone_number: null,
          verified_name: null,
          business_account_id: null,
          token_expires_at: null,
          quality_rating: null,
          messaging_limit_tier: null,
          updated_at: now,
        })
        .eq('salon_id', salon.id);

      if (clearError) {
        throw new Error(clearError.message);
      }
    }

    await markIntegrationNotConnected(salon.id);

    const payload = await loadPublicIntegration(salon.id);
    return res.json({
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      connected: payload.connected,
      connection: payload.connection,
    });
  } catch (err) {
    return handleRouteError(res, err, salonId || null, 'disconnect');
  }
});

export default router;
