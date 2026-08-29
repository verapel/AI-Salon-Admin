/**
 * Week calendar date header vs timed-event layer.
 * Event cards must start below the day/date row; layout math is unchanged.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  WEEK_DAY_HEADER_HEIGHT_PX,
  MOBILE_DAY_HEADER_HEIGHT_PX,
  TIMED_EVENTS_LAYER_OFFSET_PX,
  layoutDayEvents,
  nowLineOffset,
} from '../../../client/src/lib/calendarLayout.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('calendar week date header vs timed events', () => {
  it('reserves a fixed/sticky date header and offsets the timed-events layer', () => {
    assert.equal(WEEK_DAY_HEADER_HEIGHT_PX, 72);
    assert.equal(MOBILE_DAY_HEADER_HEIGHT_PX, 44);
    assert.ok(TIMED_EVENTS_LAYER_OFFSET_PX >= 8);

    const page = read('client/src/pages/Calendar.tsx');
    const desktop = page.slice(page.indexOf('DESKTOP: week grid'));
    const mobileWeek = page.slice(
      page.indexOf("mobileView === 'week'"),
      page.indexOf("mobileView === 'month'"),
    );

    assert.match(page, /WEEK_DAY_HEADER_HEIGHT_PX/);
    assert.match(page, /MOBILE_DAY_HEADER_HEIGHT_PX/);
    assert.match(page, /TIMED_EVENTS_LAYER_OFFSET_PX/);
    assert.match(page, /data-calendar-day-header/);
    assert.match(page, /data-calendar-timed-events/);

    assert.match(desktop, /sticky top-0 z-30/);
    assert.match(desktop, /height: WEEK_DAY_HEADER_HEIGHT_PX/);
    assert.match(desktop, /paddingTop: TIMED_EVENTS_LAYER_OFFSET_PX/);
    assert.ok(
      desktop.indexOf('data-calendar-day-header') < desktop.indexOf('data-calendar-timed-events'),
      'date header must precede the timed-events layer',
    );
    assert.ok(desktop.indexOf('z-30') < desktop.indexOf('data-calendar-timed-events'));
    assert.match(desktop, /relative z-0/);

    assert.match(mobileWeek, /height: MOBILE_DAY_HEADER_HEIGHT_PX/);
    assert.match(mobileWeek, /paddingTop: TIMED_EVENTS_LAYER_OFFSET_PX/);
    assert.match(mobileWeek, /data-calendar-day-header/);
    assert.match(page, /MOBILE: today \/ week \/ month[\s\S]*lg:hidden/);

    const dayTimeline = page.slice(page.indexOf('function DayTimeline'), page.indexOf('function TimeGutter'));
    assert.match(dayTimeline, /overflow-hidden/);
    assert.doesNotMatch(dayTimeline, /absolute z-10/);
    assert.match(dayTimeline, /nowLineOffset/);

    assert.doesNotMatch(page, /events\.(insert|update|patch|delete)/);
  });

  it('keeps event start/end, overlap columns, and now-line math on the time grid', () => {
    const laid = layoutDayEvents(
      [
        { id: 'a', startTime: '08:00', endTime: '09:00' },
        { id: 'b', startTime: '08:30', endTime: '09:30' },
        { id: 'c', startTime: '10:00', endTime: '11:00' },
      ],
      8,
      19,
      60,
    );
    assert.equal(laid.length, 3);
    assert.equal(laid[0]?.top, 0);
    assert.equal(laid[0]?.height, 60);
    assert.equal(laid[1]?.top, 30);
    assert.ok((laid[0]?.columnCount ?? 0) >= 2);
    assert.notEqual(laid[0]?.column, laid[1]?.column);
    assert.equal(laid[2]?.columnCount, 1);
    assert.equal(laid[2]?.top, 2 * 60);

    const nowTop = nowLineOffset(8, 60, new Date(2026, 7, 29, 10, 0, 0));
    assert.equal(nowTop, 2 * 60);
  });
});
