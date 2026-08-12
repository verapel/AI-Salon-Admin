/**
 * IG-ACTIVATE-2G: Instagram same-phone identity conflict regression.
 *
 * Static / source-contract only. No Meta. No live SQL execution.
 * Asserts commit_instagram_booking_owned no longer writes booking phone into
 * Instagram identity normalized_address/display_address (WhatsApp uniqueness field).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migRoot = join(here, '../../../supabase/migrations');
const serverLib = here;

const FIX = readFileSync(
  join(migRoot, '20260812000002_fix_instagram_identity_phone_conflict.sql'),
  'utf8',
);
const IG2F = readFileSync(
  join(migRoot, '20260812000001_fix_instagram_commit_uuid_min.sql'),
  'utf8',
);
const IG4 = readFileSync(
  join(migRoot, '20260807000004_instagram_identity_conversation.sql'),
  'utf8',
);
const WA_FOUNDATION = readFileSync(
  join(migRoot, '20260727000002_whatsapp_channel_foundation.sql'),
  'utf8',
);
const WA_COMMIT = readFileSync(
  join(migRoot, '20260805000002_whatsapp_idempotent_booking_commit.sql'),
  'utf8',
);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

const fixBody = stripSqlComments(FIX);

function readLib(name: string): string {
  return readFileSync(join(serverLib, name), 'utf8');
}

describe('IG-ACTIVATE-2G Instagram identity phone conflict (static)', () => {
  it('1. replaces commit_instagram_booking_owned only; no schema/index DDL', () => {
    assert.match(FIX, /CREATE OR REPLACE FUNCTION public\.commit_instagram_booking_owned\(/);
    assert.equal((FIX.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1);
    assert.doesNotMatch(fixBody, /commit_whatsapp_booking_owned/);
    assert.doesNotMatch(fixBody, /attach_whatsapp_identity_owned/);
    assert.doesNotMatch(
      fixBody,
      /CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX|ALTER\s+TABLE|CREATE\s+TABLE/i,
    );
  });

  it('2. UUID array_agg fix preserved; MIN(c.id) not reintroduced', () => {
    assert.match(
      fixBody,
      /SELECT COUNT\(\*\)::integer,\s*\(array_agg\(c\.id ORDER BY c\.id::text\)\)\[1\]/,
    );
    assert.doesNotMatch(fixBody, /MIN\s*\(\s*c\.id\s*\)/);
    assert.match(IG2F, /array_agg\(c\.id ORDER BY c\.id::text\)/);
  });

  it('3. INSERT identity uses NULL normalized_address/display_address (not phone)', () => {
    assert.match(
      fixBody,
      /INSERT INTO public\.client_channel_identities\s*\([\s\S]*?normalized_address,\s*display_address,[\s\S]*?VALUES\s*\([\s\S]*?'instagram',\s*v_ext,\s*NULL,\s*NULL,/s,
    );
    assert.doesNotMatch(
      fixBody,
      /VALUES\s*\([\s\S]*?'instagram',\s*v_ext,\s*v_phone_digits,\s*v_phone_store,/s,
    );
  });

  it('4. NULL→client_id link and same-client touch do not set phone addresses', () => {
    assert.doesNotMatch(
      fixBody,
      /normalized_address\s*=\s*COALESCE\(\s*i\.normalized_address\s*,\s*v_phone_digits\s*\)/,
    );
    assert.doesNotMatch(
      fixBody,
      /display_address\s*=\s*COALESCE\(\s*i\.display_address\s*,\s*v_phone_store\s*\)/,
    );
    // NULL→set still present
    assert.match(
      fixBody,
      /ELSIF v_ident\.client_id IS NULL THEN[\s\S]*client_id = v_client_id[\s\S]*AND i\.client_id IS NULL/,
    );
    // same-client touch keeps timestamps only
    assert.match(
      fixBody,
      /ELSIF v_ident\.client_id IS DISTINCT FROM v_client_id THEN[\s\S]*identity_conflict[\s\S]*ELSE[\s\S]*last_interaction_at = v_now[\s\S]*AND i\.client_id = v_client_id/,
    );
  });

  it('5. phone advisory lock + salon client reuse + ambiguous_client preserved', () => {
    assert.match(
      fixBody,
      /hashtext\('instagram-client\|' \|\| p_salon_id::text\)/,
    );
    assert.match(fixBody, /pg_advisory_xact_lock\(v_phone_lock_k1,\s*v_phone_lock_k2\)/);
    assert.match(
      fixBody,
      /FROM public\.clients c\s+WHERE c\.salon_id = p_salon_id/,
    );
    assert.match(fixBody, /ambiguous_client/);
    assert.match(fixBody, /INSERT INTO public\.clients/);
  });

  it('6. no-flip identity_conflict + appointment source/idempotency preserved', () => {
    assert.match(fixBody, /identity_conflict/);
    assert.match(fixBody, /source = 'instagram'/);
    assert.match(fixBody, /source_external_event_id/);
    assert.match(fixBody, /already_booked/);
    assert.match(fixBody, /unique_violation/);
    assert.match(fixBody, /booking_created/);
  });

  it('7. SECURITY INVOKER + service_role grants restated; index definition untouched', () => {
    assert.match(FIX, /SECURITY INVOKER/);
    assert.match(FIX, /SET search_path = public/);
    assert.match(
      FIX,
      /GRANT EXECUTE ON FUNCTION public\.commit_instagram_booking_owned\([\s\S]*TO service_role/,
    );
    assert.match(
      WA_FOUNDATION,
      /client_channel_identities_salon_provider_normalized_unique/,
    );
    // Executable body must not DDL-touch the index (header comments may name it).
    assert.doesNotMatch(
      fixBody,
      /DROP\s+INDEX[\s\S]*client_channel_identities_salon_provider_normalized_unique|CREATE\s+UNIQUE\s+INDEX[\s\S]*client_channel_identities_salon_provider_normalized_unique/i,
    );
  });

  it('8. IG-4 creates Instagram identities with NULL addresses; commit aligns', () => {
    assert.match(
      IG4,
      /INSERT INTO public\.client_channel_identities\s*\([\s\S]*?'instagram',[\s\S]*?NULL,\s*NULL,/s,
    );
    assert.match(IG4, /external_user_id/);
  });

  it('9. WhatsApp still writes phone to normalized_address; WA runtime not modified by 2G', () => {
    assert.match(
      WA_COMMIT,
      /normalized_address = COALESCE\(i\.normalized_address, v_phone_digits\)/,
    );
    assert.match(WA_FOUNDATION, /normalized_address/);
    const waTs = readLib('whatsappIdentity.ts');
    assert.match(waTs, /normalized_address_conflict/);
    assert.match(waTs, /p_normalized_address/);
  });

  it('10. Instagram TypeScript runtime does not depend on phone normalized_address', () => {
    const files = [
      'instagramIdentityConversation.ts',
      'instagramBookingCommit.ts',
      'instagramBookingFlow.ts',
      'instagramBookingConversation.ts',
      'instagramBookingState.ts',
      'instagramWebhookProcess.ts',
      'instagramWebhookRouting.ts',
      'instagramWebhookEvents.ts',
      'instagramOutbound.ts',
      'instagramOutboundWorker.ts',
      'instagramOutboundIntent.ts',
      'instagramMessagingApi.ts',
    ];
    let scanned = 0;
    for (const f of files) {
      let src: string;
      try {
        src = readLib(f);
      } catch {
        continue;
      }
      scanned += 1;
      assert.doesNotMatch(
        src,
        /normalized_address|normalizedAddress|display_address|displayAddress/,
        `${f} must not depend on identity phone addresses`,
      );
    }
    assert.ok(scanned >= 8, `expected to scan Instagram runtime files, got ${scanned}`);
  });

  it('11. two IG senders / one phone model: unique key remains external_user_id', () => {
    assert.match(
      WA_FOUNDATION,
      /UNIQUE\s*\(\s*salon_id\s*,\s*provider\s*,\s*external_user_id\s*\)/,
    );
    // Fix never collapses identities by phone
    assert.doesNotMatch(
      fixBody,
      /WHERE[\s\S]*provider = 'instagram'[\s\S]*normalized_address\s*=\s*v_phone/,
    );
    assert.match(
      fixBody,
      /provider = 'instagram'\s+AND i\.external_user_id = v_ext/,
    );
  });

  it('12. applied 00001 / 00006 phone-assignment history remains on disk (additive fix)', () => {
    assert.match(
      IG2F,
      /normalized_address = COALESCE\(i\.normalized_address, v_phone_digits\)/,
    );
    assert.match(FIX, /IG-ACTIVATE-2G|20260812000002/);
  });
});
