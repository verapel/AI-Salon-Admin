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
    assert.match(bulk, /\.in\('id',\s*ids\)/);
    assert.match(bulk, /\.eq\('salon_id',\s*salonId\)/);
    assert.doesNotMatch(bulk, /\.eq\('source'/);
    assert.match(bulk, /cancelledIds/);
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
