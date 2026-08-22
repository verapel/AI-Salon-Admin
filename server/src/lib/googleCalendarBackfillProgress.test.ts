import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginGoogleBackfillProgress,
  getGoogleBackfillProgress,
  googleBackfillPercent,
  updateGoogleBackfillProgress,
} from './googleCalendarBackfillProgress.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('Google manual sync live progress', () => {
  it('computes real percent from processed/total, not a timer', () => {
    assert.equal(googleBackfillPercent(0, null, 'listing'), 0);
    assert.equal(googleBackfillPercent(0, 4, 'processing'), 0);
    assert.equal(googleBackfillPercent(1, 4, 'processing'), 25);
    assert.equal(googleBackfillPercent(2, 4, 'processing'), 50);
    assert.equal(googleBackfillPercent(4, 4, 'processing'), 100);
    assert.equal(googleBackfillPercent(3, 4, 'done'), 100);
  });

  it('stores salon-scoped progress snapshots', () => {
    beginGoogleBackfillProgress('salon-progress-a');
    updateGoogleBackfillProgress('salon-progress-a', {
      status: 'processing',
      processed: 2,
      total: 8,
    });
    const a = getGoogleBackfillProgress('salon-progress-a');
    const b = getGoogleBackfillProgress('salon-progress-b');
    assert.equal(a.processed, 2);
    assert.equal(a.total, 8);
    assert.equal(a.percent, 25);
    assert.equal(b.status, 'idle');
  });

  it('manual sync reports onProgress and UI polls existing POST', () => {
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    const route = read('server/src/routes/calendarConnections.ts');
    const ui = read('client/src/pages/SalonIntegrations.tsx');
    const api = read('client/src/lib/api.ts');

    assert.match(backfill, /onProgress\?:/);
    assert.match(backfill, /processed:\s*summary\.scanned/);
    assert.match(backfill, /knownTotal/);
    assert.doesNotMatch(backfill, /setInterval|setTimeout\(/);

    assert.match(route, /router\.get\('\/google\/events\/import-last-30-days\/progress'/);
    assert.match(route, /getGoogleBackfillProgress\(salonId\)/);
    assert.match(route, /tryBeginGoogleBackfillProgress/);
    assert.match(route, /status\(202\)/);
    assert.match(route, /google_backfill_already_running/);
    assert.match(route, /onProgress:/);

    assert.match(api, /import-last-30-days\/progress/);
    assert.match(ui, /getGoogleBackfillProgress/);
    assert.match(ui, /backfillProgressCount/);
    assert.match(ui, /googleBackfillProgress\?\.percent/);
    assert.doesNotMatch(ui, /Math\.min\(100,\s*elapsed/);
  });
});
