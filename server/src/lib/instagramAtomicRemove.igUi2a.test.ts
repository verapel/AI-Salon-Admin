/**
 * IG-UI-2A: Atomic Instagram remove + orphan registry consistency — static contracts.
 * No Meta. No production DB writes. Migration not executed here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isMeaningfulInstagramConnectionPresence,
  type InstagramBusinessConnectionPublic,
} from './instagramConnectionPublic.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const routes = read('server/src/routes/instagramIntegrations.ts');
const migration = read(
  'supabase/migrations/20260812000003_remove_instagram_integration_owned.sql',
);
const tab = read('client/src/components/developer/InstagramIntegrationsTab.tsx');
const detail = read('client/src/components/developer/SalonDetailModal.tsx');
const addModal = read('client/src/components/developer/AddIntegrationModal.tsx');
const card = read('client/src/components/developer/SalonInstagramCard.tsx');
const index = read('server/src/index.ts');
const publicDto = read('server/src/lib/instagramConnectionPublic.ts');

describe('IG-UI-2A atomic remove + orphan consistency (static + executed helpers)', () => {
  it('1. remove route uses one atomic RPC; old two-write sequence absent', () => {
    assert.match(routes, /remove_instagram_integration_owned/);
    assert.match(routes, /\.rpc\(\s*'remove_instagram_integration_owned'/);
    // Inside remove handler: no sequential clear+delete.
    const removeHandler = routes.slice(routes.indexOf("router.delete('/:salonId/remove'"));
    assert.doesNotMatch(
      removeHandler,
      /clearInstagramConnectionSecrets[\s\S]{0,200}\.from\('salon_integrations'\)\s*\.delete\(/,
    );
    assert.match(removeHandler, /atomic:\s*true/);
  });

  it('2. RPC update/delete are salon + provider scoped', () => {
    assert.match(migration, /UPDATE public\.instagram_business_connections/);
    assert.match(migration, /WHERE salon_id = p_salon_id/);
    assert.match(migration, /DELETE FROM public\.salon_integrations/);
    assert.match(
      migration,
      /WHERE salon_id = p_salon_id\s*\n\s*AND provider = 'instagram'/,
    );
    assert.doesNotMatch(migration, /DELETE FROM public\.salons|UPDATE public\.clients/);
    assert.doesNotMatch(migration, /provider = 'telegram'|provider = 'whatsapp'|apple/);
    assert.match(migration, /SECURITY INVOKER/);
    assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
    assert.match(migration, /REVOKE ALL[\s\S]*FROM anon/);
  });

  it('3. connected confirmation uses requiresRemoveConfirmation (token-bearing)', () => {
    assert.match(routes, /requiresRemoveConfirmation/);
    assert.match(routes, /INSTAGRAM_REMOVE_REQUIRES_CONFIRM/);
    assert.match(tab, /requiresRemoveConfirmation === true/);
    assert.match(publicDto, /requiresRemoveConfirmation/);
  });

  it('4. orphan connection is visible; soft-cleared is not', () => {
    assert.match(routes, /isMeaningfulInstagramConnectionPresence/);
    assert.match(routes, /registryPresent \|\| meaningful/);
    assert.match(publicDto, /isMeaningfulInstagramConnectionPresence/);

    const connected: InstagramBusinessConnectionPublic = {
      id: 'c1',
      salonId: 's1',
      status: 'connected',
      instagramUserId: '178414',
      instagramUsername: 'x',
      connectedAt: '2026-08-01T00:00:00.000Z',
      lastWebhookAt: null,
      lastError: null,
      tokenExpiresAt: null,
      isAccessTokenStored: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    assert.equal(isMeaningfulInstagramConnectionPresence(connected, true), true);

    const errorWithToken: InstagramBusinessConnectionPublic = {
      ...connected,
      status: 'error',
      isAccessTokenStored: true,
    };
    assert.equal(isMeaningfulInstagramConnectionPresence(errorWithToken, true), true);

    const softCleared: InstagramBusinessConnectionPublic = {
      ...connected,
      status: 'not_connected',
      instagramUserId: null,
      instagramUsername: null,
      connectedAt: null,
      isAccessTokenStored: false,
    };
    assert.equal(isMeaningfulInstagramConnectionPresence(softCleared, false), false);
    assert.equal(isMeaningfulInstagramConnectionPresence(null, false), false);
  });

  it('5. add picker uses list (orphans included) — no fresh duplicate path', () => {
    assert.match(addModal, /getInstagramIntegrations/);
    assert.match(addModal, /eligibleSalons/);
    assert.match(addModal, /added\.add\(row\.salonId\)/);
  });

  it('6. salon detail not-added only when integrationAdded === false', () => {
    assert.match(detail, /integrationAdded === false/);
    assert.match(detail, /notAdded/);
  });

  it('7. unconnected card still hides Disconnect; remove × remains', () => {
    assert.match(card, /showDisconnect \? \(/);
    assert.match(card, /onRemove/);
  });

  it('8. protected runtimes / outbound / worker / secrets', () => {
    assert.doesNotMatch(migration, /telegram|whatsapp|apple_calendar|appointments/);
    assert.doesNotMatch(index, /startInstagramOutboundWorker/);
    assert.doesNotMatch(routes, /graph\.facebook\.com/);
    // Client surfaces must never mention credential/secret columns.
    for (const src of [tab, card, addModal, detail]) {
      assert.doesNotMatch(
        src,
        /access_token_ciphertext|APP_SECRET|WEBHOOK_VERIFY_TOKEN|CREDENTIALS_ENCRYPTION_KEY/,
      );
    }
    // Remove response path must not JSON-return credential columns.
    const removeHandler = routes.slice(routes.indexOf("router.delete('/:salonId/remove'"));
    assert.doesNotMatch(
      removeHandler,
      /access_token_ciphertext|access_token_iv|access_token_auth_tag/,
    );
  });

  it('9. migration filename exists and is not executed by tests', () => {
    assert.match(migration, /remove_instagram_integration_owned/);
    assert.doesNotMatch(migration, /EXECUTE FUNCTION|SELECT public\.remove_instagram/);
  });
});
