/**
 * Owner/admin calendar connection APIs.
 * APPLE-A3B: Apple connect/disconnect (encrypted app-specific passwords).
 * GOOGLE-CAL-A2: provider-neutral GET read model (no Google OAuth/import yet).
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import {
  encryptCalendarCredential,
  isCalendarCredentialCryptoError,
} from '../lib/calendarCredentialsCrypto.js';
import type {
  AppleCalendarConnectRequest,
  CalendarConnectionPublic,
  CalendarConnectionStatus,
  CalendarProvider,
} from '../types.js';

const router = Router();

const APPLE_PROVIDER = 'apple' as const;

/** Explicit metadata columns — never select credential_* or provider_config for responses. */
const CONNECTION_METADATA_SELECT = `
  id,
  provider,
  account_email,
  selected_calendar_id,
  selected_calendar_url,
  selected_calendar_name,
  status,
  import_enabled,
  last_sync_at,
  last_sync_started_at,
  last_error,
  created_at,
  updated_at
`.replace(/\s+/g, ' ').trim();

/**
 * Internal read may include credential columns solely to compute isCredentialStored.
 * Those columns must never appear on CalendarConnectionPublic.
 */
const CONNECTION_INTERNAL_SELECT = `${CONNECTION_METADATA_SELECT}, credential_ciphertext, credential_iv, credential_auth_tag`;

type ConnectionMetadataRow = {
  id: string;
  provider: CalendarProvider;
  account_email: string | null;
  selected_calendar_id: string | null;
  selected_calendar_url: string | null;
  selected_calendar_name: string | null;
  status: CalendarConnectionStatus;
  import_enabled: boolean;
  last_sync_at: string | null;
  last_sync_started_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ConnectionInternalRow = ConnectionMetadataRow & {
  credential_ciphertext: string | null;
  credential_iv: string | null;
  credential_auth_tag: string | null;
};

function isCredentialMaterialPresent(row: {
  credential_ciphertext: string | null;
  credential_iv: string | null;
  credential_auth_tag: string | null;
}): boolean {
  const ciphertext = row.credential_ciphertext;
  const iv = row.credential_iv;
  const authTag = row.credential_auth_tag;
  return (
    typeof ciphertext === 'string' &&
    ciphertext.trim().length > 0 &&
    typeof iv === 'string' &&
    iv.trim().length > 0 &&
    typeof authTag === 'string' &&
    authTag.trim().length > 0
  );
}

function toMetadataRow(row: ConnectionInternalRow): ConnectionMetadataRow {
  return {
    id: row.id,
    provider: row.provider,
    account_email: row.account_email,
    selected_calendar_id: row.selected_calendar_id,
    selected_calendar_url: row.selected_calendar_url,
    selected_calendar_name: row.selected_calendar_name,
    status: row.status,
    import_enabled: row.import_enabled,
    last_sync_at: row.last_sync_at,
    last_sync_started_at: row.last_sync_started_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Map an explicitly selected metadata row to the public DTO.
 * Never accepts or spreads credential fields.
 */
export function mapCalendarConnectionSafe(
  row: ConnectionMetadataRow,
  isCredentialStored: boolean
): CalendarConnectionPublic {
  const verificationPending = isCredentialStored && row.status === 'connected';
  return {
    id: row.id,
    provider: row.provider,
    accountEmail: row.account_email,
    selectedCalendarId: row.selected_calendar_id,
    selectedCalendarName: row.selected_calendar_name,
    selectedCalendarUrl: row.selected_calendar_url,
    status: row.status,
    importEnabled: row.import_enabled,
    lastSyncAt: row.last_sync_at,
    lastSyncStartedAt: row.last_sync_started_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isCredentialStored,
    verificationPending,
  };
}

/** Build public DTO from an internal row (credential columns used for presence only). */
export function mapCalendarConnectionInternalSafe(
  row: ConnectionInternalRow
): CalendarConnectionPublic {
  return mapCalendarConnectionSafe(toMetadataRow(row), isCredentialMaterialPresent(row));
}

/**
 * Split multi-provider list into legacy Apple `connection` + full `connections`.
 * Legacy field stays Apple-only for existing SalonIntegrations UI.
 */
export function buildCalendarConnectionsResponse(
  connections: CalendarConnectionPublic[]
): {
  connection: CalendarConnectionPublic | null;
  connections: CalendarConnectionPublic[];
} {
  const apple = connections.find((c) => c.provider === APPLE_PROVIDER) ?? null;
  return { connection: apple, connections };
}

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseConnectBody(body: unknown): AppleCalendarConnectRequest | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid request body' };
  }
  const raw = body as Record<string, unknown>;
  const accountEmail = typeof raw.accountEmail === 'string' ? raw.accountEmail.trim() : '';
  const appSpecificPassword =
    typeof raw.appSpecificPassword === 'string' ? raw.appSpecificPassword.trim() : '';

  if (!accountEmail) {
    return { error: 'accountEmail is required' };
  }
  if (!BASIC_EMAIL_RE.test(accountEmail)) {
    return { error: 'accountEmail is invalid' };
  }
  if (!appSpecificPassword) {
    return { error: 'appSpecificPassword is required' };
  }
  // Reject accidental field names that imply the normal Apple account password.
  if ('password' in raw || 'applePassword' in raw || 'accountPassword' in raw) {
    return { error: 'Only appSpecificPassword is accepted' };
  }

  return { accountEmail, appSpecificPassword };
}

async function loadAppleConnectionPublic(
  salonId: string
): Promise<CalendarConnectionPublic | null> {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select(CONNECTION_INTERNAL_SELECT)
    .eq('salon_id', salonId)
    .eq('provider', APPLE_PROVIDER)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) return null;

  return mapCalendarConnectionInternalSafe(data as unknown as ConnectionInternalRow);
}

/**
 * Load all calendar connections for the authenticated salon (safe public DTOs).
 * Scoped exclusively by salon_id from auth context.
 */
export async function loadSalonCalendarConnectionsPublic(
  salonId: string
): Promise<CalendarConnectionPublic[]> {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select(CONNECTION_INTERNAL_SELECT)
    .eq('salon_id', salonId)
    .order('provider', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as unknown as ConnectionInternalRow[];
  return rows.map((row) => mapCalendarConnectionInternalSafe(row));
}

/**
 * GET /api/calendar/connections
 * Provider-neutral safe metadata for the authenticated salon.
 * Response:
 *   connection  — legacy Apple-only field (SalonIntegrations compatibility)
 *   connections — all providers for this salon (may include google when present)
 * Does not create Google rows or start OAuth.
 */
router.get('/connections', async (req, res) => {
  try {
    const salonId = getSalonId(req);
    const connections = await loadSalonCalendarConnectionsPublic(salonId);
    return res.json(buildCalendarConnectionsResponse(connections));
  } catch (err) {
    console.error('[calendar] GET connections failed', {
      salonId: req.auth?.salonId ?? null,
      operation: 'get_connections',
    });
    return res.status(500).json({ error: 'Could not load calendar connections' });
  }
});

/**
 * POST /api/calendar/apple/connect
 * Encrypts app-specific password and upserts apple calendar_connections row.
 * Does not verify CalDAV — status "connected" means credentials stored only.
 */
router.post('/apple/connect', requireSalonWriteAccess, async (req, res) => {
  const parsed = parseConnectBody(req.body);
  if ('error' in parsed) {
    return res.status(400).json({ error: parsed.error });
  }

  const salonId = getSalonId(req);
  const { accountEmail, appSpecificPassword } = parsed;

  let encrypted;
  try {
    encrypted = encryptCalendarCredential(appSpecificPassword);
  } catch (err) {
    if (isCalendarCredentialCryptoError(err)) {
      console.error('[calendar] connect encrypt failed', {
        salonId,
        operation: 'apple_connect_encrypt',
      });
      return res.status(503).json({ error: 'Credential storage is unavailable' });
    }
    console.error('[calendar] connect encrypt unexpected failure', {
      salonId,
      operation: 'apple_connect_encrypt',
    });
    return res.status(500).json({ error: 'Could not store Apple credentials' });
  }

  const now = new Date().toISOString();

  try {
    const { error } = await supabase.from('calendar_connections').upsert(
      {
        salon_id: salonId,
        provider: APPLE_PROVIDER,
        account_email: accountEmail,
        credential_ciphertext: encrypted.ciphertext,
        credential_iv: encrypted.iv,
        credential_auth_tag: encrypted.authTag,
        status: 'connected',
        import_enabled: false,
        last_error: null,
        // Credential replacement cannot reliably prove same Apple Account — clear stale state.
        selected_calendar_id: null,
        selected_calendar_url: null,
        selected_calendar_name: null,
        last_sync_at: null,
        last_sync_started_at: null,
        sync_lock_token: null,
        updated_at: now,
      },
      { onConflict: 'salon_id,provider' }
    );

    if (error) {
      console.error('[calendar] connect upsert failed', {
        salonId,
        operation: 'apple_connect_upsert',
      });
      return res.status(500).json({ error: 'Could not store Apple credentials' });
    }

    const connection = await loadAppleConnectionPublic(salonId);
    if (!connection) {
      return res.status(500).json({ error: 'Could not store Apple credentials' });
    }

    return res.status(200).json({
      connection,
      // Explicit: A3B does not call Apple/CalDAV.
      verificationPending: true,
      message: 'Credentials stored securely. Apple verification is pending.',
    });
  } catch {
    console.error('[calendar] connect failed', {
      salonId,
      operation: 'apple_connect',
    });
    return res.status(500).json({ error: 'Could not store Apple credentials' });
  }
});

/**
 * DELETE /api/calendar/apple
 * Wipe credentials and reset Apple connection state; keep the row.
 */
router.delete('/apple', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const now = new Date().toISOString();

  try {
    const { data: existing, error: existingError } = await supabase
      .from('calendar_connections')
      .select('id')
      .eq('salon_id', salonId)
      .eq('provider', APPLE_PROVIDER)
      .maybeSingle();

    if (existingError) {
      console.error('[calendar] disconnect lookup failed', {
        salonId,
        operation: 'apple_disconnect_lookup',
      });
      return res.status(500).json({ error: 'Could not disconnect Apple Calendar' });
    }

    if (!existing) {
      return res.json({ connection: null });
    }

    const { error: updateError } = await supabase
      .from('calendar_connections')
      .update({
        credential_ciphertext: null,
        credential_iv: null,
        credential_auth_tag: null,
        account_email: null,
        import_enabled: false,
        status: 'disconnected',
        selected_calendar_id: null,
        selected_calendar_url: null,
        selected_calendar_name: null,
        last_error: null,
        last_sync_at: null,
        last_sync_started_at: null,
        sync_lock_token: null,
        updated_at: now,
      })
      .eq('salon_id', salonId)
      .eq('provider', APPLE_PROVIDER);

    if (updateError) {
      console.error('[calendar] disconnect update failed', {
        salonId,
        operation: 'apple_disconnect_update',
      });
      return res.status(500).json({ error: 'Could not disconnect Apple Calendar' });
    }

    const connection = await loadAppleConnectionPublic(salonId);
    return res.json({ connection });
  } catch {
    console.error('[calendar] disconnect failed', {
      salonId,
      operation: 'apple_disconnect',
    });
    return res.status(500).json({ error: 'Could not disconnect Apple Calendar' });
  }
});

export default router;
