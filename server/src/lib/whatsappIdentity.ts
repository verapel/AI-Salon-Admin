/**
 * WhatsApp client_channel_identities resolution + attach (WA-4B / WA-4B1).
 * Conversation-first: never creates clients; attaches identity only to a real client.
 * Durable identity/client-link writes go through owned Postgres RPCs (receipt FOR UPDATE).
 * No appointments or outbound messaging (booking FSM is WA-4C, separate).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  linkWhatsAppConversationClient,
  touchWhatsAppConversation,
} from './whatsappConversation.js';
import {
  normalizeWhatsAppAddress,
  type InboundSenderIdentity,
} from './whatsappInboundIdentity.js';

export const WHATSAPP_IDENTITY_PROVIDER = 'whatsapp' as const;

export type IdentityResolutionOutcome =
  | 'existing_identity'
  | 'unique_phone_match'
  | 'unresolved'
  | 'ambiguous'
  | 'conversation_only';

export type InboundIdentityFoundationResult =
  | {
      kind: 'ok';
      outcome: IdentityResolutionOutcome;
      conversationId: string;
      clientId: string | null;
      expiredReset: boolean;
      /** False when inbound was older than conversation.last_inbound_at (out-of-order). */
      advanced: boolean;
      externalUserId: string;
    }
  | {
      kind: 'conflict';
      code:
        | 'identity_client_mismatch'
        | 'conversation_client_mismatch'
        | 'normalized_address_conflict'
        | 'sender_mismatch'
        | 'identity_client_missing';
    }
  | { kind: 'lost_ownership' }
  | { kind: 'skipped'; code: 'malformed_sender' | 'not_inbound' }
  | { kind: 'error'; code: string };

type IdentityRow = {
  id: string;
  salon_id: string;
  client_id: string;
  external_user_id: string;
  normalized_address: string | null;
};

type ClientRow = {
  id: string;
  salon_id: string;
  phone: string;
  is_blocked: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function loadIdentityByExternalUserId(
  db: SupabaseClient | any,
  salonId: string,
  externalUserId: string
): Promise<{ ok: true; identity: IdentityRow | null } | { ok: false; code: string }> {
  const { data, error } = await db
    .from('client_channel_identities')
    .select('id, salon_id, client_id, external_user_id, normalized_address')
    .eq('salon_id', salonId)
    .eq('provider', WHATSAPP_IDENTITY_PROVIDER)
    .eq('external_user_id', externalUserId)
    .maybeSingle();

  if (error) return { ok: false, code: 'identity_load' };
  if (!data) return { ok: true, identity: null };
  return {
    ok: true,
    identity: {
      id: String(data.id),
      salon_id: String(data.salon_id),
      client_id: String(data.client_id),
      external_user_id: String(data.external_user_id),
      normalized_address:
        data.normalized_address == null ? null : String(data.normalized_address),
    },
  };
}

async function loadSalonClient(
  db: SupabaseClient | any,
  salonId: string,
  clientId: string
): Promise<{ ok: true; client: ClientRow | null } | { ok: false; code: string }> {
  const { data, error } = await db
    .from('clients')
    .select('id, salon_id, phone, is_blocked')
    .eq('id', clientId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) return { ok: false, code: 'client_load' };
  if (!data) return { ok: true, client: null };
  return {
    ok: true,
    client: {
      id: String(data.id),
      salon_id: String(data.salon_id),
      phone: String(data.phone ?? ''),
      is_blocked: Boolean(data.is_blocked),
    },
  };
}

/**
 * Exact-one phone match within a salon using application-side normalization.
 * Read-only. 0 → unresolved, 1 → eligible, >1 → ambiguous (never pick first).
 */
export async function findUniqueSalonClientByNormalizedPhone(
  db: SupabaseClient | any,
  salonId: string,
  normalizedAddress: string
): Promise<
  | { kind: 'unique'; client: ClientRow }
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'error'; code: string }
> {
  const { data, error } = await db
    .from('clients')
    .select('id, salon_id, phone, is_blocked')
    .eq('salon_id', salonId)
    .neq('phone', '');

  if (error) return { kind: 'error', code: 'client_phone_search' };

  const matches: ClientRow[] = [];
  for (const row of data ?? []) {
    const phone = String((row as { phone?: string }).phone ?? '');
    const normalized = normalizeWhatsAppAddress(phone);
    if (normalized && normalized === normalizedAddress) {
      matches.push({
        id: String((row as { id: string }).id),
        salon_id: String((row as { salon_id: string }).salon_id),
        phone,
        is_blocked: Boolean((row as { is_blocked?: boolean }).is_blocked),
      });
    }
  }

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return { kind: 'unique', client: matches[0]! };
}

/**
 * Attach or refresh identity for an existing client via owned RPC.
 * Never flips client_id. Correctness boundary is the RPC receipt lock.
 */
export async function attachWhatsAppClientIdentity(params: {
  db: SupabaseClient | any;
  salonId: string;
  clientId: string;
  externalUserId: string;
  normalizedAddress: string | null;
  displayAddress: string | null;
  profileName: string | null;
  receiptId: string;
  attemptCount: number;
}): Promise<
  | { kind: 'ok' }
  | {
      kind: 'conflict';
      code:
        | 'identity_client_mismatch'
        | 'normalized_address_conflict'
        | 'identity_client_missing';
    }
  | { kind: 'lost_ownership' }
  | { kind: 'error'; code: string }
> {
  const { data, error } = await params.db.rpc('attach_whatsapp_identity_owned', {
    p_salon_id: params.salonId,
    p_receipt_id: params.receiptId,
    p_attempt_count: params.attemptCount,
    p_client_id: params.clientId,
    p_external_user_id: params.externalUserId,
    p_normalized_address: params.normalizedAddress,
    p_display_address: params.displayAddress,
    p_profile_name_hint: params.profileName,
  });

  if (error) {
    return { kind: 'error', code: 'identity_rpc' };
  }

  const row = asRecord(data);
  if (!row) return { kind: 'error', code: 'identity_rpc_shape' };

  const kind = String(row.kind ?? '');
  if (kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (kind === 'conflict') {
    const code = String(row.code ?? 'identity_client_mismatch');
    if (code === 'normalized_address_conflict') {
      return { kind: 'conflict', code: 'normalized_address_conflict' };
    }
    if (code === 'identity_client_missing') {
      return { kind: 'conflict', code: 'identity_client_missing' };
    }
    return { kind: 'conflict', code: 'identity_client_mismatch' };
  }
  if (kind === 'error') {
    return { kind: 'error', code: String(row.code ?? 'identity_rpc_error') };
  }
  if (kind !== 'ok') return { kind: 'error', code: 'identity_rpc_kind' };
  return { kind: 'ok' };
}

/**
 * WA-4B inbound foundation: owned conversation upsert + safe existing-client resolution.
 * Does not create clients. Does not send messages or run booking FSM.
 */
export async function processWhatsAppInboundIdentityFoundation(params: {
  db: SupabaseClient | any;
  salonId: string;
  sender: InboundSenderIdentity | null;
  externalMessageId: string | null;
  messageTimestampIso: string | null;
  receiptId: string;
  attemptCount: number;
}): Promise<InboundIdentityFoundationResult> {
  const sender = params.sender;
  if (!sender?.externalUserId) {
    return { kind: 'skipped', code: 'malformed_sender' };
  }

  if (sender.senderAddressMismatch) {
    // Permanent inconsistency in provider payload — fail closed, no attach.
    return { kind: 'conflict', code: 'sender_mismatch' };
  }

  const touched = await touchWhatsAppConversation({
    db: params.db,
    salonId: params.salonId,
    externalUserId: sender.externalUserId,
    externalMessageId: params.externalMessageId,
    messageTimestampIso: params.messageTimestampIso,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
    profileNameHint: sender.profileName,
  });

  if (touched.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (touched.kind === 'error') return { kind: 'error', code: touched.code };

  const conversationId = touched.conversationId;

  // 1) Existing identity lookup (read-only) before phone matching.
  const identityLoad = await loadIdentityByExternalUserId(
    params.db,
    params.salonId,
    sender.externalUserId
  );
  if (!identityLoad.ok) return { kind: 'error', code: identityLoad.code };

  if (identityLoad.identity) {
    const clientLoad = await loadSalonClient(
      params.db,
      params.salonId,
      identityLoad.identity.client_id
    );
    if (!clientLoad.ok) return { kind: 'error', code: clientLoad.code };
    if (!clientLoad.client) {
      return { kind: 'conflict', code: 'identity_client_missing' };
    }

    // Owned refresh (same client) — never unguarded direct UPDATE.
    const attached = await attachWhatsAppClientIdentity({
      db: params.db,
      salonId: params.salonId,
      clientId: clientLoad.client.id,
      externalUserId: sender.externalUserId,
      normalizedAddress: sender.normalizedAddress,
      displayAddress: sender.displayAddress,
      profileName: sender.profileName,
      receiptId: params.receiptId,
      attemptCount: params.attemptCount,
    });
    if (attached.kind === 'lost_ownership') return { kind: 'lost_ownership' };
    if (attached.kind === 'conflict') return { kind: 'conflict', code: attached.code };
    if (attached.kind === 'error') return { kind: 'error', code: attached.code };

    const linked = await linkWhatsAppConversationClient({
      db: params.db,
      salonId: params.salonId,
      externalUserId: sender.externalUserId,
      clientId: clientLoad.client.id,
      receiptId: params.receiptId,
      attemptCount: params.attemptCount,
    });
    if (linked.kind === 'lost_ownership') return { kind: 'lost_ownership' };
    if (linked.kind === 'conflict') return { kind: 'conflict', code: linked.code };
    if (linked.kind === 'error') return { kind: 'error', code: linked.code };

    return {
      kind: 'ok',
      outcome: 'existing_identity',
      conversationId,
      clientId: clientLoad.client.id,
      expiredReset: touched.expiredReset,
      advanced: touched.advanced,
      externalUserId: sender.externalUserId,
    };
  }

  // 2) Phone match — exact one only (read-only).
  if (!sender.normalizedAddress) {
    return {
      kind: 'ok',
      outcome: 'unresolved',
      conversationId,
      clientId: touched.clientId,
      expiredReset: touched.expiredReset,
      advanced: touched.advanced,
      externalUserId: sender.externalUserId,
    };
  }

  const phoneMatch = await findUniqueSalonClientByNormalizedPhone(
    params.db,
    params.salonId,
    sender.normalizedAddress
  );
  if (phoneMatch.kind === 'error') return { kind: 'error', code: phoneMatch.code };
  if (phoneMatch.kind === 'ambiguous') {
    return {
      kind: 'ok',
      outcome: 'ambiguous',
      conversationId,
      clientId: null,
      expiredReset: touched.expiredReset,
      advanced: touched.advanced,
      externalUserId: sender.externalUserId,
    };
  }
  if (phoneMatch.kind === 'none') {
    return {
      kind: 'ok',
      outcome: touched.clientId ? 'conversation_only' : 'unresolved',
      conversationId,
      clientId: touched.clientId,
      expiredReset: touched.expiredReset,
      advanced: touched.advanced,
      externalUserId: sender.externalUserId,
    };
  }

  // 3) Owned attach + link (no client creation).
  const attached = await attachWhatsAppClientIdentity({
    db: params.db,
    salonId: params.salonId,
    clientId: phoneMatch.client.id,
    externalUserId: sender.externalUserId,
    normalizedAddress: sender.normalizedAddress,
    displayAddress: sender.displayAddress,
    profileName: sender.profileName,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
  });
  if (attached.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (attached.kind === 'conflict') return { kind: 'conflict', code: attached.code };
  if (attached.kind === 'error') return { kind: 'error', code: attached.code };

  const linked = await linkWhatsAppConversationClient({
    db: params.db,
    salonId: params.salonId,
    externalUserId: sender.externalUserId,
    clientId: phoneMatch.client.id,
    receiptId: params.receiptId,
    attemptCount: params.attemptCount,
  });
  if (linked.kind === 'lost_ownership') return { kind: 'lost_ownership' };
  if (linked.kind === 'conflict') return { kind: 'conflict', code: linked.code };
  if (linked.kind === 'error') return { kind: 'error', code: linked.code };

  return {
    kind: 'ok',
    outcome: 'unique_phone_match',
    conversationId,
    clientId: phoneMatch.client.id,
    expiredReset: touched.expiredReset,
    advanced: touched.advanced,
    externalUserId: sender.externalUserId,
  };
}
