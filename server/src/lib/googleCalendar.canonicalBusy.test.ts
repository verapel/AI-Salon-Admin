/**
 * Canonical Google busy appointments + event-timezone clocks.
 * Reproduces: (A) visual-only "Требует проверки" missing from bookings
 * and (B) one-hour Yerevan→Moscow shift, then asserts the required invariant.
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
  pullGoogleCalendarConnection,
} from './googleCalendarAutoImport.js';
import { listGoogleReviewCalendarItems } from './googleCalendarReviewOverlay.js';
import { googleEventCalendarTimes } from './googleCalendarReviewOverlay.js';
import { filterSlotsByBusyAppointments, FALLBACK_SLOT_STARTS } from './scheduleSlots.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STAFF = 'staff-tatev';
const SERVICE = 'service-color';
const CLIENT = 'client-anna';
const SINCE = '2026-08-16T17:00:00.000Z';
const PROD_CAL = 'tatevik.miqaelyan@gmail.com';

function yerevanEvent(
  id: string,
  date: string,
  start: string,
  end: string,
  summary: string,
): GoogleEventPreviewItem {
  return {
    id,
    iCalUID: `${id}@google.com`,
    summary,
    description: null,
    location: null,
    status: 'confirmed',
    start: {
      dateTime: `${date}T${start}:00+04:00`,
      date: null,
      timeZone: 'Asia/Yerevan',
      allDay: false,
    },
    end: {
      dateTime: `${date}T${end}:00+04:00`,
      date: null,
      timeZone: 'Asia/Yerevan',
      allDay: false,
    },
    recurringEventId: null,
    originalStartTime: null,
    created: '2026-08-20T18:00:00.000Z',
    updated: '2026-08-29T18:00:00.000Z',
    etag: `etag-${id}`,
    htmlLink: null,
    calendarId: PROD_CAL,
    calendarName: 'Salon',
  };
}

function busyDb(opts: {
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
          insert(row: any) {
            importedLinkRows.push({
              appointment_id: row.appointment_id,
              external_uid: row.external_uid,
              recurrence_id: row.recurrence_id || '',
              external_calendar_id: row.external_calendar_id || '',
              ...row,
            });
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
              maybeSingle: async () => ({ data: appointments[0] ?? null, error: null }),
              then: async (resolve: any) => resolve({ data: appointments, error: null }),
            };
            return chain;
          },
          insert(row: any) {
            const created = {
              id: row.id || `appt-${appointments.length + 1}`,
              salon_id: row.salon_id,
              status: row.status || 'scheduled',
              reminder_sent: row.reminder_sent ?? false,
              ...row,
            };
            appointments.push(created);
            return {
              select() {
                return { single: async () => ({ data: created, error: null }) };
              },
              then: async (resolve: any) => resolve({ data: created, error: null }),
            };
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
                  data: [{ id: STAFF, name: 'Tatev Mikaelyan' }],
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
                  selected_calendar_id: PROD_CAL,
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

function bookingsFromAppointments(rows: Array<Record<string, unknown>>) {
  return rows
    .filter((row) => String(row.status || '') !== 'cancelled')
    .map((row) => ({
      id: String(row.id),
      date: String(row.date || '').slice(0, 10),
      startTime: String(row.start_time || '').slice(0, 5),
      endTime: String(row.end_time || '').slice(0, 5),
      source: String(row.source || ''),
      notes: String(row.notes || ''),
      clientId: String(row.client_id || ''),
    }));
}

async function pullUnmatched(params: {
  db: ReturnType<typeof busyDb>;
  events: GoogleEventPreviewItem[];
  authoritative?: GoogleEventPreviewItem[];
}) {
  return pullGoogleCalendarConnection({
    db: params.db,
    salonId: 'salon-1',
    connectionId: 'conn-1',
    matchCatalog: {
      clients: [],
      services: CATALOG.services,
    },
    salonTimeZone: 'Europe/Moscow',
    eventsOverride: params.events,
    authoritativeOverride: params.authoritative
      ? {
          events: params.authoritative,
          complete: true,
          timeMin: '2026-07-30T00:00:00.000Z',
          timeMax: '2026-11-27T00:00:00.000Z',
        }
      : undefined,
    isStillEnabled: async () => true,
    executeImport: async () => {
      throw new Error('recognition failed — must persist busy without executeImport');
    },
  });
}

describe('canonical Google busy + event timezone', () => {
  it('B. googleEventCalendarTimes: Sep1 15:00–17:00 Yerevan is not 14:00–16:00 Moscow', () => {
    const ev = yerevanEvent('evt-sep1', '2026-09-01', '15:00', '17:00', 'Unknown title');
    const times = googleEventCalendarTimes(ev, 'Europe/Moscow');
    assert.equal(times?.date, '2026-09-01');
    assert.equal(times?.startTime, '15:00');
    assert.equal(times?.endTime, '17:00');
  });

  it('B. googleEventCalendarTimes: Sep2 13:00–15:00 Yerevan is not 12:00–14:00 Moscow', () => {
    const ev = yerevanEvent('evt-sep2', '2026-09-02', '13:00', '15:00', 'Unknown title');
    const times = googleEventCalendarTimes(ev, 'Europe/Moscow');
    assert.equal(times?.startTime, '13:00');
    assert.equal(times?.endTime, '15:00');
  });

  it('A+B. unmatched Sep1 becomes source=google appointment at 15:00–17:00, in bookings, no overlay dup', async () => {
    const ev = yerevanEvent('evt-sep1', '2026-09-01', '15:00', '17:00', 'Random Google title');
    const db = busyDb();
    await pullUnmatched({ db, events: [ev] });
    const googleRows = db.appointments.filter(
      (row) => row.source === 'google' && row.status !== 'cancelled',
    );
    assert.equal(googleRows.length, 1);
    assert.equal(String(googleRows[0]?.date).slice(0, 10), '2026-09-01');
    assert.equal(String(googleRows[0]?.start_time).slice(0, 5), '15:00');
    assert.equal(String(googleRows[0]?.end_time).slice(0, 5), '17:00');
    assert.equal(googleRows[0]?.staff_id, STAFF);
    assert.ok(String(googleRows[0]?.notes || '').includes('Random Google title'));
    const bookings = bookingsFromAppointments(db.appointments);
    assert.ok(bookings.some((b) => b.startTime === '15:00' && b.endTime === '17:00'));
    const overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 0);
    const slots = filterSlotsByBusyAppointments(FALLBACK_SLOT_STARTS, 60, [
      { start_time: String(googleRows[0]?.start_time), end_time: String(googleRows[0]?.end_time) },
    ]);
    assert.equal(slots.includes('15:00'), false);
    assert.equal(slots.includes('16:00'), false);
    assert.ok(slots.includes('14:00'));
    assert.ok(slots.includes('17:00'));
  });

  it('A+B. unmatched Sep2 is exactly 13:00–15:00 everywhere', async () => {
    const ev = yerevanEvent('evt-sep2', '2026-09-02', '13:00', '15:00', 'Another title');
    const db = busyDb();
    await pullUnmatched({ db, events: [ev] });
    const row = db.appointments.find((a) => a.source === 'google');
    assert.equal(String(row?.start_time).slice(0, 5), '13:00');
    assert.equal(String(row?.end_time).slice(0, 5), '15:00');
    assert.ok(bookingsFromAppointments(db.appointments).some((b) => b.startTime === '13:00'));
  });

  it('A. existing visual-only overlay is promoted to the same canonical appointment', async () => {
    const ev = yerevanEvent('evt-sep1', '2026-09-01', '15:00', '17:00', 'Needs review');
    const db = busyDb({
      issues: [
        {
          id: 'issue-1',
          salon_id: 'salon-1',
          calendar_connection_id: 'conn-1',
          external_uid: 'evt-sep1',
          recurrence_id: '',
          status: 'open',
          reason_code: 'service_not_matched',
          parsed_event: {
            title: 'Needs review',
            date: '2026-09-01',
            startTime: '14:00',
            endTime: '16:00',
            durationMinutes: 120,
            staffId: STAFF,
            staffName: 'Tatev',
            clientId: CLIENT,
          },
        },
      ],
      clients: [{ id: CLIENT, name: 'Needs review', phone: '' }],
    });
    await pullUnmatched({ db, events: [ev] });
    const row = db.appointments.find((a) => a.source === 'google' && a.status !== 'cancelled');
    assert.ok(row);
    assert.equal(String(row?.start_time).slice(0, 5), '15:00');
    assert.equal(String(row?.end_time).slice(0, 5), '17:00');
    assert.equal(
      bookingsFromAppointments(db.appointments).some((b) => b.id === String(row?.id)),
      true,
    );
    const overlay = await listGoogleReviewCalendarItems({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
    });
    assert.equal(overlay.length, 0);
  });

  it('legacy Aug 30 11:00 rows update to current Google Yerevan clocks on same rows', async () => {
    const evA = yerevanEvent('evt-a', '2026-08-30', '12:00', '13:00', 'A');
    const evB = yerevanEvent('evt-b', '2026-08-30', '12:30', '13:30', 'B');
    const evC = yerevanEvent('evt-c', '2026-08-30', '14:00', '15:00', 'C');
    const db = busyDb({
      imported: [
        {
          appointment_id: 'appt-a',
          external_uid: 'evt-a',
          recurrence_id: '',
          external_calendar_id: PROD_CAL,
        },
        {
          appointment_id: 'appt-b',
          external_uid: 'evt-b',
          recurrence_id: '',
          external_calendar_id: PROD_CAL,
        },
        {
          appointment_id: 'appt-c',
          external_uid: 'evt-c',
          recurrence_id: '',
          external_calendar_id: PROD_CAL,
        },
      ],
      appointments: [
        {
          id: 'appt-a',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: 'client-a',
          date: '2026-08-30',
          start_time: '11:00',
          end_time: '12:00',
          status: 'scheduled',
          notes: 'Google Calendar import\nA',
          source: 'google',
        },
        {
          id: 'appt-b',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: 'client-b',
          date: '2026-08-30',
          start_time: '11:00',
          end_time: '13:00',
          status: 'scheduled',
          notes: 'Google Calendar import\nB',
          source: 'google',
        },
        {
          id: 'appt-c',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: 'client-c',
          date: '2026-08-30',
          start_time: '11:00',
          end_time: '13:00',
          status: 'scheduled',
          notes: 'Google Calendar import\nC',
          source: 'google',
        },
        {
          id: 'appt-telegram',
          salon_id: 'salon-1',
          staff_id: STAFF,
          client_id: 'other',
          date: '2026-08-30',
          start_time: '18:00',
          end_time: '19:00',
          status: 'scheduled',
          notes: 'telegram booking',
          source: 'telegram',
        },
      ],
      clients: [
        { id: 'client-a', name: 'A', phone: '' },
        { id: 'client-b', name: 'B', phone: '' },
        { id: 'client-c', name: 'C', phone: '' },
        { id: 'other', name: 'TG', phone: '' },
      ],
    });
    await pullGoogleCalendarConnection({
      db,
      salonId: 'salon-1',
      connectionId: 'conn-1',
      matchCatalog: CATALOG,
      salonTimeZone: 'Europe/Moscow',
      eventsOverride: [evA, evB, evC],
      authoritativeOverride: {
        events: [evA, evB, evC],
        complete: true,
        timeMin: '2026-07-30T00:00:00.000Z',
        timeMax: '2026-11-27T00:00:00.000Z',
      },
      isStillEnabled: async () => true,
      executeImport: async () => {
        throw new Error('must update existing rows');
      },
    });
    const a = db.appointments.find((row) => row.id === 'appt-a');
    const b = db.appointments.find((row) => row.id === 'appt-b');
    const c = db.appointments.find((row) => row.id === 'appt-c');
    const telegram = db.appointments.find((row) => row.id === 'appt-telegram');
    assert.equal(String(a?.start_time).slice(0, 5), '12:00');
    assert.equal(String(a?.end_time).slice(0, 5), '13:00');
    assert.equal(String(b?.start_time).slice(0, 5), '12:30');
    assert.equal(String(b?.end_time).slice(0, 5), '13:30');
    assert.equal(String(c?.start_time).slice(0, 5), '14:00');
    assert.equal(String(c?.end_time).slice(0, 5), '15:00');
    assert.equal(a?.id, 'appt-a');
    assert.equal(b?.id, 'appt-b');
    assert.equal(c?.id, 'appt-c');
    assert.equal(telegram?.start_time, '18:00');
    assert.equal(telegram?.source, 'telegram');
    assert.equal(db.clients.length, 4);
  });

  it('move Sep1 updates SAME appointment id; delete deactivates only that Google row', async () => {
    const first = yerevanEvent('evt-sep1', '2026-09-01', '15:00', '17:00', 'Hold');
    const db = busyDb();
    await pullUnmatched({ db, events: [first] });
    const created = db.appointments.find((row) => row.source === 'google');
    const appointmentId = created?.id;
    assert.ok(appointmentId);
    const clientId = created?.client_id;
    const moved = yerevanEvent('evt-sep1', '2026-09-01', '16:00', '18:00', 'Hold moved');
    await pullUnmatched({ db, events: [moved], authoritative: [moved] });
    const afterMove = db.appointments.find((row) => row.id === appointmentId);
    assert.equal(String(afterMove?.start_time).slice(0, 5), '16:00');
    assert.equal(String(afterMove?.end_time).slice(0, 5), '18:00');
    assert.equal(afterMove?.id, appointmentId);
    const deleted = { ...moved, status: 'cancelled' };
    await pullUnmatched({ db, events: [deleted], authoritative: [deleted] });
    const afterDelete = db.appointments.find((row) => row.id === appointmentId);
    assert.equal(afterDelete?.status, 'cancelled');
    assert.ok(db.clients.some((cl) => cl.id === clientId));
    const slots = filterSlotsByBusyAppointments(FALLBACK_SLOT_STARTS, 60, []);
    assert.ok(slots.includes('16:00'));
  });

  it('Calendar still merges appointments + review overlay; Bookings is appointments-only', () => {
    const calendar = read('client/src/pages/Calendar.tsx');
    const bookings = read('client/src/pages/Bookings.tsx');
    assert.match(calendar, /appointments\.filter/);
    assert.match(calendar, /reviewEvents\.map\(reviewToBlock\)/);
    assert.match(calendar, /getGoogleReviewEvents/);
    assert.match(bookings, /appointments\.getAll\(\)/);
    assert.doesNotMatch(bookings, /getGoogleReviewEvents/);
  });
});
