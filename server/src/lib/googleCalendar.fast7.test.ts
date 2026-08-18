/**
 * GOOGLE-CAL-FAST-7: Manual 30-day historical backfill. Exercises real FAST-7 helpers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseExternalCalendarEvent } from './calendarEventParser.js';
import {
  matchParsedCalendarEvent,
  type CalendarMatchCatalog,
} from './calendarEventMatcher.js';
import { decideGoogleAutoImport } from './googleCalendarAutoImport.js';
import {
  GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
} from './googleCalendarAutoImport.js';
import { GoogleCalendarImportError } from './googleCalendarImport.js';
import {
  GOOGLE_BACKFILL_LOOKBACK_DAYS,
  GOOGLE_BACKFILL_MAX_PAGES,
  GOOGLE_BACKFILL_MAX_SCAN_EVENTS,
  buildGoogleBackfillWindow,
  classifyGoogleBackfillSkip,
  importGoogleCalendarLast30Days,
  isForbiddenMayaStaffName,
  isGoogleEventStartInBackfillWindow,
  listGoogleCalendarEventsForBackfill,
  resolveGoogleBackfillPilotStaff,
  selectGoogleEventsForBackfill,
} from './googleCalendarBackfill.js';
import {
  GOOGLE_EVENTS_PREVIEW_LOOKAHEAD_DAYS,
  GOOGLE_EVENTS_PREVIEW_LOOKBACK_DAYS,
  GOOGLE_EVENTS_PREVIEW_MAX_EVENTS,
  GOOGLE_EVENTS_PREVIEW_MAX_PAGES,
} from './googleCalendarOAuth.js';
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
const TOO_OLD = '2026-07-16T10:00:00.000Z';
const FUTURE = '2026-08-20T10:00:00.000Z';
const WATERMARK = '2026-08-01T00:00:00.000Z';
const PAGE_TOKEN = 'fast6-page-token';

const BASE_CATALOG: CalendarMatchCatalog = {
  clients: [],
  services: [{ id: SERVICE, name: 'Окрашивание' }],
};

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-hist',
    iCalUID: null,
    summary: TITLE,
    description: null,
    location: null,
    status: 'confirmed',
    start: {
      dateTime: IN_WINDOW,
      date: null,
      timeZone: 'UTC',
      allDay: false,
    },
    end: {
      dateTime: IN_WINDOW_END,
      date: null,
      timeZone: 'UTC',
      allDay: false,
    },
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

function backfillDb(opts: {
  connected?: boolean;
  selectedCalendarId?: string | null;
  providerConfig?: Record<string, unknown>;
  staffRows?: Array<{ id: string; name: string; active?: boolean }>;
  importedLinkRows?: Array<{
    external_uid: string;
    recurrence_id?: string;
    external_calendar_id?: string;
  }>;
  clients?: Array<{ id: string; name: string; phone: string; notes?: string }>;
} = {}) {
  const updates: Record<string, unknown>[] = [];
  const staffRows = opts.staffRows ?? [
    { id: STAFF, name: 'Tatev Mikaelyan', active: true },
  ];
  const importedLinkRows = opts.importedLinkRows ?? [];
  const clients = opts.clients ?? [];
  let clientSeq = 1;
  const cfg = opts.providerConfig ?? {
    [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
    [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: WATERMARK,
    [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: PAGE_TOKEN,
  };

  return {
    updates,
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
            };
            clients.push(created);
            return {
              select() {
                return {
                  single: async () => ({ data: { id: created.id }, error: null }),
                };
              },
              then: async (resolve: any) => resolve({ data: created, error: null }),
            };
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
            const filters: Record<string, unknown> = {};
            const chain: any = {
              eq(col: string, val: unknown) {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                const match = staffRows.find((r) => {
                  if (filters.id && r.id !== filters.id) return false;
                  if (filters.active === true && r.active === false) return false;
                  return true;
                });
                return {
                  data: match ? { id: match.id, name: match.name } : null,
                  error: null,
                };
              },
              then: async (resolve: any) =>
                resolve({
                  data: staffRows
                    .filter((r) => r.active !== false)
                    .map((r) => ({ id: r.id, name: r.name })),
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
                data:
                  opts.connected === false
                    ? null
                    : {
                        id: 'conn-1',
                        salon_id: 'salon-1',
                        credential_ciphertext: 'x',
                        credential_iv: 'y',
                        credential_auth_tag: 'z',
                        status: 'connected',
                        selected_calendar_id:
                          opts.selectedCalendarId === undefined
                            ? 'primary'
                            : opts.selectedCalendarId,
                        selected_calendar_name: 'Salon',
                        provider_config: cfg,
                      },
                error: null,
              }),
            };
            return chain;
          },
          update(payload: Record<string, unknown>) {
            updates.push(payload);
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
              return {
                eq() {
                  return { then: async (resolve: any) => resolve({ data: [], error: null }) };
                },
                then: async (resolve: any) => resolve({ data: [], error: null }),
              };
            },
          };
        },
      };
    },
  };
}

async function runBackfill(
  extra: Partial<Parameters<typeof importGoogleCalendarLast30Days>[0]> & {
    db?: ReturnType<typeof backfillDb>;
    events?: GoogleEventPreviewItem[];
    catalog?: CalendarMatchCatalog;
    executeImport?: Parameters<typeof importGoogleCalendarLast30Days>[0]['executeImport'];
  } = {},
) {
  const db = extra.db ?? backfillDb();
  return importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: 'UTC',
    matchCatalog: extra.catalog ?? BASE_CATALOG,
    eventsOverride: extra.events ?? [previewEvent()],
    executeImport:
      extra.executeImport ??
      (async ({ body }) => ({
        appointmentId: `a-${body.eventId}`,
        clientId: body.client.mode === 'existing' ? String(body.client.clientId) : 'new-1',
        clientCreated: body.client.mode === 'new',
        alreadyImported: false,
      })),
    ...extra,
  });
}

describe('GOOGLE-CAL-FAST-7 30-day backfill (executed)', () => {
  it('1. event started 10 days ago is considered', async () => {
    const window = buildGoogleBackfillWindow(NOW);
    const ev = previewEvent({ start: { dateTime: IN_WINDOW, date: null, timeZone: 'UTC', allDay: false } });
    assert.equal(isGoogleEventStartInBackfillWindow(ev, window), true);
    const imported: string[] = [];
    const result = await runBackfill({
      events: [ev],
      executeImport: async ({ body }) => {
        imported.push(body.eventId);
        return {
          appointmentId: 'a1',
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.imported, 1);
    assert.deepEqual(imported, ['evt-hist']);
  });

  it('2. event started 31 days ago is excluded', async () => {
    const window = buildGoogleBackfillWindow(NOW);
    const ev = previewEvent({
      id: 'too-old',
      start: { dateTime: TOO_OLD, date: null, timeZone: 'UTC', allDay: false },
      end: { dateTime: '2026-07-16T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    });
    assert.equal(isGoogleEventStartInBackfillWindow(ev, window), false);
    let calls = 0;
    const result = await runBackfill({
      events: [ev],
      executeImport: async () => {
        calls += 1;
        return {
          appointmentId: 'nope',
          clientId: 'c',
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(result.scanned, 0);
    assert.equal(result.imported, 0);
    assert.equal(calls, 0);
  });

  it('3. future event is included (no future timeMax)', async () => {
    const window = buildGoogleBackfillWindow(NOW);
    const ev = previewEvent({
      id: 'future',
      start: { dateTime: FUTURE, date: null, timeZone: 'UTC', allDay: false },
      end: { dateTime: '2026-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    });
    assert.equal(isGoogleEventStartInBackfillWindow(ev, window), true);
    assert.equal(window.timeMax, undefined);
    let calls = 0;
    const result = await runBackfill({
      events: [ev, previewEvent({ id: 'in-window' })],
      executeImport: async ({ body }) => {
        calls += 1;
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.equal(selectGoogleEventsForBackfill([ev], window).length, 1);
    assert.equal(result.imported, 2);
    assert.equal(calls, 2);
  });

  it('4. >250 events follows pagination', async () => {
    let calls = 0;
    const page1 = Array.from({ length: 250 }, (_, i) => ({
      id: `p1-${i}`,
      summary: `E${i}`,
      start: { dateTime: IN_WINDOW },
      end: { dateTime: IN_WINDOW_END },
    }));
    const page2 = Array.from({ length: 20 }, (_, i) => ({
      id: `p2-${i}`,
      summary: `F${i}`,
      start: { dateTime: '2026-08-07T10:00:00.000Z' },
      end: { dateTime: '2026-08-07T11:00:00.000Z' },
    }));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      assert.match(url, /singleEvents=true/);
      assert.match(url, /orderBy=startTime/);
      assert.match(url, /showDeleted=false/);
      assert.match(url, /timeMin=/);
      assert.doesNotMatch(url, /timeMax=/);
      if (calls === 1) {
        return new Response(JSON.stringify({ items: page1, nextPageToken: 'p2' }), {
          status: 200,
        });
      }
      assert.match(url, /pageToken=p2/);
      return new Response(JSON.stringify({ items: page2 }), { status: 200 });
    }) as typeof fetch;

    const listed = await listGoogleCalendarEventsForBackfill({
      accessToken: 'at',
      calendarId: 'primary',
      timeMin: buildGoogleBackfillWindow(NOW).timeMin,
      fetchImpl,
    });
    assert.equal(listed.events.length, 270);
    assert.equal(listed.truncated, false);
    assert.equal(calls, 2);
    assert.equal(GOOGLE_BACKFILL_MAX_PAGES, 20);
    assert.equal(GOOGLE_BACKFILL_MAX_SCAN_EVENTS, 5000);
  });

  it('5. scanning bound returns truncated=true', async () => {
    let pages = 0;
    const fetchImpl = (async () => {
      pages += 1;
      return new Response(
        JSON.stringify({
          items: Array.from({ length: 250 }, (_, i) => ({
            id: `cap-${pages}-${i}`,
            start: { dateTime: IN_WINDOW },
            end: { dateTime: IN_WINDOW_END },
          })),
          nextPageToken: 'more',
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const listed = await listGoogleCalendarEventsForBackfill({
      accessToken: 'at',
      calendarId: 'primary',
      timeMin: buildGoogleBackfillWindow(NOW).timeMin,
      fetchImpl,
    });
    assert.equal(listed.events.length, 5000);
    assert.equal(listed.truncated, true);
    assert.ok(pages <= GOOGLE_BACKFILL_MAX_PAGES);
    const small = await listGoogleCalendarEventsForBackfill({
      accessToken: 'at',
      calendarId: 'primary',
      timeMin: buildGoogleBackfillWindow(NOW).timeMin,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            items: Array.from({ length: 8 }, (_, i) => ({
              id: `s${i}`,
              start: { dateTime: IN_WINDOW },
              end: { dateTime: IN_WINDOW_END },
            })),
            nextPageToken: 'more',
          }),
          { status: 200 },
        )) as typeof fetch,
      maxEvents: 5,
    });
    assert.equal(small.events.length, 5);
    assert.equal(small.truncated, true);
  });

  it('6. already imported is skipped before an import attempt', async () => {
    let calls = 0;
    const result = await runBackfill({
      db: backfillDb({
        importedLinkRows: [
          { external_uid: 'evt-hist', external_calendar_id: 'primary' },
        ],
      }),
      executeImport: async () => {
        calls += 1;
        return {
          appointmentId: 'nope',
          clientId: 'c',
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.alreadyImported, 1);
    assert.equal(result.imported, 0);
    assert.equal(result.scanned, 1);
  });

  it('7. running backfill twice does not duplicate', async () => {
    const links: Array<{
      external_uid: string;
      recurrence_id?: string;
      external_calendar_id?: string;
    }> = [];
    const db = backfillDb({ importedLinkRows: links });
    const imported: string[] = [];
    const executeImport: Parameters<typeof importGoogleCalendarLast30Days>[0]['executeImport'] =
      async ({ body }) => {
        const exists = links.some((l) => l.external_uid === body.eventId);
        if (exists) {
          return {
            appointmentId: 'a-dup',
            clientId: 'c1',
            clientCreated: false,
            alreadyImported: true,
          };
        }
        imported.push(body.eventId);
        links.push({
          external_uid: body.eventId,
          external_calendar_id: 'primary',
        });
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      };
    const first = await runBackfill({ db, executeImport });
    const second = await runBackfill({ db, executeImport });
    assert.equal(first.imported, 1);
    assert.equal(second.imported, 0);
    assert.equal(second.alreadyImported, 1);
    assert.equal(imported.length, 1);
  });

  it('8. existing unique client is reused', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [{ id: CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    let client: { mode?: string; clientId?: string } = {};
    const result = await runBackfill({
      catalog,
      executeImport: async ({ body }) => {
        client = body.client;
        return {
          appointmentId: 'a1',
          clientId: CLIENT,
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(result.imported, 1);
    assert.equal(client.mode, 'existing');
    assert.equal(client.clientId, CLIENT);
  });

  it('9. safe new client is created', async () => {
    let client: { mode?: string; name?: string; clientId?: string } = {};
    const result = await runBackfill({
      executeImport: async ({ body }) => {
        client = body.client;
        return {
          appointmentId: 'a1',
          clientId: 'new-1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.equal(result.imported, 1);
    assert.equal(client.mode, 'existing');
    assert.ok(client.clientId);
    assert.equal(result.clientsCreated, 1);
  });

  it('10. no exact phone is skipped', async () => {
    let calls = 0;
    const result = await runBackfill({
      events: [previewEvent({ summary: 'Agunik Yeganian окрашивание воде дома' })],
      executeImport: async () => {
        calls += 1;
        return {
          appointmentId: 'nope',
          clientId: 'c',
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.imported, 0);
    assert.equal(result.reasons.noPhone, 1);
    assert.equal(result.skipped, 1);
  });

  it('11. unsafe client name is skipped', async () => {
    let calls = 0;
    const result = await runBackfill({
      events: [previewEvent({ summary: 'New Client +380 63 202 2810 окрашивание' })],
      executeImport: async () => {
        calls += 1;
        return {
          appointmentId: 'nope',
          clientId: 'c',
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.reasons.unsafeClientName, 1);
  });

  it('12. ambiguous client is skipped', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [
        { id: 'c-a', name: 'Agunik A', phone: '+380632022810' },
        { id: 'c-b', name: 'Agunik B', phone: '+380632022810' },
      ],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    let calls = 0;
    const result = await runBackfill({
      catalog,
      executeImport: async () => {
        calls += 1;
        return {
          appointmentId: 'nope',
          clientId: 'c',
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.reasons.clientAmbiguous, 1);
  });

  it('13. unmatched and ambiguous services are skipped', async () => {
    const unmatched = await runBackfill({
      catalog: { clients: [], services: [{ id: 'cut', name: 'Стрижка' }] },
      executeImport: async () => {
        throw new Error('should not import unmatched');
      },
    });
    assert.equal(unmatched.reasons.serviceUnmatched, 1);

    const ambiguous = await runBackfill({
      catalog: {
        clients: [],
        services: [
          { id: 's1', name: 'Окрашивание' },
          { id: 's2', name: 'Окрашивание' },
        ],
      },
      executeImport: async () => {
        throw new Error('should not import ambiguous');
      },
    });
    assert.equal(ambiguous.reasons.serviceAmbiguous, 1);
  });

  it('14. inactive service is skipped (active catalog only)', async () => {
    const matcher = read('server/src/lib/calendarEventMatcher.ts');
    assert.match(matcher, /eq\('active', true\)/);
    const result = await runBackfill({
      catalog: { clients: [], services: [] },
      executeImport: async () => {
        throw new Error('inactive must not import');
      },
    });
    assert.equal(result.reasons.serviceUnmatched, 1);
    assert.equal(result.imported, 0);
  });

  it('15. conflict is skipped', async () => {
    const result = await runBackfill({
      executeImport: async () => {
        throw new GoogleCalendarImportError('appointment_conflict', 'busy');
      },
    });
    assert.equal(result.reasons.conflict, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.imported, 0);
  });

  it('16. cancelled is skipped', async () => {
    const result = await runBackfill({
      events: [previewEvent({ status: 'cancelled' })],
      executeImport: async () => {
        throw new Error('cancelled must not import');
      },
    });
    assert.equal(result.reasons.cancelled, 1);
  });

  it('17. all-day is skipped', async () => {
    const result = await runBackfill({
      events: [
        previewEvent({
          start: { dateTime: null, date: '2026-08-06', timeZone: null, allDay: true },
          end: { dateTime: null, date: '2026-08-07', timeZone: null, allDay: true },
        }),
      ],
      executeImport: async () => {
        throw new Error('all-day must not import');
      },
    });
    assert.equal(result.reasons.allDay, 1);
  });

  it('18. Tatev is used for successful imports', async () => {
    let staffId = '';
    const result = await runBackfill({
      executeImport: async ({ body }) => {
        staffId = body.staffId;
        return {
          appointmentId: 'a1',
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.equal(result.imported, 1);
    assert.equal(staffId, STAFF);
    const resolved = await resolveGoogleBackfillPilotStaff({
      db: backfillDb(),
      salonId: 'salon-1',
      providerConfig: { [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF },
    });
    assert.equal(resolved?.id, STAFF);
    assert.match(resolved?.name || '', /Tatev/i);
  });

  it('19. Maya is never assigned', async () => {
    assert.equal(isForbiddenMayaStaffName('Maya'), true);
    assert.equal(isForbiddenMayaStaffName('Майя'), true);
    let calls = 0;
    await assert.rejects(
      () =>
        runBackfill({
          db: backfillDb({
            providerConfig: { [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: 'staff-maya' },
            staffRows: [{ id: 'staff-maya', name: 'Maya', active: true }],
          }),
          executeImport: async () => {
            calls += 1;
            return {
              appointmentId: 'nope',
              clientId: 'c',
              clientCreated: false,
              alreadyImported: false,
            };
          },
        }),
      /Tatev|staff/i,
    );
    assert.equal(calls, 0);
    const src = read('server/src/lib/googleCalendarBackfill.ts');
    assert.match(src, /isPilotTatevStaffName/);
    assert.match(src, /isForbiddenMayaStaffName/);
    assert.doesNotMatch(src, /staffId:\s*['"]maya/i);
  });

  it('20. a bad event does not abort a later good event', async () => {
    const imported: string[] = [];
    const result = await runBackfill({
      events: [
        previewEvent({ id: 'bad' }),
        previewEvent({ id: 'good' }),
      ],
      executeImport: async ({ body }) => {
        if (body.eventId === 'bad') throw new Error('boom');
        imported.push(body.eventId);
        return {
          appointmentId: 'a-good',
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.deepEqual(imported, ['good']);
    assert.equal(result.imported, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.reasons.other, 1);
  });

  it('21. Google Calendar remains read-only', () => {
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    const route = read('server/src/routes/calendarConnections.ts');
    const api = read('client/src/lib/api.ts');
    for (const src of [backfill, route, api]) {
      assert.doesNotMatch(src, /events\.(insert|update|patch|delete)/i);
    }
    assert.match(backfill, /listGoogleCalendarEventsPreview/);
    assert.match(backfill, /executeManualGoogleCalendarImport/);
    assert.doesNotMatch(backfill, /openrouter|openai/i);
  });

  it('22. FAST-6 watermark and page token stay unchanged', async () => {
    const db = backfillDb();
    await runBackfill({ db });
    assert.equal(db.updates.length, 0);
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    assert.doesNotMatch(backfill, /persistAutoImportPageToken/);
    assert.doesNotMatch(backfill, /setGoogleCalendarImportEnabled/);
    assert.doesNotMatch(backfill, /auto_import_since\s*=/);
    assert.doesNotMatch(backfill, /auto_import_page_token\s*=/);
    assert.match(backfill, /Does not write watermarks/);
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    const worker = read('server/src/lib/googleCalendarPullWorker.ts');
    assert.match(auto, /GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY/);
    assert.match(worker, /GOOGLE_CALENDAR_PULL_INTERVAL_MS/);
    assert.equal(GOOGLE_EVENTS_PREVIEW_LOOKBACK_DAYS, 30);
    assert.equal(GOOGLE_EVENTS_PREVIEW_LOOKAHEAD_DAYS, 90);
    assert.equal(GOOGLE_EVENTS_PREVIEW_MAX_PAGES, 10);
    assert.equal(GOOGLE_EVENTS_PREVIEW_MAX_EVENTS, 500);
    assert.equal(GOOGLE_BACKFILL_LOOKBACK_DAYS, 30);
  });

  it('historical created timestamps remain eligible without FAST-6 watermark', () => {
    const parsed = parseExternalCalendarEvent(
      {
        summary: TITLE,
        description: null,
        status: 'confirmed',
        start: {
          dateTime: IN_WINDOW,
          date: null,
          timeZone: 'UTC',
          allDay: false,
        },
        end: {
          dateTime: IN_WINDOW_END,
          date: null,
          timeZone: 'UTC',
          allDay: false,
        },
      },
      'UTC',
    );
    const matching = matchParsedCalendarEvent({
      parsed,
      originalTitle: TITLE,
      catalog: BASE_CATALOG,
    });
    const withoutWatermark = decideGoogleAutoImport({
      parsed,
      matching,
      eventStatus: 'confirmed',
      summary: TITLE,
      staffId: STAFF,
      alreadyImported: false,
      created: '2026-01-01T00:00:00.000Z',
      serviceNames: ['Окрашивание'],
    });
    assert.equal(withoutWatermark.action, 'import');
    const withWatermark = decideGoogleAutoImport({
      parsed,
      matching,
      eventStatus: 'confirmed',
      summary: TITLE,
      staffId: STAFF,
      alreadyImported: false,
      created: '2026-01-01T00:00:00.000Z',
      autoImportSince: WATERMARK,
      serviceNames: ['Окрашивание'],
    });
    assert.equal(withWatermark.action, 'skip');
  });

  it('maps skip reasons into the compact DTO buckets', () => {
    assert.deepEqual(classifyGoogleBackfillSkip({ decisionReason: 'no_exact_phone' }), {
      kind: 'skipped',
      reason: 'noPhone',
    });
    assert.deepEqual(
      classifyGoogleBackfillSkip({
        decisionReason: 'service_not_matched',
        serviceStatus: 'ambiguous',
      }),
      { kind: 'skipped', reason: 'serviceAmbiguous' },
    );
    assert.deepEqual(classifyGoogleBackfillSkip({ importErrorCode: 'appointment_conflict' }), {
      kind: 'skipped',
      reason: 'conflict',
    });
    assert.deepEqual(classifyGoogleBackfillSkip({ importErrorCode: 'google_event_already_imported' }), {
      kind: 'alreadyImported',
    });
  });

  it('route is authenticated salon-write and ignores browser salon/staff authority', () => {
    const route = read('server/src/routes/calendarConnections.ts');
    assert.match(
      route,
      /router\.post\('\/google\/events\/import-last-30-days', requireSalonWriteAccess/,
    );
    assert.match(route, /importGoogleCalendarLast30Days/);
    const start = route.indexOf("router.post('/google/events/import-last-30-days'");
    const end = route.indexOf("router.put('/google/import-enabled'");
    const block = route.slice(start, end);
    assert.match(block, /getSalonId\(req\)/);
    assert.doesNotMatch(block, /req\.body.*salonId/);
    assert.doesNotMatch(block, /req\.body.*staffId/);
    const ui = read('client/src/pages/SalonIntegrations.tsx');
    assert.match(ui, /backfillConfirmTitle/);
    assert.match(ui, /disabled=\{googleBackfillRunning\}/);
    assert.match(ui, /setGoogleBackfillConfirmOpen\(true\)/);
    assert.match(ui, /importGoogleLast30Days/);
    assert.match(ui, /getGoogleBackfillProgress/);
    assert.match(ui, /backfillProgressCount/);
    assert.match(ui, /googleBackfillProgress\?\.percent/);
  });

  it('reports live processed/total without changing import counts', async () => {
    const ticks: { processed: number; total: number }[] = [];
    const events = [
      previewEvent({ id: 'p1' }),
      previewEvent({ id: 'p2' }),
      previewEvent({ id: 'p3' }),
    ];
    const result = await runBackfill({
      events,
      onProgress: (progress) => ticks.push({ ...progress }),
    });
    assert.equal(result.scanned, 3);
    assert.deepEqual(ticks[0], { processed: 0, total: 3 });
    assert.equal(ticks.at(-1)?.processed, 3);
    assert.equal(ticks.at(-1)?.total, 3);
    assert.ok(ticks.some((tick) => tick.processed === 1 && tick.total === 3));
  });

  it('invalid time is skipped and Tatev abort happens before any import', async () => {
    const invalid = await runBackfill({
      events: [
        previewEvent({
          end: { dateTime: null, date: null, timeZone: null, allDay: false },
        }),
      ],
      executeImport: async () => {
        throw new Error('invalid must not import');
      },
    });
    assert.equal(invalid.reasons.invalidTime, 1);

    let calls = 0;
    await assert.rejects(
      () =>
        runBackfill({
          db: backfillDb({
            staffRows: [],
            providerConfig: {},
          }),
          executeImport: async () => {
            calls += 1;
            return {
              appointmentId: 'nope',
              clientId: 'c',
              clientCreated: false,
              alreadyImported: false,
            };
          },
        }),
      /Tatev|staff/i,
    );
    assert.equal(calls, 0);
  });
});
