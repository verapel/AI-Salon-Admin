/**
 * GOOGLE-CAL-FAST-8: live automatic Google → AI Salon Admin after manual sync.
 * Does not execute SQL. Does not write Google. Does not enable production import.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CalendarMatchCatalog } from './calendarEventMatcher.js';
import {
  classifyAutoImportCreatedAt,
  GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY,
  GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY,
  isPilotTatevStaffName,
  persistAutoImportPageToken,
  pullGoogleCalendarConnection,
  setGoogleCalendarImportEnabled,
} from './googleCalendarAutoImport.js';
import { GOOGLE_PROVISIONAL_KEY_PREFIX } from './googleCalendarCoverageClient.js';
import { listGoogleReviewCalendarItems } from './googleCalendarReviewOverlay.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const EXISTING_CLIENT = 'client-agunik';
const WATERMARK = '2026-08-16T17:00:00.000Z';
const NOW = new Date('2026-08-16T19:00:00.000Z');
const SAFE_TITLE = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';

function previewEvent(overrides: Partial<GoogleEventPreviewItem> = {}): GoogleEventPreviewItem {
  return {
    id: 'evt-new',
    iCalUID: null,
    summary: SAFE_TITLE,
    description: null,
    location: null,
    status: 'confirmed',
    start: {
      dateTime: '2026-08-20T06:00:00.000Z',
      date: null,
      timeZone: 'UTC',
      allDay: false,
    },
    end: {
      dateTime: '2026-08-20T08:00:00.000Z',
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

function autoDb(opts: {
  importEnabled?: boolean;
  watermark?: string;
  imported?: Array<{
    external_uid: string;
    external_calendar_id?: string;
    recurrence_id?: string;
    appointment_id?: string;
  }>;
  appointments?: Array<Record<string, unknown>>;
  clients?: Array<{ id: string; name: string; phone: string; notes?: string; deleted_at?: string | null }>;
  issues?: any[];
} = {}) {
  const importEnabled = { value: opts.importEnabled !== false };
  const watermark = { value: opts.watermark ?? WATERMARK };
  const importedLinkRows = opts.imported ?? [];
  const appointments = opts.appointments ?? [];
  const clients = opts.clients ?? [];
  const issues = opts.issues ?? [];
  let issueSeq = issues.length + 1;
  let clientSeq = clients.length + 1;
  const saved: Record<string, unknown>[] = [];

  return {
    clients,
    issues,
    importedLinkRows,
    appointments,
    importEnabled,
    watermark,
    saved,
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
                  credential_iv: 'y',
                  credential_auth_tag: 'z',
                  status: 'connected',
                  selected_calendar_id: 'primary',
                  selected_calendar_name: 'Salon',
                  provider_config: {
                    [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
                    [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: watermark.value,
                    [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: 'keep-me',
                  },
                  import_enabled: importEnabled.value,
                  sync_lock_token: null,
                  last_sync_started_at: null,
                },
                error: null,
              }),
            };
            return chain;
          },
          update(payload?: Record<string, unknown>) {
            saved.push(payload ?? {});
            if (typeof payload?.import_enabled === 'boolean') {
              importEnabled.value = payload.import_enabled;
            }
            const cfg = payload?.provider_config as Record<string, unknown> | undefined;
            if (cfg && typeof cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY] === 'string') {
              watermark.value = String(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]);
            }
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
  clients: [{ id: EXISTING_CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
  services: [{ id: SERVICE, name: 'Окрашивание' }],
};

async function pull(params: {
  events: GoogleEventPreviewItem[];
  db?: ReturnType<typeof autoDb>;
  catalog?: CalendarMatchCatalog;
  imports?: Array<Record<string, unknown>>;
  executeImport?: Parameters<typeof pullGoogleCalendarConnection>[0]['executeImport'];
  isStillEnabled?: () => Promise<boolean>;
}) {
  const db = params.db ?? autoDb();
  const imports = params.imports ?? [];
  const pulled = await pullGoogleCalendarConnection({
    db,
    salonId: 'salon-1',
    connectionId: 'conn-1',
    now: NOW,
    salonTimeZone: 'UTC',
    matchCatalog: params.catalog ?? {
      clients: [...CATALOG.clients],
      services: [...CATALOG.services],
    },
    eventsOverride: params.events,
    isStillEnabled: params.isStillEnabled,
    executeImport:
      params.executeImport ??
      (async ({ body }) => {
        imports.push(body);
        return {
          appointmentId: `a-${body.eventId}`,
          clientId:
            body.client.mode === 'existing' ? String(body.client.clientId) : 'new-import',
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
  return { pulled, overlay, db, imports };
}

describe('GOOGLE-CAL-FAST-8 automatic sync after manual import', () => {
  it('A. manual-sync event existing before enable is not duplicated', async () => {
    const ev = previewEvent({
      id: 'manual-old',
      created: '2026-07-01T00:00:00.000Z',
      updated: '2026-08-16T18:30:00.000Z',
    });
    const db = autoDb({
      imported: [
        {
          external_uid: 'manual-old',
          external_calendar_id: 'primary',
          appointment_id: 'appt-manual-old',
        },
      ],
      appointments: [
        {
          id: 'appt-manual-old',
          date: '2026-08-20',
          start_time: '06:00:00',
          end_time: '08:00:00',
          staff_id: STAFF,
          client_id: EXISTING_CLIENT,
          status: 'scheduled',
        },
      ],
      clients: [{ id: EXISTING_CLIENT, name: 'Agunik Yeganian', phone: '+380632022810' }],
    });
    const { pulled, overlay, imports } = await pull({ events: [ev], db });
    assert.equal(pulled.imported, 0);
    assert.equal(imports.length, 0);
    assert.equal(db.clients.length, 1);
    assert.equal(overlay.length, 0);
    assert.equal(pulled.scanned, 0);
  });

  it('B. new Google event after enable becomes an appointment when safe', async () => {
    const { pulled, overlay, imports, db } = await pull({
      events: [previewEvent({ id: 'safe-new' })],
    });
    assert.equal(pulled.imported, 1);
    assert.equal(imports.length, 1);
    assert.equal(imports[0]?.staffId, STAFF);
    assert.equal(imports[0]?.serviceId, SERVICE);
    assert.equal((imports[0]?.client as { mode?: string; clientId?: string }).mode, 'existing');
    assert.equal((imports[0]?.client as { clientId?: string }).clientId, EXISTING_CLIENT);
    assert.equal(overlay.length, 0);
    assert.equal(db.clients.filter((c) => c.id !== EXISTING_CLIENT).length, 0);
  });

  it('C. unmatched-service new event gets client + review overlay', async () => {
    const { pulled, overlay, db, imports } = await pull({
      events: [previewEvent({ id: 'no-service', summary: 'Agunik Yeganian +380 63 202 2810 unknown service' })],
      catalog: { clients: [], services: [{ id: SERVICE, name: 'Окрашивание' }] },
    });
    assert.equal(pulled.imported, 0);
    assert.equal(imports.length, 0);
    assert.equal(db.clients.length, 1);
    assert.equal(overlay.length, 1);
    assert.ok(overlay[0]?.clientId);
    assert.ok((pulled.skippedByReason.service_not_matched || 0) >= 1);
  });

  it('D. no-phone new event creates client without fake phone + overlay', async () => {
    const { overlay, db, imports } = await pull({
      events: [previewEvent({ id: 'no-phone', summary: 'Agunik Yeganian окрашивание' })],
      catalog: { clients: [], services: [{ id: SERVICE, name: 'Окрашивание' }] },
    });
    assert.equal(imports.length, 0);
    assert.equal(db.clients.length, 1);
    assert.equal(db.clients[0]?.phone, '');
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0]?.clientId, db.clients[0]?.id);
  });

  it('E. same worker event processed repeatedly does not duplicate client', async () => {
    const ev = previewEvent({ id: 'repeat-client', summary: 'Agunik Yeganian окрашивание' });
    const db = autoDb({ clients: [] });
    const catalog = (): CalendarMatchCatalog => ({
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    });
    await pull({ events: [ev], db, catalog: catalog() });
    await pull({ events: [ev], db, catalog: catalog() });
    assert.equal(db.clients.length, 1);
  });

  it('F. existing FAST-7D provisional client is reused', async () => {
    const key = `${GOOGLE_PROVISIONAL_KEY_PREFIX}event:prov-1`;
    const db = autoDb({
      clients: [
        {
          id: 'prov-client',
          name: 'Google',
          phone: '',
          notes: `Создано из Google Calendar — требуется проверка\n${key}`,
        },
      ],
    });
    const { overlay } = await pull({
      events: [previewEvent({ id: 'prov-1', summary: 'окрашивание' })],
      db,
      catalog: { clients: [], services: [{ id: SERVICE, name: 'Окрашивание' }] },
    });
    assert.equal(db.clients.length, 1);
    assert.equal(overlay[0]?.clientId, 'prov-client');
  });

  it('G. existing appointment_external_link does not create a second appointment', async () => {
    const ev = previewEvent({ id: 'linked-new' });
    const db = autoDb({
      imported: [
        {
          external_uid: 'linked-new',
          external_calendar_id: 'primary',
          appointment_id: 'appt-linked-new',
        },
      ],
      appointments: [
        {
          id: 'appt-linked-new',
          date: '2026-08-20',
          start_time: '06:00:00',
          end_time: '08:00:00',
          staff_id: STAFF,
          client_id: EXISTING_CLIENT,
          status: 'scheduled',
        },
      ],
    });
    const { pulled, imports, overlay } = await pull({ events: [ev], db });
    assert.equal(imports.length, 0);
    assert.equal(pulled.imported, 0);
    assert.equal(pulled.scanned, 0);
    assert.equal(overlay.length, 0);
  });

  it('H. existing review overlay is reused, not duplicated', async () => {
    const ev = previewEvent({ id: 'overlay-1', summary: 'Agunik Yeganian окрашивание' });
    const db = autoDb({ clients: [] });
    const catalog: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: SERVICE, name: 'Окрашивание' }],
    };
    await pull({ events: [ev], db, catalog });
    await pull({ events: [ev], db, catalog });
    assert.equal(db.issues.filter((row) => row.status === 'open').length, 1);
  });

  it('I. far-future event created after enable is discovered', async () => {
    const ev = previewEvent({
      id: 'far-future',
      created: '2026-08-16T18:30:00.000Z',
      start: { dateTime: '2027-03-01T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
      end: { dateTime: '2027-03-01T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    });
    assert.equal(
      classifyAutoImportCreatedAt({ created: ev.created, autoImportSince: WATERMARK }),
      'new',
    );
    const { pulled, imports } = await pull({ events: [ev] });
    assert.equal(pulled.imported, 1);
    assert.equal(imports[0]?.eventId, 'far-future');
  });

  it('J/K. Tatev is assigned and Maya is never inferred', async () => {
    assert.equal(isPilotTatevStaffName('Tatev Mikaelyan'), true);
    assert.equal(isPilotTatevStaffName('Maya Avetisyan'), false);
    const { imports, overlay } = await pull({
      events: [
        previewEvent({ id: 'staff-safe' }),
        previewEvent({ id: 'staff-overlay', summary: 'Agunik Yeganian окрашивание' }),
      ],
      catalog: { clients: [...CATALOG.clients], services: [...CATALOG.services] },
    });
    for (const body of imports) {
      assert.equal(body.staffId, STAFF);
      assert.notEqual(body.staffId, 'staff-maya');
    }
    for (const item of overlay) {
      assert.match(item.staffName, /Tatev/i);
      assert.doesNotMatch(item.staffName, /Maya/i);
    }
  });

  it('L. disable stops subsequent automatic imports', async () => {
    const db = autoDb({ importEnabled: false });
    const { pulled, imports } = await pull({
      events: [previewEvent({ id: 'after-disable' })],
      db,
    });
    assert.equal(imports.length, 0);
    assert.equal(pulled.imported, 0);
    assert.ok((pulled.skippedByReason.import_disabled || 0) >= 1);
  });

  it('M. re-enable uses a new watermark and does not backfill disabled-window events', async () => {
    const db = autoDb({
      importEnabled: false,
      watermark: '2026-08-16T10:00:00.000Z',
    });
    await setGoogleCalendarImportEnabled({ db, salonId: 'salon-1', enabled: true });
    const newSince = db.watermark.value;
    assert.notEqual(newSince, '2026-08-16T10:00:00.000Z');
    assert.ok(Date.parse(newSince) > Date.parse('2026-08-16T10:00:00.000Z'));
    const createdWhileDisabled = previewEvent({
      id: 'while-disabled',
      created: '2026-08-16T12:00:00.000Z',
    });
    assert.equal(
      classifyAutoImportCreatedAt({
        created: createdWhileDisabled.created,
        autoImportSince: newSince,
      }),
      'before_auto_import',
    );
    const { pulled, imports } = await pull({
      events: [createdWhileDisabled],
      db,
    });
    assert.equal(imports.length, 0);
    assert.equal(pulled.imported, 0);
    assert.equal(pulled.scanned, 0);
  });

  it('N. page-token persist stays session-safe', async () => {
    const live = {
      import_enabled: true,
      selected_calendar_id: 'primary',
      provider_config: {
        [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: WATERMARK,
        [GOOGLE_AUTO_IMPORT_STAFF_CONFIG_KEY]: STAFF,
      },
    };
    let saved: Record<string, unknown> | null = null;
    const db = {
      from() {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              maybeSingle: async () => ({ data: live, error: null }),
            };
            return chain;
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
    const ok = await persistAutoImportPageToken({
      db,
      connectionId: 'conn-1',
      salonId: 'salon-1',
      expectedWatermark: WATERMARK,
      expectedCalendarId: 'primary',
      pageToken: 'page-8',
    });
    assert.equal(ok, true);
    const cfg = saved!.provider_config as Record<string, unknown>;
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], 'page-8');
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY], WATERMARK);
  });

  it('O. Google write methods are absent from auto/coverage/overlay modules', () => {
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    const coverage = read('server/src/lib/googleCalendarCoverageClient.ts');
    const overlay = read('server/src/lib/googleCalendarReviewOverlay.ts');
    const worker = read('server/src/lib/googleCalendarPullWorker.ts');
    for (const src of [auto, coverage, overlay, worker]) {
      assert.doesNotMatch(src, /events\.(insert|update|patch|delete)/i);
    }
    assert.match(auto, /googleSkipReasonNeedsCalendarOverlay/);
    assert.match(auto, /ensureAutoCoverageClient/);
  });
});
