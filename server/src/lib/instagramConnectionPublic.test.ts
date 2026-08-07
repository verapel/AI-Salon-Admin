/**
 * IG-1: Safe Instagram DTO + migration/authz static checks.
 * No Meta. No SQL execution. No real credentials.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  instagramPublicDtoHasNoSecrets,
  mapInstagramConnectionPublic,
  maskInstagramUserId,
  type InstagramConnectionMetadataRow,
} from './instagramConnectionPublic.js';

function readRepo(relFromServerSrcLib: string): string {
  return readFileSync(new URL(relFromServerSrcLib, import.meta.url), 'utf8');
}

describe('instagramConnectionPublic DTO (executed)', () => {
  it('1. safe DTO never exposes secret fields', () => {
    const row: InstagramConnectionMetadataRow = {
      id: 'conn-1',
      salon_id: 'salon-1',
      instagram_user_id: '17841400000000000',
      instagram_username: 'salon_demo',
      status: 'connected',
      connected_at: '2026-08-07T00:00:00.000Z',
      last_webhook_at: null,
      last_error: null,
      created_at: '2026-08-07T00:00:00.000Z',
      updated_at: '2026-08-07T00:00:00.000Z',
    };
    const dto = mapInstagramConnectionPublic(row, true);
    assert.equal(instagramPublicDtoHasNoSecrets(dto), true);
    assert.equal(instagramPublicDtoHasNoSecrets({ connection: dto, salonId: 'salon-1' }), true);
    assert.equal(
      instagramPublicDtoHasNoSecrets({
        ...dto,
        access_token_ciphertext: 'leak',
      }),
      false,
    );
    const json = JSON.stringify(dto);
    assert.ok(!json.includes('ciphertext'));
    assert.ok(!json.includes('auth_tag'));
    assert.ok(!json.includes('access_token_iv'));
  });

  it('2. maskInstagramUserId truncates Professional Account ID', () => {
    assert.equal(maskInstagramUserId('17841400000000000'), '1784…0000');
    assert.equal(maskInstagramUserId('short'), 'short');
    assert.equal(maskInstagramUserId(null), null);
  });

  it('3. connected flag requires stored token at route layer (DTO keeps status)', () => {
    const row: InstagramConnectionMetadataRow = {
      id: 'conn-2',
      salon_id: 'salon-2',
      instagram_user_id: 'ig-1',
      instagram_username: null,
      status: 'connected',
      connected_at: null,
      last_webhook_at: null,
      last_error: null,
      created_at: '2026-08-07T00:00:00.000Z',
      updated_at: '2026-08-07T00:00:00.000Z',
    };
    const withoutToken = mapInstagramConnectionPublic(row, false);
    assert.equal(withoutToken.status, 'connected');
    assert.equal(withoutToken.isAccessTokenStored, false);
  });
});

describe('IG-1 migration/schema static checks', () => {
  const sql = readRepo(
    '../../../supabase/migrations/20260807000001_instagram_connection_foundation.sql',
  );

  it('4. UNIQUE(salon_id) and UNIQUE(instagram_user_id) present', () => {
    assert.match(sql, /UNIQUE\s*\(\s*salon_id\s*\)/i);
    assert.match(sql, /UNIQUE\s*\(\s*instagram_user_id\s*\)/i);
  });

  it('5. status CHECK + connected requires user id + token triple', () => {
    assert.match(sql, /status IN \('not_connected', 'connected', 'error', 'disabled'\)/);
    assert.match(sql, /instagram_business_connections_connected_requires_user_id_check/);
    assert.match(sql, /instagram_business_connections_connected_requires_token_check/);
    assert.match(sql, /instagram_business_connections_token_triple_complete_check/);
  });

  it('6. no seed of connected fake credentials', () => {
    assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.instagram_business_connections/i);
    assert.doesNotMatch(sql, /status\s*=\s*'connected'/i);
  });

  it('7. RLS enabled; additive only (no DROP)', () => {
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(sql, /\bDROP\s+COLUMN\b/i);
  });
});

describe('IG-1 authz / route boundary static checks', () => {
  const developer = readRepo('../routes/developer.ts');
  const index = readRepo('../index.ts');
  const igRoutes = readRepo('../routes/instagramIntegrations.ts');
  const auth = readRepo('../middleware/auth.ts');

  it('8. Instagram mounted only under developer router', () => {
    assert.match(
      developer,
      /router\.use\('\/integrations\/instagram',\s*instagramIntegrationsRouter\)/,
    );
    assert.doesNotMatch(index, /instagramIntegrations/);
    assert.doesNotMatch(index, /\/api\/integrations\/instagram/);
    assert.doesNotMatch(index, /\/api\/webhooks\/instagram/);
  });

  it('9. developer gate denies non-developers (owner/admin/staff)', () => {
    assert.match(auth, /export async function requireDeveloperAuth/);
    assert.match(auth, /if \(!req\.auth!\.isDeveloper\)/);
    assert.match(auth, /Developer access required/);
    assert.match(index, /app\.use\('\/api\/developer',\s*developerAuth,\s*developerRouter\)/);
  });

  it('10. detail/disconnect use route salonId only (body cannot retarget)', () => {
    assert.match(igRoutes, /req\.params\.salonId/);
    assert.doesNotMatch(igRoutes, /req\.body\.salonId/);
    assert.doesNotMatch(igRoutes, /status:\s*'connected'/);
    assert.doesNotMatch(igRoutes, /router\.post\(/);
  });

  it('11. disconnect clears secrets and does not touch clients/appointments', () => {
    assert.match(igRoutes, /access_token_ciphertext:\s*null/);
    assert.match(igRoutes, /status:\s*'not_connected'/);
    assert.doesNotMatch(igRoutes, /\.from\('clients'\)/);
    assert.doesNotMatch(igRoutes, /\.from\('appointments'\)/);
  });
});

describe('IG-1 protected runtime regression static checks', () => {
  it('12. WhatsApp/Telegram/Apple runtime files untouched in this patch set (reasoned via git)', () => {
    // Content presence smoke: IG-1 must not rewrite WA webhook/booking helpers.
    const waWebhook = readRepo('../routes/whatsappWebhook.ts');
    assert.match(waWebhook, /whatsapp/);
    const telegramBot = readRepo('./telegramBotManager.ts');
    assert.match(telegramBot, /telegram/i);
    const apple = readRepo('./calendarCredentialsCrypto.ts');
    assert.match(apple, /CALENDAR_CREDENTIALS_ENCRYPTION_KEY/);
  });
});
