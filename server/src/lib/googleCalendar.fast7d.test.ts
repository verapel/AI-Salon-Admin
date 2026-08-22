/**
 * GOOGLE-CAL-FAST-7D: now-30d through all future + client cards for every represented event.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CalendarMatchCatalog } from './calendarEventMatcher.js';
import {
  GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
  pullGoogleCalendarConnection,
} from './googleCalendarAutoImport.js';
import {
  buildGoogleBackfillWindow,
  importGoogleCalendarLast30Days,
  isGoogleEventStartInBackfillWindow,
} from './googleCalendarBackfill.js';
import {
  decideGoogleCoverageClient,
  GOOGLE_PROVISIONAL_NOTE,
  looksLikeGooglePersonName,
} from './googleCalendarCoverageClient.js';
import { listGoogleReviewCalendarItems } from './googleCalendarReviewOverlay.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const NOW = new Date('2026-08-16T19:00:00.000Z');
const TITLE = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-1',
    iCalUID: null,
    summary: TITLE,
    description: null,
    location: null,
    status: 'confirmed',
    start: { dateTime: '2026-08-06T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    end: { dateTime: '2026-08-06T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
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

function coverageDb(opts: {
  imported?: Array<{
    external_uid: string;
    external_calendar_id?: string;
    appointment_id?: string;
  }>;
  appointments?: Array<Record<string, unknown>>;
  clients?: Array<{ id: string; name: string; phone: string; notes?: string; deleted_at?: string | null }>;
} = {}) {
  const importedLinkRows = opts.imported ?? [];
  const appointments = opts.appointments ?? [];
  const clients = opts.clients ?? [];
  const issues: any[] = [];
  let issueSeq = 1;
  let clientSeq = 1;
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
              email: row.email || '',
              deleted_at: null,
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
              maybeSingle: async () => ({ data: { id: STAFF, name: 'Tatev Mikaelyan' }, error: null }),
              then: async (resolve: any) =>
                resolve({ data: [{ id: STAFF, name: 'Tatev Mikaelyan' }], error: null }),
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
                    [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: 'keep-me',
                  },
                  import_enabled: true,
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
          return { eq() { return { then: async (resolve: any) => resolve({ data: [], error: null }) }; } };
        },
      };
    },
  };
}

const CATALOG: CalendarMatchCatalog = {
  clients: [],
  services: [{ id: SERVICE, name: 'Окрашивание' }],
};

async function runSync(params: {
  events: GoogleEventPreviewItem[];
  db?: ReturnType<typeof coverageDb>;
  catalog?: CalendarMatchCatalog;
}) {
  const db = params.db ?? coverageDb();
  const result = await importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: 'UTC',
    matchCatalog: params.catalog ?? { ...CATALOG, clients: [...(params.catalog?.clients ?? [])] },
    eventsOverride: params.events,
    executeImport: async ({ body }) => ({
      appointmentId: `a-${body.eventId}`,
      clientId: body.client.mode === 'existing' ? String(body.client.clientId) : 'new-import',
      clientCreated: body.client.mode === 'new',
      alreadyImported: false,
    }),
  });
  const overlay = await listGoogleReviewCalendarItems({
    db,
    salonId: 'salon-1',
    calendarConnectionId: 'conn-1',
  });
  return { result, overlay, db };
}

describe('GOOGLE-CAL-FAST-7D client + past/future coverage', () => {
  it('A-F. window includes 20d ago / today / tomorrow / 90d / 1y and excludes 31d ago', () => {
    const window = buildGoogleBackfillWindow(NOW);
    assert.equal(window.timeMax, undefined);
    const cases: Array<[string, string, boolean]> = [
      ['A', '2026-07-27T10:00:00.000Z', true],
      ['B', '2026-07-16T10:00:00.000Z', false],
      ['C', '2026-08-16T18:00:00.000Z', true],
      ['D', '2026-08-17T10:00:00.000Z', true],
      ['E', '2026-11-14T10:00:00.000Z', true],
      ['F', '2027-08-16T10:00:00.000Z', true],
    ];
    for (const [, start, expected] of cases) {
      const ev = previewEvent({
        start: { dateTime: start, date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: start, date: null, timeZone: 'UTC', allDay: false },
      });
      assert.equal(isGoogleEventStartInBackfillWindow(ev, window), expected);
    }
  });

  it('G. exact phone existing client reused', async () => {
    const db = coverageDb({
      clients: [{ id: 'existing-phone', name: 'Agunik Yeganian', phone: '+380632022810' }],
    });
    const { result, db: out } = await runSync({ db, events: [previewEvent()] });
    assert.equal(result.clientsReused, 1);
    assert.equal(result.clientsCreated, 0);
    assert.equal(out.clients.length, 1);
  });

  it('H. exact unique name existing client reused', async () => {
    const db = coverageDb({
      clients: [{ id: 'existing-name', name: 'Agunik Yeganian', phone: '' }],
    });
    const { result } = await runSync({
      db,
      events: [previewEvent({ id: 'n1', summary: 'Agunik Yeganian окрашивание' })],
    });
    assert.equal(result.clientsReused, 1);
    assert.equal(result.clientsCreated, 0);
  });

  it('I. new safe name+phone creates a normal client', () => {
    const decision = decideGoogleCoverageClient({
      clients: [],
      phoneDigits: '380632022810',
      displayName: 'Agunik Yeganian',
      eventId: 'e1',
    });
    assert.equal(decision.action, 'create');
    if (decision.action === 'create') {
      assert.equal(decision.provisional, false);
      assert.equal(decision.phone, '380632022810');
      assert.equal(decision.name, 'Agunik Yeganian');
    }
  });

  it('J. no phone creates provisional client without fake phone', async () => {
    const { result, db } = await runSync({
      events: [previewEvent({ id: 'np', summary: 'Agunik Yeganian окрашивание' })],
    });
    assert.equal(result.reviewEvents, 1);
    assert.equal(result.clientsCreated, 1);
    assert.equal(db.clients[0]?.phone, '');
    assert.match(db.clients[0]?.notes || '', new RegExp(GOOGLE_PROVISIONAL_NOTE));
    assert.doesNotMatch(db.clients[0]?.phone || '', /\d/);
  });

  it('K. unmatched service creates client + review overlay', async () => {
    const { result, overlay, db } = await runSync({
      events: [previewEvent({ id: 'svc' })],
      catalog: { clients: [], services: [{ id: 'cut', name: 'Стрижка' }] },
    });
    assert.equal(result.imported, 0);
    assert.equal(result.reviewEvents, 1);
    assert.equal(overlay.length, 1);
    assert.equal(db.clients.length, 1);
    assert.ok(overlay[0]?.clientId);
  });

  it('L/M. repeated sync does not duplicate client or overlay', async () => {
    const db = coverageDb();
    const ev = previewEvent({ id: 'rep', summary: 'Agunik Yeganian окрашивание' });
    const first = await runSync({ db, events: [ev] });
    const second = await runSync({ db, events: [ev] });
    assert.equal(first.result.clientsCreated, 1);
    assert.equal(second.result.clientsCreated, 0);
    assert.equal(second.result.clientsReused, 1);
    assert.equal(db.clients.length, 1);
    assert.equal(db.issues.filter((i) => i.status === 'open').length, 1);
  });

  it('N. existing imported appointment does not duplicate client', async () => {
    const db = coverageDb({
      imported: [
        {
          external_uid: 'evt-1',
          external_calendar_id: 'primary',
          appointment_id: 'appt-1',
        },
      ],
      appointments: [
        {
          id: 'appt-1',
          date: '2026-08-06',
          start_time: '10:00:00',
          end_time: '12:00:00',
          staff_id: STAFF,
          client_id: 'already',
          status: 'scheduled',
        },
      ],
      clients: [{ id: 'already', name: 'Agunik Yeganian', phone: '+380632022810' }],
    });
    const { result } = await runSync({ db, events: [previewEvent()] });
    assert.equal(result.alreadyImported, 1);
    assert.equal(result.clientsCreated, 0);
    assert.equal(db.clients.length, 1);
  });

  it('O. future event existing before FAST-6 enable is covered by manual sync', async () => {
    const ev = previewEvent({
      id: 'old-future',
      created: '2026-07-01T00:00:00.000Z',
      start: { dateTime: '2026-11-01T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      end: { dateTime: '2026-11-01T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    });
    const { result } = await runSync({ events: [ev] });
    assert.equal(result.scanned, 1);
    assert.ok(result.represented >= 1);
  });

  it('P. later FAST-6 new event follows same client+overlay rule', async () => {
    const db = coverageDb();
    const ev = previewEvent({
      id: 'new-auto',
      created: '2026-08-16T18:00:00.000Z',
      summary: 'Agunik Yeganian окрашивание',
    });
    const pulled = await pullGoogleCalendarConnection({
      db,
      salonId: 'salon-1',
      connectionId: 'conn-1',
      now: NOW,
      salonTimeZone: 'UTC',
      matchCatalog: { clients: [], services: [{ id: SERVICE, name: 'Окрашивание' }] },
      eventsOverride: [ev],
      executeImport: async () => {
        throw new Error('should overlay, not import');
      },
    });
    assert.ok((pulled.skippedByReason.no_exact_phone || 0) >= 1);
    assert.equal(db.clients.length, 1);
    assert.equal(db.clients[0]?.phone, '');
    assert.equal(db.issues.filter((i) => i.status === 'open').length, 1);
  });

  it('Q. client card is visible through the normal clients store', async () => {
    const { db } = await runSync({
      events: [previewEvent({ id: 'vis', summary: 'Agunik Yeganian окрашивание' })],
    });
    const visible = db.clients.filter((c) => !c.deleted_at);
    assert.equal(visible.length, 1);
    assert.ok(visible[0]?.name);
  });

  it('R/S. Tatev remains staff; Maya never assigned', async () => {
    const { overlay } = await runSync({
      events: [previewEvent({ id: 'staff', summary: 'Someone окрашивание' })],
    });
    assert.match(overlay[0]?.staffName || '', /Tatev/i);
    assert.doesNotMatch(overlay[0]?.staffName || '', /Maya/i);
  });

  it('T/U. Google writes absent; FAST-6 watermark/page token unchanged', () => {
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    const coverage = read('server/src/lib/googleCalendarCoverageClient.ts');
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    for (const src of [backfill, coverage]) {
      assert.doesNotMatch(src, /events\.(insert|update|patch|delete)/i);
      assert.doesNotMatch(src, /persistAutoImportPageToken/);
      assert.doesNotMatch(src, /auto_import_since\s*=/);
      assert.doesNotMatch(src, /auto_import_page_token\s*=/);
    }
    assert.match(auto, /Does not write watermarks|auto_import_since/);
    assert.match(backfill, /Does not write FAST-6 provider_config keys/);
  });

  it('aggregate 135 past-window + 50 future events all represented with clients', async () => {
    const past = Array.from({ length: 135 }, (_, i) =>
      previewEvent({
        id: `past-${i}`,
        summary: i % 2 === 0 ? TITLE : `Guest ${i} окрашивание`,
        start: { dateTime: '2026-08-06T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-08-06T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      }),
    );
    const future = Array.from({ length: 50 }, (_, i) =>
      previewEvent({
        id: `fut-${i}`,
        summary: `Future Person ${i} окрашивание`,
        start: { dateTime: '2026-12-01T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        end: { dateTime: '2026-12-01T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      }),
    );
    const { result, db } = await runSync({ events: [...past, ...future] });
    assert.equal(result.scanned, 185);
    assert.equal(result.represented, 185);
    assert.equal(result.imported + result.reviewEvents, 185);
    assert.ok(db.clients.length > 0);
    assert.ok(result.clientsCreated + result.clientsReused >= 185);
  });

  it('person-name helper rejects service-only titles', () => {
    assert.equal(looksLikeGooglePersonName('Agunik Yeganian'), true);
    assert.equal(looksLikeGooglePersonName('окрашивание'), false);
  });
});
