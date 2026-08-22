/**
 * GOOGLE-CAL-SYNC-FIX-1: manual sync completes all pages without restarting.
 * No SQL. No Google writes. No production calls.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CalendarMatchCatalog } from './calendarEventMatcher.js';
import {
  GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
  pullGoogleCalendarConnection,
} from './googleCalendarAutoImport.js';
import {
  buildGoogleBackfillWindow,
  importGoogleCalendarLast30Days,
  listGoogleCalendarEventsForBackfill,
} from './googleCalendarBackfill.js';
import {
  resetGoogleBackfillProgressStore,
  tryBeginGoogleBackfillProgress,
  updateGoogleBackfillProgress,
  getGoogleBackfillProgress,
} from './googleCalendarBackfillProgress.js';
import { listGoogleReviewCalendarItems } from './googleCalendarReviewOverlay.js';
import { buildGoogleCalendarEventsListUrl, type GoogleEventPreviewItem } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const NOW = new Date('2026-08-16T19:00:00.000Z');
const SAFE_TITLE = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';

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
    created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-01T00:00:00.000Z',
    etag: 'etag-1',
    htmlLink: null,
    calendarId: 'primary',
    calendarName: 'Salon',
    ...overrides,
  };
}

function coverageDb(opts: {
  imported?: Array<{ external_uid: string; external_calendar_id?: string }>;
  clients?: Array<{ id: string; name: string; phone: string; notes?: string }>;
  issues?: any[];
} = {}) {
  const importedLinkRows = opts.imported ?? [];
  const clients = opts.clients ?? [];
  const issues = opts.issues ?? [];
  let issueSeq = issues.length + 1;
  let clientSeq = clients.length + 1;
  return {
    clients,
    issues,
    importedLinkRows,
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
                  iv: 'y',
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
                  sync_lock_token: null,
                  last_sync_started_at: null,
                },
                error: null,
              }),
            };
            return chain;
          },
          update(payload?: Record<string, unknown>) {
            const claimed =
              typeof payload?.sync_lock_token === 'string' ? payload.sync_lock_token : 'claimed';
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
                    data: { id: 'conn-1', sync_lock_token: claimed },
                    error: null,
                  }),
                };
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

const CATALOG: CalendarMatchCatalog = {
  clients: [{ id: 'client-agunik', name: 'Agunik Yeganian', phone: '+380632022810' }],
  services: [{ id: SERVICE, name: 'Окрашивание' }],
};

async function runSync(params: {
  events: GoogleEventPreviewItem[];
  db?: ReturnType<typeof coverageDb>;
  catalog?: CalendarMatchCatalog;
  onProgress?: (progress: { processed: number; total: number | null }) => void;
  onPage?: Parameters<typeof importGoogleCalendarLast30Days>[0]['onPage'];
}) {
  const db = params.db ?? coverageDb();
  const imports: Array<Record<string, unknown>> = [];
  const result = await importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: 'UTC',
    matchCatalog: params.catalog ?? {
      clients: [...CATALOG.clients],
      services: [...CATALOG.services],
    },
    eventsOverride: params.events,
    onProgress: params.onProgress,
    onPage: params.onPage,
    executeImport: async ({ body }) => {
      imports.push(body);
      return {
        appointmentId: `a-${body.eventId}`,
        clientId: body.client.mode === 'existing' ? String(body.client.clientId) : 'new-import',
        clientCreated: body.client.mode === 'new',
        alreadyImported: false,
      };
    },
  });
  const overlay = await listGoogleReviewCalendarItems({
    db,
    salonId: 'salon-1',
    calendarConnectionId: 'conn-1',
  });
  return { result, overlay, db, imports };
}

function googleListItem(id: string, startIso: string) {
  return {
    id,
    summary: `Event ${id}`,
    status: 'confirmed',
    start: { dateTime: startIso },
    end: { dateTime: new Date(Date.parse(startIso) + 3600_000).toISOString() },
    created: startIso,
    updated: startIso,
  };
}

describe('GOOGLE-CAL-SYNC-FIX-1 incomplete full sync', () => {
  beforeEach(() => {
    resetGoogleBackfillProgressStore();
  });

  it('1. >2000-event paginated manual sync completes', async () => {
    const events = Array.from({ length: 2100 }, (_, i) =>
      previewEvent({
        id: `bulk-${i}`,
        summary: i % 10 === 0 ? SAFE_TITLE : `Client ${i} unknown service`,
        start: {
          dateTime: new Date(Date.parse('2026-08-01T10:00:00.000Z') + i * 3600_000).toISOString(),
          date: null,
          timeZone: 'UTC',
          allDay: false,
        },
        end: {
          dateTime: new Date(Date.parse('2026-08-01T12:00:00.000Z') + i * 3600_000).toISOString(),
          date: null,
          timeZone: 'UTC',
          allDay: false,
        },
      }),
    );
    const { result } = await runSync({ events });
    assert.equal(result.scanned, 2100);
    assert.ok(result.represented + result.excluded + result.failed + result.skipped >= 0);
    assert.equal(result.represented, result.imported + result.reviewEvents + result.alreadyImported);
    assert.equal(result.truncated, false);
  });

  it('2/3. every page processed once and nextPageToken advances', async () => {
    const usedTokens: Array<string | null> = [];
    const nextTokens: Array<string | null> = [];
    const seenPages: number[] = [];
    const fetchImpl = async (url: string) => {
      const u = new URL(url);
      const token = u.searchParams.get('pageToken');
      const page = token ? Number(token.replace('p', '')) : 0;
      const next = page < 8 ? `p${page + 1}` : null;
      const items = Array.from({ length: 250 }, (_, i) =>
        googleListItem(`p${page}-${i}`, '2026-08-20T10:00:00.000Z'),
      );
      return {
        ok: true,
        json: async () => ({ items, nextPageToken: next }),
      } as Response;
    };
    const listed = await listGoogleCalendarEventsForBackfill({
      accessToken: 'tok',
      calendarId: 'primary',
      timeMin: buildGoogleBackfillWindow(NOW).timeMin,
      fetchImpl,
      maxPages: 20,
      maxEvents: 5000,
      onPage: (page) => {
        seenPages.push(page.pageIndex);
        usedTokens.push(page.pageTokenUsed);
        nextTokens.push(page.nextPageToken);
      },
    });
    assert.equal(listed.events.length, 2250);
    assert.deepEqual(seenPages, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(usedTokens, [null, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    assert.equal(new Set(usedTokens.map((t) => String(t))).size, usedTokens.length);
    assert.equal(nextTokens.at(-1), null);
    assert.equal(listed.truncated, false);
  });

  it('4. progress never decreases for one job', async () => {
    const ticks: number[] = [];
    const percents: number[] = [];
    const events = Array.from({ length: 12 }, (_, i) => previewEvent({ id: `prog-${i}` }));
    tryBeginGoogleBackfillProgress('salon-progress');
    await runSync({
      events,
      onProgress: (progress) => {
        ticks.push(progress.processed);
        const next = updateGoogleBackfillProgress('salon-progress', {
          status: 'processing',
          processed: progress.processed,
          total: progress.total,
        });
        percents.push(next.percent);
      },
    });
    for (let i = 1; i < ticks.length; i += 1) {
      assert.ok(ticks[i]! >= ticks[i - 1]!, `processed decreased ${ticks[i - 1]} → ${ticks[i]}`);
    }
    for (let i = 1; i < percents.length; i += 1) {
      assert.ok(percents[i]! >= percents[i - 1]!, `percent decreased ${percents[i - 1]} → ${percents[i]}`);
    }
  });

  it('5. duplicate click cannot create overlapping jobs', () => {
    const first = tryBeginGoogleBackfillProgress('salon-lock');
    const second = tryBeginGoogleBackfillProgress('salon-lock');
    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(getGoogleBackfillProgress('salon-lock').status, 'listing');
    const route = read('server/src/routes/calendarConnections.ts');
    const ui = read('client/src/pages/SalonIntegrations.tsx');
    assert.match(route, /google_backfill_already_running/);
    assert.match(ui, /if \(googleBackfillRunning\) return/);
  });

  it('6. already represented events do not duplicate', async () => {
    const ev = previewEvent({ id: 'dup-1', summary: 'Agunik Yeganian окрашивание' });
    const db = coverageDb();
    const first = await runSync({ events: [ev], db, catalog: { clients: [], services: CATALOG.services } });
    const second = await runSync({ events: [ev], db, catalog: { clients: [], services: CATALOG.services } });
    assert.equal(db.clients.length, 1);
    assert.equal(db.issues.filter((row) => row.status === 'open').length, 1);
    assert.equal(first.result.clientsCreated, 1);
    assert.equal(second.result.clientsCreated, 0);
    assert.equal(second.imports.length, 0);
  });

  it('7. unmatched event becomes overlay + client', async () => {
    const { result, overlay, db } = await runSync({
      events: [previewEvent({ id: 'unsafe', summary: 'Agunik Yeganian unknown service' })],
      catalog: { clients: [], services: CATALOG.services },
    });
    assert.equal(result.imported, 0);
    assert.equal(result.reviewEvents, 1);
    assert.equal(overlay.length, 1);
    assert.equal(db.clients.length, 1);
    assert.ok(overlay[0]?.clientId);
  });

  it('8. safe event becomes appointment + client', async () => {
    const { result, overlay, imports } = await runSync({
      events: [previewEvent({ id: 'safe-1' })],
    });
    assert.equal(result.imported, 1);
    assert.equal(imports.length, 1);
    assert.equal(imports[0]?.staffId, STAFF);
    assert.equal(overlay.length, 0);
  });

  it('9. future events are processed', async () => {
    const { result, imports } = await runSync({
      events: [
        previewEvent({
          id: 'future-1y',
          created: '2026-08-16T18:00:00.000Z',
          start: { dateTime: '2027-08-16T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2027-08-16T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        }),
      ],
    });
    assert.equal(result.imported, 1);
    assert.equal(imports[0]?.eventId, 'future-1y');
  });

  it('10. no future timeMax on manual sync list URL', () => {
    const window = buildGoogleBackfillWindow(NOW);
    assert.equal(window.timeMax, undefined);
    const url = buildGoogleCalendarEventsListUrl({
      calendarId: 'primary',
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      orderBy: 'startTime',
    });
    const parsed = new URL(url);
    assert.ok(parsed.searchParams.get('timeMin'));
    assert.equal(parsed.searchParams.get('timeMax'), null);
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    assert.match(backfill, /No future timeMax/);
  });

  it('11. final completion only after last page', async () => {
    const pages: Array<{ pageIndex: number; nextPageToken: string | null }> = [];
    const fetchImpl = async (url: string) => {
      const token = new URL(url).searchParams.get('pageToken');
      const page = token ? Number(token.replace('p', '')) : 0;
      const next = page < 2 ? `p${page + 1}` : null;
      return {
        ok: true,
        json: async () => ({
          items: [googleListItem(`last-${page}`, '2026-08-20T10:00:00.000Z')],
          nextPageToken: next,
        }),
      } as Response;
    };
    await listGoogleCalendarEventsForBackfill({
      accessToken: 'tok',
      calendarId: 'primary',
      timeMin: buildGoogleBackfillWindow(NOW).timeMin,
      fetchImpl,
      onPage: (page) => {
        pages.push({ pageIndex: page.pageIndex, nextPageToken: page.nextPageToken });
      },
    });
    assert.equal(pages.length, 3);
    assert.ok(pages.slice(0, -1).every((p) => p.nextPageToken));
    assert.equal(pages.at(-1)?.nextPageToken, null);
    const started = tryBeginGoogleBackfillProgress('salon-complete');
    assert.equal(started.progress.status, 'listing');
    updateGoogleBackfillProgress('salon-complete', { status: 'processing', processed: 2, total: 3 });
    assert.notEqual(getGoogleBackfillProgress('salon-complete').status, 'done');
    updateGoogleBackfillProgress('salon-complete', { status: 'done', processed: 3, total: 3 });
    assert.equal(getGoogleBackfillProgress('salon-complete').status, 'done');
    assert.equal(getGoogleBackfillProgress('salon-complete').percent, 100);
  });

  it('12. FAST-6 new-event worker still works independently', async () => {
    const ev = previewEvent({
      id: 'auto-new',
      created: '2026-08-16T18:30:00.000Z',
    });
    const pulled = await pullGoogleCalendarConnection({
      db: coverageDb(),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      now: NOW,
      salonTimeZone: 'UTC',
      matchCatalog: {
        clients: [...CATALOG.clients],
        services: [...CATALOG.services],
      },
      eventsOverride: [ev],
      executeImport: async ({ body }) => ({
        appointmentId: `a-${body.eventId}`,
        clientId: 'client-agunik',
        clientCreated: false,
        alreadyImported: false,
      }),
    });
    assert.equal(pulled.imported, 1);
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.match(auto, /updatedMin/);
    assert.match(auto, /classifyAutoImportCreatedAt/);
    assert.doesNotMatch(auto, /importGoogleCalendarLast30Days/);
  });

  it('Google write methods stay absent from the manual sync path', () => {
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    const route = read('server/src/routes/calendarConnections.ts');
    for (const src of [backfill, route]) {
      assert.doesNotMatch(src, /events\.(insert|update|patch|delete)/i);
    }
  });
});
