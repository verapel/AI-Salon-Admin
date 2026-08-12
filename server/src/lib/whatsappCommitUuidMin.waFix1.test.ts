/**
 * WA-FIX-1: regression for Postgres MIN(uuid) defect in
 * commit_whatsapp_booking_owned phone-client resolution.
 *
 * Static / source-contract only. No Meta. No live SQL execution.
 * Migration is NOT applied by these tests.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migRoot = join(here, '../../../supabase/migrations');

const FIX = readFileSync(
  join(migRoot, '20260812000004_fix_whatsapp_commit_uuid_min.sql'),
  'utf8',
);
const WA_COMMIT = readFileSync(
  join(migRoot, '20260805000002_whatsapp_idempotent_booking_commit.sql'),
  'utf8',
);
const WA_RECOVERY = readFileSync(
  join(migRoot, '20260805000003_whatsapp_booking_recovery.sql'),
  'utf8',
);
const IG_FIX = readFileSync(
  join(migRoot, '20260812000001_fix_instagram_commit_uuid_min.sql'),
  'utf8',
);
const PACKAGE = readFileSync(join(here, '../../package.json'), 'utf8');

/** Strip SQL line/block comments for executable-body assertions. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

const fixBody = stripSqlComments(FIX);

const WA_SIG =
  /commit_whatsapp_booking_owned\(\s*p_salon_id uuid,\s*p_receipt_id uuid,\s*p_attempt_count integer,\s*p_external_user_id text,\s*p_expected_source_message_id text,\s*p_external_event_id text,\s*p_service_id uuid,\s*p_staff_id uuid,\s*p_date text,\s*p_time text,\s*p_name text,\s*p_phone text\s*\)/s;

describe('WA-FIX-1 MIN(uuid) corrective migration (static)', () => {
  it('1. corrective migration replaces commit_whatsapp_booking_owned only', () => {
    assert.match(FIX, /CREATE OR REPLACE FUNCTION public\.commit_whatsapp_booking_owned\(/);
    assert.equal(
      (FIX.match(/CREATE OR REPLACE FUNCTION/g) || []).length,
      1,
      'exactly one function replace',
    );
    assert.doesNotMatch(FIX, /commit_instagram_booking_owned/);
    assert.doesNotMatch(FIX, /transition_whatsapp_booking_owned/);
    assert.doesNotMatch(FIX, /CREATE TABLE|ALTER TABLE|CREATE INDEX/i);
  });

  it('2. no executable MIN(c.id); UUID-safe array_agg replacement present', () => {
    assert.doesNotMatch(fixBody, /MIN\s*\(\s*c\.id\s*\)/);
    assert.doesNotMatch(fixBody, /MIN\s*\(\s*[^)]*uuid/i);
    assert.match(
      fixBody,
      /SELECT COUNT\(\*\)::integer,\s*\(array_agg\(c\.id ORDER BY c\.id::text\)\)\[1\]/,
    );
    assert.match(
      fixBody,
      /regexp_replace\(COALESCE\(c\.phone, ''\), '\\D', '', 'g'\) = v_phone_digits/,
    );
    assert.match(fixBody, /FROM public\.clients c\s+WHERE c\.salon_id = p_salon_id/);
  });

  it('3. count + single-id capture semantics preserved (ambiguous / one / zero)', () => {
    assert.match(fixBody, /INTO\s+v_phone_count,\s*v_phone_client/);
    assert.match(fixBody, /IF v_phone_count > 1 THEN[\s\S]*ambiguous_client/);
    assert.match(fixBody, /ELSIF v_phone_count = 1 THEN/);
    assert.match(fixBody, /INSERT INTO public\.clients[\s\S]*v_phone_store/);
  });

  it('4. staff|date booking lock preserved; identity conflict / no-flip preserved', () => {
    // WA booking lock is salon|staff + date (unchanged).
    assert.match(fixBody, /pg_advisory_xact_lock\(v_lock_k1,\s*v_lock_k2\)/);
    assert.match(
      fixBody,
      /hashtext\(p_salon_id::text \|\| '\|' \|\| p_staff_id::text\)/,
    );
    assert.match(fixBody, /v_lock_k2 := hashtext\(v_date\)/);
    // Existing identity with different client_id → identity_conflict (no flip).
    assert.match(
      fixBody,
      /ELSIF v_ident\.client_id IS DISTINCT FROM v_client_id THEN\s+RETURN jsonb_build_object\('kind', 'identity_conflict'\)/,
    );
    // Unique race on identity insert: conflict unless same client_id.
    assert.match(fixBody, /WA_IDENTITY_CONFLICT/);
    assert.match(
      fixBody,
      /IF NOT FOUND OR v_ident\.client_id IS DISTINCT FROM v_client_id THEN\s+RAISE EXCEPTION 'WA_IDENTITY_CONFLICT'/,
    );
    // Conversation A + phone B fail-closed.
    assert.match(fixBody, /client_resolution_conflict/);
  });

  it('4b. phone-scoped advisory lock before client SELECT/create (salon + digits)', () => {
    assert.match(
      fixBody,
      /v_phone_lock_k1 := hashtext\('whatsapp-client\|' \|\| p_salon_id::text\)/,
    );
    assert.match(fixBody, /v_phone_lock_k2 := hashtext\(v_phone_digits\)/);
    assert.match(fixBody, /pg_advisory_xact_lock\(v_phone_lock_k1,\s*v_phone_lock_k2\)/);

    const phoneLockIdx = fixBody.search(
      /pg_advisory_xact_lock\(v_phone_lock_k1,\s*v_phone_lock_k2\)/,
    );
    const phoneSelectIdx = fixBody.search(
      /SELECT COUNT\(\*\)::integer,\s*\(array_agg\(c\.id ORDER BY c\.id::text\)\)\[1\]/,
    );
    const clientInsertIdx = fixBody.search(/INSERT INTO public\.clients/);
    assert.ok(phoneLockIdx >= 0 && phoneSelectIdx >= 0 && clientInsertIdx >= 0);
    assert.ok(phoneLockIdx < phoneSelectIdx, 'phone lock before phone client SELECT');
    assert.ok(phoneSelectIdx < clientInsertIdx, 'phone SELECT before client INSERT');

    // Cross-salon: lock namespace includes salon_id (different salons ⇒ different k1).
    assert.match(fixBody, /'whatsapp-client\|' \|\| p_salon_id::text/);
    // No global clients.phone uniqueness introduced.
    assert.doesNotMatch(FIX, /UNIQUE\s*\(.*phone|CREATE UNIQUE INDEX.*clients.*phone/i);
    // Digits semantics unchanged (normalized_address still v_phone_digits).
    assert.match(
      fixBody,
      /INSERT INTO public\.client_channel_identities[\s\S]*v_phone_digits[\s\S]*v_phone_store/,
    );
  });

  it('5. identity client_id no-flip + salon-scoped identity/provider', () => {
    assert.match(fixBody, /provider = 'whatsapp'/);
    assert.match(
      fixBody,
      /FROM public\.client_channel_identities i\s+WHERE i\.salon_id = p_salon_id\s+AND i\.provider = 'whatsapp'/,
    );
    // UPDATE path never assigns a new client_id (SET has no client_id=).
    const identUpdate = fixBody.match(
      /UPDATE public\.client_channel_identities i\s+SET([\s\S]*?)WHERE i\.id = v_ident\.id/,
    );
    assert.ok(identUpdate, 'identity touch UPDATE present');
    assert.doesNotMatch(identUpdate![1], /\bclient_id\s*=/);
    assert.match(
      fixBody,
      /WHERE i\.id = v_ident\.id\s+AND i\.client_id = v_client_id/,
    );
  });

  it('6. appointment idempotency + whatsapp source preserved', () => {
    assert.match(fixBody, /source = 'whatsapp'/);
    assert.match(fixBody, /source_external_event_id/);
    assert.match(fixBody, /already_booked/);
    assert.match(fixBody, /unique_violation/);
    // Provisional cleanup on appointment unique race (comment + executable DELETEs).
    assert.match(FIX, /Drop this TX's provisional client/);
    assert.match(
      fixBody,
      /IF v_created_identity THEN\s+DELETE FROM public\.client_channel_identities/,
    );
    assert.match(fixBody, /IF v_created_client THEN\s+DELETE FROM public\.clients/);
  });

  it('7. SECURITY INVOKER + search_path + service_role-only grants', () => {
    assert.match(FIX, /SECURITY INVOKER/);
    assert.match(FIX, /SET search_path = public/);
    assert.match(
      FIX,
      /REVOKE ALL ON FUNCTION public\.commit_whatsapp_booking_owned\([\s\S]*FROM PUBLIC/,
    );
    assert.match(
      FIX,
      /REVOKE ALL ON FUNCTION public\.commit_whatsapp_booking_owned\([\s\S]*FROM anon/,
    );
    assert.match(
      FIX,
      /REVOKE ALL ON FUNCTION public\.commit_whatsapp_booking_owned\([\s\S]*FROM authenticated/,
    );
    assert.match(
      FIX,
      /GRANT EXECUTE ON FUNCTION public\.commit_whatsapp_booking_owned\([\s\S]*TO service_role/,
    );
  });

  it('8. historical applied WA migrations keep MIN(c.id); fix is additive forward-only', () => {
    assert.match(WA_COMMIT, /MIN\(c\.id\)/);
    assert.match(WA_RECOVERY, /MIN\(c\.id\)/);
    assert.match(FIX, /20260812000004|WA-FIX-1/);
    assert.match(WA_RECOVERY, WA_SIG);
    assert.match(FIX, WA_SIG);
  });

  it('9. does not rewrite Instagram fix / other providers; index untouched by this patch', () => {
    assert.match(IG_FIX, /commit_instagram_booking_owned/);
    assert.doesNotMatch(FIX, /commit_instagram_booking_owned/);
    assert.doesNotMatch(FIX, /apple_calendar|graph\.facebook|telegramBotManager/);
    assert.doesNotMatch(FIX, /whatsappOutboundWorker|startWhatsAppOutboundWorker/);
    // This patch must not edit server/src/index.ts (outbound/Telegram bootstrap unchanged).
    assert.match(PACKAGE, /whatsappCommitUuidMin\.waFix1\.test\.ts/);
  });

  it('10. UUID-safe selection is deterministic for same-phone candidates', () => {
    // ORDER BY c.id::text is the documented deterministic key (same as IG-ACTIVATE-2F).
    assert.match(fixBody, /array_agg\(c\.id ORDER BY c\.id::text\)/);
    // When count > 1 the function still fails closed before using the selected id for linking.
    assert.match(
      fixBody,
      /IF v_phone_count > 1 THEN\s+RETURN jsonb_build_object\('kind', 'ambiguous_client'\)/,
    );
  });
});
