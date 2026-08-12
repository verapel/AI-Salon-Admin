/**
 * WA-UI-1: WhatsApp developer UI lifecycle alignment — static source contracts.
 * No Meta. No production DB writes. Migration not executed here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  hasAnyWhatsAppCredentialMaterial,
  isMeaningfulWhatsAppConnectionPresence,
} from './whatsappDeveloperVisibility.js';
import type { WhatsAppBusinessConnectionPublic } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const routes = read('server/src/routes/whatsappIntegrations.ts');
const visibility = read('server/src/lib/whatsappDeveloperVisibility.ts');
const migration = read(
  'supabase/migrations/20260812000005_remove_whatsapp_integration_owned.sql',
);
const disconnectSource = routes.slice(
  routes.indexOf("router.delete('/:salonId/disconnect'"),
  routes.indexOf("router.delete('/:salonId/remove'"),
);
const removeHandler = routes.slice(routes.indexOf('DELETE /api/developer/integrations/whatsapp/:salonId/remove'));
const listHandler = routes.slice(
  routes.indexOf("Active salons with WhatsApp registry"),
  routes.indexOf("router.get('/:salonId'"),
);
const card = read('client/src/components/developer/SalonWhatsAppCard.tsx');
const tab = read('client/src/components/developer/WhatsAppIntegrationsTab.tsx');
const addModal = read('client/src/components/developer/AddIntegrationModal.tsx');
const page = read('client/src/pages/developer/DeveloperIntegrations.tsx');
const detail = read('client/src/components/developer/SalonDetailModal.tsx');
const api = read('client/src/lib/api.ts');
const i18n = read('client/src/i18n/translations.ts');
const types = read('client/src/types/index.ts');
const serverTypes = read('server/src/types.ts');
const index = read('server/src/index.ts');
const bookingCommit = read('server/src/lib/whatsappBookingCommit.ts');
const bookingFlow = read('server/src/lib/whatsappBookingFlow.ts');
const outboundWorker = read('server/src/lib/whatsappOutboundWorker.ts');
const waFixMigration = read(
  'supabase/migrations/20260812000004_fix_whatsapp_commit_uuid_min.sql',
);
const igRoutes = read('server/src/routes/instagramIntegrations.ts');
const developerRoutes = read('server/src/routes/developer.ts');
const calendarRoutes = read('server/src/routes/calendarConnections.ts');

describe('WA-UI-1 WhatsApp developer UI lifecycle (static + helpers)', () => {
  it('1. list no longer forces every active salon', () => {
    assert.match(listHandler, /salon_integrations/);
    assert.match(listHandler, /provider',\s*WHATSAPP_PROVIDER/);
    assert.match(listHandler, /\.in\('id',\s*salonIds\)/);
    assert.match(listHandler, /isMeaningfulWhatsAppConnectionPresence/);
    assert.match(listHandler, /Non-mutating|non-mutating/i);
    assert.doesNotMatch(listHandler, /\.insert\(/);
    // Old behavior selected all active salons first; now registry ∪ orphans drive the set.
    assert.match(
      listHandler,
      /from\('salon_integrations'\)[\s\S]*from\('whatsapp_business_connections'\)[\s\S]*from\('salons'\)[\s\S]*\.in\('id',\s*salonIds\)/,
    );
  });

  it('2. registry-based visibility + meaningful orphan remains visible', () => {
    assert.match(routes, /isMeaningfulWhatsAppConnectionPresence/);
    assert.match(routes, /registryPresent \|\| meaningful/);
    assert.match(visibility, /isMeaningfulWhatsAppConnectionPresence/);

    const shell: WhatsAppBusinessConnectionPublic = {
      id: 'c1',
      salonId: 's1',
      integrationId: 'i1',
      provider: 'meta_cloud',
      businessAccountId: null,
      phoneNumberId: null,
      displayPhoneNumber: null,
      verifiedName: null,
      tokenExpiresAt: null,
      lastWebhookAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      qualityRating: null,
      messagingLimitTier: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      isAccessTokenStored: false,
      isAppSecretStored: false,
      isVerifyTokenStored: false,
      webhookKey: 'wk_only',
      webhookCallbackUrl: 'https://example.test/wa/wk_only',
    };
    assert.equal(isMeaningfulWhatsAppConnectionPresence(shell, false), false);

    const orphanIds: WhatsAppBusinessConnectionPublic = {
      ...shell,
      phoneNumberId: '12345',
      businessAccountId: 'waba',
    };
    assert.equal(isMeaningfulWhatsAppConnectionPresence(orphanIds, false), true);

    assert.equal(
      hasAnyWhatsAppCredentialMaterial({
        access_token_ciphertext: 'x',
        access_token_iv: null,
        access_token_auth_tag: null,
      }),
      true,
    );
    assert.equal(
      hasAnyWhatsAppCredentialMaterial({
        access_token_ciphertext: null,
        access_token_iv: null,
        access_token_auth_tag: null,
        app_secret_ciphertext: null,
        app_secret_iv: null,
        app_secret_auth_tag: null,
        verify_token_ciphertext: null,
        verify_token_iv: null,
        verify_token_auth_tag: null,
      }),
      false,
    );
  });

  it('3. Add Integration includes WhatsApp; eligible picker excludes already-added', () => {
    assert.match(addModal, /'whatsapp'/);
    assert.match(addModal, /onAddWhatsApp/);
    assert.match(addModal, /getWhatsAppIntegrations/);
    assert.match(addModal, /eligibleSalons/);
    assert.match(addModal, /channel === 'whatsapp'/);
    assert.match(page, /prepareWhatsApp/);
    assert.match(page, /handleAddWhatsApp/);
    assert.match(page, /onAddWhatsApp=\{handleAddWhatsApp\}/);
  });

  it('4. prepare endpoint reused; no duplicate prepare architecture', () => {
    assert.match(api, /prepareWhatsApp/);
    assert.match(api, /\/developer\/integrations\/whatsapp\/\$\{salonId\}\/prepare/);
    assert.match(routes, /router\.post\('\/:salonId\/prepare'/);
    assert.match(page, /prepareWhatsApp\(salonId\)/);
    assert.equal((routes.match(/router\.post\('\/:salonId\/prepare'/g) || []).length, 1);
  });

  it('5. unconnected card hides Disconnect; shows Remove ×; connected shows Disconnect', () => {
    assert.match(card, /showDisconnect/);
    assert.match(card, /showDisconnect = connected === true/);
    assert.match(card, /showDisconnect \? \(/);
    assert.match(card, /onRemove/);
    assert.match(card, /removeAria/);
    assert.match(card, /<X /);
    assert.match(tab, /onRemove=/);
    assert.match(tab, /removeWhatsApp/);
  });

  it('6. remove route uses one atomic RPC; salon + provider scoped', () => {
    assert.match(removeHandler, /remove_whatsapp_integration_owned/);
    assert.match(removeHandler, /\.rpc\(\s*'remove_whatsapp_integration_owned'/);
    assert.match(removeHandler, /atomic:\s*true/);
    assert.match(migration, /UPDATE public\.whatsapp_business_connections/);
    assert.match(migration, /WHERE salon_id = p_salon_id/);
    assert.match(migration, /DELETE FROM public\.salon_integrations/);
    assert.match(
      migration,
      /WHERE salon_id = p_salon_id\s*\n\s*AND provider = 'whatsapp'/,
    );
    assert.match(migration, /SECURITY INVOKER/);
    assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
    assert.match(migration, /REVOKE ALL[\s\S]*FROM anon/);
    assert.match(migration, /REVOKE ALL[\s\S]*FROM authenticated/);
  });

  it('7. remove never deletes salon / business data / messaging history', () => {
    assert.doesNotMatch(migration, /DELETE FROM public\.salons/);
    assert.doesNotMatch(migration, /DELETE FROM public\.clients|DELETE FROM public\.staff/);
    assert.doesNotMatch(
      migration,
      /DELETE FROM public\.services|DELETE FROM public\.appointments|DELETE FROM public\.reminders/,
    );
    assert.doesNotMatch(
      migration,
      /DELETE FROM public\.client_channel_identities|DELETE FROM public\.whatsapp_conversations|DELETE FROM public\.whatsapp_webhook_receipts|DELETE FROM public\.whatsapp_outbound/,
    );
    assert.match(removeHandler, /NEVER deletes salon/i);
    assert.doesNotMatch(removeHandler, /\.from\('salons'\)\s*\.delete\(/);
    assert.doesNotMatch(tab, /\/developer\/salons\/\$\{.*\}\/permanent|deleteSalon|permanentDelete/);
  });

  it('8. disconnect equivalence — RPC clears same credential fields; keeps webhook_key', () => {
    for (const field of [
      'access_token_ciphertext',
      'access_token_iv',
      'access_token_auth_tag',
      'app_secret_ciphertext',
      'app_secret_iv',
      'app_secret_auth_tag',
      'verify_token_ciphertext',
      'verify_token_iv',
      'verify_token_auth_tag',
      'phone_number_id',
      'display_phone_number',
      'verified_name',
      'business_account_id',
      'token_expires_at',
      'quality_rating',
      'messaging_limit_tier',
    ]) {
      assert.match(disconnectSource, new RegExp(`${field}:\\s*null`));
      assert.match(migration, new RegExp(`${field}\\s*=\\s*NULL`, 'i'));
    }
    assert.doesNotMatch(disconnectSource, /webhook_key:\s*null/);
    assert.doesNotMatch(migration, /webhook_key\s*=\s*NULL/i);
    assert.match(migration, /Preserves webhook_key|preserve webhook_key|keeps webhook_key/i);
    // WA-UI-1A: detach shell before registry delete
    assert.match(migration, /integration_id\s*=\s*NULL/i);
  });

  it('9. partial credential material requires confirmation', () => {
    assert.match(routes, /hasAnyWhatsAppCredentialMaterial/);
    assert.match(routes, /requiresRemoveConfirmation/);
    assert.match(routes, /WHATSAPP_REMOVE_REQUIRES_CONFIRM/);
    assert.match(routes, /confirmConnected/);
    assert.match(tab, /requiresRemoveConfirmation === true/);
    assert.match(tab, /removeConfirmConnected/);
    assert.match(serverTypes, /requiresRemoveConfirmation: boolean/);
    assert.match(types, /requiresRemoveConfirmation\?/);
  });

  it('10. remove→add-back lifecycle + salon detail WhatsApp state', () => {
    assert.match(page, /prepareWhatsApp/);
    assert.match(addModal, /onAddWhatsApp/);
    assert.match(detail, /getWhatsAppIntegration\(salonId\)/);
    assert.match(detail, /whatsapp\.integrationAdded === false/);
    assert.match(detail, /developer\.integrations\.whatsapp\.notAdded/);
    assert.match(detail, /let cancelled = false/);
    assert.match(detail, /tab=whatsapp/);
  });

  it('11. secrets absent from public DTO / browser surfaces', () => {
    for (const src of [card, tab, addModal, detail, api]) {
      assert.doesNotMatch(
        src,
        /access_token_ciphertext|access_token_iv|access_token_auth_tag|app_secret_ciphertext|APP_SECRET|CREDENTIALS_ENCRYPTION_KEY/,
      );
    }
    assert.doesNotMatch(
      removeHandler,
      /access_token_ciphertext|access_token_iv|access_token_auth_tag/,
    );
    assert.match(types, /integrationAdded\?/);
  });

  it('12. WA booking / phone-lock / outbound worker / Telegram / Instagram / Apple untouched', () => {
    assert.match(waFixMigration, /pg_advisory_xact_lock/);
    assert.match(waFixMigration, /array_agg\(c\.id ORDER BY c\.id::text\)/);
    assert.doesNotMatch(migration, /commit_whatsapp_booking_owned/);
    assert.doesNotMatch(routes, /commit_whatsapp_booking_owned/);
    // Outbound worker bootstrap path unchanged in this stage.
    assert.match(index, /startWhatsAppOutboundWorker|whatsappOutboundWorker/);
    assert.doesNotMatch(migration, /telegram|instagram|apple_calendar/);
    // Sibling provider routes not rewritten by this patch (presence sanity).
    assert.match(igRoutes, /INSTAGRAM_PROVIDER|instagram/);
    assert.match(developerRoutes, /telegram/i);
    assert.match(calendarRoutes, /apple|calendar/i);
    assert.doesNotMatch(bookingCommit, /remove_whatsapp_integration_owned/);
    assert.doesNotMatch(bookingFlow, /remove_whatsapp_integration_owned/);
    assert.doesNotMatch(outboundWorker, /remove_whatsapp_integration_owned/);
  });

  it('13. RU/EN/HY keys for add/remove/not-added copy', () => {
    const keys = [
      'developer.integrations.whatsapp.remove',
      'developer.integrations.whatsapp.removeConfirm',
      'developer.integrations.whatsapp.removeConfirmHint',
      'developer.integrations.whatsapp.removeConfirmConnected',
      'developer.integrations.whatsapp.notAdded',
      'developer.integrations.whatsapp.add',
      'developer.integrations.whatsapp.addInIntegrations',
      'developer.integrations.whatsapp.selectSalon',
      'developer.integrations.whatsapp.noEligibleSalons',
      'developer.integrations.whatsapp.removeAction',
    ];
    for (const k of keys) {
      const n = (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}'`, 'g')) || []).length;
      assert.equal(n, 3, `${k} must appear in en/ru/hy (got ${n})`);
    }
  });

  it('14. migration created and not executed by tests', () => {
    assert.match(migration, /remove_whatsapp_integration_owned/);
    assert.doesNotMatch(migration, /EXECUTE FUNCTION|SELECT public\.remove_whatsapp/);
  });
});

describe('WA-UI-1A cascade fix / shell preservation (static + helpers)', () => {
  const foundation = read(
    'supabase/migrations/20260727000002_whatsapp_channel_foundation.sql',
  );
  const webhook = read('server/src/routes/whatsappWebhook.ts');
  const prepareHandler = routes.slice(routes.indexOf("router.post('/:salonId/prepare'"));

  it('1. historical FK cascade audited; 00005 replaces with SET NULL + nullable', () => {
    assert.match(
      foundation,
      /integration_id\s+UUID NOT NULL REFERENCES salon_integrations\(id\) ON DELETE CASCADE/,
    );
    assert.match(migration, /ALTER COLUMN integration_id DROP NOT NULL/);
    assert.match(
      migration,
      /DROP CONSTRAINT IF EXISTS whatsapp_business_connections_integration_id_fkey/,
    );
    assert.match(migration, /ON DELETE SET NULL/);
    assert.doesNotMatch(
      migration,
      /ADD CONSTRAINT whatsapp_business_connections_integration_id_fkey[\s\S]*ON DELETE CASCADE/,
    );
  });

  it('2. remove RPC detaches shell then deletes registry; does not DELETE connection rows', () => {
    assert.match(migration, /integration_id\s*=\s*NULL/);
    assert.match(migration, /DELETE FROM public\.salon_integrations/);
    assert.doesNotMatch(migration, /DELETE FROM public\.whatsapp_business_connections/);
    assert.match(migration, /shellDetached|shell already detached|detach/i);
    assert.match(migration, /No CASCADE shell delete|preserve webhook_key/i);
  });

  it('3. webhook_key never cleared; credentials cleared; registry provider-scoped', () => {
    assert.doesNotMatch(migration, /webhook_key\s*=\s*NULL/i);
    assert.match(migration, /access_token_ciphertext\s*=\s*NULL/i);
    assert.match(migration, /app_secret_ciphertext\s*=\s*NULL/i);
    assert.match(migration, /verify_token_ciphertext\s*=\s*NULL/i);
    assert.match(
      migration,
      /WHERE salon_id = p_salon_id\s*\n\s*AND provider = 'whatsapp'/,
    );
  });

  it('4. detached webhook-key-only shell is not meaningful / not visible', () => {
    const shell: WhatsAppBusinessConnectionPublic = {
      id: 'c1',
      salonId: 's1',
      integrationId: null,
      provider: 'meta_cloud',
      businessAccountId: null,
      phoneNumberId: null,
      displayPhoneNumber: null,
      verifiedName: null,
      tokenExpiresAt: null,
      lastWebhookAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      qualityRating: null,
      messagingLimitTier: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      isAccessTokenStored: false,
      isAppSecretStored: false,
      isVerifyTokenStored: false,
      webhookKey: 'wk_kept',
      webhookCallbackUrl: 'https://example.test/wa/wk_kept',
    };
    assert.equal(isMeaningfulWhatsAppConnectionPresence(shell, false), false);
    assert.match(visibility, /webhook_key alone\) are NOT meaningful/);
    assert.match(routes, /registryPresent \|\| meaningful/);
  });

  it('5. prepare reattaches existing shell; preserves webhook_key; no second insert when shell exists', () => {
    assert.match(prepareHandler, /integration_id !== integration\.id/);
    assert.match(prepareHandler, /integration_id:\s*integration\.id/);
    assert.match(prepareHandler, /reattach|Remove→Add|preserve/i);
    assert.match(prepareHandler, /select\('id, integration_id, webhook_key'\)/);
    const existingBranch = prepareHandler.slice(prepareHandler.indexOf('} else {'));
    assert.match(
      existingBranch,
      /\.update\(\{[\s\S]*integration_id:\s*integration\.id/,
    );
    assert.doesNotMatch(existingBranch, /\.insert\(/);
    // Reattach update must not rotate webhook_key.
    assert.doesNotMatch(
      existingBranch,
      /\.update\(\{[\s\S]*webhook_key\s*:/,
    );
  });

  it('6. removed salon eligible for Add; prepare reused for add-back', () => {
    assert.match(addModal, /getWhatsAppIntegrations/);
    assert.match(addModal, /eligibleSalons/);
    assert.match(page, /prepareWhatsApp\(salonId\)/);
    assert.match(api, /prepareWhatsApp/);
  });

  it('7. webhook routing fail-closed on detached integration_id; outbound/booking untouched', () => {
    assert.match(webhook, /Detached shell/);
    assert.match(webhook, /integration_id !== 'string'/);
    assert.doesNotMatch(outboundWorker, /remove_whatsapp_integration_owned/);
    assert.doesNotMatch(bookingCommit, /DROP NOT NULL|ON DELETE SET NULL/);
    assert.doesNotMatch(waFixMigration, /remove_whatsapp_integration_owned/);
  });

  it('8. atomic remove still single RPC; messaging/salon not deleted; providers untouched', () => {
    assert.match(removeHandler, /\.rpc\(\s*'remove_whatsapp_integration_owned'/);
    assert.match(removeHandler, /atomic:\s*true/);
    assert.doesNotMatch(migration, /DELETE FROM public\.salons|DELETE FROM public\.clients/);
    assert.doesNotMatch(
      migration,
      /DELETE FROM public\.channel_conversations|DELETE FROM public\.channel_event_receipts|DELETE FROM public\.whatsapp_outbound|DELETE FROM public\.client_channel_identities/,
    );
    assert.doesNotMatch(migration, /provider = 'telegram'|provider = 'instagram'|apple/);
  });
});
