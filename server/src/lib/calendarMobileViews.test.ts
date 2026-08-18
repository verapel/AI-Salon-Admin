/**
 * FIX-MOBILE-CALENDAR-VIEWS: mobile Today/Week/Month tabs.
 * Does not execute SQL. Does not call Google APIs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('FIX-MOBILE-CALENDAR-VIEWS', () => {
  it('mobile tabs switch Today/Week/Month without changing desktop or Google overlay', () => {
    const page = read('client/src/pages/Calendar.tsx');
    const ru = read('client/src/i18n/translations.ts');
    const mobileHeader = page.slice(page.indexOf('MOBILE HEADER'), page.indexOf('DESKTOP HEADER'));
    const mobileBody = page.slice(page.indexOf('MOBILE: today / week / month'), page.indexOf('DESKTOP: week grid'));
    const desktop = page.slice(page.indexOf('DESKTOP: week grid'));

    assert.match(mobileHeader, /setMobileView\(view\)/);
    assert.match(mobileHeader, /calendar\.today/);
    assert.match(mobileHeader, /calendar\.week/);
    assert.match(mobileHeader, /calendar\.month/);
    assert.match(ru, /'calendar\.week': 'Неделя'/);
    assert.match(ru, /'calendar\.month': 'Месяц'/);

    assert.match(mobileBody, /mobileView === 'today'/);
    assert.match(mobileBody, /todayAppointments/);
    assert.match(mobileBody, /mobileView === 'week'/);
    assert.match(mobileBody, /mobileWeekDays/);
    assert.match(mobileBody, /mobileView === 'month'/);
    assert.match(mobileBody, /mobileMonthCells/);
    assert.match(page, /kind === 'google_review'/);
    assert.match(page, /matchesStaffFilter/);
    assert.match(page, /overflow-x-clip/);

    assert.match(page, /WEEK_GRID_CLASS/);
    assert.match(page, /navigateWeek/);
    assert.match(desktop, /hidden lg:block/);
    assert.doesNotMatch(desktop, /setMobileView/);

    assert.match(page, /getGoogleReviewEvents/);
    assert.doesNotMatch(page, /events\.(insert|update|patch|delete)/);
  });
});
