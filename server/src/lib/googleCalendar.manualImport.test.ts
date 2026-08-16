/**
 * GOOGLE-CAL FAST manual one-event import — essential executed tests.
 * No production SQL. No real Google writes. RPC is mocked.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPE,
  serializeGoogleCalendarCredentialBlob,
} from './googleCalendarOAuth.js';
import { encryptCalendarCredential } from './calendarCredentialsCrypto.js';
import { parseExternalCalendarEvent } from './calendarEventParser.js';
import { matchParsedCalendarEvent, type CalendarMatchCatalog } from './calendarEventMatcher.js';
import {
  GOOGLE_IMPORT_RPC,
  buildGoogleOccurrenceKey,
  buildGoogleOccurrenceRecurrenceId,
  buildGoogleSourceExternalEventId,
  computeGoogleImportReadiness,
  executeManualGoogleCalendarImport,
  GoogleCalendarImportError,
  suggestNewClientNameFromTitle,
} from './googleCalendarImport.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const PREV_ENV: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const SALON = 'salon-1';
const STAFF = 'staff-1';
const SERVICE = 'service-1';
const CLIENT = 'client-1';
const EVENT_ID = 'gcal-event-agunik';
const CAL_ID = 'primary';

function makeTimedGoogleEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    status: 'confirmed',
    summary: 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома',
    description: null,
    etag: 'etag-1',
    updated: '2026-07-19T10:00:00.000Z',
    start: { dateTime: '2026-07-20T06:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-07-20T08:00:00Z', timeZone: 'UTC' },
    ...overrides,
  };
}

function makeConnRow() {
  const enc = encryptCalendarCredential(
    serializeGoogleCalendarCredentialBlob({
      refresh_token: 'rt-secret',
      scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
      token_type: 'Bearer',
    }),
  );
  return {
    id: 'conn-1',
    credential_ciphertext: enc.ciphertext,
    credential_iv: enc.iv,
    credential_auth_tag: enc.authTag,
    status: 'connected',
    selected_calendar_id: CAL_ID,
    selected_calendar_name: 'Salon',
    provider_config: {},
  };
}

function mockDb(opts: {
  rpcResult?: Record<string, unknown>;
  rpcError?: { message: string; code?: string } | null;
  onRpc?: (name: string, args: Record<string, unknown>) => void;
  conn?: Record<string, unknown> | null;
}) {
  const conn = opts.conn === undefined ? makeConnRow() : opts.conn;
  return {
    from(_table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: conn, error: null }),
                  };
                },
              };
            },
          };
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      opts.onRpc?.(name, args);
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      return { data: opts.rpcResult ?? { kind: 'ok' }, error: null };
    },
  };
}

function mockFetch(event: Record<string, unknown> | null) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const method = String(init?.method || 'GET').toUpperCase();
    calls.push({ url, method });
    if (url.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as any;
    }
    if (url.includes('/calendar/v3/calendars/') && url.includes('/events/')) {
      if (!event) {
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }
      return { ok: true, status: 200, json: async () => event } as any;
    }
    return { ok: false, status: 500, json: async () => ({ error: 'unexpected' }) } as any;
  };
  return { fetchImpl, calls };
}

function readinessFor(
  title: string,
  catalog: CalendarMatchCatalog,
  extra: Partial<Parameters<typeof computeGoogleImportReadiness>[0]> = {},
) {
  const parsed = parseExternalCalendarEvent(
    {
      summary: title,
      description: null,
      status: 'confirmed',
      start: {
        dateTime: '2026-07-20T06:00:00Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
      end: {
        dateTime: '2026-07-20T08:00:00Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
    },
    'Asia/Yerevan',
  );
  const matching = matchParsedCalendarEvent({
    parsed,
    originalTitle: title,
    catalog,
  });
  return computeGoogleImportReadiness({
    parsed,
    matching,
    event: {
      id: EVENT_ID,
      calendarId: CAL_ID,
      status: 'confirmed',
      summary: title,
      recurringEventId: null,
      originalStartTime: null,
    },
    alreadyImported: false,
    ...extra,
  });
}

describe('GOOGLE-CAL FAST manual import (executed)', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_ID', 'cid');
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', 'csecret');
    setEnv('GOOGLE_CALENDAR_REDIRECT_URI', 'http://localhost/api/calendar/google/callback');
    setEnv('PUBLIC_APP_ORIGIN', 'http://localhost');
    setEnv('CALENDAR_CREDENTIALS_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });

  after(() => {
    for (const [k, v] of Object.entries(PREV_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('1. existing client + matched service + staff → readiness needs_staff then importable', () => {
    const catalog: CalendarMatchCatalog = {
      clients: [{ id: CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const title = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';
    const noStaff = readinessFor(title, catalog);
    assert.equal(noStaff.status, 'needs_staff_review');
    const ready = readinessFor(title, catalog, { selectedStaffId: STAFF });
    assert.equal(ready.status, 'importable');
  });

  it('2. new client exact phone + confirmed name → canCreateNewClient + importable with staff', () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const title = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';
    const r = readinessFor(title, catalog, {
      selectedStaffId: STAFF,
      confirmedNewClientName: 'Agunik Yeganian',
    });
    assert.equal(r.canCreateNewClient, true);
    assert.equal(r.status, 'importable');
    assert.ok(suggestNewClientNameFromTitle(title)?.includes('Agunik'));
  });

  it('3. execute new-client mode: RPC gets Google phone; phone reuse is RPC responsibility', async () => {
    let rpcArgs: Record<string, unknown> | null = null;
    const db = mockDb({
      rpcResult: {
        kind: 'ok',
        appointmentId: 'a1',
        clientId: 'c-existing',
        clientCreated: false,
      },
      onRpc: (_n, args) => {
        rpcArgs = args;
      },
    });
    const { fetchImpl, calls } = mockFetch(makeTimedGoogleEvent());
    const reminders: unknown[] = [];
    const result = await executeManualGoogleCalendarImport({
      db,
      salonId: SALON,
      body: {
        eventId: EVENT_ID,
        staffId: STAFF,
        serviceId: SERVICE,
        client: { mode: 'new', name: 'Agunik Yeganian', phone: '+999' },
        expectedEtag: 'etag-1',
      },
      fetchImpl: fetchImpl as any,
      salonTimeZone: 'Asia/Yerevan',
      syncReminder: async (p) => {
        reminders.push(p);
      },
    });
    assert.equal(result.appointmentId, 'a1');
    assert.equal(result.clientCreated, false);
    assert.equal(rpcArgs?.p_client_mode, 'new');
    // Browser phone substitution ignored — Google exact phone used.
    assert.equal(rpcArgs?.p_client_phone, '+380632022810');
    assert.equal(rpcArgs?.p_client_name, 'Agunik Yeganian');
    assert.equal(reminders.length, 1);
    assert.ok(calls.every((c) => c.method === 'GET' || c.url.includes('/token')));
  });

  it('4. RPC client_ambiguous → reject', async () => {
    const db = mockDb({
      rpcResult: { kind: 'error', code: 'client_ambiguous' },
    });
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent());
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: STAFF,
            serviceId: SERVICE,
            client: { mode: 'new', name: 'Agunik' },
          },
          fetchImpl: fetchImpl as any,
          salonTimeZone: 'Asia/Yerevan',
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError && err.code === 'client_ambiguous',
    );
  });

  it('5. no staff → reject staff_required', async () => {
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db: mockDb({}),
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: '',
            serviceId: SERVICE,
            client: { mode: 'existing', clientId: CLIENT },
          },
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError && err.code === 'staff_required',
    );
  });

  it('6. wrong-salon staff → RPC staff_invalid', async () => {
    const db = mockDb({
      rpcResult: { kind: 'error', code: 'staff_invalid' },
    });
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent());
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: 'other-salon-staff',
            serviceId: SERVICE,
            client: { mode: 'existing', clientId: CLIENT },
          },
          fetchImpl: fetchImpl as any,
          salonTimeZone: 'Asia/Yerevan',
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError && err.code === 'staff_invalid',
    );
  });

  it('7. inactive/wrong-salon service → RPC service_invalid', async () => {
    const db = mockDb({
      rpcResult: { kind: 'error', code: 'service_invalid' },
    });
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent());
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: STAFF,
            serviceId: 'bad-service',
            client: { mode: 'existing', clientId: CLIENT },
          },
          fetchImpl: fetchImpl as any,
          salonTimeZone: 'Asia/Yerevan',
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError && err.code === 'service_invalid',
    );
  });

  it('8a. cancelled Google event → reject', async () => {
    const db = mockDb({});
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent({ status: 'cancelled' }));
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: STAFF,
            serviceId: SERVICE,
            client: { mode: 'existing', clientId: CLIENT },
          },
          fetchImpl: fetchImpl as any,
          salonTimeZone: 'Asia/Yerevan',
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError && err.code === 'google_event_cancelled',
    );
  });

  it('8b. all-day Google event → reject', async () => {
    const db = mockDb({});
    const { fetchImpl } = mockFetch(
      makeTimedGoogleEvent({
        start: { date: '2026-07-20' },
        end: { date: '2026-07-21' },
      }),
    );
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: STAFF,
            serviceId: SERVICE,
            client: { mode: 'existing', clientId: CLIENT },
          },
          fetchImpl: fetchImpl as any,
          salonTimeZone: 'Asia/Yerevan',
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError &&
        err.code === 'google_event_not_importable',
    );
  });

  it('9. staff overlap → appointment_conflict', async () => {
    const db = mockDb({
      rpcResult: { kind: 'error', code: 'appointment_conflict' },
    });
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent());
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: STAFF,
            serviceId: SERVICE,
            client: { mode: 'existing', clientId: CLIENT },
          },
          fetchImpl: fetchImpl as any,
          salonTimeZone: 'Asia/Yerevan',
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError && err.code === 'appointment_conflict',
    );
  });

  it('10. duplicate Google event → alreadyImported once', async () => {
    const db = mockDb({
      rpcResult: {
        kind: 'already_imported',
        appointmentId: 'a-existing',
        clientId: null,
        clientCreated: false,
      },
    });
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent());
    const result = await executeManualGoogleCalendarImport({
      db,
      salonId: SALON,
      body: {
        eventId: EVENT_ID,
        staffId: STAFF,
        serviceId: SERVICE,
        client: { mode: 'existing', clientId: CLIENT },
      },
      fetchImpl: fetchImpl as any,
      salonTimeZone: 'Asia/Yerevan',
      syncReminder: async () => {
        throw new Error('should not sync reminder on already_imported');
      },
    });
    assert.equal(result.alreadyImported, true);
    assert.equal(result.appointmentId, 'a-existing');
  });

  it('11. atomicity: business write goes only through owned RPC (no JS inserts)', async () => {
    const sql = read(
      'supabase/migrations/20260816000003_google_calendar_manual_import_commit.sql',
    );
    assert.match(sql, /commit_google_calendar_manual_import/);
    assert.match(sql, /INSERT INTO public\.clients/);
    assert.match(sql, /INSERT INTO public\.appointments/);
    assert.match(sql, /INSERT INTO public\.appointment_external_links/);
    assert.match(sql, /source,\s*\n\s*source_external_event_id/);
    assert.match(sql, /'google'/);
    assert.match(sql, /appointment_conflict/);
    assert.match(sql, /client_ambiguous/);
    assert.match(sql, /FOR UPDATE/);
    assert.match(sql, /pg_advisory_xact_lock/);

    let rpcName = '';
    const db = mockDb({
      rpcResult: {
        kind: 'ok',
        appointmentId: 'a1',
        clientId: 'c1',
        clientCreated: true,
      },
      onRpc: (name) => {
        rpcName = name;
      },
    });
    // Ensure execute path never calls from() for inserts — only connection read + rpc.
    const originalFrom = db.from.bind(db);
    let fromTables: string[] = [];
    db.from = (table: string) => {
      fromTables.push(table);
      return originalFrom(table);
    };
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent());
    await executeManualGoogleCalendarImport({
      db,
      salonId: SALON,
      body: {
        eventId: EVENT_ID,
        staffId: STAFF,
        serviceId: SERVICE,
        client: { mode: 'new', name: 'Agunik Yeganian' },
      },
      fetchImpl: fetchImpl as any,
      salonTimeZone: 'Asia/Yerevan',
      syncReminder: async () => {},
    });
    assert.equal(rpcName, GOOGLE_IMPORT_RPC);
    assert.deepEqual(fromTables, ['calendar_connections']);
  });

  it('12. no Google writes — only token + event GET', async () => {
    const db = mockDb({
      rpcResult: {
        kind: 'ok',
        appointmentId: 'a1',
        clientId: 'c1',
        clientCreated: false,
      },
    });
    const { fetchImpl, calls } = mockFetch(makeTimedGoogleEvent());
    await executeManualGoogleCalendarImport({
      db,
      salonId: SALON,
      body: {
        eventId: EVENT_ID,
        staffId: STAFF,
        serviceId: SERVICE,
        client: { mode: 'existing', clientId: CLIENT },
      },
      fetchImpl: fetchImpl as any,
      salonTimeZone: 'Asia/Yerevan',
      syncReminder: async () => {},
    });
    const mutating = calls.filter((c) =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.method),
    );
    // Token endpoint is POST — allow only that.
    assert.ok(mutating.every((c) => c.url.includes('oauth2.googleapis.com/token')));
    assert.ok(
      calls.some(
        (c) =>
          c.method === 'GET' &&
          c.url.includes('/calendar/v3/calendars/') &&
          c.url.includes(`/events/${encodeURIComponent(EVENT_ID)}`),
      ),
    );
  });

  it('occurrence identity: recurring instances get distinct keys', () => {
    const a = buildGoogleOccurrenceKey({
      calendarId: CAL_ID,
      eventId: 'series_20260720',
      recurrenceId: '2026-07-20T06:00:00Z',
    });
    const b = buildGoogleOccurrenceKey({
      calendarId: CAL_ID,
      eventId: 'series_20260727',
      recurrenceId: '2026-07-27T06:00:00Z',
    });
    assert.notEqual(a, b);
    const rec = buildGoogleOccurrenceRecurrenceId({
      recurringEventId: 'series',
      originalStartTime: { dateTime: '2026-07-20T06:00:00Z', date: null },
    });
    assert.equal(rec, '2026-07-20T06:00:00Z');
    const src = buildGoogleSourceExternalEventId({
      calendarId: CAL_ID,
      eventId: EVENT_ID,
      recurrenceId: '',
    });
    assert.equal(src, `${CAL_ID}:${EVENT_ID}`);
  });

  it('already_imported readiness blocks UI path', () => {
    const catalog: CalendarMatchCatalog = {
      clients: [{ id: CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const r = readinessFor(
      'Agunik Yeganian +380 63 202 2810 окрашивание',
      catalog,
      { alreadyImported: true, selectedStaffId: STAFF },
    );
    assert.equal(r.status, 'already_imported');
  });

  it('new client without exact phone stays needs_client_review', () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const r = readinessFor('Окрашивание без телефона', catalog, {
      selectedStaffId: STAFF,
      confirmedNewClientName: 'Someone',
    });
    assert.equal(r.canCreateNewClient, false);
    assert.equal(r.status, 'needs_client_review');
  });

  it('etag mismatch → google_event_changed', async () => {
    const db = mockDb({});
    const { fetchImpl } = mockFetch(makeTimedGoogleEvent({ etag: 'etag-new' }));
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          body: {
            eventId: EVENT_ID,
            staffId: STAFF,
            serviceId: SERVICE,
            client: { mode: 'existing', clientId: CLIENT },
            expectedEtag: 'etag-old',
          },
          fetchImpl: fetchImpl as any,
          salonTimeZone: 'Asia/Yerevan',
          syncReminder: async () => {},
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarImportError && err.code === 'google_event_changed',
    );
  });

  it('route + migration files exist; import_enabled not flipped', () => {
    const route = read('server/src/routes/calendarConnections.ts');
    assert.match(route, /\/google\/events\/import/);
    assert.match(route, /executeManualGoogleCalendarImport/);
    assert.doesNotMatch(route, /import_enabled\s*:\s*true/);
    const sql = read(
      'supabase/migrations/20260816000003_google_calendar_manual_import_commit.sql',
    );
    assert.doesNotMatch(sql, /import_enabled\s*=\s*true/);
    // Protected systems untouched by this migration.
    assert.doesNotMatch(sql, /commit_whatsapp/);
    assert.doesNotMatch(sql, /commit_instagram/);
    assert.doesNotMatch(sql, /telegram/);
  });
});
