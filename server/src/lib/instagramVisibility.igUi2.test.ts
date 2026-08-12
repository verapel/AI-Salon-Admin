/**
 * IG-UI-2: Per-salon Instagram visibility (add/remove) — static source contracts.
 * No Meta. No production DB writes. No salon DELETE.
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
const addModal = read('client/src/components/developer/AddIntegrationModal.tsx');
const page = read('client/src/pages/developer/DeveloperIntegrations.tsx');
const api = read('client/src/lib/api.ts');
const i18n = read('client/src/i18n/translations.ts');
const routes = read('server/src/routes/instagramIntegrations.ts');
const persist = read('server/src/lib/instagramConnectionPersist.ts');
const index = read('server/src/index.ts');
const types = read('client/src/types/index.ts');

describe('IG-UI-2 Instagram visibility / remove (static)', () => {
  it('1. remove does not call salon permanent delete', () => {
    assert.match(tab, /removeInstagram\(/);
    assert.match(api, /\/developer\/integrations\/instagram\/\$\{salonId\}\/remove/);
    assert.doesNotMatch(tab, /\/developer\/salons\/\$\{.*\}\/permanent|deleteSalon|permanentDelete/);
    assert.doesNotMatch(routes, /\.from\('salons'\)\s*\.delete\(/);
    assert.match(routes, /Never delete from `salons`|NEVER deletes salon/i);
  });

  it('2. remove clears Instagram registry only; does not touch Telegram/WhatsApp/Apple', () => {
    assert.match(routes, /router\.delete\('\/:salonId\/remove'/);
    assert.match(routes, /\.eq\('provider',\s*INSTAGRAM_PROVIDER\)/);
    assert.doesNotMatch(routes, /provider:\s*'telegram'|provider:\s*'whatsapp'|apple_calendar/);
    assert.match(routes, /NEVER touches Telegram \/ WhatsApp \/ Apple/i);
  });

  it('3. unconnected card does not render Disconnect; connected/error can', () => {
    assert.match(card, /showDisconnect/);
    assert.match(card, /showDisconnect \? \(/);
    assert.match(card, /isConnected \|\| needsReconnect/);
    assert.doesNotMatch(
      card,
      /disabled=\{!canDisconnect/,
    );
  });

  it('4. list is registry-filtered; prepare adds without credentials', () => {
    assert.match(routes, /salon_integrations/);
    assert.match(routes, /\.eq\('provider',\s*INSTAGRAM_PROVIDER\)/);
    assert.match(routes, /router\.post\('\/:salonId\/prepare'/);
    assert.match(persist, /export async function ensureInstagramIntegrationRow/);
    assert.match(routes, /ensureInstagramIntegrationRow/);
    assert.doesNotMatch(
      routes,
      /prepare[\s\S]{0,400}instagram_business_connections[\s\S]{0,200}\.insert\(/,
    );
  });

  it('5. remove while credentials stored requires confirmConnected; not silent', () => {
    assert.match(routes, /INSTAGRAM_REMOVE_REQUIRES_CONFIRM/);
    assert.match(routes, /confirmConnected/);
    assert.match(routes, /requiresRemoveConfirmation/);
    assert.match(tab, /requiresRemoveConfirmation === true/);
    assert.match(tab, /removeConfirmConnected/);
  });

  it('6. add-back via Add Integration modal + prepare; no duplicate invent', () => {
    assert.match(addModal, /channel === 'instagram'/);
    assert.match(addModal, /onAddInstagram/);
    assert.match(addModal, /eligibleSalons/);
    assert.match(page, /prepareInstagram/);
    assert.match(api, /prepareInstagram/);
  });

  it('7. salon detail distinguishes not-added vs not-connected', () => {
    assert.match(detail, /integrationAdded === false/);
    assert.match(detail, /notAdded/);
    assert.match(detail, /addInIntegrations/);
  });

  it('8. salon-scoped + no secrets in UI/API contracts', () => {
    assert.match(routes, /salonId must not be provided in the request body/);
    for (const src of [card, tab, addModal, detail, api]) {
      assert.doesNotMatch(
        src,
        /access_token_ciphertext|APP_SECRET|WEBHOOK_VERIFY_TOKEN|CREDENTIALS_ENCRYPTION_KEY/,
      );
    }
    assert.match(types, /integrationAdded\?/);
  });

  it('9. outbound remains read-only; worker not bootstrapped', () => {
    assert.match(card, /outboundDisabled/);
    assert.doesNotMatch(card, /type=["']checkbox["']|setOutboundEnabled/);
    assert.doesNotMatch(index, /startInstagramOutboundWorker/);
  });

  it('10. RU/EN/HY keys for remove/add visibility strings', () => {
    const keys = [
      'developer.integrations.instagram.remove',
      'developer.integrations.instagram.removeConfirm',
      'developer.integrations.instagram.removeConfirmHint',
      'developer.integrations.instagram.removeConfirmConnected',
      'developer.integrations.instagram.notAdded',
      'developer.integrations.instagram.add',
      'developer.integrations.instagram.addInIntegrations',
      'developer.integrations.instagram.selectSalon',
      'developer.integrations.instagram.noEligibleSalons',
    ];
    for (const k of keys) {
      const n = (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}'`, 'g')) || []).length;
      assert.equal(n, 3, `${k} must appear in en/ru/hy (got ${n})`);
    }
  });
});
