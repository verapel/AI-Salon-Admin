/**
 * IG-3: Instagram Professional Account → salon routing.
 * Routing key = opaque instagram_user_id string only (never username).
 */

import { supabase } from './supabase.js';
import {
  INSTAGRAM_CREDENTIAL_PRESENCE_SELECT,
  isInstagramCredentialTripleStored,
  type InstagramCredentialTripleRow,
} from './instagramConnectionPublic.js';
import { tryParseInstagramWebhookOpaqueId } from './instagramWebhookEvents.js';

export type InstagramRouteResult =
  | {
      kind: 'connected';
      salonId: string;
      professionalAccountId: string;
    }
  | {
      kind: 'disconnected';
      salonId: string;
      professionalAccountId: string;
      reason: 'not_connected' | 'missing_token' | 'inactive_salon';
    }
  | {
      kind: 'unknown';
      professionalAccountId: string | null;
      reason: 'unknown_account' | 'invalid_id';
    }
  | {
      kind: 'failed_transient';
      code: string;
    };

export type InstagramRoutingDeps = {
  findConnectionByProfessionalId: (professionalAccountId: string) => Promise<
    | { ok: true; row: { salon_id: string; status: string } | null }
    | { ok: false }
  >;
  findSalonActive: (
    salonId: string,
  ) => Promise<{ ok: true; active: boolean } | { ok: false }>;
  findTokenTripleStored: (
    salonId: string,
  ) => Promise<{ ok: true; stored: boolean } | { ok: false }>;
};

function createDefaultRoutingDeps(): InstagramRoutingDeps {
  return {
    async findConnectionByProfessionalId(professionalAccountId) {
      const { data: conn, error } = await supabase
        .from('instagram_business_connections')
        .select('salon_id, instagram_user_id, status')
        .eq('instagram_user_id', professionalAccountId)
        .maybeSingle();
      if (error) return { ok: false };
      if (!conn) return { ok: true, row: null };
      return {
        ok: true,
        row: {
          salon_id: String((conn as { salon_id: string }).salon_id),
          status: String((conn as { status: string }).status),
        },
      };
    },
    async findSalonActive(salonId) {
      const { data: salon, error } = await supabase
        .from('salons')
        .select('id, active')
        .eq('id', salonId)
        .maybeSingle();
      if (error) return { ok: false };
      return { ok: true, active: Boolean(salon && (salon as { active: boolean }).active) };
    },
    async findTokenTripleStored(salonId) {
      const { data: creds, error } = await supabase
        .from('instagram_business_connections')
        .select(INSTAGRAM_CREDENTIAL_PRESENCE_SELECT)
        .eq('salon_id', salonId)
        .maybeSingle();
      if (error) return { ok: false };
      const credRow = (creds as InstagramCredentialTripleRow | null) ?? null;
      const stored = credRow
        ? isInstagramCredentialTripleStored(
            credRow.access_token_ciphertext,
            credRow.access_token_iv,
            credRow.access_token_auth_tag,
          )
        : false;
      return { ok: true, stored };
    },
  };
}

/**
 * Resolve Professional Account ID → salon.
 * Does not mutate connections. Does not create rows.
 */
export async function resolveInstagramProfessionalAccountRoute(
  professionalAccountIdRaw: unknown,
  deps: InstagramRoutingDeps = createDefaultRoutingDeps(),
): Promise<InstagramRouteResult> {
  const professionalAccountId = tryParseInstagramWebhookOpaqueId(professionalAccountIdRaw);
  if (!professionalAccountId) {
    return { kind: 'unknown', professionalAccountId: null, reason: 'invalid_id' };
  }

  const conn = await deps.findConnectionByProfessionalId(professionalAccountId);
  if (!conn.ok) {
    return { kind: 'failed_transient', code: 'route_lookup' };
  }
  if (!conn.row) {
    return {
      kind: 'unknown',
      professionalAccountId,
      reason: 'unknown_account',
    };
  }

  const salonId = conn.row.salon_id;
  const status = conn.row.status;

  const salon = await deps.findSalonActive(salonId);
  if (!salon.ok) {
    return { kind: 'failed_transient', code: 'salon_lookup' };
  }
  if (!salon.active) {
    return {
      kind: 'disconnected',
      salonId,
      professionalAccountId,
      reason: 'inactive_salon',
    };
  }

  if (status !== 'connected') {
    return {
      kind: 'disconnected',
      salonId,
      professionalAccountId,
      reason: 'not_connected',
    };
  }

  const token = await deps.findTokenTripleStored(salonId);
  if (!token.ok) {
    return { kind: 'failed_transient', code: 'credential_lookup' };
  }
  if (!token.stored) {
    return {
      kind: 'disconnected',
      salonId,
      professionalAccountId,
      reason: 'missing_token',
    };
  }

  return {
    kind: 'connected',
    salonId,
    professionalAccountId,
  };
}
