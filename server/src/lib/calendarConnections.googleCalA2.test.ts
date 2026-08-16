/**
 * GOOGLE-CAL-A2: appointments.source += google; provider-neutral calendar GET read model.
 * No Google OAuth, no Google API, no migration execution.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppointmentSource, CalendarProvider } from '../types.js';
import {
  buildCalendarConnectionsResponse,
  mapCalendarConnectionInternalSafe,
  mapCalendarConnectionSafe,
} from '../routes/calendarConnections.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const MIGRATION =
  'supabase/migrations/20260816000001_google_calendar_appointment_source.sql';

describe('GOOGLE-CAL-A2 AppointmentSource + migration (static/runtime)', () => {
  const sql = read(MIGRATION);
  const serverTypes = read('server/src/types.ts');
  const databaseTypes = read('server/src/types/database.ts');
  const clientTypes = read('client/src/types/index.ts');
  const packageJson = read('server/package.json');

  it('1. AppointmentSource accepts google (runtime + type declarations)', () => {
    const src: AppointmentSource = 'google';
    assert.equal(src, 'google');
    const allowed: AppointmentSource[] = [
      'telegram',
      'owner',
      'apple',
      'whatsapp',
      'instagram',
      'google',
    ];
    for (const value of allowed) {
      assert.ok(allowed.includes(value));
    }
    assert.match(serverTypes, /'google'/);
    assert.match(databaseTypes, /'google'/);
    assert.match(clientTypes, /'google'/);
  });

  it('2/3/4/5. migration CHECK preserves prior values + NULL; adds google; no rewrite', () => {
    assert.match(sql, /DROP CONSTRAINT IF EXISTS appointments_source_check/);
    assert.match(sql, /ADD CONSTRAINT appointments_source_check/);
    assert.match(sql, /source IS NULL/);
    for (const value of [
      'telegram',
      'owner',
      'apple',
      'whatsapp',
      'instagram',
      'google',
    ]) {
      assert.match(sql, new RegExp(`'${value}'`));
    }
    assert.doesNotMatch(sql, /UPDATE\s+(?:public\.)?appointments/i);
    assert.doesNotMatch(sql, /DELETE\s+FROM\s+(?:public\.)?appointments/i);
    assert.doesNotMatch(sql, /DROP\s+TABLE/i);
    assert.doesNotMatch(sql, /TRUNCATE/i);
  });

  it('6. CalendarProvider still accepts apple | google', () => {
    const apple: CalendarProvider = 'apple';
    const google: CalendarProvider = 'google';
    assert.equal(apple, 'apple');
    assert.equal(google, 'google');
    assert.match(serverTypes, /CalendarProvider\s*=\s*'apple'\s*\|\s*'google'/);
    assert.match(clientTypes, /CalendarProvider\s*=\s*'apple'\s*\|\s*'google'/);
  });

  it('12–15. prior appointment sources remain in type union', () => {
    for (const value of ['telegram', 'owner', 'apple', 'whatsapp', 'instagram'] as const) {
      const src: AppointmentSource = value;
      assert.equal(src, value);
      assert.match(serverTypes, new RegExp(`'${value}'`));
    }
  });

  it('package registers GOOGLE-CAL-A2 suite once', () => {
    const n = (packageJson.match(/calendarConnections\.googleCalA2\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});

describe('GOOGLE-CAL-A2 calendar connections read model', () => {
  const routes = read('server/src/routes/calendarConnections.ts');
  const crypto = read('server/src/lib/calendarCredentialsCrypto.ts');
  const integrations = read('client/src/pages/SalonIntegrations.tsx');
  const clientTypes = read('client/src/types/index.ts');
  const serverTypes = read('server/src/types.ts');

  it('7. public DTO mapping never exposes credential columns', () => {
    const publicDto = mapCalendarConnectionSafe(
      {
        id: 'c1',
        provider: 'apple',
        account_email: 'a@example.com',
        selected_calendar_id: null,
        selected_calendar_url: null,
        selected_calendar_name: null,
        status: 'connected',
        import_enabled: false,
        last_sync_at: null,
        last_sync_started_at: null,
        last_error: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      },
      true,
    );
    assert.equal('credential_ciphertext' in publicDto, false);
    assert.equal('credential_iv' in publicDto, false);
    assert.equal('credential_auth_tag' in publicDto, false);
    assert.equal('provider_config' in publicDto, false);
    assert.equal(publicDto.isCredentialStored, true);

    const fromInternal = mapCalendarConnectionInternalSafe({
      id: 'c2',
      provider: 'google',
      account_email: 'g@example.com',
      selected_calendar_id: 'primary',
      selected_calendar_url: null,
      selected_calendar_name: 'Work',
      status: 'connected',
      import_enabled: false,
      last_sync_at: null,
      last_sync_started_at: null,
      last_error: null,
      created_at: '2026-08-16T00:00:00.000Z',
      updated_at: '2026-08-16T00:00:00.000Z',
      credential_ciphertext: 'cipher',
      credential_iv: 'iv',
      credential_auth_tag: 'tag',
    });
    assert.equal(fromInternal.provider, 'google');
    assert.equal(fromInternal.isCredentialStored, true);
    assert.equal(JSON.stringify(fromInternal).includes('cipher'), false);
    assert.equal(JSON.stringify(fromInternal).includes('credential_'), false);
  });

  it('8. Apple legacy connection compatibility preserved', () => {
    const apple = mapCalendarConnectionSafe(
      {
        id: 'apple-1',
        provider: 'apple',
        account_email: 'apple@example.com',
        selected_calendar_id: null,
        selected_calendar_url: null,
        selected_calendar_name: null,
        status: 'connected',
        import_enabled: false,
        last_sync_at: null,
        last_sync_started_at: null,
        last_error: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      },
      true,
    );
    const google = mapCalendarConnectionSafe(
      {
        id: 'google-1',
        provider: 'google',
        account_email: 'google@example.com',
        selected_calendar_id: 'primary',
        selected_calendar_url: null,
        selected_calendar_name: 'Gmail',
        status: 'connected',
        import_enabled: false,
        last_sync_at: null,
        last_sync_started_at: null,
        last_error: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      },
      true,
    );
    const response = buildCalendarConnectionsResponse([google, apple]);
    assert.equal(response.connection?.id, 'apple-1');
    assert.equal(response.connection?.provider, 'apple');
    assert.equal(response.connections.length, 2);
    assert.match(clientTypes, /connections:\s*CalendarConnectionPublic\[\]/);
    assert.match(integrations, /data\.connection/);
  });

  it('9. mocked Google row appears in multi-provider collection', () => {
    const response = buildCalendarConnectionsResponse([
      mapCalendarConnectionSafe(
        {
          id: 'g1',
          provider: 'google',
          account_email: 'tatevik.migaelyan@gmail.com',
          selected_calendar_id: null,
          selected_calendar_url: null,
          selected_calendar_name: null,
          status: 'disconnected',
          import_enabled: false,
          last_sync_at: null,
          last_sync_started_at: null,
          last_error: null,
          created_at: '2026-08-16T00:00:00.000Z',
          updated_at: '2026-08-16T00:00:00.000Z',
        },
        false,
      ),
    ]);
    assert.equal(response.connection, null);
    assert.equal(response.connections[0]?.provider, 'google');
  });

  it('10. GET connections remains salon-scoped via getSalonId', () => {
    assert.match(routes, /getSalonId\(req\)/);
    assert.match(routes, /\.eq\('salon_id',\s*salonId\)/);
    assert.doesNotMatch(routes, /DEFAULT_SALON|defaultSalon|PILOT_SALON/);
    assert.doesNotMatch(routes, /req\.query\.salonId|req\.body\.salonId/);
  });

  it('11. A2 foundation intact; Google OAuth routes owned by FAST-1', () => {
    // A2 shipped read-model + source enum only. OAuth/discovery live in GOOGLE-CAL-FAST-1.
    assert.match(routes, /buildCalendarConnectionsResponse|connections/);
    assert.match(serverTypes, /'google'/);
    assert.doesNotMatch(routes, /events\.list/);
  });

  it('Apple write routes and crypto helper unchanged in behaviour surface', () => {
    assert.match(routes, /router\.post\('\/apple\/connect'/);
    assert.match(routes, /router\.delete\('\/apple'/);
    assert.match(routes, /encryptCalendarCredential/);
    assert.match(routes, /appSpecificPassword/);
    assert.doesNotMatch(crypto, /google|oauth/i);
    assert.match(crypto, /CALENDAR_CREDENTIALS_ENCRYPTION_KEY/);
  });
});
