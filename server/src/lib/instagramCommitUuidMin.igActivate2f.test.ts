/**
 * IG-ACTIVATE-2F: regression for Postgres MIN(uuid) defect in
 * commit_instagram_booking_owned phone-client resolution.
 *
 * Static / source-contract only. No Meta. No live SQL execution.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migRoot = join(here, '../../../supabase/migrations');

const FIX = readFileSync(
  join(migRoot, '20260812000001_fix_instagram_commit_uuid_min.sql'),
  'utf8',
);
const IG6 = readFileSync(
  join(migRoot, '20260807000006_instagram_booking_commit.sql'),
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

/** Strip SQL line/block comments for executable-body assertions. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

const fixBody = stripSqlComments(FIX);

describe('IG-ACTIVATE-2F MIN(uuid) corrective migration (static)', () => {
  it('1. corrective migration replaces commit_instagram_booking_owned only', () => {
    assert.match(FIX, /CREATE OR REPLACE FUNCTION public\.commit_instagram_booking_owned\(/);
    assert.equal(
      (FIX.match(/CREATE OR REPLACE FUNCTION/g) || []).length,
      1,
      'exactly one function replace',
    );
    assert.doesNotMatch(FIX, /commit_whatsapp_booking_owned/);
    assert.doesNotMatch(FIX, /transition_instagram_booking_owned/);
    assert.doesNotMatch(FIX, /CREATE TABLE|ALTER TABLE|CREATE INDEX/i);
  });

  it('2. no executable MIN(c.id) remains; array_agg replacement present', () => {
    assert.doesNotMatch(fixBody, /MIN\s*\(\s*c\.id\s*\)/);
    assert.match(
      fixBody,
      /SELECT COUNT\(\*\)::integer,\s*\(array_agg\(c\.id ORDER BY c\.id::text\)\)\[1\]/,
    );
    assert.match(
      fixBody,
      /regexp_replace\(COALESCE\(c\.phone, ''\), '\\D', '', 'g'\) = v_phone_digits/,
    );
  });

  it('3. count + single-id capture semantics preserved (ambiguous / one / zero)', () => {
    assert.match(fixBody, /INTO\s+v_phone_count,\s*v_phone_client/);
    assert.match(
      fixBody,
      /IF v_phone_count > 1 THEN[\s\S]*ambiguous_client/,
    );
    assert.match(fixBody, /ELSIF v_phone_count = 1 THEN/);
    // zero-client path still inserts a client (create path after phone lock)
    assert.match(
      fixBody,
      /INSERT INTO public\.clients[\s\S]*v_phone_store/,
    );
  });

  it('4. phone advisory lock + salon scoping unchanged', () => {
    assert.match(
      fixBody,
      /hashtext\('instagram-client\|' \|\| p_salon_id::text\)/,
    );
    assert.match(fixBody, /pg_advisory_xact_lock\(v_phone_lock_k1,\s*v_phone_lock_k2\)/);
    assert.match(
      fixBody,
      /FROM public\.clients c\s+WHERE c\.salon_id = p_salon_id/,
    );
  });

  it('5. identity NULL→set / no-flip and appointment source/idempotency preserved', () => {
    assert.match(
      fixBody,
      /ELSIF v_ident\.client_id IS NULL THEN[\s\S]*client_id = v_client_id[\s\S]*AND i\.client_id IS NULL/,
    );
    assert.match(fixBody, /identity_conflict/);
    assert.match(fixBody, /source = 'instagram'/);
    assert.match(fixBody, /source_external_event_id/);
    assert.match(fixBody, /already_booked/);
    assert.match(fixBody, /unique_violation/);
  });

  it('6. SECURITY INVOKER + search_path + service_role-only grants restated', () => {
    assert.match(FIX, /SECURITY INVOKER/);
    assert.match(FIX, /SET search_path = public/);
    assert.match(
      FIX,
      /REVOKE ALL ON FUNCTION public\.commit_instagram_booking_owned\([\s\S]*FROM PUBLIC/,
    );
    assert.match(
      FIX,
      /REVOKE ALL ON FUNCTION public\.commit_instagram_booking_owned\([\s\S]*FROM anon/,
    );
    assert.match(
      FIX,
      /REVOKE ALL ON FUNCTION public\.commit_instagram_booking_owned\([\s\S]*FROM authenticated/,
    );
    assert.match(
      FIX,
      /GRANT EXECUTE ON FUNCTION public\.commit_instagram_booking_owned\([\s\S]*TO service_role/,
    );
  });

  it('7. applied IG-6 migration still documents pre-fix MIN(c.id); fix is additive', () => {
    assert.match(IG6, /MIN\(c\.id\)/);
    assert.match(FIX, /20260812000001|IG-ACTIVATE-2F/);
    // Fix must not edit the applied file contents expectation: IG6 unchanged on disk
    assert.match(IG6, /commit_instagram_booking_owned/);
  });

  it('8. WhatsApp commit/recovery still contain MIN(c.id) — out of scope (not modified)', () => {
    assert.match(WA_COMMIT, /MIN\(c\.id\)/);
    assert.match(WA_RECOVERY, /MIN\(c\.id\)/);
    assert.doesNotMatch(fixBody, /commit_whatsapp_booking_owned/);
    assert.doesNotMatch(fixBody, /provider = 'whatsapp'/);
  });

  it('9. signature unchanged vs IG-6', () => {
    const sig =
      /commit_instagram_booking_owned\(\s*p_salon_id uuid,\s*p_receipt_id uuid,\s*p_attempt_count integer,\s*p_external_user_id text,\s*p_expected_source_message_id text,\s*p_external_event_id text\s*\)/s;
    assert.match(IG6, sig);
    assert.match(FIX, sig);
  });
});
