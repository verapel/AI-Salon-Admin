/**
 * GOOGLE-CAL-SYNC-FIX-2: new + in-place update reconciliation.
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
  mergeGooglePreviewEvents,
  pullGoogleCalendarConnection,
  recentGoogleAutoPullUpdatedMin,
} from './googleCalendarAutoImport.js';
import { googleImportedAppointmentNotes } from './googleCalendarImport.js';
import { importGoogleCalendarLast30Days } from './googleCalendarBackfill.js';
import { listGoogleReviewCalendarItems } from './googleCalendarReviewOverlay.js';
import {
  googleImportedOccurrenceUnchanged,
  googleOverlayOccurrenceUnchanged,
  type GoogleImportedOccurrenceRecord,
} from './googleCalendarReconcile.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';
import type { GoogleReviewOverlayRecord } from './googleCalendarReviewOverlay.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const CLIENT = 'client-anna';
const NOW = new Date('2026-08-16T19:00:00.000Z');
const SINCE = '2026-08-16T17:00:00.000Z';
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
    created: '2026-08-16T18:00:00.000Z',
    updated: '2026-08-16T18:00:00.000Z',
    etag: 'etag-1',
    htmlLink: null,
    calendarId: 'primary',
    calendarName: 'Salon',
    ...overrides,
  };
}

function fix2Db(opts: {
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
          update(payload: any) {
            const chain: any = {
              eq() {
                return chain;
              },
              then: async (resolve: any) => {
                for (const row of importedLinkRows) Object.assign(row, payload);
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
              in() {
                return chain;
              },
              maybeSingle: async () => ({ data: appointments[0] ?? null, error: null }),
              then: async (resolve: any) => resolve({ data: appointments, error: null }),
            };
            return chain;
          },
          update(payload: any) {
            const allowed = new Set([
              'date',
              'start_time',
              'end_time',
              'notes',
              'status',
              'staff_id',
              'client_id',
              'service_id',
              'reminder_sent',
            ]);
            const filters: Record<string, string> = {};
            const chain: any = {
              eq(col: string, val: string) {
                filters[col] = val;
                return chain;
              },
              then: async (resolve: any) => {
                const unknown = Object.keys(payload || {}).filter((key) => !allowed.has(key));
                if (unknown.length) {
                  return resolve({
                    error: {
                      message: `Could not find the '${unknown[0]}' column of 'appointments' in the schema cache`,
                    },
                  });
                }
                for (const row of appointments) {
                  if (
                    Object.entries(filters).every(
                      ([k, v]) => String((row as Record<string, unknown>)[k] ?? '') === String(v),
                    )
                  ) {
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
                    [GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY]: SINCE,
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

async function runManual(params: {
  events: GoogleEventPreviewItem[];
  db?: ReturnType<typeof fix2Db>;
  executeImport?: Parameters<typeof importGoogleCalendarLast30Days>[0]['executeImport'];
}) {
  const imports: string[] = [];
  const db = params.db ?? fix2Db();
  const result = await importGoogleCalendarLast30Days({
    db,
    salonId: 'salon-1',
    now: NOW,
    salonTimeZone: 'UTC',
    matchCatalog: CATALOG,
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

describe('GOOGLE-CAL-SYNC-FIX-2 new + update', () => {
  it('1. new Google event → manual sync creates representation', async () => {
    const { result, imports } = await runManual({ events: [previewEvent({ id: 'evt-new' })] });
    assert.equal(result.scanned, 1);
    assert.equal(result.newEvents, 1);
    assert.equal(result.imported, 1);
    assert.deepEqual(imports, ['evt-new']);
  });

  it('2. new post-enable event → FAST-6 creates representation', async () => {
    const imported: string[] = [];
    const result = await pullGoogleCalendarConnection({
      db: fix2Db(),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: CATALOG,
      salonTimeZone: 'UTC',
      eventsOverride: [previewEvent({ id: 'evt-auto-new' })],
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => {
        imported.push(body.eventId);
        return {
          appointmentId: 'a-new',
          clientId: CLIENT,
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(result.imported, 1);
    assert.deepEqual(imported, ['evt-auto-new']);
  });

  it('3. far-future new event → discovered', async () => {
    const { result, imports } = await runManual({
      events: [
        previewEvent({
          id: 'evt-far',
          start: { dateTime: '2027-08-20T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2027-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        }),
      ],
    });
    assert.equal(result.imported, 1);
    assert.deepEqual(imports, ['evt-far']);
    const auto = await pullGoogleCalendarConnection({
      db: fix2Db(),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: CATALOG,
      salonTimeZone: 'UTC',
      eventsOverride: [
        previewEvent({
          id: 'evt-far-auto',
          start: { dateTime: '2027-12-01T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2027-12-01T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        }),
      ],
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => ({
        appointmentId: `a-${body.eventId}`,
        clientId: CLIENT,
        clientCreated: false,
        alreadyImported: false,
      }),
    });
    assert.equal(auto.imported, 1);
  });

  it('4-6. existing overlay title/time edit updates same overlay, no second overlay/client', async () => {
    const db = fix2Db({
      clients: [{ id: CLIENT, name: 'Anna', phone: '' }],
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
            title: 'Anna coloring',
            date: '2026-08-20',
            startTime: '10:00',
            endTime: '12:00',
            durationMinutes: 120,
            staffId: STAFF,
            staffName: 'Tatev Mikaelyan',
            clientId: CLIENT,
          },
        },
      ],
    });
    let importCalls = 0;
    const first = await runManual({
      db,
      events: [
        previewEvent({
          id: 'evt-ov',
          summary: 'Anna haircut',
          start: { dateTime: '2026-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2026-08-20T14:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          etag: 'new-etag',
          updated: '2026-08-16T19:00:00.000Z',
        }),
      ],
      executeImport: async () => {
        importCalls += 1;
        return {
          appointmentId: 'nope',
          clientId: CLIENT,
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(importCalls, 0);
    assert.equal(first.result.updatedEvents, 1);
    assert.equal(first.result.reviewEventsUpdated, 1);
    assert.equal(db.issues.length, 1);
    assert.equal(db.issues[0].parsed_event.title, 'Anna haircut');
    assert.equal(db.issues[0].parsed_event.startTime, '12:00');
    assert.equal(db.clients.length, 1);

    const second = await runManual({
      db,
      events: [
        previewEvent({
          id: 'evt-ov',
          summary: 'Anna haircut',
          start: { dateTime: '2026-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2026-08-20T14:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          etag: 'new-etag',
        }),
      ],
      executeImport: async () => {
        importCalls += 1;
        return {
          appointmentId: 'nope',
          clientId: CLIENT,
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(second.result.unchangedEvents, 1);
    assert.equal(db.issues.length, 1);
    assert.equal(db.clients.length, 1);
  });

  it('7. linked Google appointment time edit updates same appointment', async () => {
    const db = fix2Db({
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
          date: '2026-08-20',
          start_time: '10:00',
          end_time: '12:00',
          status: 'scheduled',
        },
      ],
    });
    let importCalls = 0;
    const { result } = await runManual({
      db,
      events: [
        previewEvent({
          id: 'evt-ap',
          start: { dateTime: '2026-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2026-08-20T14:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          etag: 'moved',
        }),
      ],
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
    assert.equal(result.appointmentsUpdated, 1);
    assert.equal(result.updatedEvents, 1);
    assert.equal(db.appointments.length, 1);
    assert.equal(db.appointments[0].start_time, '12:00');
    assert.equal(db.appointments[0].end_time, '14:00');
  });

  it('8. appointment move conflict → review, no duplicate', async () => {
    const db = fix2Db({
      imported: [
        {
          appointment_id: 'appt-1',
          external_uid: 'evt-ap',
          recurrence_id: '',
          external_calendar_id: 'primary',
        },
      ],
      appointments: [
        {
          id: 'appt-1',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: CLIENT,
          date: '2026-08-20',
          start_time: '10:00',
          end_time: '12:00',
          status: 'scheduled',
        },
        {
          id: 'appt-busy',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: 'other',
          date: '2026-08-20',
          start_time: '12:00',
          end_time: '14:00',
          status: 'confirmed',
        },
      ],
    });
    const { result, imports } = await runManual({
      db,
      events: [
        previewEvent({
          id: 'evt-ap',
          start: { dateTime: '2026-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2026-08-20T14:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
        }),
      ],
    });
    assert.equal(imports.length, 0);
    assert.equal(result.conflicts, 1);
    assert.equal(db.appointments[0].start_time, '10:00');
    assert.equal(db.appointments.length, 2);
    assert.equal(db.issues.length, 1);
    assert.equal(db.issues[0].reason_code, 'appointment_conflict');
  });

  it('9. unchanged represented event skips expensive recreate path', async () => {
    const record: GoogleImportedOccurrenceRecord = {
      appointmentId: 'appt-1',
      etag: 'etag-1',
      lastModified: '2026-08-16T18:00:00.000Z',
      date: '2026-08-20',
      startTime: '10:00',
      endTime: '12:00',
      staffId: STAFF,
      clientId: CLIENT,
      status: 'scheduled',
      notes: null,
    };
    assert.equal(googleImportedOccurrenceUnchanged(previewEvent(), record, 'UTC'), true);
    const overlay: GoogleReviewOverlayRecord = {
      issueId: 'issue-1',
      etag: 'etag-1',
      title: 'Google',
      date: '2026-08-20',
      startTime: '10:00',
      endTime: '12:00',
      staffId: STAFF,
      staffName: 'Tatev',
      reasonCode: 'no_exact_phone',
      clientId: CLIENT,
    };
    const titled = previewEvent({ summary: 'Google' });
    assert.equal(googleOverlayOccurrenceUnchanged(titled, overlay, 'UTC'), true);

    let importCalls = 0;
    const { result } = await runManual({
      db: fix2Db({
        imported: [
          {
            appointment_id: 'appt-1',
            external_uid: 'evt-1',
            recurrence_id: '',
            external_calendar_id: 'primary',
            external_etag: 'etag-1',
          },
        ],
        appointments: [
          {
            id: 'appt-1',
            date: '2026-08-20',
            start_time: '10:00',
            end_time: '12:00',
            staff_id: STAFF,
            status: 'scheduled',
          },
        ],
      }),
      events: [previewEvent()],
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
    assert.equal(result.unchangedEvents, 1);
    assert.equal(result.alreadyImported, 1);
  });

  it('10-12. repeated sync does not duplicate appointment, overlay, or client', async () => {
    const db = fix2Db();
    const ev = previewEvent({ id: 'evt-rep', summary: 'Need review coloring' });
    const first = await runManual({ db, events: [ev] });
    const second = await runManual({ db, events: [ev] });
    assert.equal(first.result.reviewEventsCreated + first.result.imported, 1);
    assert.equal(second.result.newEvents, 0);
    assert.ok(db.issues.length <= 1);
    const uniqueClients = new Set(db.clients.map((c: { id: string }) => c.id));
    assert.equal(uniqueClients.size, db.clients.length);
  });

  it('13. existing event edited multiple times keeps one occurrence identity', async () => {
    const db = fix2Db({
      issues: [
        {
          id: 'issue-1',
          salon_id: 'salon-1',
          calendar_connection_id: 'conn-1',
          external_uid: 'evt-many',
          recurrence_id: '',
          status: 'open',
          reason_code: 'no_exact_phone',
          parsed_event: {
            title: 'One',
            date: '2026-08-20',
            startTime: '10:00',
            endTime: '12:00',
            durationMinutes: 120,
            staffId: STAFF,
            staffName: 'Tatev',
            clientId: CLIENT,
          },
        },
      ],
    });
    await runManual({
      db,
      events: [previewEvent({ id: 'evt-many', summary: 'Two' })],
    });
    await runManual({
      db,
      events: [previewEvent({ id: 'evt-many', summary: 'Three' })],
    });
    assert.equal(db.issues.filter((r: { status: string }) => r.status === 'open').length, 1);
    assert.equal(db.issues[0].external_uid, 'evt-many');
  });

  it('14. manual sync still now−30d → all future', () => {
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    assert.match(backfill, /Event START window: \[now - 30 days, \+∞\)/);
    assert.match(backfill, /No future timeMax/);
  });

  it('15. FIX-1 progress/background behavior remains valid', () => {
    const routes = read('server/src/routes/calendarConnections.ts');
    const progress = read('server/src/lib/googleCalendarBackfillProgress.ts');
    assert.match(routes, /tryBeginGoogleBackfillProgress/);
    assert.match(routes, /status\(202\)/);
    assert.match(routes, /google_backfill_already_running/);
    assert.match(progress, /tryBeginGoogleBackfillProgress/);
  });

  it('16. FAST-6 watermark/page-token session behavior remains valid', () => {
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.match(auto, /GOOGLE_AUTO_IMPORT_SINCE_CONFIG_KEY/);
    assert.match(auto, /mergeAutoImportPageTokenIfSameSession/);
    assert.match(auto, /updatedMin: watermark/);
    assert.doesNotMatch(auto, /auto_import_since\s*=/);
  });

  it('17. Google write methods absent', () => {
    const files = [
      'server/src/lib/googleCalendarBackfill.ts',
      'server/src/lib/googleCalendarAutoImport.ts',
      'server/src/lib/googleCalendarReconcile.ts',
      'server/src/lib/googleCalendarReviewOverlay.ts',
    ];
    for (const rel of files) {
      const src = read(rel);
      assert.doesNotMatch(src, /events\.(insert|update|patch|delete)/);
    }
  });

  it('pre-watermark unrepresented event is not auto-imported', async () => {
    const imported: string[] = [];
    const result = await pullGoogleCalendarConnection({
      db: fix2Db(),
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: CATALOG,
      salonTimeZone: 'UTC',
      eventsOverride: [
        previewEvent({
          id: 'old-unrep',
          created: '2026-07-01T00:00:00.000Z',
        }),
      ],
      isStillEnabled: async () => true,
      executeImport: async ({ body }) => {
        imported.push(body.eventId);
        return {
          appointmentId: 'a',
          clientId: CLIENT,
          clientCreated: false,
          alreadyImported: false,
        };
      },
    });
    assert.equal(imported.length, 0);
    assert.equal(result.imported, 0);
  });

  it('FAST-6 updates the same imported appointment after Google time/title edit', async () => {
    const oldNotes = googleImportedAppointmentNotes('Old title');
    const db = fix2Db({
      imported: [
        {
          appointment_id: 'appt-google',
          external_uid: 'evt-ap',
          recurrence_id: '',
          external_calendar_id: 'primary',
          external_etag: 'old',
        },
      ],
      appointments: [
        {
          id: 'appt-google',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: CLIENT,
          date: '2026-08-20',
          start_time: '11:00',
          end_time: '13:00',
          status: 'scheduled',
          notes: oldNotes,
          source: 'google',
        },
        {
          id: 'appt-owner',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: 'other',
          date: '2026-08-20',
          start_time: '09:00',
          end_time: '10:00',
          status: 'scheduled',
          notes: 'manual',
          source: 'owner',
        },
      ],
    });
    let importCalls = 0;
    const result = await pullGoogleCalendarConnection({
      db,
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: CATALOG,
      salonTimeZone: 'UTC',
      eventsOverride: [
        previewEvent({
          id: 'evt-ap',
          summary: 'New title',
          start: { dateTime: '2026-08-20T12:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          end: { dateTime: '2026-08-20T13:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
          etag: 'moved',
          updated: '2026-08-16T19:00:00.000Z',
        }),
      ],
      isStillEnabled: async () => true,
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
    assert.equal(result.updated, 1);
    assert.equal(result.imported, 0);
    assert.equal(db.appointments.length, 2);
    const google = db.appointments.find((row) => row.id === 'appt-google');
    const owner = db.appointments.find((row) => row.id === 'appt-owner');
    assert.ok(google);
    assert.equal(google.start_time, '12:00');
    assert.equal(google.end_time, '13:00');
    assert.notEqual(google.start_time, '11:00');
    assert.equal(google.notes, googleImportedAppointmentNotes('New title'));
    assert.equal(owner?.start_time, '09:00');
    assert.equal(owner?.end_time, '10:00');
    assert.equal(owner?.notes, 'manual');
    const reconcile = read('server/src/lib/googleCalendarReconcile.ts');
    const updateFn = reconcile.slice(
      reconcile.indexOf('export async function reconcileGoogleSourcedAppointment'),
      reconcile.indexOf('async function touchImportedLink'),
    );
    assert.match(updateFn, /start_time: times.startTime/);
    assert.match(updateFn, /end_time: times.endTime/);
    assert.doesNotMatch(updateFn, /updated_at/);
  });

  it('recent autosync updatedMin is last_sync overlap, not the enable watermark', () => {
    const now = new Date('2026-08-16T19:00:00.000Z');
    const recent = recentGoogleAutoPullUpdatedMin({
      watermark: SINCE,
      lastSyncAt: '2026-08-16T18:55:00.000Z',
      now,
    });
    assert.equal(recent, '2026-08-16T18:50:00.000Z');
    assert.notEqual(recent, SINCE);
    const merged = mergeGooglePreviewEvents(
      [previewEvent({ id: 'edited', etag: 'new' })],
      [previewEvent({ id: 'edited', etag: 'old' }), previewEvent({ id: 'other' })],
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.etag, 'new');
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.match(auto, /recentGoogleAutoPullUpdatedMin/);
    assert.match(auto, /pageToken: null/);
    assert.match(auto, /mergeGooglePreviewEvents/);
  });

  it('FAST-6 refreshes an already represented overlay after Google edit', async () => {
    const db = fix2Db({
      issues: [
        {
          id: 'issue-1',
          salon_id: 'salon-1',
          calendar_connection_id: 'conn-1',
          external_uid: 'evt-old',
          recurrence_id: '',
          status: 'open',
          reason_code: 'no_exact_phone',
          parsed_event: {
            title: 'Old title',
            date: '2026-08-20',
            startTime: '10:00',
            endTime: '12:00',
            durationMinutes: 120,
            staffId: STAFF,
            staffName: 'Tatev',
            clientId: CLIENT,
          },
        },
      ],
    });
    const result = await pullGoogleCalendarConnection({
      db,
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: CATALOG,
      salonTimeZone: 'UTC',
      eventsOverride: [
        previewEvent({
          id: 'evt-old',
          created: '2026-07-01T00:00:00.000Z',
          updated: '2026-08-16T18:30:00.000Z',
          summary: 'New title',
        }),
      ],
      isStillEnabled: async () => true,
      executeImport: async () => {
        throw new Error('must not create');
      },
    });
    assert.equal(result.updated, 1);
    assert.equal(db.issues.length, 1);
    assert.equal(db.issues[0].parsed_event.title, 'New title');
  });

  it('cancelled overlay is dismissed, appointment/client are not deleted', async () => {
    const db = fix2Db({
      clients: [{ id: CLIENT, name: 'Anna', phone: '' }],
      issues: [
        {
          id: 'issue-1',
          salon_id: 'salon-1',
          calendar_connection_id: 'conn-1',
          external_uid: 'evt-can',
          recurrence_id: '',
          status: 'open',
          reason_code: 'no_exact_phone',
          parsed_event: {
            title: 'Anna',
            date: '2026-08-20',
            startTime: '10:00',
            endTime: '12:00',
            durationMinutes: 120,
            staffId: STAFF,
            staffName: 'Tatev',
            clientId: CLIENT,
          },
        },
      ],
    });
    await runManual({
      db,
      events: [previewEvent({ id: 'evt-can', status: 'cancelled' })],
    });
    assert.equal(db.issues[0].status, 'dismissed');
    assert.equal(db.clients.length, 1);
    const overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 0);
  });
});
