/**
 * GOOGLE-CAL-SYNC-FIX-3: zero-loss terminals + Marijke-shaped Aug 22 coverage.
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
import { importGoogleCalendarLast30Days } from './googleCalendarBackfill.js';
import {
  googleOccurrenceLookupKeys,
} from './googleCalendarImport.js';
import {
  googleSkipReasonNeedsCalendarOverlay,
  listGoogleReviewCalendarItems,
} from './googleCalendarReviewOverlay.js';
import {
  googleImportedAppointmentIsVisible,
  googleImportedOccurrenceUnchanged,
  googleOverlayOccurrenceUnchanged,
} from './googleCalendarReconcile.js';
import { googleSyncAccountingConsistent } from './googleCalendarSyncTerminals.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const CLIENT = 'client-anna';
const NOW = new Date('2026-08-22T15:00:00.000Z');
const SAFE_TITLE = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';
const MARIJKE_TITLE = 'Marijke +31 6 40988864';

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-1',
    iCalUID: null,
    summary: SAFE_TITLE,
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

function marijkeEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return previewEvent({
    id: 'evt-marijke',
    summary: MARIJKE_TITLE,
    start: { dateTime: '2026-08-22T05:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    end: { dateTime: '2026-08-22T07:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    etag: 'etag-marijke',
    ...overrides,
  });
}

function fix3Db(opts: {
  imported?: Array<Record<string, unknown>>;
  appointments?: Array<Record<string, unknown>>;
  clients?: Array<{ id: string; name: string; phone: string; notes?: string }>;
  issues?: any[];
  failIssueWrites?: boolean;
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
            if (opts.failIssueWrites) {
              return { then: async (resolve: any) => resolve({ error: { message: 'insert failed' } }) };
            }
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
                if (opts.failIssueWrites) return resolve({ error: { message: 'update failed' } });
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

const CATALOG: CalendarMatchCatalog = {
  clients: [{ id: CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
  services: [{ id: SERVICE, name: 'Окрашивание' }],
};

const EMPTY_SERVICES: CalendarMatchCatalog = {
  clients: [],
  services: [],
};

async function runManual(params: {
  events: GoogleEventPreviewItem[];
  db?: ReturnType<typeof fix3Db>;
  catalog?: CalendarMatchCatalog;
  executeImport?: Parameters<typeof importGoogleCalendarLast30Days>[0]['executeImport'];
  salonTimeZone?: string;
}) {
  const imports: string[] = [];
  const db = params.db ?? fix3Db();
  const result = await importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: params.salonTimeZone ?? 'Europe/Moscow',
    matchCatalog: params.catalog ?? CATALOG,
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
  return { result, db, imports };
}

describe('GOOGLE-CAL-SYNC-FIX-3 zero-loss', () => {
  it('unknown skip reasons fail closed to overlay', () => {
    assert.equal(googleSkipReasonNeedsCalendarOverlay('service_not_matched'), true);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('mystery_reason'), true);
    assert.equal(googleSkipReasonNeedsCalendarOverlay(null), true);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('cancelled'), false);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('all_day'), false);
  });

  it('unchanged appointment requires a visible non-cancelled row', () => {
    assert.equal(
      googleImportedAppointmentIsVisible({
        appointmentId: '',
        etag: 'e',
        lastModified: null,
        date: '2026-08-22',
        startTime: '08:00',
        endTime: '10:00',
        staffId: STAFF,
        clientId: CLIENT,
        status: 'scheduled',
      }),
      false,
    );
    assert.equal(
      googleImportedOccurrenceUnchanged(
        marijkeEvent(),
        {
          appointmentId: 'appt-1',
          etag: 'etag-marijke',
          lastModified: null,
          date: null,
          startTime: null,
          endTime: null,
          staffId: STAFF,
          clientId: CLIENT,
          status: 'scheduled',
        },
        'Europe/Moscow',
      ),
      false,
    );
  });

  it('etag does not short-circuit an unmappable overlay snapshot', () => {
    assert.equal(
      googleOverlayOccurrenceUnchanged(
        marijkeEvent({ summary: 'Google' }),
        {
          issueId: 'issue-1',
          etag: 'etag-marijke',
          title: '',
          date: '',
          startTime: '',
          endTime: '',
          staffId: '',
          staffName: '',
          reasonCode: 'service_not_matched',
          clientId: null,
        },
        'Europe/Moscow',
      ),
      false,
    );
  });

  it('recurring occurrences do not share a bare series eventId', () => {
    const a = previewEvent({
      id: 'series-1',
      recurringEventId: 'series-1',
      originalStartTime: {
        dateTime: '2026-08-22T05:00:00.000Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
    });
    const b = previewEvent({
      id: 'series-1',
      recurringEventId: 'series-1',
      originalStartTime: {
        dateTime: '2026-08-29T05:00:00.000Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
    });
    const keysA = googleOccurrenceLookupKeys(a);
    const keysB = googleOccurrenceLookupKeys(b);
    assert.ok(keysA.every((k) => k.includes('2026-08-22')));
    assert.ok(keysB.every((k) => k.includes('2026-08-29')));
    assert.equal(keysA.some((k) => keysB.includes(k)), false);
    assert.equal(keysA.includes('series-1'), false);
  });

  it('Marijke-shaped Aug 22 unmatched event creates open overlay + client', async () => {
    const db = fix3Db();
    const { result } = await runManual({
      db,
      catalog: EMPTY_SERVICES,
      events: [marijkeEvent()],
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assert.equal(result.terminals.unchangedReviewOverlay, 0);
    assert.equal(result.newEvents, 1);
    assert.equal(result.represented, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.inconsistent, false);
    assert.equal(db.issues.length, 1);
    assert.equal(db.issues[0].status, 'open');
    assert.equal(db.issues[0].parsed_event.date, '2026-08-22');
    assert.equal(db.issues[0].parsed_event.startTime, '08:00');
    assert.equal(db.issues[0].parsed_event.endTime, '10:00');
    assert.equal(db.issues[0].parsed_event.staffId, STAFF);
    assert.equal(db.issues[0].parsed_event.title, MARIJKE_TITLE);
    assert.ok(db.clients.length >= 1);
    assert.match(String(db.clients[0].name), /Marijke/i);
    const overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].date, '2026-08-22');
  });

  it('every unmatched Aug 22 timed event creates an overlay', async () => {
    const db = fix3Db();
    const events = [
      marijkeEvent(),
      marijkeEvent({
        id: 'evt-lilit',
        summary: 'Lilit kask',
        start: { dateTime: '2026-08-22T08:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-08-22T09:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        etag: 'etag-lilit',
      }),
      marijkeEvent({
        id: 'evt-1400',
        summary: 'Walk-in 14:00',
        start: { dateTime: '2026-08-22T11:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-08-22T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        etag: 'etag-1400',
      }),
    ];
    const { result } = await runManual({ db, catalog: EMPTY_SERVICES, events });
    assert.equal(result.scanned, 3);
    assert.equal(result.terminals.newReviewOverlay, 3);
    assert.equal(db.issues.length, 3);
    assert.equal(
      new Set(db.issues.map((i: { parsed_event: { date: string } }) => i.parsed_event.date)).size,
      1,
    );
    assert.ok(googleSyncAccountingConsistent(result));
  });

  it('2283-style mixed fixture: scanned == terminals and every timed event is visible', async () => {
    const db = fix3Db({
      imported: [
        {
          appointment_id: 'appt-safe',
          external_uid: 'evt-safe-old',
          recurrence_id: '',
          external_calendar_id: 'primary',
          external_etag: 'etag-safe-old',
        },
      ],
      appointments: [
        {
          id: 'appt-safe',
          date: '2026-08-20',
          start_time: '10:00',
          end_time: '12:00',
          staff_id: STAFF,
          status: 'scheduled',
        },
      ],
      issues: [
        {
          id: 'issue-old',
          salon_id: 'salon-1',
          calendar_connection_id: 'conn-1',
          external_uid: 'evt-overlay-old',
          recurrence_id: '',
          status: 'open',
          reason_code: 'service_not_matched',
          external_etag: 'etag-old',
          parsed_event: {
            title: 'Need review coloring',
            date: '2026-08-19',
            startTime: '10:00',
            endTime: '11:00',
            staffId: STAFF,
            staffName: 'Tatev Mikaelyan',
          },
        },
      ],
    });
    const events: GoogleEventPreviewItem[] = [
      previewEvent({ id: 'evt-safe-new', created: '2026-08-21T10:00:00.000Z' }),
      previewEvent({
        id: 'evt-unmatched-1',
        summary: 'Unknown service 1',
        start: { dateTime: '2026-08-22T08:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-08-22T09:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      }),
      previewEvent({
        id: 'evt-unmatched-2',
        summary: 'Unknown service 2',
        start: { dateTime: '2026-08-22T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-08-22T11:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      }),
      previewEvent({
        id: 'evt-overlay-old',
        summary: 'Need review coloring',
        start: { dateTime: '2026-08-19T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-08-19T11:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        etag: 'etag-old',
      }),
      previewEvent({
        id: 'evt-safe-old',
        etag: 'etag-safe-old',
      }),
      previewEvent({
        id: 'evt-cancelled',
        status: 'cancelled',
        summary: 'Cancelled timed',
      }),
      previewEvent({
        id: 'evt-allday',
        summary: 'Birthday',
        start: { dateTime: null, date: '2026-08-22', timeZone: 'UTC', allDay: true },
        end: { dateTime: null, date: '2026-08-23', timeZone: 'UTC', allDay: true },
      }),
      previewEvent({
        id: 'evt-invalid',
        summary: 'Broken time',
        start: { dateTime: '2026-08-22T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-08-22T11:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      }),
    ];
    const { result } = await runManual({ db, events, salonTimeZone: 'UTC' });
    assert.equal(result.scanned, events.length);
    assert.equal(result.inconsistent, false);
    assert.ok(googleSyncAccountingConsistent(result));
    assert.equal(result.terminals.newAppointment, 1);
    assert.equal(result.terminals.newReviewOverlay, 2);
    assert.equal(result.terminals.unchangedReviewOverlay, 1);
    assert.equal(result.terminals.unchangedAppointment, 1);
    assert.equal(result.terminals.excludedCancelled, 1);
    assert.equal(result.terminals.excludedAllDay, 1);
    assert.equal(result.terminals.excludedInvalidTime, 1);
    const overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    const overlayIds = new Set(overlay.map((o) => o.eventId));
    assert.ok(overlayIds.has('evt-unmatched-1'));
    assert.ok(overlayIds.has('evt-unmatched-2'));
    assert.ok(overlayIds.has('evt-overlay-old'));
    assert.equal(overlayIds.has('evt-cancelled'), false);
    assert.equal(overlayIds.has('evt-allday'), false);
  });

  it('overlay persist failure is failed, not hidden or represented', async () => {
    const db = fix3Db({ failIssueWrites: true });
    const { result } = await runManual({
      db,
      catalog: EMPTY_SERVICES,
      events: [marijkeEvent()],
    });
    assert.equal(result.terminals.failed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.represented, 0);
    assert.equal(result.terminals.newReviewOverlay, 0);
    assert.equal(db.issues.length, 0);
    assert.ok(googleSyncAccountingConsistent(result));
  });

  it('stale imported link without appointment becomes an overlay', async () => {
    const db = fix3Db({
      imported: [
        {
          appointment_id: 'missing-appt',
          external_uid: 'evt-marijke',
          recurrence_id: '',
          external_calendar_id: 'primary',
        },
      ],
      appointments: [],
    });
    const { result } = await runManual({
      db,
      catalog: EMPTY_SERVICES,
      events: [marijkeEvent()],
    });
    assert.equal(result.terminals.unchangedAppointment, 0);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assert.equal(db.issues.length, 1);
    const overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 1);
  });

  it('repeat sync does not duplicate overlay or client', async () => {
    const db = fix3Db();
    const ev = marijkeEvent();
    const first = await runManual({ db, catalog: EMPTY_SERVICES, events: [ev] });
    const second = await runManual({ db, catalog: EMPTY_SERVICES, events: [ev] });
    assert.equal(first.result.terminals.newReviewOverlay, 1);
    assert.equal(second.result.terminals.newReviewOverlay, 0);
    assert.equal(second.result.terminals.unchangedReviewOverlay, 1);
    assert.equal(db.issues.length, 1);
    assert.equal(new Set(db.clients.map((c: { id: string }) => c.id)).size, db.clients.length);
  });

  it('recurring instances each get their own overlay', async () => {
    const db = fix3Db();
    const a = marijkeEvent({
      id: 'series-1',
      recurringEventId: 'series-1',
      originalStartTime: {
        dateTime: '2026-08-22T05:00:00.000Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
    });
    const b = marijkeEvent({
      id: 'series-1',
      recurringEventId: 'series-1',
      start: { dateTime: '2026-08-29T05:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      end: { dateTime: '2026-08-29T07:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      originalStartTime: {
        dateTime: '2026-08-29T05:00:00.000Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
      etag: 'etag-b',
    });
    const { result } = await runManual({ db, catalog: EMPTY_SERVICES, events: [a, b] });
    assert.equal(result.terminals.newReviewOverlay, 2);
    assert.equal(db.issues.length, 2);
    assert.notEqual(db.issues[0].recurrence_id, db.issues[1].recurrence_id);
  });

  it('preserves FIX-1 background job, window, and no Google writes', () => {
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    const route = read('server/src/routes/calendarConnections.ts');
    const overlay = read('server/src/lib/googleCalendarReviewOverlay.ts');
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.match(route, /status\(202\)/);
    assert.match(route, /google_backfill_already_running/);
    assert.match(backfill, /GOOGLE_BACKFILL_LOOKBACK_DAYS = 30/);
    assert.match(backfill, /No future timeMax/);
    assert.doesNotMatch(backfill, /events\.(insert|update|patch|delete)/);
    assert.doesNotMatch(overlay, /events\.(insert|update|patch|delete)/);
    assert.match(auto, /auto_import_since|GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY/);
    assert.match(auto, /GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY/);
    const integrations = read('client/src/pages/SalonIntegrations.tsx');
    assert.match(integrations, /backfillExcluded/);
    assert.match(integrations, /backfillReviewEvents/);
  });
});
