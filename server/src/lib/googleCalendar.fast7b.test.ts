/**
 * GOOGLE-CAL-FAST-7B: All valid 30-day Google events visible on the salon calendar.
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
import { listGoogleCalendarEventsForBackfill } from './googleCalendarBackfill.js';
import { buildGoogleBackfillWindow } from './googleCalendarBackfill.js';
import {
  googleSkipReasonNeedsCalendarOverlay,
  isGoogleEventEligibleForSalonCalendarDisplay,
  listGoogleReviewCalendarItems,
  mapGoogleReviewIssueToCalendarItem,
  persistGoogleReviewOrResolve,
  representedInSalonCalendar,
  resolveGoogleCalendarReviewIssue,
} from './googleCalendarReviewOverlay.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const TITLE = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';
const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const CLIENT = 'client-1';
const NOW = new Date('2026-08-16T19:00:00.000Z');
const IN_WINDOW = '2026-08-06T10:00:00.000Z';
const IN_WINDOW_END = '2026-08-06T12:00:00.000Z';

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-hist',
    iCalUID: null,
    summary: TITLE,
    description: null,
    location: null,
    status: 'confirmed',
    start: { dateTime: IN_WINDOW, date: null, timeZone: 'UTC', allDay: false },
    end: { dateTime: IN_WINDOW_END, date: null, timeZone: 'UTC', allDay: false },
    recurringEventId: null,
    originalStartTime: null,
    created: '2026-07-01T00:00:00.000Z',
    updated: '2026-07-01T00:00:00.000Z',
    etag: 'etag-1',
    htmlLink: null,
    calendarId: 'primary',
    calendarName: 'Salon',
    ...overrides,
  };
}

type IssueRow = {
  id: string;
  salon_id: string;
  calendar_connection_id: string;
  external_uid: string;
  recurrence_id: string;
  reason_code: string;
  parsed_event: unknown;
  status: string;
  resolved_appointment_id?: string | null;
};

function coverageDb(opts: {
  importedLinkRows?: Array<{
    external_uid: string;
    recurrence_id?: string;
    external_calendar_id?: string;
  }>;
  issues?: IssueRow[];
  clients?: Array<{ id: string; name: string; phone: string; notes?: string; deleted_at?: string | null }>;
} = {}) {
  const importedLinkRows = opts.importedLinkRows ?? [];
  const issues = opts.issues ?? [];
  const clients = opts.clients ?? [];
  let issueSeq = 1;
  let clientSeq = 1;

  return {
    issues,
    importedLinkRows,
    clients,
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
              id: row.id || `gclient-${clientSeq++}`,
              name: row.name,
              phone: row.phone || '',
              notes: row.notes || '',
              deleted_at: null,
            };
            clients.push(created);
            const chain: any = {
              select() {
                return {
                  single: async () => ({ data: { id: created.id }, error: null }),
                };
              },
              then: async (resolve: any) => resolve({ data: created, error: null }),
            };
            return chain;
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
                    Object.entries(filters).every(
                      ([k, v]) => String((r as any)[k] ?? '') === String(v),
                    ),
                  ) ?? null,
                error: null,
              }),
              then: async (resolve: any) =>
                resolve({
                  data: issues.filter((r) =>
                    Object.entries(filters).every(
                      ([k, v]) => String((r as any)[k] ?? '') === String(v),
                    ),
                  ),
                  error: null,
                }),
            };
            return chain;
          },
          insert(row: any) {
            issues.push({
              id: `issue-${issueSeq++}`,
              salon_id: row.salon_id,
              calendar_connection_id: row.calendar_connection_id,
              external_uid: row.external_uid,
              recurrence_id: row.recurrence_id || '',
              reason_code: row.reason_code,
              parsed_event: row.parsed_event,
              status: row.status || 'open',
              resolved_appointment_id: row.resolved_appointment_id ?? null,
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
                    ([k, v]) => String((row as any)[k] ?? '') === String(v),
                  );
                  if (match) Object.assign(row, payload);
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
                  data: [{ id: STAFF, name: 'Tatev Mikaelyan' }],
                  error: null,
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
                    [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: '2026-08-01T00:00:00.000Z',
                  },
                },
                error: null,
              }),
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

async function runCoverage(params: {
  events: GoogleEventPreviewItem[];
  catalog?: CalendarMatchCatalog;
  db?: ReturnType<typeof coverageDb>;
  executeImport?: Parameters<typeof importGoogleCalendarLast30Days>[0]['executeImport'];
}) {
  const db = params.db ?? coverageDb();
  const result = await importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: 'UTC',
    matchCatalog: params.catalog ?? {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    },
    eventsOverride: params.events,
    executeImport:
      params.executeImport ??
      (async ({ body }) => ({
        appointmentId: `a-${body.eventId}`,
        clientId: body.client.mode === 'existing' ? String(body.client.clientId) : 'new-1',
        clientCreated: body.client.mode === 'new',
        alreadyImported: false,
      })),
  });
  const overlay = await listGoogleReviewCalendarItems({
    db,
    salonId: 'salon-1',
    calendarConnectionId: 'conn-1',
  });
  return { result, overlay, db };
}

describe('GOOGLE-CAL-FAST-7B all-event calendar coverage', () => {
  it('1. safe Google event becomes a normal appointment, not an overlay', async () => {
    const { result, overlay } = await runCoverage({ events: [previewEvent()] });
    assert.equal(result.imported, 1);
    assert.equal(overlay.length, 0);
  });

  it('2. no phone stays visible as a Google review event', async () => {
    const ev = previewEvent({ id: 'no-phone', summary: 'Agunik Yeganian окрашивание' });
    const { result, overlay } = await runCoverage({ events: [ev] });
    assert.equal(result.imported, 0);
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.eventId, 'no-phone');
    assert.equal(overlay[0]?.kind, 'google_review');
    assert.match(overlay[0]?.title || '', /Agunik/);
  });

  it('3. unsafe client name stays visible', async () => {
    const ev = previewEvent({
      id: 'unsafe',
      summary: 'New Client +380 63 202 2810 окрашивание',
    });
    const { overlay } = await runCoverage({ events: [ev] });
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.reasonCode, 'unsafe_client_name');
  });

  it('4. unmatched service stays visible', async () => {
    const { overlay } = await runCoverage({
      events: [previewEvent({ id: 'unmatched' })],
      catalog: { clients: [], services: [{ id: 'cut', name: 'Стрижка' }] },
    });
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.reasonCode, 'service_not_matched');
  });

  it('5. ambiguous client stays visible', async () => {
    const { overlay } = await runCoverage({
      events: [previewEvent({ id: 'amb-client' })],
      catalog: {
        clients: [
          { id: 'c-a', name: 'A', phone: '+380632022810' },
          { id: 'c-b', name: 'B', phone: '+380632022810' },
        ],
        services: [{ id: SERVICE, name: 'Окрашивание' }],
      },
    });
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.reasonCode, 'client_ambiguous');
  });

  it('6. ambiguous service stays visible', async () => {
    const { overlay } = await runCoverage({
      events: [previewEvent({ id: 'amb-svc' })],
      catalog: {
        clients: [],
        services: [
          { id: 's1', name: 'Окрашивание' },
          { id: 's2', name: 'Окрашивание' },
        ],
      },
    });
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.reasonCode, 'service_not_matched');
  });

  it('7. imported event is appointment-only with no duplicate overlay', async () => {
    const db = coverageDb({
      importedLinkRows: [{ external_uid: 'evt-hist', external_calendar_id: 'primary' }],
    });
    const { result, overlay } = await runCoverage({
      db,
      events: [previewEvent()],
      executeImport: async () => {
        throw new Error('already imported must not re-import');
      },
    });
    assert.equal(result.alreadyImported, 1);
    assert.equal(overlay.length, 0);
  });

  it('8. unresolved event disappears from overlay after later import', async () => {
    const db = coverageDb();
    const ev = previewEvent({ id: 'later', summary: 'Agunik Yeganian окрашивание' });
    const first = await runCoverage({ db, events: [ev] });
    assert.equal(first.overlay.length, 1);
    db.importedLinkRows.push({
      external_uid: 'later',
      external_calendar_id: 'primary',
    });
    await resolveGoogleCalendarReviewIssue({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
      ev,
      appointmentId: 'a-later',
    });
    const overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 0);
  });

  it('9. 30-day action represents every valid timed Google event', async () => {
    const events = [
      previewEvent({ id: 'safe' }),
      previewEvent({ id: 'no-phone', summary: 'Only a name окрашивание' }),
      previewEvent({
        id: 'cancelled',
        status: 'cancelled',
        summary: 'Cancelled +380 63 202 2810 окрашивание',
      }),
      previewEvent({
        id: 'all-day',
        start: { dateTime: null, date: '2026-08-06', timeZone: null, allDay: true },
        end: { dateTime: null, date: '2026-08-07', timeZone: null, allDay: true },
      }),
    ];
    const { result, overlay, db } = await runCoverage({ events });
    assert.equal(result.imported, 1);
    const overlayIds = new Set(overlay.map((o) => o.eventId));
    const importedKeys = new Set(['primary:safe', 'safe']);
    assert.equal(
      representedInSalonCalendar({
        ev: events[0]!,
        importedKeys,
        overlayEventIds: overlayIds,
      }),
      true,
    );
    assert.equal(
      representedInSalonCalendar({
        ev: events[1]!,
        importedKeys: new Set(),
        overlayEventIds: overlayIds,
      }),
      true,
    );
    assert.equal(isGoogleEventEligibleForSalonCalendarDisplay(events[2]!), false);
    assert.equal(isGoogleEventEligibleForSalonCalendarDisplay(events[3]!), false);
    assert.ok(overlayIds.has('no-phone'));
    assert.equal(overlayIds.has('cancelled'), false);
    assert.equal(db.issues.filter((i) => i.status === 'open').length, 1);
  });

  it('10. >250 events pagination still works', async () => {
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            items: Array.from({ length: 250 }, (_, i) => ({
              id: `p1-${i}`,
              start: { dateTime: IN_WINDOW },
              end: { dateTime: IN_WINDOW_END },
            })),
            nextPageToken: 'p2',
          }),
          { status: 200 },
        );
      }
      assert.match(url, /pageToken=p2/);
      return new Response(
        JSON.stringify({
          items: Array.from({ length: 10 }, (_, i) => ({
            id: `p2-${i}`,
            start: { dateTime: IN_WINDOW },
            end: { dateTime: IN_WINDOW_END },
          })),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const window = buildGoogleBackfillWindow(NOW);
    const listed = await listGoogleCalendarEventsForBackfill({
      accessToken: 'at',
      calendarId: 'primary',
      timeMin: window.timeMin,
      fetchImpl,
    });
    assert.equal(listed.events.length, 260);
    assert.equal(listed.truncated, false);
    assert.equal(calls, 2);
  });

  it('11. Tatev is shown on unresolved Google events', async () => {
    const { overlay } = await runCoverage({
      events: [previewEvent({ id: 'rev', summary: 'Someone окрашивание' })],
    });
    assert.equal(overlay[0]?.staffId, STAFF);
    assert.match(overlay[0]?.staffName || '', /Tatev/i);
  });

  it('12. Maya is never auto-assigned', () => {
    const src = read('server/src/lib/googleCalendarReviewOverlay.ts');
    assert.doesNotMatch(src, /staffId:\s*['"]maya/i);
    assert.match(src, /staffId: params.staffId/);
    const calendar = read('client/src/pages/Calendar.tsx');
    assert.doesNotMatch(calendar, /Maya/);
  });

  it('13. Google writes are absent', () => {
    const overlay = read('server/src/lib/googleCalendarReviewOverlay.ts');
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    const ui = read('client/src/pages/Calendar.tsx');
    for (const src of [overlay, backfill, auto, ui]) {
      assert.doesNotMatch(src, /events\.(insert|update|patch|delete)/i);
    }
  });

  it('14. Telegram / WhatsApp / Instagram / Apple routes are unchanged by overlay writes', () => {
    const overlay = read('server/src/lib/googleCalendarReviewOverlay.ts');
    assert.doesNotMatch(overlay, /from\('telegram/i);
    assert.doesNotMatch(overlay, /from\('whatsapp/i);
    assert.doesNotMatch(overlay, /from\('instagram/i);
    assert.doesNotMatch(overlay, /from\('apple/i);
    assert.match(overlay, /calendar_import_issues/);
    const appointments = read('server/src/routes/appointments.ts');
    assert.doesNotMatch(appointments, /google\/review-events/);
    const staffPortal = read('server/src/routes/staffPortal.ts');
    assert.doesNotMatch(staffPortal, /google\/review-events/);
  });

  it('matching failures need overlay; cancelled/all-day do not', () => {
    assert.equal(googleSkipReasonNeedsCalendarOverlay('no_exact_phone'), true);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('unsafe_client_name'), true);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('cancelled'), false);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('all_day'), false);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('already_imported'), false);
    assert.equal(googleSkipReasonNeedsCalendarOverlay('before_auto_import'), false);
  });

  it('overlay item maps Google title and Tatev without fake client/service ids', () => {
    const item = mapGoogleReviewIssueToCalendarItem({
      id: 'iss-1',
      external_uid: 'evt-1',
      recurrence_id: '',
      reason_code: 'no_exact_phone',
      parsed_event: {
        title: TITLE,
        date: '2026-08-06',
        startTime: '10:00',
        endTime: '12:00',
        durationMinutes: 120,
        staffId: STAFF,
        staffName: 'Tatev Mikaelyan',
        clientCandidate: 'Agunik Yeganian',
        phoneCandidate: null,
        serviceCandidate: 'окрашивание',
      },
    });
    assert.ok(item);
    assert.equal(item?.kind, 'google_review');
    assert.equal(item?.staffId, STAFF);
    assert.equal(item?.title, TITLE);
    assert.equal(item?.clientId, null);
    assert.doesNotMatch(JSON.stringify(item), /"serviceId"/);
  });

  it('persist + list + imported-key filter removes duplicate overlay', async () => {
    const db = coverageDb();
    const ev = previewEvent({ id: 'dup', summary: 'No phone окрашивание' });
    const persisted = await persistGoogleReviewOrResolve({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
      ev,
      reasonCode: 'no_exact_phone',
      staffId: STAFF,
      staffName: 'Tatev Mikaelyan',
      salonTimeZone: 'UTC',
      importedKeys: new Set(),
    });
    assert.equal(persisted, 'overlay');
    let overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 1);
    db.importedLinkRows.push({
      external_uid: 'dup',
      external_calendar_id: 'primary',
    });
    overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 0);
  });

  it('existing unique client still imports as a real appointment', async () => {
    const { result, overlay } = await runCoverage({
      events: [previewEvent({ id: 'reuse' })],
      catalog: {
        clients: [{ id: CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
        services: [{ id: SERVICE, name: 'Окрашивание' }],
      },
    });
    assert.equal(result.imported, 1);
    assert.equal(overlay.length, 0);
  });

  it('main calendar fetches overlay; bookings/dashboard stay on appointments only', () => {
    const calendar = read('client/src/pages/Calendar.tsx');
    const bookings = read('client/src/pages/Bookings.tsx');
    const dashboard = read('client/src/pages/Dashboard.tsx');
    assert.match(calendar, /getGoogleReviewEvents/);
    assert.match(calendar, /googleNeedsReview/);
    assert.doesNotMatch(bookings, /getGoogleReviewEvents/);
    assert.doesNotMatch(dashboard, /getGoogleReviewEvents/);
    const route = read('server/src/routes/calendarConnections.ts');
    assert.match(route, /\/google\/review-events/);
  });
});
