/**
 * IG-UI-1: Developer Cabinet Instagram integration UI — static source contracts.
 * No Meta. No production DB writes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const card = read('client/src/components/developer/SalonInstagramCard.tsx');
const tab = read('client/src/components/developer/InstagramIntegrationsTab.tsx');
const detail = read('client/src/components/developer/SalonDetailModal.tsx');
const api = read('client/src/lib/api.ts');
const types = read('client/src/types/index.ts');
const i18n = read('client/src/i18n/translations.ts');
const routes = read('server/src/routes/instagramIntegrations.ts');
const publicDto = read('server/src/lib/instagramConnectionPublic.ts');
const index = read('server/src/index.ts');

describe('IG-UI-1 Developer Instagram UI (static)', () => {
  it('1. developer Instagram card + tab exist and are salon-scoped', () => {
    assert.match(card, /SalonInstagramCard/);
    assert.match(tab, /getInstagramIntegrations/);
    assert.match(tab, /startInstagramConnect\(integration\.salonId\)/);
    assert.match(tab, /disconnectInstagram\(disconnectTarget\.salonId\)/);
    assert.doesNotMatch(tab, /buildInstagramAuthorizeUrl|instagram\.com\/oauth/);
  });

  it('2. not-connected / connected / reconnect-required states', () => {
    assert.match(card, /notConnectedHint/);
    assert.match(card, /status === 'connected'/);
    assert.match(card, /reconnectRequired/);
    assert.match(card, /onReconnect/);
    assert.match(card, /onConnect/);
  });

  it('3. safe account fields only — no credential columns rendered', () => {
    for (const src of [card, tab, detail]) {
      assert.doesNotMatch(
        src,
        /access_token_ciphertext|access_token_iv|access_token_auth_tag|APP_SECRET|WEBHOOK_VERIFY_TOKEN|CREDENTIALS_ENCRYPTION_KEY|authorizationUrl\.secret/,
      );
      assert.doesNotMatch(src, /console\.log\([^)]*authorizationUrl/);
    }
    assert.match(card, /professionalAccountId|maskInstagramUserId|instagramUserId/);
    assert.match(card, /tokenExpires/);
  });

  it('4. connect uses backend authorizationUrl; missing config safe message', () => {
    assert.match(tab, /started\.authorizationUrl/);
    assert.match(tab, /window\.location\.assign\(started\.authorizationUrl\)/);
    assert.match(tab, /INSTAGRAM_NOT_CONFIGURED/);
    assert.match(tab, /notConfigured/);
    assert.match(api, /startInstagramConnect/);
    assert.match(
      api,
      /\/developer\/integrations\/instagram\/\$\{salonId\}\/connect\/start/,
    );
    assert.match(api, /authorizationUrl/);
    assert.doesNotMatch(api, /graph\.facebook\.com|facebook\.com\/dialog\/oauth/);
  });

  it('5. OAuth callback banners for connected / cancelled / error codes', () => {
    assert.match(tab, /searchParams\.get\('instagram'\)/);
    assert.match(tab, /result === 'connected'/);
    assert.match(tab, /result === 'cancelled'/);
    assert.match(tab, /result === 'error'/);
    assert.match(tab, /invalid_state/);
    assert.match(tab, /oauthInvalidState/);
  });

  it('6. outbound shown read-only disabled; no env toggle', () => {
    assert.match(card, /outboundDisabled/);
    assert.match(card, /outboundDisabledHint/);
    assert.match(card, /outboundEnabled/);
    assert.doesNotMatch(card, /type=["']checkbox["']|toggleOutbound|setOutboundEnabled/);
    assert.doesNotMatch(tab, /INSTAGRAM_OUTBOUND_ENABLED\s*=/);
    assert.match(routes, /outboundEnabled/);
    assert.match(routes, /isInstagramOutboundEnabled/);
    assert.match(types, /outboundEnabled\?/);
  });

  it('7. webhook status honest — path shown; no verify token', () => {
    assert.match(card, /\/api\/webhooks\/instagram/);
    assert.match(card, /webhookReady|webhookActivitySeen/);
    assert.doesNotMatch(card, /VERIFY_TOKEN|verifyToken|verify_token/);
  });

  it('8. disconnect wired to existing DELETE endpoint', () => {
    assert.match(tab, /disconnectInstagram/);
    assert.match(api, /method: 'DELETE'/);
    assert.match(routes, /router\.delete\('\/:salonId\/disconnect'/);
    // IG-UI-2: Disconnect is conditional — not shown when unconnected.
    assert.match(card, /showDisconnect/);
  });

  it('9. status API is developer-mounted; public DTO forbids secrets', () => {
    assert.match(index, /\/api\/developer/);
    assert.match(routes, /router\.get\('\/:salonId'/);
    assert.match(publicDto, /instagramPublicDtoHasNoSecrets/);
    assert.match(publicDto, /FORBIDDEN_SECRET_KEYS|access_token_ciphertext/);
    assert.match(types, /InstagramBusinessConnectionPublic/);
    assert.doesNotMatch(types, /access_token_ciphertext/);
  });

  it('10. salon detail shows Instagram status for selected salonId only', () => {
    assert.match(detail, /getInstagramIntegration\(salonId\)/);
    assert.match(detail, /developer\/integrations\?tab=instagram/);
    assert.match(detail, /outboundDisabled/);
  });

  it('10a. IG-UI-1A: Instagram status load is independent of main salon detail load', () => {
    const loadDetailBlock = detail.match(
      /const loadDetail = useCallback\(async \(\) => \{[\s\S]*?\}, \[salonId, populateForm, t\]\);/,
    );
    assert.ok(loadDetailBlock, 'loadDetail callback must exist');
    assert.doesNotMatch(loadDetailBlock![0], /getInstagramIntegration/);
    assert.match(loadDetailBlock![0], /getSalon\(salonId\)/);
    // Independent Instagram effect keyed on isOpen + salonId.
    assert.match(detail, /getInstagramIntegration\(salonId\)/);
    assert.match(detail, /}, \[isOpen, salonId\]\);/);
  });

  it('10b. IG-UI-1A: stale Instagram responses ignored after cleanup / salon switch', () => {
    assert.match(detail, /let cancelled = false/);
    assert.match(detail, /if \(cancelled\) return/);
    assert.match(detail, /return \(\) => \{\s*cancelled = true;\s*\};/);
    // Reset before fetch so prior salon status is not shown for the new salon.
    assert.match(
      detail,
      /setInstagram\(null\);\s*setInstagramError\(false\);\s*\n\s*void api\.developer/,
    );
    // Closed / missing salon clears IG state.
    assert.match(
      detail,
      /if \(!isOpen \|\| !salonId\) \{\s*setInstagram\(null\);\s*setInstagramError\(false\);\s*return;/,
    );
  });

  it('11. RU/EN/HY keys exist for new IG-UI-1 strings', () => {
    const keys = [
      'developer.integrations.instagram.title',
      'developer.integrations.instagram.reconnectRequired',
      'developer.integrations.instagram.outbound',
      'developer.integrations.instagram.outboundDisabled',
      'developer.integrations.instagram.outboundDisabledHint',
      'developer.integrations.instagram.webhookReady',
      'developer.integrations.instagram.tokenExpires',
      'developer.integrations.instagram.oauthInvalidState',
      'developer.integrations.instagram.manageInIntegrations',
    ];
    for (const k of keys) {
      const n = (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}'`, 'g')) || []).length;
      assert.equal(n, 3, `${k} must appear in en/ru/hy (got ${n})`);
    }
  });

  it('12. Instagram outbound worker still not bootstrapped in index', () => {
    assert.doesNotMatch(index, /startInstagramOutboundWorker/);
    assert.match(index, /startWhatsAppOutboundWorker/);
  });

  it('13. developer routes require developer auth mount; salonId explicit', () => {
    assert.match(index, /app\.use\('\/api\/developer',\s*developerAuth,\s*developerRouter\)/);
    assert.match(routes, /Developer cabinet|Salon cabinet has no access/);
    assert.match(routes, /router\.post\('\/:salonId\/connect\/start'/);
    assert.match(routes, /router\.get\('\/:salonId'/);
  });

  it('14. callback refresh loads status after any OAuth marker', () => {
    assert.match(tab, /loadIntegrations\(\)/);
    assert.match(tab, /result === 'connected'/);
    assert.match(tab, /result === 'cancelled'/);
    assert.match(tab, /result === 'error'/);
  });

  it('15. salon A card never falls back to default/global salon id', () => {
    assert.doesNotMatch(card, /aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001|DEFAULT_SALON|defaultSalon/);
    assert.match(detail, /getInstagramIntegration\(salonId\)/);
  });
});
