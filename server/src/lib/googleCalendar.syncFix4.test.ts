/**
 * GOOGLE-CAL-SYNC-FIX-4: salon preview = manual window; dateTime wins over date.
 * No SQL. No Google writes. No production calls.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseExternalCalendarEvent } from './calendarEventParser.js';
import type { CalendarMatchCatalog } from './calendarEventMatcher.js';
import {
  GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
} from './googleCalendarAutoImport.js';
import { importGoogleCalendarLast30Days } from './googleCalendarBackfill.js';
import {
  isGoogleEventAllDay,
  listGoogleReviewCalendarItems,
  usableGoogleDateTime,
} from './googleCalendarReviewOverlay.js';
import { googleSyncAccountingConsistent } from './googleCalendarSyncTerminals.js';
import {
  GOOGLE_EVENTS_PREVIEW_MAX_EVENTS,
  GOOGLE_EVENTS_PREVIEW_MAX_PAGES,
  GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
  GOOGLE_EVENTS_SALON_PREVIEW_MAX_PAGES,
  buildGoogleEventsPreviewWindow,
  mapGoogleEventPreviewEntry,
  type GoogleEventPreviewItem,
} from './googleCalendarOAuth.js';

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
const MARIJKE = 'Marijke +31 6 40988864';

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

function marijkeEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return previewEvent({
    id: 'evt-marijke',
    summary: MARIJKE,
    start: {
      dateTime: '2026-08-22T05:00:00.000Z',
      date: null,
      timeZone: 'Europe/Moscow',
      allDay: false,
    },
    end: {
      dateTime: '2026-08-22T07:00:00.000Z',
      date: null,
      timeZone: 'Europe/Moscow',
      allDay: false,
    },
    etag: 'etag-marijke',
    ...overrides,
  });
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

function fix4Db(opts: {
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
  db?: ReturnType<typeof fix4Db>;
  catalog?: CalendarMatchCatalog;
}) {
  const db = params.db ?? fix4Db();
  const result = await importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: TZ,
    matchCatalog: params.catalog ?? MATCHED,
    eventsOverride: params.events,
    executeImport: async ({ body }) => ({
      appointmentId: `a-${body.eventId}`,
      clientId: body.client.mode === 'existing' ? String(body.client.clientId) : 'new-1',
      clientCreated: body.client.mode === 'new',
      alreadyImported: false,
    }),
  });
  const overlay = await listGoogleReviewCalendarItems({
    db,
    salonId: 'salon-1',
    calendarConnectionId: 'conn-1',
  });
  return { result, db, overlay };
}

describe('GOOGLE-CAL-SYNC-FIX-4 preview + all-day', () => {
  it('salon preview window matches manual: now-30d UTC day start, no timeMax', () => {
    const w = buildGoogleEventsPreviewWindow(NOW);
    assert.equal(w.timeMin, '2026-07-23T00:00:00.000Z');
    assert.equal(w.timeMax, undefined);
    assert.equal(GOOGLE_EVENTS_SALON_PREVIEW_MAX_PAGES, 20);
    assert.equal(GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS, 5000);
    assert.equal(GOOGLE_EVENTS_PREVIEW_MAX_PAGES, 10);
    assert.equal(GOOGLE_EVENTS_PREVIEW_MAX_EVENTS, 500);
    const oauth = read('server/src/lib/googleCalendarOAuth.ts');
    assert.match(oauth, /GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS/);
    assert.match(oauth, /maxEvents: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS/);
    assert.doesNotMatch(
      oauth.slice(oauth.indexOf('export function buildGoogleEventsPreviewWindow')),
      /LOOKAHEAD_DAYS/,
    );
  });

  it('Marijke-shaped timed event is not all-day', () => {
    const ev = marijkeEvent();
    assert.equal(usableGoogleDateTime(ev.start.dateTime), true);
    assert.equal(usableGoogleDateTime(ev.end.dateTime), true);
    assert.equal(isGoogleEventAllDay(ev), false);
    const parsed = parseExternalCalendarEvent(
      {
        summary: ev.summary,
        description: ev.description,
        status: ev.status,
        start: ev.start,
        end: ev.end,
      },
      TZ,
    );
    assert.equal(parsed.classification.includes('all_day'), false);
  });

  it('date leftover / allDay flag cannot hide usable dateTime', () => {
    const raw = mapGoogleEventPreviewEntry(
      {
        id: 'evt-mixed',
        summary: MARIJKE,
        status: 'confirmed',
        start: {
          dateTime: '2026-08-22T05:00:00.000Z',
          date: '2026-08-22',
          timeZone: 'Europe/Moscow',
        },
        end: {
          dateTime: '2026-08-22T07:00:00.000Z',
          date: '2026-08-22',
          timeZone: 'Europe/Moscow',
        },
      },
      'primary',
      'Salon',
    );
    assert.ok(raw);
    assert.equal(raw.start.date, '2026-08-22');
    assert.equal(isGoogleEventAllDay(raw), false);

    const flagged = marijkeEvent({
      start: {
        dateTime: '2026-08-22T05:00:00.000Z',
        date: '2026-08-22',
        timeZone: 'Europe/Moscow',
        allDay: true,
      },
      end: {
        dateTime: '2026-08-22T07:00:00.000Z',
        date: '2026-08-22',
        timeZone: 'Europe/Moscow',
        allDay: true,
      },
    });
    assert.equal(isGoogleEventAllDay(flagged), false);
    const parsed = parseExternalCalendarEvent(
      {
        summary: flagged.summary,
        description: null,
        status: 'confirmed',
        start: flagged.start,
        end: flagged.end,
      },
      TZ,
    );
    assert.equal(parsed.classification.includes('all_day'), false);
  });

  it('genuine date-only event remains all-day', () => {
    const ev = previewEvent({
      id: 'evt-allday',
      summary: 'Birthday',
      start: { dateTime: null, date: '2026-08-22', timeZone: 'UTC', allDay: true },
      end: { dateTime: null, date: '2026-08-23', timeZone: 'UTC', allDay: true },
    });
    assert.equal(isGoogleEventAllDay(ev), true);
  });

  it('Marijke Aug 22 becomes visible overlay, not excludedAllDay', async () => {
    const { result, overlay } = await runManual({
      events: [marijkeEvent()],
      catalog: EMPTY,
    });
    assert.equal(isGoogleEventAllDay(marijkeEvent()), false);
    assert.equal(result.scanned, 1);
    assert.equal(result.terminals.excludedAllDay, 0);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.date, '2026-08-22');
    assert.equal(overlay[0]?.startTime, '08:00');
    assert.equal(overlay[0]?.endTime, '10:00');
    assert.equal(overlay[0]?.title, MARIJKE);
    assert.equal(overlay[0]?.staffId, STAFF);
    assert.ok(googleSyncAccountingConsistent(result));
  });

  it('false all-day normalization is reconsidered on next sync', async () => {
    const ev = mapGoogleEventPreviewEntry(
      {
        id: 'evt-reconsider',
        summary: MARIJKE,
        status: 'confirmed',
        start: {
          dateTime: '2026-08-22T05:00:00.000Z',
          date: '2026-08-22',
          timeZone: 'Europe/Moscow',
        },
        end: {
          dateTime: '2026-08-22T07:00:00.000Z',
          date: '2026-08-22',
          timeZone: 'Europe/Moscow',
        },
      },
      'primary',
      'Salon',
    );
    assert.ok(ev);
    const { result, overlay } = await runManual({ events: [ev], catalog: EMPTY });
    assert.equal(result.terminals.excludedAllDay, 0);
    assert.equal(result.terminals.newReviewOverlay, 1);
    assert.equal(overlay[0]?.date, '2026-08-22');
  });

  it('mixed coverage batch: every valid timed event is appointment or overlay', async () => {
    const events: GoogleEventPreviewItem[] = [
      timedAt('evt-30d', '2026-07-23T05:00:00.000Z', '2026-07-23T07:00:00.000Z', 'Thirty days'),
      timedAt('evt-today', '2026-08-22T10:00:00.000Z', '2026-08-22T11:00:00.000Z', 'Today timed'),
      marijkeEvent(),
      timedAt(
        'evt-lilit',
        '2026-08-22T08:00:00.000Z',
        '2026-08-22T09:00:00.000Z',
        'Lilit kask',
      ),
      timedAt('evt-90d', '2026-11-20T10:00:00.000Z', '2026-11-20T11:00:00.000Z', 'Plus ninety'),
      timedAt('evt-1y', '2027-08-22T10:00:00.000Z', '2027-08-22T11:00:00.000Z', 'Plus year'),
      timedAt('evt-nophone', '2026-08-21T10:00:00.000Z', '2026-08-21T11:00:00.000Z', 'No phone person'),
      timedAt(
        'evt-unmatched',
        '2026-08-21T12:00:00.000Z',
        '2026-08-21T13:00:00.000Z',
        'Anna +380 63 202 2810 unknown service',
      ),
      previewEvent({
        id: 'evt-allday',
        summary: 'Birthday',
        start: { dateTime: null, date: '2026-08-22', timeZone: 'UTC', allDay: true },
        end: { dateTime: null, date: '2026-08-23', timeZone: 'UTC', allDay: true },
      }),
      timedAt(
        'evt-cancelled',
        '2026-08-22T14:00:00.000Z',
        '2026-08-22T15:00:00.000Z',
        'Cancelled timed',
      ),
    ];
    events[events.length - 1]!.status = 'cancelled';

    const { result, overlay, db } = await runManual({ events, catalog: EMPTY });
    assert.equal(result.scanned, events.length);
    assert.equal(result.terminals.excludedAllDay, 1);
    assert.equal(result.terminals.excludedCancelled, 1);
    assert.equal(result.terminals.excludedInvalidTime, 0);
    const timedIds = [
      'evt-30d',
      'evt-today',
      'evt-marijke',
      'evt-lilit',
      'evt-90d',
      'evt-1y',
      'evt-nophone',
      'evt-unmatched',
    ];
    assert.equal(result.terminals.newReviewOverlay, timedIds.length);
    const overlayIds = new Set(overlay.map((o) => o.eventId));
    for (const id of timedIds) assert.ok(overlayIds.has(id), id);
    assert.equal(overlayIds.has('evt-allday'), false);
    assert.equal(overlayIds.has('evt-cancelled'), false);
    assert.equal(db.issues.filter((i: { parsed_event: { staffId: string } }) => i.parsed_event.staffId === STAFF).length, timedIds.length);
    assert.ok(googleSyncAccountingConsistent(result));
  });

  it('true date-only all-day stays excludedAllDay', async () => {
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

  it('does not change FAST-6 watermark keys or Google write methods', () => {
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    const overlay = read('server/src/lib/googleCalendarReviewOverlay.ts');
    const oauth = read('server/src/lib/googleCalendarOAuth.ts');
    assert.match(auto, /GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY/);
    assert.match(auto, /GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY/);
    assert.doesNotMatch(overlay, /events\.(insert|update|patch|delete)/);
    assert.doesNotMatch(oauth, /events\.(insert|update|patch|delete)/);
    assert.match(auto, /GOOGLE_EVENTS_PREVIEW_LOOKAHEAD_DAYS/);
  });
});
