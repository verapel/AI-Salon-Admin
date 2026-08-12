/**
 * IG-2 / IG-2A / IG-2B: Persist verified Instagram connection after Meta verification.
 *
 * Authoritative record: instagram_business_connections.
 * Authority boundary: successful upsert of status='connected' + token triple +
 * verified instagram_user_id. After that commit, registry sync and public DTO
 * read-back are secondary — failures become pending/degraded success, not OAuth error.
 *
 * Non-destructive on pre-persist failures — never clears an existing working connection.
 */

import { supabase } from './supabase.js';
import {
  encryptInstagramCredential,
  isInstagramCredentialCryptoError,
} from './instagramCredentialsCrypto.js';
import {
  INSTAGRAM_CONNECTION_PUBLIC_SELECT,
  INSTAGRAM_CREDENTIAL_PRESENCE_SELECT,
  isInstagramCredentialTripleStored,
  isMeaningfulInstagramConnectionPresence,
  mapInstagramConnectionPublic,
  type DeveloperInstagramIntegration,
  type InstagramConnectionMetadataRow,
  type InstagramCredentialTripleRow,
} from './instagramConnectionPublic.js';
import {
  InstagramApiError,
  type InstagramVerifiedAccount,
} from './instagramApi.js';
import { isInstagramOutboundEnabled } from './instagramOutboundWorker.js';

const INSTAGRAM_PROVIDER = 'instagram' as const;

export type PersistInstagramConnectionResult =
  | {
      ok: true;
      /** Authoritative connection write committed. */
      connectionCommitted: true;
      /** Public DTO read-back after commit. */
      confirmation: 'ok' | 'pending';
      /** salon_integrations registry sync after commit. */
      registrySync: 'ok' | 'pending';
      integration: DeveloperInstagramIntegration | null;
    }
  | { ok: false; error: InstagramApiError };

/** Pure classifier for post-authoritative secondary steps (executed in tests). */
export function classifyPostAuthoritativePersistOutcome(input: {
  readBackConnected: boolean;
  registryMarked: boolean;
}): { confirmation: 'ok' | 'pending'; registrySync: 'ok' | 'pending' } {
  return {
    confirmation: input.readBackConnected ? 'ok' : 'pending',
    registrySync: input.registryMarked ? 'ok' : 'pending',
  };
}

/** Build the authoritative mutation (ID must remain opaque string exactly). */
export function buildAuthoritativeInstagramConnectionMutation(
  salonId: string,
  verified: InstagramVerifiedAccount,
  encrypted: { ciphertext: string; iv: string; authTag: string },
  connectedAt: string,
): {
  salon_id: string;
  instagram_user_id: string;
  instagram_username: string | null;
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_auth_tag: string;
  status: 'connected';
  connected_at: string;
  last_error: null;
  token_expires_at: string | null;
  updated_at: string;
} {
  return {
    salon_id: salonId,
    instagram_user_id: verified.instagramUserId,
    instagram_username: verified.username,
    access_token_ciphertext: encrypted.ciphertext,
    access_token_iv: encrypted.iv,
    access_token_auth_tag: encrypted.authTag,
    status: 'connected',
    connected_at: connectedAt,
    last_error: null,
    token_expires_at: verified.tokenExpiresAt,
    updated_at: connectedAt,
  };
}

export type PersistInstagramDeps = {
  findCrossSalonAccount: (
    salonId: string,
    instagramUserId: string,
  ) => Promise<{ otherSalon: boolean; storageError: boolean }>;
  upsertConnection: (
    mutation: ReturnType<typeof buildAuthoritativeInstagramConnectionMutation>,
  ) => Promise<{ uniqueViolation: boolean; error: boolean }>;
  markRegistryConnected: (salonId: string, connectedAt: string) => Promise<boolean>;
  loadPublicIntegration: (salonId: string) => Promise<DeveloperInstagramIntegration | null>;
};

async function defaultLoadPublicIntegration(
  salonId: string,
): Promise<DeveloperInstagramIntegration | null> {
  const { data: salon, error: salonError } = await supabase
    .from('salons')
    .select('id, name, slug, active')
    .eq('id', salonId)
    .maybeSingle();

  if (salonError) throw new Error(salonError.message);
  if (!salon || !(salon as { active: boolean }).active) return null;

  const salonRow = salon as { id: string; name: string; slug: string };

  const { data: registry, error: registryError } = await supabase
    .from('salon_integrations')
    .select('id')
    .eq('salon_id', salonId)
    .eq('provider', INSTAGRAM_PROVIDER)
    .maybeSingle();
  if (registryError) throw new Error(registryError.message);
  const registryPresent = Boolean(registry);

  const { data: meta, error: metaError } = await supabase
    .from('instagram_business_connections')
    .select(INSTAGRAM_CONNECTION_PUBLIC_SELECT)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (metaError) throw new Error(metaError.message);

  if (!meta) {
    return {
      salonId: salonRow.id,
      salonName: salonRow.name,
      slug: salonRow.slug,
      integrationAdded: registryPresent,
      connected: false,
      connection: null,
      requiresRemoveConfirmation: false,
      outboundEnabled: isInstagramOutboundEnabled(),
    };
  }

  const { data: creds, error: credError } = await supabase
    .from('instagram_business_connections')
    .select(INSTAGRAM_CREDENTIAL_PRESENCE_SELECT)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (credError) throw new Error(credError.message);
  const credRow = (creds as InstagramCredentialTripleRow | null) ?? null;
  const stored = credRow
    ? isInstagramCredentialTripleStored(
        credRow.access_token_ciphertext,
        credRow.access_token_iv,
        credRow.access_token_auth_tag,
      )
    : false;

  const connection = mapInstagramConnectionPublic(
    meta as unknown as InstagramConnectionMetadataRow,
    stored,
  );
  const meaningful = isMeaningfulInstagramConnectionPresence(connection, stored);

  return {
    salonId: salonRow.id,
    salonName: salonRow.name,
    slug: salonRow.slug,
    integrationAdded: registryPresent || meaningful,
    connected: connection.status === 'connected' && connection.isAccessTokenStored,
    connection,
    requiresRemoveConfirmation: stored,
    outboundEnabled: isInstagramOutboundEnabled(),
  };
}

function isUniqueViolation(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  const hay = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
  return (
    hay.includes('instagram_business_connections_instagram_user_id_unique') ||
    (hay.includes('instagram_user_id') &&
      (hay.includes('duplicate') || hay.includes('unique')))
  );
}

/**
 * Ensure salon_integrations row for Instagram exists (visibility / "added").
 * Does NOT create instagram_business_connections or credentials.
 * Idempotent — duplicate unique races are ignored.
 */
export async function ensureInstagramIntegrationRow(salonId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await supabase
    .from('salon_integrations')
    .select('id')
    .eq('salon_id', salonId)
    .eq('provider', INSTAGRAM_PROVIDER)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);
  if (existing) return;

  const { error: insertError } = await supabase.from('salon_integrations').insert({
    salon_id: salonId,
    provider: INSTAGRAM_PROVIDER,
    status: 'not_connected',
    health: 'unknown',
    token_ciphertext: null,
    created_at: now,
    updated_at: now,
  });

  if (insertError) {
    const hay = `${insertError.message ?? ''}`.toLowerCase();
    if (!hay.includes('duplicate') && !hay.includes('unique')) {
      throw new Error(insertError.message);
    }
  }
}

async function defaultMarkIntegrationConnected(
  salonId: string,
  connectedAt: string,
): Promise<boolean> {
  try {
    await ensureInstagramIntegrationRow(salonId);
  } catch {
    return false;
  }
  const { error } = await supabase
    .from('salon_integrations')
    .update({
      status: 'connected',
      health: 'healthy',
      last_error: null,
      connected_at: connectedAt,
      updated_at: connectedAt,
      token_ciphertext: null,
    })
    .eq('salon_id', salonId)
    .eq('provider', INSTAGRAM_PROVIDER);

  return !error;
}

function createDefaultDeps(): PersistInstagramDeps {
  return {
    async findCrossSalonAccount(salonId, instagramUserId) {
      const { data: other, error: otherError } = await supabase
        .from('instagram_business_connections')
        .select('salon_id')
        .eq('instagram_user_id', instagramUserId)
        .neq('salon_id', salonId)
        .maybeSingle();
      if (otherError) return { otherSalon: false, storageError: true };
      return { otherSalon: Boolean(other), storageError: false };
    },
    async upsertConnection(mutation) {
      const { error: upsertError } = await supabase
        .from('instagram_business_connections')
        .upsert(mutation, { onConflict: 'salon_id' });
      if (!upsertError) return { uniqueViolation: false, error: false };
      return {
        uniqueViolation: isUniqueViolation(upsertError),
        error: true,
      };
    },
    markRegistryConnected: defaultMarkIntegrationConnected,
    loadPublicIntegration: defaultLoadPublicIntegration,
  };
}

/**
 * Persist a Meta-verified Instagram connection for salonId.
 *
 * Authoritative success boundary = successful connection upsert of:
 *   status='connected' + encrypted token triple + verified instagram_user_id.
 * After that commit, read-back (DTO confirmation) and registry sync are secondary.
 */
export async function persistVerifiedInstagramConnection(
  salonId: string,
  verified: InstagramVerifiedAccount,
  deps: PersistInstagramDeps = createDefaultDeps(),
): Promise<PersistInstagramConnectionResult> {
  const cross = await deps.findCrossSalonAccount(salonId, verified.instagramUserId);
  if (cross.storageError) {
    return {
      ok: false,
      error: new InstagramApiError(
        'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE',
        503,
        'Instagram connection storage is unavailable',
      ),
    };
  }
  if (cross.otherSalon) {
    return {
      ok: false,
      error: new InstagramApiError(
        'INSTAGRAM_ACCOUNT_IN_USE',
        409,
        'This Instagram Professional Account is already connected to another salon',
      ),
    };
  }

  let encrypted;
  try {
    encrypted = encryptInstagramCredential(verified.accessToken);
  } catch (err) {
    if (isInstagramCredentialCryptoError(err)) {
      return {
        ok: false,
        error: new InstagramApiError(
          'INSTAGRAM_NOT_CONFIGURED',
          503,
          'Instagram credential encryption is not configured',
        ),
      };
    }
    throw err;
  }

  const now = new Date().toISOString();
  const mutation = buildAuthoritativeInstagramConnectionMutation(
    salonId,
    verified,
    encrypted,
    now,
  );

  if (
    'accessToken' in mutation ||
    JSON.stringify(mutation).includes(verified.accessToken)
  ) {
    return {
      ok: false,
      error: new InstagramApiError(
        'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE',
        500,
        'Instagram connection persistence aborted',
      ),
    };
  }

  // Exact opaque ID must reach the mutation unchanged (no numeric reformatting).
  if (mutation.instagram_user_id !== verified.instagramUserId) {
    return {
      ok: false,
      error: new InstagramApiError(
        'INSTAGRAM_INVALID_IDENTITY',
        500,
        'Instagram identity could not be persisted safely',
      ),
    };
  }

  const upsert = await deps.upsertConnection(mutation);
  if (upsert.error) {
    if (upsert.uniqueViolation) {
      return {
        ok: false,
        error: new InstagramApiError(
          'INSTAGRAM_ACCOUNT_IN_USE',
          409,
          'This Instagram Professional Account is already connected to another salon',
        ),
      };
    }
    return {
      ok: false,
      error: new InstagramApiError(
        'INSTAGRAM_TEMPORARY_PROVIDER_FAILURE',
        503,
        'Instagram connection storage is unavailable',
      ),
    };
  }

  // --- Authoritative connection committed. Secondary steps cannot un-succeed OAuth. ---

  let integration: DeveloperInstagramIntegration | null = null;
  let readBackConnected = false;
  try {
    integration = await deps.loadPublicIntegration(salonId);
    readBackConnected = Boolean(integration?.connected && integration.connection);
  } catch {
    integration = null;
    readBackConnected = false;
  }

  const registryMarked = await deps.markRegistryConnected(salonId, now);
  const outcome = classifyPostAuthoritativePersistOutcome({
    readBackConnected,
    registryMarked,
  });

  if (outcome.confirmation === 'pending' || outcome.registrySync === 'pending') {
    console.error('[instagram] post-authoritative sync pending after connect', {
      operation: 'persist_post_authoritative_pending',
      salonId,
      confirmation: outcome.confirmation,
      registrySync: outcome.registrySync,
    });
  }

  return {
    ok: true,
    connectionCommitted: true,
    confirmation: outcome.confirmation,
    registrySync: outcome.registrySync,
    integration: readBackConnected ? integration : null,
  };
}
