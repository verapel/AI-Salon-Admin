/**
 * GOOGLE FULL CALENDAR COVERAGE: now-30d through all future, appointment-or-overlay.
 * No SQL. No Google writes. No production calls.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CalendarMatchCatalog } from './calendarEventMatcher.js';
import {
  GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
} from './googleCalendarAutoImport.js';
import {
  GOOGLE_BACKFILL_LOOKBACK_DAYS,
  GOOGLE_BACKFILL_MAX_PAGES,
  GOOGLE_BACKFILL_MAX_SCAN_EVENTS,
  buildGoogleBackfillWindow,
  importGoogleCalendarLast30Days,
  isGoogleEventStartInBackfillWindow,
} from './googleCalendarBackfill.js';
import { listGoogleReviewCalendarItems } from './googleCalendarReviewOverlay.js';
import { googleSyncAccountingConsistent } from './googleCalendarSyncTerminals.js';
import { type GoogleEventPreviewItem } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const CLIENT = 'client-anna';
const NOW = new Date('2026-08-22T15:00:00.000Z');
const TZ = 'Europe/Moscow';

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-1',
    iCalUID: null,
    summary: 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома',
    description: null,
    location: null,
    status: 'confirmed',
    start: { dateTime: '2026-08-20T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    end: { dateTime: '2026-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    recurringEventId: null,
    originalStartTime: null,
    created: '2026-08-16T18:00:00.000Z',
    updated: '2026-08-16T18:00:00.000Z',
    etag: 'etag-1',
    htmlLink: null,
    calendarId: 'primary',
    calendarName: 'Salon',
    ...overrides,
  };
}

function timedAt(
  id: string,
  startIso: string,
  endIso: string,
  summary: string,
): GoogleEventPreviewItem {
  return previewEvent({
    id,
    summary,
    start: { dateTime: startIso, date: null, timeZone: 'UTC', allDay: false },
    end: { dateTime: endIso, date: null, timeZone: 'UTC', allDay: false },
    etag: `etag-${id}`,
  });
}

function coverageDb(opts: {
  imported?: Array<Record<string, unknown>>;
  appointments?: Array<Record<string, unknown>>;
  clients?: Array<{ id: string; name: string; phone: string; notes?: string }>;
  issues?: any[];
} = {}) {
  const importedLinkRows = opts.imported ?? [];
  const appointments = opts.appointments ?? [];
  const clients = opts.clients ?? [];
  const issues = opts.issues ?? [];
  let issueSeq = issues.length + 1;
  let clientSeq = clients.length + 1;
  return {
    clients,
    issues,
    importedLinkRows,
    appointments,
    from(table: string) {
      if (table === 'clients') {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              is() {
                return chain;
              },
              then: async (resolve: any) => resolve({ data: clients, error: null }),
            };
            return chain;
          },
          insert(row: any) {
            const created = {
              id: row.id || `c-${clientSeq++}`,
              name: row.name,
              phone: row.phone || '',
              notes: row.notes || '',
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
                  if (Object.entries(filters).every(([k, v]) => String(row[k] ?? '') === String(v))) {
                    Object.assign(row, payload);
                  }
                }
                return resolve({ error: null });
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
              in() {
                return chain;
              },
              maybeSingle: async () => ({ data: appointments[0] ?? null, error: null }),
              then: async (resolve: any) => resolve({ data: appointments, error: null }),
            };
            return chain;
          },
          update(payload: any) {
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => {
                for (const row of appointments) Object.assign(row, payload);
                return resolve({ error: null });
              },
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
                }),
            };
            return chain;
          },
        };
      }
      if (table === 'calendar_connections') {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              or() {
                return chain;
              },
              maybeSingle: async () => ({
                data: {
                  id: 'conn-1',
                  salon_id: 'salon-1',
                  credential_ciphertext: 'x',
                  credential_iv: 'y',
                  credential_auth_tag: 'z',
                  status: 'connected',
                  selected_calendar_id: 'primary',
                  selected_calendar_name: 'Salon',
                  provider_config: {
                    [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
                    [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: '2026-08-16T17:00:00.000Z',
                  },
                  import_enabled: true,
                },
                error: null,
              }),
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
          const chain: any = {
            eq() {
              return chain;
            },
            then: async (resolve: any) => resolve({ data: [], error: null }),
          };
          return chain;
        },
      };
    },
  };
}

const MATCHED: CalendarMatchCatalog = {
  clients: [{ id: CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
  services: [{ id: SERVICE, name: 'Окрашивание' }],
};

const EMPTY: CalendarMatchCatalog = { clients: [], services: [] };

async function runManual(params: {
  events: GoogleEventPreviewItem[];
  db?: ReturnType<typeof coverageDb>;
  catalog?: CalendarMatchCatalog;
  executeImport?: Parameters<typeof importGoogleCalendarLast30Days>[0]['executeImport'];
}) {
  const imports: string[] = [];
  const db = params.db ?? coverageDb();
  const result = await importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: TZ,
    matchCatalog: params.catalog ?? MATCHED,
    eventsOverride: params.events,
    executeImport:
      params.executeImport ??
      (async ({ body }) => {
        imports.push(body.eventId);
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: body.client.mode === 'existing' ? String(body.client.clientId) : 'new-1',
          clientCreated: body.client.mode === 'new',
          alreadyImported: false,
        };
      }),
  });
  const overlay = await listGoogleReviewCalendarItems({
    db,
    salonId: 'salon-1',
    calendarConnectionId: 'conn-1',
  });
  return { result, db, imports, overlay };
}

function assertVisibleOverlay(
  overlay: Awaited<ReturnType<typeof listGoogleReviewCalendarItems>>,
  eventId: string,
) {
  const item = overlay.find((o) => o.eventId === eventId);
  assert.ok(item, `expected overlay for ${eventId}`);
  assert.ok(item.date);
  assert.ok(item.startTime);
  assert.ok(item.endTime);
  assert.equal(item.staffId, STAFF);
  assert.notEqual(item.staffId, 'staff-maya');
}

describe('GOOGLE FULL CALENDAR COVERAGE', () => {
  it('window: 31d excluded; 30d / yesterday / today / tomorrow / +90d / +1y included; no timeMax', () => {
    const window = buildGoogleBackfillWindow(NOW);
    assert.equal(GOOGLE_BACKFILL_LOOKBACK_DAYS, 30);
    assert.equal(window.timeMax, undefined);
    assert.equal(window.timeMin, '2026-07-23T00:00:00.000Z');

    const cases: Array<[string, string, boolean]> = [
      ['31d', '2026-07-22T10:00:00.000Z', false],
      ['30d-morning', '2026-07-23T05:00:00.000Z', true],
      ['yesterday', '2026-08-21T10:00:00.000Z', true],
      ['today', '2026-08-22T05:00:00.000Z', true],
      ['tomorrow', '2026-08-23T10:00:00.000Z', true],
      ['+90d', '2026-11-20T10:00:00.000Z', true],
      ['+1y', '2027-08-22T10:00:00.000Z', true],
    ];
    for (const [, start, expected] of cases) {
      const ev = previewEvent({
        start: { dateTime: start, date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: start, date: null, timeZone: 'UTC', allDay: false },
      });
      assert.equal(isGoogleEventStartInBackfillWindow(ev, window), expected, start);
    }
  });

  it('A. 30 days ago timed event is visible', async () => {
    const ev = timedAt(
      'evt-30d',
      '2026-07-23T05:00:00.000Z',
      '2026-07-23T07:00:00.000Z',
      'Marijke +31 6 40988864',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.scanned, 1);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-30d');
    assert.ok(googleSyncAccountingConsistent(result));
  });

  it('B. today timed event is visible', async () => {
    const ev = timedAt(
      'evt-today',
      '2026-08-22T05:00:00.000Z',
      '2026-08-22T07:00:00.000Z',
      'Marijke +31 6 40988864',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.scanned, 1);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-today');
    assert.equal(overlay[0]?.date, '2026-08-22');
  });

  it('C. tomorrow timed event is visible', async () => {
    const ev = timedAt(
      'evt-tomorrow',
      '2026-08-23T08:00:00.000Z',
      '2026-08-23T09:00:00.000Z',
      'Lilit kask',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-tomorrow');
  });

  it('D. +90 days timed event is visible', async () => {
    const ev = timedAt(
      'evt-90d',
      '2026-11-20T10:00:00.000Z',
      '2026-11-20T11:00:00.000Z',
      'Future ninety',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-90d');
  });

  it('E. +1 year timed event is visible', async () => {
    const ev = timedAt(
      'evt-1y',
      '2027-08-22T10:00:00.000Z',
      '2027-08-22T11:00:00.000Z',
      'Future year',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-1y');
  });

  it('F. unmatched service → overlay', async () => {
    const ev = timedAt(
      'evt-unmatched-svc',
      '2026-08-22T08:00:00.000Z',
      '2026-08-22T09:00:00.000Z',
      'Anna +380 63 202 2810 unknown service',
    );
    const { result, overlay, imports } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(imports.length, 0);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-unmatched-svc');
  });

  it('G. no phone → overlay', async () => {
    const ev = timedAt(
      'evt-nophone',
      '2026-08-22T10:00:00.000Z',
      '2026-08-22T11:00:00.000Z',
      'Lilit kask',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-nophone');
    assert.equal(overlay[0]?.title, 'Lilit kask');
  });

  it('H. unsafe client name → overlay', async () => {
    const ev = timedAt(
      'evt-unsafe',
      '2026-08-22T12:00:00.000Z',
      '2026-08-22T13:00:00.000Z',
      '??? +31 6 40988864 окрашивание',
    );
    const { result, overlay, imports } = await runManual({ events: [ev] });
    assert.equal(imports.length, 0);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-unsafe');
  });

  it('I. stale external link → overlay', async () => {
    const db = coverageDb({
      imported: [
        {
          appointment_id: 'missing-appt',
          external_uid: 'evt-stale',
          recurrence_id: '',
          external_calendar_id: 'primary',
        },
      ],
      appointments: [],
    });
    const ev = timedAt(
      'evt-stale',
      '2026-08-22T05:00:00.000Z',
      '2026-08-22T07:00:00.000Z',
      'Marijke +31 6 40988864',
    );
    const { result, overlay } = await runManual({ db, events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.unchangedAppointment, 0);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assertVisibleOverlay(overlay, 'evt-stale');
  });

  it('J. repeated sync → no duplicate overlay or client', async () => {
    const db = coverageDb();
    const ev = timedAt(
      'evt-repeat',
      '2026-08-22T05:00:00.000Z',
      '2026-08-22T07:00:00.000Z',
      'Marijke +31 6 40988864',
    );
    const first = await runManual({ db, events: [ev], catalog: EMPTY });
    const second = await runManual({ db, events: [ev], catalog: EMPTY });
    assert.equal(first.result.terminals.newReviewOverlay, 1);
    assert.equal(second.result.terminals.newReviewOverlay, 0);
    assert.equal(second.result.terminals.unchangedReviewOverlay, 1);
    assert.equal(db.issues.length, 1);
    assert.equal(new Set(db.clients.map((c) => c.id)).size, db.clients.length);
  });

  it('K. changed overlay updates the same row', async () => {
    const db = coverageDb({
      issues: [
        {
          id: 'issue-1',
          salon_id: 'salon-1',
          calendar_connection_id: 'conn-1',
          external_uid: 'evt-ov',
          recurrence_id: '',
          status: 'open',
          external_etag: 'old-etag',
          reason_code: 'no_exact_phone',
          parsed_event: {
            title: 'Old title',
            date: '2026-08-22',
            startTime: '10:00',
            endTime: '11:00',
            durationMinutes: 60,
            staffId: STAFF,
            staffName: 'Tatev Mikaelyan',
          },
        },
      ],
    });
    const ev = timedAt(
      'evt-ov',
      '2026-08-22T12:00:00.000Z',
      '2026-08-22T14:00:00.000Z',
      'New overlay title',
    );
    ev.etag = 'new-etag';
    const { result, overlay } = await runManual({ db, events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.updatedReviewOverlay, 1);
    assert.equal(db.issues.length, 1);
    assert.equal(db.issues[0].parsed_event.title, 'New overlay title');
    assert.equal(db.issues[0].parsed_event.startTime, '15:00');
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.eventId, 'evt-ov');
  });

  it('L. changed linked appointment updates the same appointment', async () => {
    const db = coverageDb({
      imported: [
        {
          appointment_id: 'appt-1',
          external_uid: 'evt-ap',
          recurrence_id: '',
          external_calendar_id: 'primary',
          external_etag: 'old',
        },
      ],
      appointments: [
        {
          id: 'appt-1',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: CLIENT,
          date: '2026-08-22',
          start_time: '08:00',
          end_time: '10:00',
          status: 'scheduled',
        },
      ],
    });
    let importCalls = 0;
    const ev = timedAt(
      'evt-ap',
      '2026-08-22T12:00:00.000Z',
      '2026-08-22T14:00:00.000Z',
      'Agunik Yeganian +380 63 202 2810 окрашивание воде дома',
    );
    ev.etag = 'moved';
    const { result } = await runManual({
      db,
      events: [ev],
      executeImport: async () => {
        importCalls += 1;
        return {
          appointmentId: 'dup',
          clientId: CLIENT,
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(importCalls, 0);
    assert.equal(result.terminals.updatedAppointment, 1);
    assert.equal(db.appointments.length, 1);
    assert.equal(db.appointments[0].start_time, '15:00');
    assert.equal(db.appointments[0].end_time, '17:00');
  });

  it('M. all-day is excluded', async () => {
    const ev = previewEvent({
      id: 'evt-allday',
      summary: 'Birthday',
      start: { dateTime: null, date: '2026-08-22', timeZone: 'UTC', allDay: true },
      end: { dateTime: null, date: '2026-08-23', timeZone: 'UTC', allDay: true },
    });
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.excludedAllDay, 1);
    assert.equal(overlay.length, 0);
  });

  it('N. cancelled is excluded', async () => {
    const ev = timedAt(
      'evt-cancelled',
      '2026-08-22T08:00:00.000Z',
      '2026-08-22T09:00:00.000Z',
      'Cancelled timed',
    );
    ev.status = 'cancelled';
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.excludedCancelled, 1);
    assert.equal(overlay.length, 0);
  });

  it('O. invalid time is excluded', async () => {
    const ev = timedAt(
      'evt-invalid',
      '2026-08-22T12:00:00.000Z',
      '2026-08-22T11:00:00.000Z',
      'Broken time',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.excludedInvalidTime, 1);
    assert.equal(overlay.length, 0);
  });

  it('31 days ago is not required / not scanned', async () => {
    const ev = timedAt(
      'evt-31d',
      '2026-07-22T10:00:00.000Z',
      '2026-07-22T11:00:00.000Z',
      'Too old',
    );
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.scanned, 0);
    assert.equal(overlay.length, 0);
  });

  it('manual listing caps stay 20 pages / 5000; salon preview now matches that coverage', () => {
    assert.equal(GOOGLE_BACKFILL_MAX_PAGES, 20);
    assert.equal(GOOGLE_BACKFILL_MAX_SCAN_EVENTS, 5000);
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    const oauth = read('server/src/lib/googleCalendarOAuth.ts');
    const calendar = read('client/src/pages/Calendar.tsx');
    const integrations = read('client/src/pages/SalonIntegrations.tsx');
    assert.match(backfill, /No future timeMax/);
    assert.match(backfill, /listGoogleCalendarEventsForBackfill/);
    assert.match(backfill, /GOOGLE_BACKFILL_MAX_SCAN_EVENTS/);
    assert.match(oauth, /GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS = 5000/);
    assert.match(oauth, /GOOGLE_EVENTS_SALON_PREVIEW_MAX_PAGES = 20/);
    assert.match(oauth, /No future timeMax/);
    assert.match(calendar, /hoursForVisibleDays/);
    assert.match(calendar, /getGoogleReviewEvents/);
    assert.match(calendar, /navigateWeek/);
    assert.match(calendar, /navigateMonth/);
    assert.doesNotMatch(calendar, /LOOKAHEAD_DAYS|timeMax|\+ 90/);
    assert.match(integrations, /backfillScanned/);
    assert.match(integrations, /backfillNewEvents/);
    assert.match(integrations, /backfillUpdatedEvents/);
    assert.match(integrations, /backfillUnchangedEvents/);
    assert.match(integrations, /backfillReviewEvents/);
    assert.match(integrations, /backfillExcluded/);
    assert.match(integrations, /backfillFailed/);
    assert.doesNotMatch(backfill, /events\.(insert|update|patch|delete)/);
    assert.match(backfill, /isForbiddenMayaStaffName/);
  });
});
