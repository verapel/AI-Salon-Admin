/**
 * /bookings bulk selection + Google-duplicate safety.
 * Automatic cleanup must touch source=google only.
 * Bulk delete cancels only user-selected IDs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isVisibleOnBookingsAll } from '../../../client/src/lib/bookingsVisibility.ts';
import { cancelSelectedAppointments } from './appointmentBulkDelete.ts';
import { persistCanonicalGoogleBusyAppointment } from './googleCalendarReconcile.ts';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('bookings bulk select + Google duplicate safety', () => {
  const bookings = read('client/src/pages/Bookings.tsx');
  const api = read('client/src/lib/api.ts');
  const appointments = read('server/src/routes/appointments.ts');
  const reconcile = read('server/src/lib/googleCalendarReconcile.ts');
  const auto = read('server/src/lib/googleCalendarAutoImport.ts');
  const translations = read('client/src/i18n/translations.ts');

  it('All tab hides cancelled Google rows and keeps cancelled manual/Telegram', () => {
    assert.equal(
      isVisibleOnBookingsAll({ status: 'scheduled', source: 'google' }),
      true,
    );
    assert.equal(
      isVisibleOnBookingsAll({ status: 'confirmed', source: 'google' }),
      true,
    );
    assert.equal(
      isVisibleOnBookingsAll({ status: 'cancelled', source: 'google' }),
      false,
    );
    assert.equal(
      isVisibleOnBookingsAll({ status: 'cancelled', source: 'telegram' }),
      true,
    );
    assert.equal(
      isVisibleOnBookingsAll({ status: 'cancelled', source: 'owner' }),
      true,
    );
    assert.equal(
      isVisibleOnBookingsAll({ status: 'scheduled', source: 'telegram' }),
      true,
    );
    assert.match(bookings, /appointments\.filter\(isVisibleOnBookingsAll\)/);
  });

  it('has per-row checkboxes, select-all visible, and confirmed bulk delete of selected IDs only', () => {
    assert.match(bookings, /toggleRowSelected/);
    assert.match(bookings, /toggleSelectAllVisible/);
    assert.match(bookings, /type="checkbox"/);
    assert.match(bookings, /bookings\.selectRow/);
    assert.match(bookings, /bookings\.selectAll/);
    assert.match(bookings, /bookings\.deleteSelected/);
    assert.match(bookings, /deleteSelectedConfirm/);
    assert.match(bookings, /confirm\(t\('bookings\.deleteSelectedConfirm'\)/);
    assert.match(
      bookings,
      /const ids = visibleIds\.filter\(\(id\) => selectedIds\.has\(id\)\)/,
    );
    assert.match(bookings, /api\.appointments\.bulkDelete\(ids\)/);
    assert.match(bookings, /setAppointments\(\(prev\) => prev\.filter/);
    assert.doesNotMatch(bookings, /bulkDelete\(appointments\.map/);
    assert.doesNotMatch(bookings, /source === 'telegram'[\s\S]{0,80}bulkDelete/);
  });

  it('API and route cancel only the provided IDs with no automatic source filter', () => {
    assert.match(api, /bulkDelete:\s*\(ids:\s*string\[\]\)/);
    assert.match(api, /\/appointments\/bulk-delete/);
    assert.match(api, /JSON\.stringify\(\{\s*ids\s*\}\)/);

    const bulkStart = appointments.indexOf("router.post('/bulk-delete'");
    const bulkEnd = appointments.indexOf("router.post('/',", bulkStart);
    assert.ok(bulkStart > 0 && bulkEnd > bulkStart);
    const bulk = appointments.slice(bulkStart, bulkEnd);
    assert.match(bulk, /cancelSelectedAppointments/);
    assert.match(bulk, /normalizeAppointmentIds/);
    assert.doesNotMatch(bulk, /\.eq\('source'/);
    assert.match(bulk, /cancelledIds/);

    const helper = read('server/src/lib/appointmentBulkDelete.ts');
    assert.match(helper, /\.in\('id',\s*ids\)/);
    assert.match(helper, /\.in\('id',\s*selectedIds\)/);
    assert.match(helper, /\.eq\('salon_id',\s*params\.salonId\)/);
    assert.doesNotMatch(helper, /\.eq\('source'/);
    assert.doesNotMatch(helper, /from\('clients'\)/);
  });

  it('automatic Google cleanup deactivates source=google only', () => {
    const indexFn = reconcile.slice(
      reconcile.indexOf('export async function deactivateIndexGoogleSourcedDuplicates'),
      reconcile.indexOf('export async function deactivateDuplicateGoogleSourcedAppointments'),
    );
    const dupFn = reconcile.slice(
      reconcile.indexOf('export async function deactivateDuplicateGoogleSourcedAppointments'),
      reconcile.indexOf('export async function reconcileGoogleSourcedAppointment'),
    );
    const orphanFn = auto.slice(
      auto.indexOf('export async function deactivateUnlinkedLegacyGoogleOrphans'),
      auto.indexOf('export function readAutoImportSinceFromConfig'),
    );
    const missingFn = auto.slice(
      auto.indexOf('export function collectMissingLinkedGoogleAppointments'),
      auto.indexOf('function cancelledStubForLinkedRecord'),
    );

    assert.match(indexFn, /\.eq\('source',\s*'google'\)/);
    assert.match(dupFn, /\.eq\('source',\s*'google'\)/);
    assert.match(orphanFn, /\.eq\('source',\s*'google'\)/);
    assert.match(orphanFn, /row\.source !== 'google'/);
    assert.match(missingFn, /!== 'google'/);
    assert.doesNotMatch(indexFn, /\.eq\('source',\s*'telegram'\)/);
    assert.doesNotMatch(dupFn, /\.eq\('source',\s*'telegram'\)/);
    assert.doesNotMatch(orphanFn, /\.eq\('source',\s*'telegram'\)/);
  });

  it('RU bulk-delete label is present and each locale has one confirm key', () => {
    assert.match(translations, /'bookings\.deleteSelected': 'Удалить выбранные'/);
    assert.match(
      translations,
      /'bookings\.deleteSelectedConfirm': 'Delete \{count\} selected appointment\(s\)\?'/,
    );
    assert.match(
      translations,
      /'bookings\.deleteSelectedConfirm': 'Удалить выбранные записи \(\{count\}\)\?'/,
    );
    const confirmKeys = translations.match(/'bookings\.deleteSelectedConfirm':/g) ?? [];
    assert.equal(confirmKeys.length, 3);
  });
});

function bulkDb(appointments: Array<Record<string, unknown>>, clients: Array<Record<string, unknown>>) {
  const match = (row: Record<string, unknown>, filters: Record<string, unknown>, inFilters: Record<string, unknown[]>) => {
    for (const [k, v] of Object.entries(filters)) {
      if (String(row[k] ?? '') !== String(v)) return false;
    }
    for (const [k, vals] of Object.entries(inFilters)) {
      if (!vals.map(String).includes(String(row[k] ?? ''))) return false;
    }
    return true;
  };
  const tableApi = (rows: Array<Record<string, unknown>>) => ({
    select() {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, unknown[]> = {};
      const chain: any = {
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        in(col: string, vals: unknown[]) {
          inFilters[col] = vals;
          return chain;
        },
        then: async (resolve: any) =>
          resolve({
            data: rows.filter((row) => match(row, filters, inFilters)),
            error: null,
          }),
      };
      return chain;
    },
    update(payload: Record<string, unknown>) {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, unknown[]> = {};
      const chain: any = {
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        in(col: string, vals: unknown[]) {
          inFilters[col] = vals;
          return chain;
        },
        select() {
          return chain;
        },
        then: async (resolve: any) => {
          const changed: Array<Record<string, unknown>> = [];
          for (const row of rows) {
            if (match(row, filters, inFilters)) {
              Object.assign(row, payload);
              changed.push(row);
            }
          }
          return resolve({ data: changed, error: null });
        },
      };
      return chain;
    },
    insert(row: Record<string, unknown>) {
      const created = { id: row.id || `appt-${rows.length + 1}`, ...row };
      rows.push(created);
      return {
        then: async (resolve: any) => resolve({ data: created, error: null }),
      };
    },
  });
  return {
    appointments,
    clients,
    from(table: string) {
      if (table === 'appointments') return tableApi(appointments);
      if (table === 'clients') return tableApi(clients);
      if (table === 'appointment_external_links') {
        return {
          insert() {
            return { then: async (resolve: any) => resolve({ error: null }) };
          },
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
      }
      return tableApi([]);
    },
  };
}

function previewDupEvent(): GoogleEventPreviewItem {
  return {
    id: 'evt-dup',
    iCalUID: null,
    summary: 'Duplicate Google card',
    description: null,
    location: null,
    status: 'confirmed',
    start: { dateTime: '2026-08-20T10:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    end: { dateTime: '2026-08-20T11:00:00.000Z', date: null, timeZone: 'UTC', allDay: false },
    recurringEventId: null,
    originalStartTime: null,
    created: '2026-08-16T18:00:00.000Z',
    updated: '2026-08-16T18:00:00.000Z',
    etag: 'etag-dup',
    htmlLink: null,
    calendarId: 'primary',
    calendarName: 'Salon',
  };
}

describe('bookings bulk delete persists and does not recreate Google dups', () => {
  it('cancels selected google duplicate IDs, hides them after refresh, keeps clients and telegram/manual', async () => {
    const clients = [{ id: 'client-anna', name: 'Anna', phone: '' }];
    const appointments: Array<Record<string, unknown>> = [
      {
        id: 'g-dup-1',
        salon_id: 'salon-1',
        client_id: 'client-anna',
        staff_id: 'staff-1',
        service_id: 'svc-1',
        date: '2026-08-20',
        start_time: '10:00',
        end_time: '11:00',
        status: 'scheduled',
        source: 'google',
        source_external_event_id: 'primary:evt-dup',
        notes: 'Google Calendar import\nDuplicate Google card',
      },
      {
        id: 'g-dup-2',
        salon_id: 'salon-1',
        client_id: 'client-anna',
        staff_id: 'staff-1',
        service_id: 'svc-1',
        date: '2026-08-20',
        start_time: '10:00',
        end_time: '11:00',
        status: 'scheduled',
        source: 'google',
        source_external_event_id: 'primary:evt-dup',
        notes: 'Google Calendar import\nDuplicate Google card',
      },
      {
        id: 'appt-telegram',
        salon_id: 'salon-1',
        client_id: 'client-anna',
        staff_id: 'staff-1',
        service_id: 'svc-1',
        date: '2026-08-20',
        start_time: '14:00',
        end_time: '15:00',
        status: 'scheduled',
        source: 'telegram',
        notes: 'telegram booking',
      },
      {
        id: 'appt-owner',
        salon_id: 'salon-1',
        client_id: 'client-anna',
        staff_id: 'staff-1',
        service_id: 'svc-1',
        date: '2026-08-20',
        start_time: '16:00',
        end_time: '17:00',
        status: 'scheduled',
        source: 'owner',
        notes: 'manual',
      },
    ];
    const db = bulkDb(appointments, clients);

    const result = await cancelSelectedAppointments({
      db,
      salonId: 'salon-1',
      ids: ['g-dup-1', 'g-dup-2'],
      skipReminders: async () => undefined,
    });
    assert.deepEqual(result.cancelledIds.sort(), ['g-dup-1', 'g-dup-2']);

    const afterDelete = appointments.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      source: String(row.source || 'owner'),
    }));
    const cardsAfterDelete = afterDelete.filter(isVisibleOnBookingsAll);
    assert.equal(cardsAfterDelete.some((row) => row.id === 'g-dup-1'), false);
    assert.equal(cardsAfterDelete.some((row) => row.id === 'g-dup-2'), false);
    assert.ok(cardsAfterDelete.some((row) => row.id === 'appt-telegram'));
    assert.ok(cardsAfterDelete.some((row) => row.id === 'appt-owner'));
    assert.equal(appointments.find((row) => row.id === 'appt-telegram')?.status, 'scheduled');
    assert.equal(appointments.find((row) => row.id === 'appt-owner')?.status, 'scheduled');
    assert.equal(clients.length, 1);
    assert.equal(clients[0]?.id, 'client-anna');

    const sync = await persistCanonicalGoogleBusyAppointment({
      db,
      salonId: 'salon-1',
      calendarConnectionId: 'conn-1',
      ev: previewDupEvent(),
      staffId: 'staff-1',
      staffName: 'Tatev',
      salonTimeZone: 'UTC',
      clientId: 'client-anna',
      serviceId: 'svc-1',
      importedIndex: { keys: new Set(), byKey: new Map(), sharedGoogleClientIds: new Set() },
    });
    assert.equal(sync.kind, 'unchanged');
    assert.ok(sync.appointmentId === 'g-dup-1' || sync.appointmentId === 'g-dup-2');

    const afterSync = appointments.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      source: String(row.source || 'owner'),
    }));
    const cardsAfterRefresh = afterSync.filter(isVisibleOnBookingsAll);
    assert.equal(appointments.filter((row) => row.id === 'g-dup-1' || row.id === 'g-dup-2').every((row) => row.status === 'cancelled'), true);
    assert.equal(cardsAfterRefresh.some((row) => row.id === 'g-dup-1' || row.id === 'g-dup-2'), false);
    assert.equal(
      appointments.filter((row) => row.source === 'google' && row.status !== 'cancelled').length,
      0,
    );
    assert.equal(appointments.find((row) => row.id === 'appt-telegram')?.status, 'scheduled');
    assert.equal(appointments.find((row) => row.id === 'appt-owner')?.status, 'scheduled');
    assert.equal(clients.length, 1);
    assert.equal(clients[0]?.name, 'Anna');

    const reconcile = read('server/src/lib/googleCalendarReconcile.ts');
    assert.doesNotMatch(reconcile, /events\.insert|calendar\.events\.delete|events\.update/);
  });
});
