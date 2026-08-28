/**
 * GOOGLE-CAL-FAST-6B: Automatic Google pull → Tatev. Executed tests of real helpers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseExternalCalendarEvent } from './calendarEventParser.js';
import {
  matchParsedCalendarEvent,
  type CalendarMatchCatalog,
} from './calendarEventMatcher.js';
import {
  classifyAutoImportCreatedAt,
  decideGoogleAutoImport,
  extractSafeAutoClientName,
  isImportedGoogleOccurrence,
  isPilotTatevStaffName,
  parseStrictEnabledFlag,
  pickGooglePullConnections,
  pullGoogleCalendarConnection,
  runGoogleCalendarPullBatch,
  selectNewGoogleEventsForAutoPull,
  setGoogleCalendarImportEnabled,
  persistAutoImportPageToken,
  mergeAutoImportPageTokenIfSameSession,
  GOOGLE_CALENDAR_PULL_INTERVAL_MS,
  GOOGLE_CALENDAR_PULL_MAX_CONNECTIONS,
  GOOGLE_CALENDAR_PULL_MAX_IMPORTS,
  GOOGLE_CALENDAR_PULL_MAX_LIST_PAGES,
  GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY,
} from './googleCalendarAutoImport.js';
import {
  applyCalendarSelectProviderConfig,
  buildGoogleCalendarEventsListUrl,
  listGoogleCalendarEventsForAutoPull,
} from './googleCalendarOAuth.js';
import {
  stopGoogleCalendarPullWorker,
  tickGoogleCalendarPullWorker,
} from './googleCalendarPullWorker.js';
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
const SINCE = '2026-08-16T17:00:00.000Z';

function parsedFor(title: string) {
  return parseExternalCalendarEvent(
    {
      summary: title,
      description: null,
      status: 'confirmed',
      start: {
        dateTime: '2026-08-20T06:00:00Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
      end: {
        dateTime: '2026-08-20T08:00:00Z',
        date: null,
        timeZone: 'UTC',
        allDay: false,
      },
    },
    'Asia/Yerevan',
  );
}

function decide(
  title: string,
  catalog: CalendarMatchCatalog,
  extra: Partial<Parameters<typeof decideGoogleAutoImport>[0]> = {},
) {
  const parsed = parsedFor(title);
  const matching = matchParsedCalendarEvent({
    parsed,
    originalTitle: title,
    catalog,
  });
  return decideGoogleAutoImport({
    parsed,
    matching,
    eventStatus: 'confirmed',
    summary: title,
    staffId: STAFF,
    alreadyImported: false,
    created: '2026-08-16T18:00:00.000Z',
    autoImportSince: SINCE,
    serviceNames: catalog.services.map((s) => s.name),
    ...extra,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-new',
    iCalUID: null,
    summary: TITLE,
    description: null,
    location: null,
    status: 'confirmed',
    start: {
      dateTime: '2026-08-20T06:00:00Z',
      date: null,
      timeZone: 'UTC',
      allDay: false,
    },
    end: {
      dateTime: '2026-08-20T08:00:00Z',
      date: null,
      timeZone: 'UTC',
      allDay: false,
    },
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

function pullDb(opts: {
  importEnabled?: boolean;
  lockBusy?: boolean;
  providerConfig?: Record<string, unknown>;
  importedLinkRows?: Array<{
    external_uid: string;
    recurrence_id?: string;
    external_calendar_id?: string;
  }>;
}) {
  const importEnabled = opts.importEnabled !== false;
  const cfg = {
    [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
    [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: SINCE,
    ...(opts.providerConfig || {}),
  };
  return {
    from(table: string) {
      if (table === 'appointment_external_links') {
        return {
          select() {
            return {
              eq() {
                const chain: any = {
                  eq() {
                    return chain;
                  },
                  then: async (resolve: any) =>
                    resolve({ data: opts.importedLinkRows ?? [], error: null }),
                };
                return chain;
              },
            };
          },
        };
      }
      if (table === 'calendar_import_issues') {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              maybeSingle: async () => ({ data: null, error: null }),
              then: async (resolve: any) => resolve({ data: [], error: null }),
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
          insert() {
            return { then: async (resolve: any) => resolve({ error: null }) };
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
              maybeSingle: async () => ({ data: null, error: null }),
              then: async (resolve: any) => resolve({ data: [], error: null }),
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
      if (table === 'staff') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          maybeSingle: async () => ({ data: { id: STAFF }, error: null }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      return {
        select(cols?: string) {
          const isList = typeof cols === 'string' && cols.includes('salon_id') && !cols.includes('credential');
          const isLock = typeof cols === 'string' && cols.includes('sync_lock_token');
          const isEnabled = cols === 'import_enabled';
          return {
            eq() {
              const chain: any = {
                eq() {
                  return chain;
                },
                or() {
                  return chain;
                },
                maybeSingle: async () => {
                  if (isLock) {
                    return {
                      data: opts.lockBusy
                        ? {
                            id: 'conn-1',
                            sync_lock_token: 'busy',
                            last_sync_started_at: new Date().toISOString(),
                          }
                        : { id: 'conn-1', sync_lock_token: null, last_sync_started_at: null },
                      error: null,
                    };
                  }
                  if (isEnabled) {
                    return { data: { import_enabled: importEnabled }, error: null };
                  }
                  return {
                    data: {
                      id: 'conn-1',
                      salon_id: 'salon-1',
                      credential_ciphertext: 'x',
                      credential_iv: 'y',
                      credential_auth_tag: 'z',
                      status: 'connected',
                      selected_calendar_id: 'primary',
                      selected_calendar_name: 'Salon',
                      provider_config: cfg,
                      import_enabled: importEnabled,
                    },
                    error: null,
                  };
                },
                then: async (resolve: any) =>
                  resolve({
                    data: isList ? [{ id: 'conn-1', salon_id: 'salon-1' }] : [],
                    error: null,
                  }),
              };
              return chain;
            },
          };
        },
        update(payload?: Record<string, unknown>) {
          const claimedToken =
            typeof payload?.sync_lock_token === 'string' ? payload.sync_lock_token : 'claimed';
          return {
            eq() {
              const chain: any = {
                eq() {
                  return chain;
                },
                or() {
                  return chain;
                },
                select() {
                  return {
                    maybeSingle: async () => ({
                      data: {
                        id: 'conn-1',
                        sync_lock_token: opts.lockBusy ? 'other' : claimedToken,
                      },
                      error: null,
                    }),
                  };
                },
              };
              return chain;
            },
          };
        },
      };
    },
  };
}

describe('GOOGLE-CAL-FAST-6B auto pull (executed)', () => {
  after(() => {
    stopGoogleCalendarPullWorker();
  });

  it('A. first enable watermark skips pre-existing created timestamps', () => {
    assert.equal(
      classifyAutoImportCreatedAt({
        created: '2026-07-20T10:00:00.000Z',
        autoImportSince: SINCE,
      }),
      'before_auto_import',
    );
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const d = decide(TITLE, catalog, { created: '2026-07-20T10:00:00.000Z' });
    assert.equal(d.action, 'skip');
    if (d.action === 'skip') assert.equal(d.reason, 'before_auto_import');
  });

  it('B. event created after enable remains eligible', () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const d = decide(TITLE, catalog);
    assert.equal(d.action, 'import');
    if (d.action === 'import') {
      assert.equal(d.staffId, STAFF);
      assert.equal(d.clientName, 'Agunik Yeganian');
    }
  });

  it('A6D. paginates past 250 updated-ascending historical rows to a later new event', async () => {
    const oldItems = Array.from({ length: 250 }, (_, i) => ({
      id: `old-${i}`,
      created: '2026-07-01T00:00:00.000Z',
      updated: '2026-08-16T17:00:00.000Z',
      status: 'confirmed',
      summary: TITLE,
      start: { dateTime: '2026-08-20T06:00:00Z' },
      end: { dateTime: '2026-08-20T08:00:00Z' },
    }));
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      const u = new URL(url);
      assert.equal(u.searchParams.get('orderBy'), 'updated');
      assert.equal(u.searchParams.get('updatedMin'), SINCE);
      assert.equal(u.searchParams.get('timeMin'), null);
      assert.equal(u.searchParams.get('timeMax'), null);
      if (!u.searchParams.get('pageToken')) {
        return jsonResponse({ items: oldItems, nextPageToken: 'page-2' });
      }
      assert.equal(u.searchParams.get('pageToken'), 'page-2');
      return jsonResponse({
        items: [
          {
            id: 'new-late',
            created: '2026-08-16T18:00:00.000Z',
            updated: '2026-08-16T18:05:00.000Z',
            status: 'confirmed',
            summary: TITLE,
            start: { dateTime: '2026-08-20T06:00:00Z' },
            end: { dateTime: '2026-08-20T08:00:00Z' },
          },
        ],
      });
    };
    const listed = await listGoogleCalendarEventsForAutoPull({
      accessToken: 'tok',
      calendarId: 'primary',
      updatedMin: SINCE,
      fetchImpl: fetchImpl as any,
      maxPages: GOOGLE_CALENDAR_PULL_MAX_LIST_PAGES,
      maxKeepEvents: 250,
      keepEvent: (ev) =>
        classifyAutoImportCreatedAt({
          created: ev.created,
          autoImportSince: SINCE,
        }) === 'new',
    });
    assert.equal(listed.scannedRaw, 251);
    assert.deepEqual(
      listed.events.map((e) => e.id),
      ['new-late'],
    );
  });

  it('C. later new events are not starved by older listed events', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const imported: string[] = [];
    const oldOnes = Array.from({ length: 40 }, (_, i) =>
      previewEvent({
        id: `old-${i}`,
        created: '2026-07-01T00:00:00.000Z',
        summary: TITLE,
      }),
    );
    const newer = previewEvent({ id: 'new-late', created: '2026-08-16T19:00:00.000Z' });
    await pullGoogleCalendarConnection({
      db: pullDb({}),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: catalog,
      salonTimeZone: 'Asia/Yerevan',
      eventsOverride: [...oldOnes, newer],
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => {
        imported.push(body.eventId);
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.ok(imported.includes('new-late'));
    assert.equal(imported.some((id) => id.startsWith('old-')), false);
    assert.deepEqual(
      selectNewGoogleEventsForAutoPull([...oldOnes, newer], SINCE).map((e) => e.id),
      ['new-late'],
    );
  });

  it('B6D. already-imported events do not consume the 20-import budget', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const events = Array.from({ length: 25 }, (_, i) =>
      previewEvent({
        id: `n-${String(i + 1).padStart(2, '0')}`,
        created: `2026-08-16T18:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const first: string[] = [];
    await pullGoogleCalendarConnection({
      db: pullDb({}),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: catalog,
      salonTimeZone: 'Asia/Yerevan',
      eventsOverride: events,
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => {
        first.push(body.eventId);
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.equal(first.length, GOOGLE_CALENDAR_PULL_MAX_IMPORTS);
    assert.deepEqual(
      first,
      events.slice(0, 20).map((e) => e.id),
    );

    const second: string[] = [];
    await pullGoogleCalendarConnection({
      db: pullDb({
        importedLinkRows: first.map((id) => ({
          external_uid: id,
          recurrence_id: '',
          external_calendar_id: 'primary',
        })),
      }),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: catalog,
      salonTimeZone: 'Asia/Yerevan',
      eventsOverride: events,
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => {
        second.push(body.eventId);
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.deepEqual(
      second,
      ['n-21', 'n-22', 'n-23', 'n-24', 'n-25'],
    );
    assert.equal(
      isImportedGoogleOccurrence(events[0]!, new Set(['primary:n-01', 'n-01'])),
      true,
    );
  });

  it('C6D. new event with start >2h in the past is still discoverable', async () => {
    const listed = await listGoogleCalendarEventsForAutoPull({
      accessToken: 'tok',
      calendarId: 'primary',
      updatedMin: SINCE,
      fetchImpl: (async () =>
        jsonResponse({
          items: [
            {
              id: 'past-start',
              created: '2026-08-16T18:00:00.000Z',
              updated: '2026-08-16T18:00:00.000Z',
              status: 'confirmed',
              summary: TITLE,
              start: { dateTime: '2026-08-16T09:00:00Z' },
              end: { dateTime: '2026-08-16T10:00:00Z' },
            },
          ],
        })) as any,
      keepEvent: (ev) =>
        classifyAutoImportCreatedAt({
          created: ev.created,
          autoImportSince: SINCE,
        }) === 'new',
    });
    assert.deepEqual(
      listed.events.map((e) => e.id),
      ['past-start'],
    );
    const url = buildGoogleCalendarEventsListUrl({
      calendarId: 'primary',
      orderBy: 'updated',
      updatedMin: SINCE,
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get('updatedMin'), SINCE);
    assert.equal(u.searchParams.get('timeMin'), null);
    assert.equal(u.searchParams.get('timeMax'), null);
  });

  it('D6D. new event >90 days in the future is still discoverable', async () => {
    const listed = await listGoogleCalendarEventsForAutoPull({
      accessToken: 'tok',
      calendarId: 'primary',
      updatedMin: SINCE,
      fetchImpl: (async () =>
        jsonResponse({
          items: [
            {
              id: 'far-future',
              created: '2026-08-16T18:00:00.000Z',
              updated: '2026-08-16T18:00:00.000Z',
              status: 'confirmed',
              summary: TITLE,
              start: { dateTime: '2026-12-20T06:00:00Z' },
              end: { dateTime: '2026-12-20T08:00:00Z' },
            },
          ],
        })) as any,
      keepEvent: (ev) =>
        classifyAutoImportCreatedAt({
          created: ev.created,
          autoImportSince: SINCE,
        }) === 'new',
    });
    assert.deepEqual(
      listed.events.map((e) => e.id),
      ['far-future'],
    );
  });

  it('F6D. events created while disabled stay excluded after re-enable watermark', async () => {
    const duringDisabled = '2026-08-16T12:00:00.000Z';
    const reenableSince = '2026-08-16T17:00:00.000Z';
    assert.equal(
      classifyAutoImportCreatedAt({
        created: duringDisabled,
        autoImportSince: reenableSince,
      }),
      'before_auto_import',
    );
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const d = decide(TITLE, catalog, {
      created: duringDisabled,
      autoImportSince: reenableSince,
    });
    assert.equal(d.action, 'skip');
    if (d.action === 'skip') assert.equal(d.reason, 'before_auto_import');
  });

  it('D. Anna coloring +374 is rejected', () => {
    const title = 'Anna coloring +37499111222';
    assert.equal(
      extractSafeAutoClientName({
        title,
        exactPhoneNormalized: '+37499111222',
        serviceNames: ['Окрашивание'],
      }),
      null,
    );
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'coloring' }],
    };
    const d = decide(title, catalog);
    assert.equal(d.action, 'skip');
    if (d.action === 'skip') assert.equal(d.reason, 'unsafe_client_name');
  });

  it('E. Armenian service-like title is rejected', () => {
    const title = 'Աննա ներկում +37499111222';
    assert.equal(
      extractSafeAutoClientName({
        title,
        exactPhoneNormalized: '+37499111222',
      }),
      null,
    );
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Ներկում' }],
    };
    const d = decide(title, catalog);
    assert.equal(d.action, 'skip');
    if (d.action === 'skip') assert.equal(d.reason, 'unsafe_client_name');
  });

  it('F. Agunik Yeganian +380 remains eligible', () => {
    assert.equal(
      extractSafeAutoClientName({
        title: TITLE,
        exactPhoneNormalized: '+380632022810',
        serviceNames: ['Окрашивание'],
        serviceCandidate: 'окрашивание',
      }),
      'Agunik Yeganian',
    );
  });

  it('G. inactive/unmatched service is not imported', () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [],
    };
    const d = decide(TITLE, catalog);
    assert.equal(d.action, 'skip');
    if (d.action === 'skip') assert.equal(d.reason, 'service_not_matched');
    const matcher = read('server/src/lib/calendarEventMatcher.ts');
    assert.match(matcher, /\.eq\('active', true\)/);
  });

  it('H. conflict does not invoke reminder (no successful import)', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    let reminder = 0;
    const result = await pullGoogleCalendarConnection({
      db: pullDb({}),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: catalog,
      salonTimeZone: 'Asia/Yerevan',
      eventsOverride: [previewEvent()],
      isStillEnabled: async () => true,
      executeImport: async () => {
        reminder += 1;
        const err = new Error('conflict') as Error & { code: string };
        err.code = 'appointment_conflict';
        throw err;
      },
    });
    assert.equal(result.imported, 0);
    assert.equal(result.conflicts, 1);
    // executeImport threw before reminder; our mock never reached success.
    assert.equal(result.skippedByReason.appointment_conflict, 1);
    assert.equal(reminder, 1);
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.doesNotMatch(auto, /syncAppointmentReminder/);
  });

  it('I. duplicate occurrence returns alreadyImported and does not count as new import', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [{ id: CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const calls: string[] = [];
    const result = await pullGoogleCalendarConnection({
      db: pullDb({}),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: catalog,
      salonTimeZone: 'Asia/Yerevan',
      eventsOverride: [previewEvent(), previewEvent({ id: 'evt-new' })],
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => {
        calls.push(body.eventId);
        return {
          appointmentId: 'a-existing',
          clientId: CLIENT,
          clientCreated: false,
          alreadyImported: true,
        };
      },
    });
    assert.equal(result.imported, 0);
    assert.ok((result.skippedByReason.already_imported || 0) >= 1);
    assert.ok(calls.length >= 1);
  });

  it('J. worker and manual path share executeManualGoogleCalendarImport / RPC', () => {
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    const manual = read('server/src/lib/googleCalendarImport.ts');
    assert.match(auto, /executeManualGoogleCalendarImport/);
    assert.match(manual, /commit_google_calendar_manual_import/);
    assert.match(manual, /already_imported|google_event_already_imported/);
  });

  it('K. disabling import stops further imports in the active batch', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    let enabled = true;
    const imported: string[] = [];
    const result = await pullGoogleCalendarConnection({
      db: pullDb({}),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: catalog,
      salonTimeZone: 'Asia/Yerevan',
      eventsOverride: [
        previewEvent({ id: 'first' }),
        previewEvent({ id: 'second' }),
        previewEvent({ id: 'third' }),
      ],
      isStillEnabled: async () => enabled,
      executeImport: async ({ body }) => {
        imported.push(body.eventId);
        enabled = false;
        return {
          appointmentId: `a-${body.eventId}`,
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.equal(imported.length, 1);
    assert.equal(imported[0], 'first');
    assert.ok((result.skippedByReason.import_disabled || 0) >= 1);
  });

  it('L. string "false" is not a boolean enable flag', () => {
    assert.equal(parseStrictEnabledFlag('false'), null);
    assert.equal(parseStrictEnabledFlag('true'), null);
    assert.equal(parseStrictEnabledFlag(true), true);
    assert.equal(parseStrictEnabledFlag(false), false);
    const route = read('server/src/routes/calendarConnections.ts');
    assert.match(route, /parseStrictEnabledFlag/);
    assert.match(route, /invalid_enabled_flag/);
    assert.doesNotMatch(route, /const enabled = Boolean\(\(req\.body/);
  });

  it('M/N. auto-import uses provided Tatev staff id; Maya names never resolve as Tatev', () => {
    assert.equal(isPilotTatevStaffName('Tatevik Mikaelyan'), true);
    assert.equal(isPilotTatevStaffName('Maya'), false);
    assert.equal(isPilotTatevStaffName('Майя'), false);
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    const d = decide(TITLE, catalog, { staffId: STAFF });
    assert.equal(d.action, 'import');
    if (d.action === 'import') assert.equal(d.staffId, STAFF);
    assert.notEqual(STAFF, 'maya');
  });

  it('O. reminder only after successful executeImport (success path counted)', async () => {
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    let success = 0;
    await pullGoogleCalendarConnection({
      db: pullDb({}),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: catalog,
      salonTimeZone: 'Asia/Yerevan',
      eventsOverride: [previewEvent()],
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => {
        assert.equal(body.staffId, STAFF);
        success += 1;
        return {
          appointmentId: 'a1',
          clientId: 'c1',
          clientCreated: true,
          alreadyImported: false,
        };
      },
    });
    assert.equal(success, 1);
    const impl = read('server/src/lib/googleCalendarImport.ts');
    const okIdx = impl.indexOf("if (kind !== 'ok')");
    const reminderCallIdx = impl.indexOf('await syncReminder(');
    assert.ok(okIdx >= 0 && reminderCallIdx > okIdx);
  });

  it('P. Google Calendar remains read-only in FAST-6 modules', () => {
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    const worker = read('server/src/lib/googleCalendarPullWorker.ts');
    assert.doesNotMatch(auto, /events\.(insert|update|patch|delete)/i);
    assert.doesNotMatch(worker, /events\.(insert|update|patch|delete)/i);
    assert.match(auto, /listGoogleCalendarEventsForAutoPull/);
  });

  it('edited old event (updated after watermark, created before) stays skipped', () => {
    assert.equal(
      classifyAutoImportCreatedAt({
        created: '2026-01-01T00:00:00.000Z',
        autoImportSince: SINCE,
      }),
      'before_auto_import',
    );
  });

  it('worker discovery uses updatedMin, not a start-time window', () => {
    const url = buildGoogleCalendarEventsListUrl({
      calendarId: 'primary',
      orderBy: 'updated',
      updatedMin: SINCE,
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get('orderBy'), 'updated');
    assert.equal(u.searchParams.get('updatedMin'), SINCE);
    assert.equal(u.searchParams.get('timeMin'), null);
    assert.equal(u.searchParams.get('timeMax'), null);
    assert.equal(GOOGLE_CALENDAR_PULL_INTERVAL_MS, 60 * 1000);
    assert.equal(GOOGLE_CALENDAR_PULL_MAX_IMPORTS, 20);
    assert.equal(GOOGLE_CALENDAR_PULL_MAX_CONNECTIONS, 10);
    assert.equal(GOOGLE_CALENDAR_PULL_MAX_LIST_PAGES, 20);
  });

  it('G6D. generic/service titles fail closed; Agunik Yeganian remains eligible', () => {
    const phone = '+37499111222';
    const rejects = [
      'New Client +37499111222',
      'Test Client +37499111222',
      'VIP Client +37499111222',
      'Hair Color +37499111222',
      'Anna Consultation +37499111222',
      'Anna Wedding +37499111222',
      'Anna coloring +37499111222',
      'Анна окрашивание +37499111222',
      'Աննա ներկում +37499111222',
    ];
    for (const title of rejects) {
      assert.equal(
        extractSafeAutoClientName({
          title,
          exactPhoneNormalized: phone,
        }),
        null,
        title,
      );
    }
    assert.equal(
      extractSafeAutoClientName({
        title: TITLE,
        exactPhoneNormalized: '+380632022810',
        serviceNames: ['Окрашивание'],
      }),
      'Agunik Yeganian',
    );
  });

  it('connection pick prefers least-recently-synced ids', () => {
    const picked = pickGooglePullConnections(
      [
        { id: 'c-new', salon_id: 's1', last_sync_at: '2026-08-16T18:00:00.000Z' },
        { id: 'c-old', salon_id: 's2', last_sync_at: '2026-08-16T10:00:00.000Z' },
        { id: 'c-never', salon_id: 's3', last_sync_at: null },
      ],
      2,
    );
    assert.deepEqual(
      picked.map((r) => r.id),
      ['c-never', 'c-old'],
    );
  });

  it('Maria / Окрашивание-only titles skip new-client auto-create', () => {
    assert.equal(
      extractSafeAutoClientName({
        title: 'Maria +380632022810 окрашивание',
        exactPhoneNormalized: '+380632022810',
      }),
      null,
    );
    assert.equal(
      extractSafeAutoClientName({
        title: 'Окрашивание +37499111222',
        exactPhoneNormalized: '+37499111222',
      }),
      null,
    );
  });

  it('import_enabled=false batch imports nothing', async () => {
    const db = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq: async () => ({ data: [], error: null }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    const batch = await runGoogleCalendarPullBatch({ db });
    assert.equal(batch.imported, 0);
    assert.equal(batch.connections, 0);
  });

  it('first enable writes auto_import_since watermark', async () => {
    let saved: Record<string, unknown> | null = null;
    const db = {
      from(table: string) {
        if (table === 'staff') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        then: async (resolve: any) =>
                          resolve({
                            data: [{ id: STAFF, name: 'Tatevik Mikaelyan' }],
                            error: null,
                          }),
                      };
                    },
                  };
                },
              };
            },
          };
        }
        return {
          select() {
            return {
              eq() {
                const chain: any = {
                  eq() {
                    return chain;
                  },
                  maybeSingle: async () => ({
                    data: {
                      id: 'conn-1',
                      status: 'connected',
                      selected_calendar_id: 'primary',
                      provider_config: {},
                      import_enabled: false,
                    },
                    error: null,
                  }),
                };
                return chain;
              },
            };
          },
          update(payload: Record<string, unknown>) {
            saved = payload;
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => resolve({ error: null }),
            };
            return chain;
          },
        };
      },
    };
    const result = await setGoogleCalendarImportEnabled({
      db,
      salonId: 'salon-1',
      enabled: true,
    });
    assert.equal(result.importEnabled, true);
    assert.equal(result.autoImportStaffId, STAFF);
    assert.ok(saved);
    assert.equal(saved.import_enabled, true);
    const cfg = saved.provider_config as Record<string, unknown>;
    assert.equal(typeof cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], 'string');
    assert.ok(Date.parse(String(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY])) > 0);
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], undefined);
  });

  function enableDb(opts: {
    importEnabled: boolean;
    providerConfig: Record<string, unknown>;
  }) {
    let saved: Record<string, unknown> | null = null;
    const db = {
      saved: () => saved,
      from(table: string) {
        if (table === 'staff') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        then: async (resolve: any) =>
                          resolve({
                            data: [{ id: STAFF, name: 'Tatevik Mikaelyan' }],
                            error: null,
                          }),
                        maybeSingle: async () => ({
                          data: { name: 'Tatevik Mikaelyan' },
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
          };
        }
        return {
          select() {
            return {
              eq() {
                const chain: any = {
                  eq() {
                    return chain;
                  },
                  maybeSingle: async () => ({
                    data: {
                      id: 'conn-1',
                      status: 'connected',
                      selected_calendar_id: 'primary',
                      provider_config: opts.providerConfig,
                      import_enabled: opts.importEnabled,
                    },
                    error: null,
                  }),
                };
                return chain;
              },
            };
          },
          update(payload: Record<string, unknown>) {
            saved = payload;
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => resolve({ error: null }),
            };
            return chain;
          },
        };
      },
    };
    return db;
  }

  function persistLiveDb(live: {
    import_enabled: boolean;
    selected_calendar_id: string;
    provider_config: Record<string, unknown>;
  }) {
    let saved: Record<string, unknown> | null = null;
    const db = {
      saved: () => saved,
      from() {
        return {
          select() {
            return {
              eq() {
                const chain: any = {
                  eq() {
                    return chain;
                  },
                  maybeSingle: async () => ({ data: { ...live }, error: null }),
                };
                return chain;
              },
            };
          },
          update(payload: Record<string, unknown>) {
            saved = payload;
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => resolve({ error: null }),
            };
            return chain;
          },
        };
      },
    };
    return db;
  }

  it('6F-A. first enable writes watermark and no page token', async () => {
    const db = enableDb({ importEnabled: false, providerConfig: {} });
    await setGoogleCalendarImportEnabled({ db, salonId: 'salon-1', enabled: true });
    const cfg = db.saved()!.provider_config as Record<string, unknown>;
    assert.equal(typeof cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], 'string');
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], undefined);
  });

  it('6F-B/G. same session persists a valid next page token', async () => {
    const live = {
      import_enabled: true,
      selected_calendar_id: 'primary',
      provider_config: {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: SINCE,
        [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      },
    };
    const db = persistLiveDb(live);
    const ok = await persistAutoImportPageToken({
      db,
      connectionId: 'conn-1',
      salonId: 'salon-1',
      expectedWatermark: SINCE,
      expectedCalendarId: 'primary',
      pageToken: 'page-2',
    });
    assert.equal(ok, true);
    const cfg = db.saved()!.provider_config as Record<string, unknown>;
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], 'page-2');
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], SINCE);
  });

  it('6F-C. disable then re-enable writes new watermark and clears old token', async () => {
    const disabled = enableDb({
      importEnabled: false,
      providerConfig: {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: '2026-08-16T10:00:00.000Z',
        [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: 'stale-token',
        [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      },
    });
    await setGoogleCalendarImportEnabled({
      db: disabled,
      salonId: 'salon-1',
      enabled: true,
    });
    const cfg = disabled.saved()!.provider_config as Record<string, unknown>;
    assert.notEqual(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], '2026-08-16T10:00:00.000Z');
    assert.ok(Date.parse(String(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY])) > Date.parse('2026-08-16T10:00:00.000Z'));
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], undefined);
  });

  it('6F-D. calendar A → B clears page token and does not enable import', () => {
    const next = applyCalendarSelectProviderConfig(
      {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: SINCE,
        [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: 'cal-a-token',
        [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      },
      { id: 'cal-b', summary: 'B' },
    );
    assert.equal(next[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], undefined);
    assert.equal(next[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], SINCE);
    assert.deepEqual(next.selectedCalendar, { id: 'cal-b', summary: 'B' });
    const selectSrc = read('server/src/lib/googleCalendarOAuth.ts');
    assert.match(selectSrc, /import_enabled: false/);
    assert.match(selectSrc, /applyCalendarSelectProviderConfig/);
  });

  it('6F-E. old worker W1 persist cannot overwrite newer W2', async () => {
    const db = persistLiveDb({
      import_enabled: true,
      selected_calendar_id: 'primary',
      provider_config: {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: '2026-08-16T17:00:00.000Z',
        [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      },
    });
    const ok = await persistAutoImportPageToken({
      db,
      connectionId: 'conn-1',
      salonId: 'salon-1',
      expectedWatermark: '2026-08-16T10:00:00.000Z',
      expectedCalendarId: 'primary',
      pageToken: 'old-w1-token',
    });
    assert.equal(ok, false);
    assert.equal(db.saved(), null);
    assert.equal(
      mergeAutoImportPageTokenIfSameSession({
        currentImportEnabled: true,
        currentCalendarId: 'primary',
        currentProviderConfig: {
          [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: '2026-08-16T17:00:00.000Z',
        },
        expectedWatermark: '2026-08-16T10:00:00.000Z',
        expectedCalendarId: 'primary',
        pageToken: 'old-w1-token',
      }),
      null,
    );
  });

  it('6F-F. old worker calendar A persist cannot overwrite calendar B', async () => {
    const db = persistLiveDb({
      import_enabled: false,
      selected_calendar_id: 'cal-b',
      provider_config: {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: SINCE,
        [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      },
    });
    const ok = await persistAutoImportPageToken({
      db,
      connectionId: 'conn-1',
      salonId: 'salon-1',
      expectedWatermark: SINCE,
      expectedCalendarId: 'cal-a',
      pageToken: 'cal-a-token',
    });
    assert.equal(ok, false);
    assert.equal(db.saved(), null);
  });

  it('6F-H. same session last page clears the stored token', async () => {
    const db = persistLiveDb({
      import_enabled: true,
      selected_calendar_id: 'primary',
      provider_config: {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: SINCE,
        [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: 'page-2',
      },
    });
    const ok = await persistAutoImportPageToken({
      db,
      connectionId: 'conn-1',
      salonId: 'salon-1',
      expectedWatermark: SINCE,
      expectedCalendarId: 'primary',
      pageToken: null,
    });
    assert.equal(ok, true);
    const cfg = db.saved()!.provider_config as Record<string, unknown>;
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], undefined);
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], SINCE);
  });

  it('6F-I. repeat enabled=true while already enabled keeps watermark and token', async () => {
    const db = enableDb({
      importEnabled: true,
      providerConfig: {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: SINCE,
        [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: 'keep-me',
        [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      },
    });
    await setGoogleCalendarImportEnabled({ db, salonId: 'salon-1', enabled: true });
    const cfg = db.saved()!.provider_config as Record<string, unknown>;
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], SINCE);
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], 'keep-me');
  });

  it('in-process overlapping ticks skip', async () => {
    const db = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq: async () => {
                        await new Promise((r) => setTimeout(r, 20));
                        return { data: [], error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    const a = tickGoogleCalendarPullWorker({ db });
    const b = tickGoogleCalendarPullWorker({ db });
    const [ra, rb] = await Promise.all([a, b]);
    assert.ok(ra === null || rb === null);
  });
});
