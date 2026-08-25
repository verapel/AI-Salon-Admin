/**
 * GOOGLE MULTI-CALENDAR: DB occurrence identity + manual sync of all selected calendars.
 * FAST-6 auto-import stays primary-only. No production SQL. No Google writes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CalendarMatchCatalog } from './calendarEventMatcher.js';
import { encryptCalendarCredential } from './calendarCredentialsCrypto.js';
import {
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
} from './googleCalendarAutoImport.js';
import {
  importGoogleCalendarLast30Days,
} from './googleCalendarBackfill.js';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPE,
  GOOGLE_SELECTED_CALENDARS_CONFIG_KEY,
  googlePreviewItemIdentity,
  serializeGoogleCalendarCredentialBlob,
  type GoogleEventPreviewItem,
} from './googleCalendarOAuth.js';
import {
  buildGoogleOccurrenceKey,
  buildGoogleOccurrenceRecurrenceId,
  executeManualGoogleCalendarImport,
  googleOccurrenceLookupKeys,
  googleRememberedOccurrenceKeys,
  googleStoredOccurrenceKeys,
  isGoogleCalendarAllowedForManualImport,
} from './googleCalendarImport.js';
import {
  findImportedOccurrenceRecord,
  findOverlayRecord,
  loadGoogleImportedOccurrenceIndex,
} from './googleCalendarReconcile.js';
import {
  listGoogleReviewCalendarItems,
  loadGoogleReviewCoverageIndex,
  upsertGoogleCalendarReviewIssue,
} from './googleCalendarReviewOverlay.js';
import { loadRememberedGoogleCoverageClientId } from './googleCalendarCoverageClient.js';

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

const NOW = new Date('2026-08-24T12:00:00.000Z');
const CAL_A = 'tatevik.miqaelyan@gmail.com';
const CAL_B = 'SetTime';
const CAL_C = 'unselected-c@example.com';
const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const SALON = 'salon-1';
const TITLE = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';
const MIGRATION = 'supabase/migrations/20260824000001_google_multi_calendar_occurrence_identity.sql';

const CATALOG: CalendarMatchCatalog = {
  clients: [{ id: 'client-agunik', name: 'Agunik Yeganian', phone: '+380632022810' }],
  services: [{ id: SERVICE, name: 'Окрашивание' }],
};

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-1',
    iCalUID: null,
    summary: TITLE,
    description: null,
    location: null,
    status: 'confirmed',
    start: { dateTime: '2026-08-21T08:00:00+04:00', date: null, timeZone: null, allDay: false },
    end: { dateTime: '2026-08-21T09:00:00+04:00', date: null, timeZone: null, allDay: false },
    recurringEventId: null,
    originalStartTime: null,
    created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-01T00:00:00.000Z',
    etag: 'etag-1',
    htmlLink: null,
    calendarId: CAL_A,
    calendarName: CAL_A,
    ...overrides,
  };
}

function recurringEvent(calendarId: string, startIso: string): GoogleEventPreviewItem {
  return previewEvent({
    id: 'series-shared',
    calendarId,
    calendarName: calendarId,
    recurringEventId: 'series-shared',
    originalStartTime: {
      dateTime: startIso,
      date: null,
      timeZone: null,
      allDay: false,
    },
    start: { dateTime: startIso, date: null, timeZone: null, allDay: false },
    end: {
      dateTime: new Date(Date.parse(startIso) + 3600_000).toISOString(),
      date: null,
      timeZone: null,
      allDay: false,
    },
  });
}

function makeCredentialRow(extra: Record<string, unknown> = {}) {
  const enc = encryptCalendarCredential(
    serializeGoogleCalendarCredentialBlob({
      refresh_token: 'rt-secret',
      scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
      token_type: 'Bearer',
    }),
  );
  return {
    id: 'conn-1',
    salon_id: SALON,
    credential_ciphertext: enc.ciphertext,
    credential_iv: enc.iv,
    credential_auth_tag: enc.authTag,
    status: 'connected',
    selected_calendar_id: CAL_A,
    selected_calendar_name: CAL_A,
    provider_config: {
      [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      [GOOGLE_SELECTED_CALENDARS_CONFIG_KEY]: [
        { id: CAL_A, summary: CAL_A },
        { id: CAL_B, summary: 'SetTime' },
      ],
    },
    ...extra,
  };
}

function syncDb(opts: {
  conn?: Record<string, unknown>;
  imported?: Array<Record<string, unknown>>;
  appointments?: Array<Record<string, unknown>>;
  issues?: any[];
  clients?: Array<{ id: string; name: string; phone: string; notes?: string; salon_id?: string }>;
} = {}) {
  const conn = opts.conn ?? makeCredentialRow();
  const importedLinkRows = opts.imported ?? [];
  const appointments = opts.appointments ?? [];
  const issues = opts.issues ?? [];
  const clients = opts.clients ?? [];
  let issueSeq = issues.length + 1;
  let clientSeq = clients.length + 1;
  return {
    conn,
    importedLinkRows,
    appointments,
    issues,
    clients,
    from(table: string) {
      if (table === 'calendar_connections') {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              maybeSingle: async () => ({ data: conn, error: null }),
            };
            return chain;
          },
        };
      }
      if (table === 'staff') {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              maybeSingle: async () => ({
                data: { id: STAFF, name: 'Tatev Mikaelyan' },
                error: null,
              }),
              then: async (resolve: any) =>
                resolve({
                  data: [
                    { id: STAFF, name: 'Tatev Mikaelyan' },
                    { id: 'staff-maya', name: 'Maya Avetisyan' },
                  ],
                  error: null,
                }),
            };
            return chain;
          },
        };
      }
      if (table === 'clients') {
        return {
          select() {
            const chain: any = {
              eq(col: string, val: string) {
                chain._eq = { col, val };
                return chain;
              },
              is() {
                return chain;
              },
              then: async (resolve: any) => {
                const filtered =
                  chain._eq?.col === 'salon_id'
                    ? clients.filter((c) => (c.salon_id || SALON) === chain._eq.val)
                    : clients;
                return resolve({ data: filtered, error: null });
              },
            };
            return chain;
          },
          insert(row: any) {
            assert.equal(row.salon_id, SALON);
            const created = {
              id: row.id || `c-${clientSeq++}`,
              name: row.name,
              phone: row.phone || '',
              notes: row.notes || '',
              salon_id: row.salon_id,
            };
            clients.push(created);
            return {
              select() {
                return { single: async () => ({ data: { id: created.id }, error: null }) };
              },
              then: async (resolve: any) => resolve({ data: created, error: null }),
            };
          },
        };
      }
      if (table === 'calendar_import_issues') {
        return {
          select() {
            const filters: Record<string, string> = {};
            const chain: any = {
              eq(col: string, val: string) {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => ({
                data:
                  issues.find((r) =>
                    Object.entries(filters).every(([k, v]) => String(r[k] ?? '') === String(v)),
                  ) ?? null,
                error: null,
              }),
              then: async (resolve: any) =>
                resolve({
                  data: issues.filter((r) =>
                    Object.entries(filters).every(([k, v]) => String(r[k] ?? '') === String(v)),
                  ),
                  error: null,
                }),
            };
            return chain;
          },
          insert(row: any) {
            issues.push({
              id: `issue-${issueSeq++}`,
              ...row,
              recurrence_id: row.recurrence_id || '',
              status: row.status || 'open',
            });
            return { then: async (resolve: any) => resolve({ error: null }) };
          },
          update(payload: any) {
            const filters: Record<string, string> = {};
            const chain: any = {
              eq(col: string, val: string) {
                filters[col] = val;
                return chain;
              },
              then: async (resolve: any) => {
                for (const row of issues) {
                  const match = Object.entries(filters).every(
                    ([k, v]) => String(row[k] ?? '') === String(v),
                  );
                  if (match) Object.assign(row, payload);
                }
                return resolve({ error: null });
              },
              or() {
                return chain;
              },
            };
            return chain;
          },
        };
      }
      if (table === 'appointment_external_links') {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => resolve({ data: importedLinkRows, error: null }),
            };
            return chain;
          },
          update() {
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => resolve({ error: null }),
            };
            return chain;
          },
        };
      }
      if (table === 'appointments') {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => resolve({ data: appointments, error: null }),
            };
            return chain;
          },
          update() {
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => resolve({ error: null }),
            };
            return chain;
          },
        };
      }
      return {
        select() {
          return {
            eq() {
              return { then: async (resolve: any) => resolve({ data: [], error: null }) };
            },
          };
        },
      };
    },
  };
}

function googleFetch(pagesByCalendar: Record<string, Array<Record<string, unknown>>>): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
        status: 200,
      });
    }
    const encoded = url.split('/calendars/')[1]?.split('/events')[0] ?? '';
    const calendarId = decodeURIComponent(encoded);
    const items = pagesByCalendar[calendarId] ?? [];
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
}

function timedRaw(
  id: string,
  startLocal: string,
  endLocal: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    summary: TITLE,
    status: 'confirmed',
    start: { dateTime: `${startLocal}+04:00` },
    end: { dateTime: `${endLocal}+04:00` },
    ...extra,
  };
}

describe('GOOGLE MULTI-CALENDAR DB identity + manual sync', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', 'test-google-client-secret');
    setEnv(
      'GOOGLE_CALENDAR_REDIRECT_URI',
      'https://app.example.com/api/calendar/google/callback',
    );
    setEnv('CALENDAR_CREDENTIALS_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
  });
  after(() => {
    for (const [k, v] of Object.entries(PREV_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('A. legacy single-calendar link survives (unscoped row still matches primary event)', async () => {
    const stored = googleStoredOccurrenceKeys({
      calendarId: '',
      eventId: 'abc',
    });
    assert.deepEqual(stored, ['abc']);
    assert.equal(stored.includes('abc'), true);
    const lookup = googleOccurrenceLookupKeys(previewEvent({ id: 'abc', calendarId: CAL_A }));
    assert.ok(lookup.includes(`${CAL_A}:abc`));
    assert.ok(lookup.includes('abc'));
    const db = syncDb({
      imported: [
        {
          appointment_id: 'appt-legacy',
          external_uid: 'abc',
          recurrence_id: '',
          external_calendar_id: '',
        },
      ],
      appointments: [
        {
          id: 'appt-legacy',
          date: '2026-08-21',
          start_time: '08:00:00',
          end_time: '09:00:00',
          staff_id: STAFF,
          client_id: 'client-agunik',
          status: 'scheduled',
        },
      ],
    });
    const index = await loadGoogleImportedOccurrenceIndex({
      db,
      salonId: SALON,
      calendarConnectionId: 'conn-1',
    });
    const found = findImportedOccurrenceRecord(previewEvent({ id: 'abc', calendarId: CAL_A }), index);
    assert.equal(found?.appointmentId, 'appt-legacy');
  });

  it('B. same eventId in two calendars remains distinct', () => {
    const a = previewEvent({ id: 'abc', calendarId: CAL_A });
    const b = previewEvent({ id: 'abc', calendarId: CAL_B });
    const storedA = googleStoredOccurrenceKeys({ calendarId: CAL_A, eventId: 'abc' });
    const storedB = googleStoredOccurrenceKeys({ calendarId: CAL_B, eventId: 'abc' });
    assert.deepEqual(storedA, [`${CAL_A}:abc`]);
    assert.deepEqual(storedB, [`${CAL_B}:abc`]);
    assert.equal(storedA.some((k) => storedB.includes(k)), false);
    assert.notEqual(googlePreviewItemIdentity(a), googlePreviewItemIdentity(b));
    assert.notEqual(
      buildGoogleOccurrenceKey({ calendarId: CAL_A, eventId: 'abc', recurrenceId: '' }),
      buildGoogleOccurrenceKey({ calendarId: CAL_B, eventId: 'abc', recurrenceId: '' }),
    );
    const rememberedA = googleRememberedOccurrenceKeys(a);
    assert.equal(rememberedA.includes('abc'), false);
    assert.equal(googleOccurrenceLookupKeys(b).some((k) => rememberedA.includes(k)), false);
  });

  it('C. same recurrence id in two calendars remains distinct', () => {
    const start = '2026-08-23T10:00:00+04:00';
    const a = recurringEvent(CAL_A, start);
    const b = recurringEvent(CAL_B, start);
    const rec = buildGoogleOccurrenceRecurrenceId(a);
    assert.equal(rec, start);
    const storedA = googleStoredOccurrenceKeys({
      calendarId: CAL_A,
      eventId: 'series-shared',
      recurrenceId: rec,
    });
    const storedB = googleStoredOccurrenceKeys({
      calendarId: CAL_B,
      eventId: 'series-shared',
      recurrenceId: rec,
    });
    assert.equal(storedA.some((k) => storedB.includes(k)), false);
    assert.equal(googleOccurrenceLookupKeys(a).includes('series-shared'), false);
    assert.notEqual(googlePreviewItemIdentity(a), googlePreviewItemIdentity(b));
  });

  it('B2. A:eventId=abc and B:eventId=abc import as two appointments; repeat stays two', async () => {
    const a = previewEvent({ id: 'abc', calendarId: CAL_A, summary: TITLE });
    const b = previewEvent({
      id: 'abc',
      calendarId: CAL_B,
      summary: TITLE,
      start: { dateTime: '2026-08-21T11:00:00+04:00', date: null, timeZone: null, allDay: false },
      end: { dateTime: '2026-08-21T12:00:00+04:00', date: null, timeZone: null, allDay: false },
    });
    const db = syncDb();
    const imports: string[] = [];
    const executeImport = async ({
      body,
    }: {
      body: { calendarId?: string; eventId: string; staffId: string };
    }) => {
      const key = `${body.calendarId}:${body.eventId}`;
      imports.push(key);
      const appointmentId = `a-${key}`;
      if (
        !db.importedLinkRows.some(
          (row) => row.external_uid === body.eventId && row.external_calendar_id === body.calendarId,
        )
      ) {
        db.importedLinkRows.push({
          appointment_id: appointmentId,
          external_uid: body.eventId,
          recurrence_id: '',
          external_calendar_id: body.calendarId,
        });
        db.appointments.push({
          id: appointmentId,
          date: '2026-08-21',
          start_time: '08:00:00',
          end_time: '09:00:00',
          staff_id: STAFF,
          client_id: 'client-agunik',
          status: 'scheduled',
        });
      }
      return {
        appointmentId,
        clientId: 'client-agunik',
        clientCreated: false,
        alreadyImported: false,
      };
    };
    const first = await importGoogleCalendarLast30Days({
      db,
      salonId: SALON,
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: CATALOG,
      eventsOverride: [a, b],
      executeImport: executeImport as any,
    });
    assert.equal(first.scanned, 2);
    assert.deepEqual(imports, [`${CAL_A}:abc`, `${CAL_B}:abc`]);
    assert.equal(db.importedLinkRows.length, 2);
    assert.equal(db.appointments.length, 2);
    const second = await importGoogleCalendarLast30Days({
      db,
      salonId: SALON,
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: CATALOG,
      eventsOverride: [a, b],
      executeImport: executeImport as any,
    });
    assert.equal(second.scanned, 2);
    assert.equal(imports.length, 2);
    assert.equal(db.importedLinkRows.length, 2);
    assert.equal(db.appointments.length, 2);
  });

  it('D. same occurrence repeated in one calendar is one representation', async () => {
    const ev = previewEvent({ id: 'dup-one' });
    const db = syncDb();
    const imports: string[] = [];
    const result = await importGoogleCalendarLast30Days({
      db,
      salonId: SALON,
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: CATALOG,
      eventsOverride: [ev, { ...ev }],
      executeImport: async ({ body }) => {
        imports.push(`${body.calendarId}:${body.eventId}`);
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: 'client-agunik',
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(result.scanned, 1);
    assert.equal(imports.length, 1);
  });

  it('E. review issues distinguish calendars', async () => {
    const db = syncDb();
    const a = previewEvent({
      id: 'abc',
      calendarId: CAL_A,
      summary: 'Unknown service A',
    });
    const b = previewEvent({
      id: 'abc',
      calendarId: CAL_B,
      summary: 'Unknown service B',
      start: { dateTime: '2026-08-21T11:00:00+04:00', date: null, timeZone: null, allDay: false },
      end: { dateTime: '2026-08-21T12:00:00+04:00', date: null, timeZone: null, allDay: false },
    });
    assert.equal(
      await upsertGoogleCalendarReviewIssue({
        db,
        salonId: SALON,
        calendarConnectionId: 'conn-1',
        ev: a,
        reasonCode: 'service_not_matched',
        staffId: STAFF,
        staffName: 'Tatev Mikaelyan',
        salonTimeZone: 'Asia/Yerevan',
      }),
      true,
    );
    assert.equal(
      await upsertGoogleCalendarReviewIssue({
        db,
        salonId: SALON,
        calendarConnectionId: 'conn-1',
        ev: b,
        reasonCode: 'service_not_matched',
        staffId: STAFF,
        staffName: 'Tatev Mikaelyan',
        salonTimeZone: 'Asia/Yerevan',
      }),
      true,
    );
    assert.equal(db.issues.length, 2);
    assert.equal(db.issues[0].external_calendar_id, CAL_A);
    assert.equal(db.issues[1].external_calendar_id, CAL_B);
    const index = await loadGoogleReviewCoverageIndex({
      db,
      salonId: SALON,
      calendarConnectionId: 'conn-1',
    });
    const recA = findOverlayRecord(a, index);
    const recB = findOverlayRecord(b, index);
    assert.ok(recA);
    assert.ok(recB);
    assert.notEqual(recA!.issueId, recB!.issueId);
  });

  it('E2. overlay insert-failure fallback UPDATE is calendar-scoped', async () => {
    const issues: any[] = [
      {
        id: 'issue-a',
        salon_id: SALON,
        calendar_connection_id: 'conn-1',
        external_uid: 'abc',
        recurrence_id: '',
        status: 'open',
        external_calendar_id: CAL_A,
        reason_code: 'old-a',
        parsed_event: { clientId: 'client-a' },
        raw_event: { calendarId: CAL_A },
      },
      {
        id: 'issue-b',
        salon_id: SALON,
        calendar_connection_id: 'conn-1',
        external_uid: 'abc',
        recurrence_id: '',
        status: 'open',
        external_calendar_id: CAL_B,
        reason_code: 'old-b',
        parsed_event: { clientId: 'client-b' },
        raw_event: { calendarId: CAL_B },
      },
    ];
    const updateFilters: Array<Record<string, string>> = [];
    let hideRows = true;
    const db = {
      from(table: string) {
        assert.equal(table, 'calendar_import_issues');
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) =>
                resolve({ data: hideRows ? [] : issues, error: null }),
            };
            return chain;
          },
          insert() {
            return { then: async (resolve: any) => resolve({ error: { message: 'duplicate' } }) };
          },
          update(payload: any) {
            const filters: Record<string, string> = {};
            const chain: any = {
              eq(col: string, val: string) {
                filters[col] = val;
                return chain;
              },
              or() {
                return chain;
              },
              then: async (resolve: any) => {
                updateFilters.push({ ...filters });
                for (const row of issues) {
                  const match = Object.entries(filters).every(
                    ([k, v]) => String(row[k] ?? '') === String(v),
                  );
                  if (match) Object.assign(row, payload);
                }
                return resolve({ error: null });
              },
            };
            return chain;
          },
        };
      },
    };
    const ok = await upsertGoogleCalendarReviewIssue({
      db,
      salonId: SALON,
      calendarConnectionId: 'conn-1',
      ev: previewEvent({
        id: 'abc',
        calendarId: CAL_A,
        summary: 'Unknown service A',
      }),
      reasonCode: 'service_not_matched',
      staffId: STAFF,
      staffName: 'Tatev Mikaelyan',
      salonTimeZone: 'Asia/Yerevan',
    });
    assert.equal(ok, true);
    assert.equal(updateFilters.length, 1);
    assert.equal(updateFilters[0]?.external_calendar_id, CAL_A);
    assert.equal(issues[0].reason_code, 'service_not_matched');
    assert.equal(issues[1].reason_code, 'old-b');
  });

  it('E3. coverage lookup is calendar-scoped and does not use maybeSingle across calendars', async () => {
    const db = syncDb({
      issues: [
        {
          id: 'issue-a',
          salon_id: SALON,
          calendar_connection_id: 'conn-1',
          external_uid: 'abc',
          recurrence_id: '',
          status: 'open',
          external_calendar_id: CAL_A,
          parsed_event: { clientId: 'client-from-a' },
          raw_event: { calendarId: CAL_A, clientId: 'raw-a' },
        },
        {
          id: 'issue-b',
          salon_id: SALON,
          calendar_connection_id: 'conn-1',
          external_uid: 'abc',
          recurrence_id: '',
          status: 'open',
          external_calendar_id: CAL_B,
          parsed_event: { clientId: 'client-from-b' },
          raw_event: { calendarId: CAL_B, clientId: 'raw-b' },
        },
      ],
    });
    const originalFrom = db.from.bind(db);
    db.from = (table: string) => {
      const builder = originalFrom(table);
      if (table === 'calendar_import_issues' && builder.select) {
        const inner = builder.select();
        inner.maybeSingle = async () => {
          throw new Error('maybeSingle must not be used across calendars');
        };
        return { select: () => inner };
      }
      return builder;
    };
    const a = await loadRememberedGoogleCoverageClientId({
      db,
      salonId: SALON,
      calendarConnectionId: 'conn-1',
      ev: previewEvent({ id: 'abc', calendarId: CAL_A }),
    });
    const b = await loadRememberedGoogleCoverageClientId({
      db,
      salonId: SALON,
      calendarConnectionId: 'conn-1',
      ev: previewEvent({ id: 'abc', calendarId: CAL_B }),
    });
    assert.equal(a, 'client-from-a');
    assert.equal(b, 'client-from-b');
  });

  it('F/G. helper accepts selected A/B and rejects unselected C; RPC SQL matches', () => {
    const cfg = {
      [GOOGLE_SELECTED_CALENDARS_CONFIG_KEY]: [
        { id: CAL_A, summary: CAL_A },
        { id: CAL_B, summary: 'SetTime' },
      ],
    };
    assert.equal(
      isGoogleCalendarAllowedForManualImport({
        selectedCalendarId: CAL_A,
        providerConfig: cfg,
        calendarId: CAL_A,
      }),
      true,
    );
    assert.equal(
      isGoogleCalendarAllowedForManualImport({
        selectedCalendarId: CAL_A,
        providerConfig: cfg,
        calendarId: CAL_B,
      }),
      true,
    );
    assert.equal(
      isGoogleCalendarAllowedForManualImport({
        selectedCalendarId: CAL_A,
        providerConfig: cfg,
        calendarId: CAL_C,
      }),
      false,
    );
    const sql = read(MIGRATION);
    assert.match(sql, /selectedCalendars/);
    assert.match(sql, /elem->>'id'/);
    assert.match(sql, /google_calendar_not_selected/);
    assert.match(sql, /COALESCE\(external_calendar_id, ''\)/);
    assert.match(sql, /appointment_external_links_connection_calendar_uid_recurrence_unique/);
    assert.match(sql, /calendar_import_issues_open_event_unique/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS external_calendar_id/);
    assert.match(sql, /DROP INDEX IF EXISTS public\.appointments_salon_source_external_event_uidx/);
    assert.match(sql, /source IS DISTINCT FROM 'google'/);
    assert.doesNotMatch(sql, /AND a\.source_external_event_id = v_source_ext/);
    assert.doesNotMatch(sql, /DROP TABLE/);
    assert.doesNotMatch(sql, /DELETE FROM public\.appointment_external_links/);
    assert.match(sql, /c\.salon_id = p_salon_id/);
    assert.match(sql, /appointment_conflict/);
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.doesNotMatch(sql, /https:\/\/www\.googleapis\.com/);
  });

  it('F/G. executeManual import accepts B and rejects C', async () => {
    const conn = makeCredentialRow();
    const rpcCalendars: string[] = [];
    const db = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return { maybeSingle: async () => ({ data: conn, error: null }) };
                  },
                };
              },
            };
          },
        };
      },
      async rpc(_name: string, args: Record<string, unknown>) {
        rpcCalendars.push(String(args.p_external_calendar_id));
        return {
          data: {
            kind: 'ok',
            appointmentId: 'a1',
            clientId: 'client-agunik',
            clientCreated: false,
          },
          error: null,
        };
      },
    };
    const timed = {
      id: 'evt-b',
      summary: TITLE,
      status: 'confirmed',
      etag: 'e',
      updated: '2026-08-01T00:00:00.000Z',
      start: { dateTime: '2026-08-21T08:00:00+04:00' },
      end: { dateTime: '2026-08-21T09:00:00+04:00' },
    };
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes(`/calendars/${encodeURIComponent(CAL_B)}/events/`)) {
        return new Response(JSON.stringify(timed), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    await executeManualGoogleCalendarImport({
      db,
      salonId: SALON,
      salonTimeZone: 'Asia/Yerevan',
      fetchImpl,
      syncReminder: async () => {},
      body: {
        eventId: 'evt-b',
        calendarId: CAL_B,
        staffId: STAFF,
        serviceId: SERVICE,
        client: { mode: 'existing', clientId: 'client-agunik' },
      },
    });
    assert.deepEqual(rpcCalendars, [CAL_B]);
    await assert.rejects(
      () =>
        executeManualGoogleCalendarImport({
          db,
          salonId: SALON,
          salonTimeZone: 'Asia/Yerevan',
          fetchImpl,
          syncReminder: async () => {},
          body: {
            eventId: 'evt-c',
            calendarId: CAL_C,
            staffId: STAFF,
            serviceId: SERVICE,
            client: { mode: 'existing', clientId: 'client-agunik' },
          },
        }),
      (err: unknown) =>
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'google_calendar_not_selected',
    );
  });

  it('H. manual sync A=6 B=5 C=4 → scanned 15 from selected A+B+C', async () => {
    const calA = Array.from({ length: 6 }, (_, i) =>
      previewEvent({
        id: `a-${i}`,
        calendarId: CAL_A,
        start: {
          dateTime: `2026-08-21T0${i}:00:00+04:00`,
          date: null,
          timeZone: null,
          allDay: false,
        },
        end: {
          dateTime: `2026-08-21T0${i}:30:00+04:00`,
          date: null,
          timeZone: null,
          allDay: false,
        },
      }),
    );
    const calB = Array.from({ length: 5 }, (_, i) =>
      previewEvent({
        id: i === 0 ? 'abc' : `b-${i}`,
        calendarId: CAL_B,
        start: {
          dateTime: `2026-08-22T0${i}:00:00+04:00`,
          date: null,
          timeZone: null,
          allDay: false,
        },
        end: {
          dateTime: `2026-08-22T0${i}:30:00+04:00`,
          date: null,
          timeZone: null,
          allDay: false,
        },
      }),
    );
    const calC = Array.from({ length: 4 }, (_, i) =>
      previewEvent({
        id: i === 0 ? 'abc' : `c-${i}`,
        calendarId: CAL_C,
        start: {
          dateTime: `2026-08-23T0${i}:00:00+04:00`,
          date: null,
          timeZone: null,
          allDay: false,
        },
        end: {
          dateTime: `2026-08-23T0${i}:30:00+04:00`,
          date: null,
          timeZone: null,
          allDay: false,
        },
      }),
    );
    const db = syncDb({
      conn: makeCredentialRow({
        provider_config: {
          [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
          [GOOGLE_SELECTED_CALENDARS_CONFIG_KEY]: [
            { id: CAL_A, summary: CAL_A },
            { id: CAL_B, summary: 'SetTime' },
            { id: CAL_C, summary: 'C' },
          ],
        },
      }),
    });
    const listed = await importGoogleCalendarLast30Days({
      db,
      salonId: SALON,
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: CATALOG,
      eventsOverride: [...calA, ...calB, ...calC],
      executeImport: async ({ body }) => ({
        appointmentId: `a-${body.calendarId}-${body.eventId}`,
        clientId: 'client-agunik',
        clientCreated: false,
        alreadyImported: false,
      }),
    });
    assert.equal(calA.length, 6);
    assert.equal(calB.length, 5);
    assert.equal(calC.length, 4);
    assert.equal(listed.scanned, 15);
    assert.equal(
      new Set([...calA, ...calB, ...calC].map((e) => googlePreviewItemIdentity(e))).size,
      15,
    );

    const fetched = await importGoogleCalendarLast30Days({
      db: syncDb({
        conn: makeCredentialRow({
          provider_config: {
            [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
            [GOOGLE_SELECTED_CALENDARS_CONFIG_KEY]: [
              { id: CAL_A, summary: CAL_A },
              { id: CAL_B, summary: 'SetTime' },
              { id: CAL_C, summary: 'C' },
            ],
          },
        }),
      }),
      salonId: SALON,
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: CATALOG,
      fetchImpl: googleFetch({
        [CAL_A]: calA.map((e) => timedRaw(e.id, '2026-08-21T08:00:00', '2026-08-21T09:00:00')),
        [CAL_B]: calB.map((e, i) =>
          timedRaw(e.id, `2026-08-22T0${i}:00:00`, `2026-08-22T0${i}:30:00`),
        ),
        [CAL_C]: calC.map((e, i) =>
          timedRaw(e.id, `2026-08-23T0${i}:00:00`, `2026-08-23T0${i}:30:00`),
        ),
      }),
      executeImport: async ({ body }) => ({
        appointmentId: `a-${body.calendarId}-${body.eventId}`,
        clientId: 'client-agunik',
        clientCreated: false,
        alreadyImported: false,
      }),
    });
    assert.equal(fetched.scanned, 15);
  });

  it('I/J/K/L. repeat sync does not duplicate; unmatched secondary → overlay; Tatev only; salon-scoped clients', async () => {
    const safeA = previewEvent({
      id: 'abc',
      calendarId: CAL_A,
      summary: TITLE,
    });
    const unmatchedB = previewEvent({
      id: 'abc',
      calendarId: CAL_B,
      summary: 'Agunik Yeganian +380 63 202 2810 unknownservicehere',
      start: { dateTime: '2026-08-21T14:00:00+04:00', date: null, timeZone: null, allDay: false },
      end: { dateTime: '2026-08-21T15:00:00+04:00', date: null, timeZone: null, allDay: false },
    });
    const db = syncDb();
    const imports: Array<{ calendarId?: string; eventId: string; staffId: string }> = [];
    const executeImport = async ({ body }: { body: { calendarId?: string; eventId: string; staffId: string; client: { clientId?: string } } }) => {
      imports.push({ calendarId: body.calendarId, eventId: body.eventId, staffId: body.staffId });
      const appointmentId = `a-${body.calendarId}-${body.eventId}`;
      if (!db.importedLinkRows.some((row) => row.external_uid === body.eventId && row.external_calendar_id === body.calendarId)) {
        db.importedLinkRows.push({
          appointment_id: appointmentId,
          external_uid: body.eventId,
          recurrence_id: '',
          external_calendar_id: body.calendarId,
        });
        db.appointments.push({
          id: appointmentId,
          date: '2026-08-21',
          start_time: '08:00:00',
          end_time: '09:00:00',
          staff_id: STAFF,
          client_id: body.client.clientId || 'client-agunik',
          status: 'scheduled',
        });
      }
      return {
        appointmentId,
        clientId: body.client.clientId || 'client-agunik',
        clientCreated: false,
        alreadyImported: false,
      };
    };
    const first = await importGoogleCalendarLast30Days({
      db,
      salonId: SALON,
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: CATALOG.services },
      eventsOverride: [safeA, unmatchedB],
      executeImport: executeImport as any,
    });
    const overlayFirst = await listGoogleReviewCalendarItems({
      db,
      salonId: SALON,
      calendarConnectionId: 'conn-1',
    });
    assert.equal(first.scanned, 2);
    assert.equal(imports.length, 1);
    assert.equal(imports[0]?.calendarId, CAL_A);
    assert.equal(imports[0]?.staffId, STAFF);
    assert.equal(overlayFirst.length, 1);
    assert.equal(overlayFirst[0]?.eventId, 'abc');
    assert.equal(db.issues.filter((row) => row.status === 'open').length, 1);
    assert.equal(db.issues[0].external_calendar_id, CAL_B);
    assert.equal(db.clients.length, 1);
    assert.ok(db.clients.every((c) => c.salon_id === SALON));

    const second = await importGoogleCalendarLast30Days({
      db,
      salonId: SALON,
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: CATALOG.services },
      eventsOverride: [safeA, unmatchedB],
      executeImport: executeImport as any,
    });
    const overlaySecond = await listGoogleReviewCalendarItems({
      db,
      salonId: SALON,
      calendarConnectionId: 'conn-1',
    });
    assert.equal(second.scanned, 2);
    assert.equal(imports.length, 1);
    assert.equal(overlaySecond.length, 1);
    assert.equal(db.issues.filter((row) => row.status === 'open').length, 1);
    assert.equal(db.importedLinkRows.length, 1);
    assert.equal(db.clients.length, 1);
    assert.equal(imports.some((row) => /maya/i.test(row.staffId)), false);

    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.match(auto, /const calendarId = String\(conn\.selected_calendar_id/);
    assert.doesNotMatch(auto, /readSelectedGoogleCalendars/);
    assert.match(auto, /GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY/);
    assert.match(auto, /GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY/);
    const ui = read('client/src/pages/SalonIntegrations.tsx');
    assert.match(ui, /ev\.calendarName \|\| ev\.calendarId/);
    assert.match(ui, /calendarId: event\.calendarId/);
  });
});
