/**
 * Telegram availability must treat stored calendar appointments as busy,
 * including source=google, using full interval overlap (not start-time match).
 * Does not call live Supabase. Does not touch Google sync or Telegram FSM.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FALLBACK_SLOT_STARTS,
  filterSlotsByBusyAppointments,
} from './scheduleSlots.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('Telegram busy slots include Google calendar appointments', () => {
  it('Google 11:00–13:00 blocks overlapping Telegram slots; others stay free', () => {
    const slots = filterSlotsByBusyAppointments(
      FALLBACK_SLOT_STARTS,
      60,
      [{ start_time: '11:00', end_time: '13:00' }]
    );
    assert.equal(slots.includes('11:00'), false);
    assert.equal(slots.includes('12:00'), false);
    assert.ok(slots.includes('10:00'));
    assert.ok(slots.includes('13:00'));
  });

  it('uses full interval overlap, not start-time equality', () => {
    const slots = filterSlotsByBusyAppointments(
      ['10:00', '11:00', '12:00', '13:00'],
      60,
      [{ start_time: '11:00:00', end_time: '13:00:00' }]
    );
    assert.deepEqual(slots, ['10:00', '13:00']);
  });

  it('owner and telegram appointments still block overlapping slots', () => {
    const owner = filterSlotsByBusyAppointments(FALLBACK_SLOT_STARTS, 60, [
      { start_time: '09:00', end_time: '10:00' },
    ]);
    assert.equal(owner.includes('09:00'), false);
    assert.ok(owner.includes('08:00'));
    assert.ok(owner.includes('10:00'));

    const telegram = filterSlotsByBusyAppointments(FALLBACK_SLOT_STARTS, 60, [
      { start_time: '15:00', end_time: '16:00' },
    ]);
    assert.equal(telegram.includes('15:00'), false);
    assert.ok(telegram.includes('14:00'));
    assert.ok(telegram.includes('16:00'));
  });

  it('busy query keeps all sources and does not filter appointments by staff', () => {
    const src = read('server/src/lib/scheduleSlots.ts');
    const loadStart = src.indexOf('Salon-calendar busy set');
    const load = src.slice(loadStart, src.indexOf('if (bookedError)', loadStart));
    assert.ok(loadStart > 0);
    assert.match(load, /from\('appointments'\)/);
    assert.match(load, /\.eq\('salon_id', salonId\)/);
    assert.match(load, /\.eq\('date', date\)/);
    assert.match(load, /\.in\('status', ACTIVE_SLOT_STATUSES\)/);
    assert.doesNotMatch(load, /\.eq\('staff_id'/);
    assert.doesNotMatch(load, /\.(eq|neq|in)\(\s*['"]source['"]/);
    assert.match(src, /filterSlotsByBusyAppointments\(/);
    assert.match(read('server/src/index.ts'), /getAvailableSlots/);
  });
});
