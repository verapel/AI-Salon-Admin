/**
 * GOOGLE-PREVIEW-MISSING-EVENTS: keep every Google occurrence in preview.
 * Parsing/matching is metadata only. No day-window Google listing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptCalendarCredential } from './calendarCredentialsCrypto.js';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPE,
  GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
  GOOGLE_EVENTS_SALON_PREVIEW_MAX_PAGES,
  googlePreviewItemIdentity,
  listGoogleCalendarEventsPreview,
  previewGoogleCalendarEventsForSalon,
  serializeGoogleCalendarCredentialBlob,
} from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const PREV_ENV: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const NOW = new Date('2026-08-24T12:00:00.000Z');

type RawGoogleEvent = {
  id: string;
  summary: string;
  status?: string;
  recurringEventId?: string;
  originalStartTime?: { dateTime: string };
  start: { dateTime: string };
  end: { dateTime: string };
};

function yerevanRange(
  id: string,
  summary: string,
  startLocal: string,
  endLocal: string,
  extra: Partial<RawGoogleEvent> = {},
): RawGoogleEvent {
  return {
    id,
    summary,
    status: 'confirmed',
    start: { dateTime: `${startLocal}+04:00` },
    end: { dateTime: `${endLocal}+04:00` },
    ...extra,
  };
}

/** 9 unique Google occurrences across 3 days, including overlaps + one recurring instance. */
const NINE_EVENTS: RawGoogleEvent[] = [
  yerevanRange('g-d1-a', 'Ani coloring', '2026-08-21T08:50:00', '2026-08-21T10:50:00'),
  yerevanRange('g-d1-b', 'Lilit haircut', '2026-08-21T09:15:00', '2026-08-21T11:15:00'),
  yerevanRange('g-d1-c', 'Mariam manicure', '2026-08-21T10:00:00', '2026-08-21T12:00:00'),
  yerevanRange('g-d1-d', 'Nareh massage', '2026-08-21T11:00:00', '2026-08-21T13:00:00'),
  yerevanRange('g-d2-a', 'Sona +37499111111 coloring', '2026-08-22T09:00:00', '2026-08-22T11:00:00'),
  yerevanRange('g-d2-b', 'Tatev pedicure', '2026-08-22T12:00:00', '2026-08-22T13:30:00'),
  yerevanRange('g-d2-c', 'Arpi makeup', '2026-08-22T15:00:00', '2026-08-22T16:00:00'),
  yerevanRange('g-d3-a', 'incomplete title only', '2026-08-23T10:00:00', '2026-08-23T11:00:00'),
  yerevanRange(
    'weekly_20260823T100000',
    'Vera окрашивание',
    '2026-08-23T14:00:00',
    '2026-08-23T16:00:00',
    {
      recurringEventId: 'weekly',
      originalStartTime: { dateTime: '2026-08-23T14:00:00+04:00' },
    },
  ),
];

function makeCredentialRow() {
  const enc = encryptCalendarCredential(
    serializeGoogleCalendarCredentialBlob({
      refresh_token: 'rt-secret',
      scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
      token_type: 'Bearer',
    }),
  );
  return {
    id: 'row1',
    credential_ciphertext: enc.ciphertext,
    credential_iv: enc.iv,
    credential_auth_tag: enc.authTag,
    status: 'connected',
    selected_calendar_id: 'tatevik.miqaelyan@gmail.com',
    selected_calendar_name: 'tatevik.miqaelyan@gmail.com',
    provider_config: {},
  };
}

function dbWithRow(row: Record<string, unknown>) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: row, error: null }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function paginatedFetch(pages: RawGoogleEvent[][]): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
        status: 200,
      });
    }
    assert.match(url, /singleEvents=true/);
    assert.match(url, /orderBy=startTime/);
    assert.doesNotMatch(url, /timeMax=/);
    const u = new URL(url);
    const pageToken = u.searchParams.get('pageToken');
    const index = pageToken ? Number(pageToken.replace('p', '')) : 0;
    const items = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    return new Response(
      JSON.stringify({
        items,
        ...(hasMore ? { nextPageToken: `p${index + 1}` } : {}),
      }),
      { status: 200 },
    );
  };
}

describe('GOOGLE-PREVIEW-MISSING-EVENTS coverage (paginated events.list)', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', 'test-google-client-secret');
    setEnv(
      'GOOGLE_CALENDAR_REDIRECT_URI',
      'https://app.example.com/api/calendar/google/callback',
    );
    setEnv('CALENDAR_CREDENTIALS_ENCRYPTION_KEY', Buffer.alloc(32, 5).toString('base64'));
  });
  after(() => {
    for (const [k, v] of Object.entries(PREV_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('9 unique overlapping occurrences survive list + parse + match + identity keys', async () => {
    const fetchImpl = paginatedFetch([
      NINE_EVENTS.slice(0, 4),
      NINE_EVENTS.slice(4, 7),
      NINE_EVENTS.slice(7),
    ]);
    const listed = await listGoogleCalendarEventsPreview({
      accessToken: 'at',
      calendarId: 'tatevik.miqaelyan@gmail.com',
      timeMin: '2026-07-25T00:00:00.000Z',
      fetchImpl,
      maxPages: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
      maxEvents: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
    });
    assert.equal(listed.events.length, 9);
    assert.equal(listed.truncated, false);

    const preview = await previewGoogleCalendarEventsForSalon({
      db: dbWithRow(makeCredentialRow()),
      salonId: 'salon-a',
      fetchImpl: paginatedFetch([
        NINE_EVENTS.slice(0, 4),
        NINE_EVENTS.slice(4, 7),
        NINE_EVENTS.slice(7),
      ]),
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: [] },
    });
    assert.equal(preview.count, 9);
    assert.equal(preview.events.length, 9);
    assert.equal(preview.windowEnd, '');
    assert.equal(new Set(preview.events.map((e) => e.id)).size, 9);
    assert.equal(new Set(preview.events.map((e) => googlePreviewItemIdentity(e))).size, 9);

    const incomplete = preview.events.find((e) => e.id === 'g-d3-a');
    assert.ok(incomplete?.parsed);
    assert.equal(incomplete?.matchingStatus === 'matched', false);

    const recurring = preview.events.find((e) => e.id === 'weekly_20260823T100000');
    assert.equal(recurring?.recurringEventId, 'weekly');
  });

  it('sparse Google pages are accumulated, not stopped after 20 requests', async () => {
    const sparse = Array.from({ length: 25 }, (_, i) =>
      yerevanRange(
        `sparse-${i}`,
        `Client ${i}`,
        `2026-08-21T${String(8 + (i % 10)).padStart(2, '0')}:00:00`,
        `2026-08-21T${String(9 + (i % 10)).padStart(2, '0')}:00:00`,
      ),
    );
    const pages = sparse.map((ev) => [ev]);

    const capped = await listGoogleCalendarEventsPreview({
      accessToken: 'at',
      calendarId: 'primary',
      timeMin: '2026-07-25T00:00:00.000Z',
      fetchImpl: paginatedFetch(pages),
      maxPages: GOOGLE_EVENTS_SALON_PREVIEW_MAX_PAGES,
      maxEvents: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS,
    });
    assert.equal(capped.events.length, 20);
    assert.equal(capped.truncated, true);

    const preview = await previewGoogleCalendarEventsForSalon({
      db: dbWithRow(makeCredentialRow()),
      salonId: 'salon-a',
      fetchImpl: paginatedFetch(pages),
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: [] },
    });
    assert.equal(preview.events.length, 25);
    assert.equal(preview.truncated, false);
  });

  it('paginates more than 500 events without dropping earlier pages', async () => {
    const many = Array.from({ length: 520 }, (_, i) =>
      yerevanRange(
        `bulk-${i}`,
        `Event ${i}`,
        `2026-08-21T08:00:00`,
        `2026-08-21T09:00:00`,
      ),
    );
    const pages: RawGoogleEvent[][] = [];
    for (let i = 0; i < many.length; i += 250) {
      pages.push(many.slice(i, i + 250));
    }
    const preview = await previewGoogleCalendarEventsForSalon({
      db: dbWithRow(makeCredentialRow()),
      salonId: 'salon-a',
      fetchImpl: paginatedFetch(pages),
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: [] },
    });
    assert.equal(preview.events.length, 520);
    assert.equal(preview.truncated, false);
    assert.equal(preview.events[0]?.id, 'bulk-0');
    assert.equal(preview.events[519]?.id, 'bulk-519');
  });
});

describe('GOOGLE-PREVIEW-MISSING-EVENTS contracts', () => {
  it('frontend renders every backend item with occurrence keys; no eligibility filter', () => {
    const integrations = read('client/src/pages/SalonIntegrations.tsx');
    const start = integrations.indexOf('{googlePreviewEvents.map((ev) => {');
    assert.ok(start > 0);
    const slice = integrations.slice(start, start + 1800);
    assert.match(
      slice,
      /key=\{`\$\{ev\.calendarId\}::\$\{ev\.id\}::\$\{ev\.start\.dateTime \|\| ev\.start\.date \|\| ''\}`\}/,
    );
    assert.doesNotMatch(slice, /\.filter\(/);
    assert.doesNotMatch(slice, /importability === 'ready'|matchingStatus === 'matched'/);
    const setCall = integrations.slice(
      integrations.indexOf('const data = await api.calendar.getGoogleEventsPreview();'),
      integrations.indexOf('const data = await api.calendar.getGoogleEventsPreview();') + 220,
    );
    assert.match(setCall, /setGooglePreviewEvents\(data\.events\)/);
  });

  it('day-by-day listing is gone; preview uses one events.list with no timeMax', () => {
    const oauth = read('server/src/lib/googleCalendarOAuth.ts');
    assert.doesNotMatch(oauth, /buildGooglePreviewDayWindows|listGoogleCalendarEventsPreviewForSalon/);
    assert.doesNotMatch(oauth, /GOOGLE_EVENTS_SALON_PREVIEW_FETCH_FUTURE_DAYS|DAY_CONCURRENCY/);
    assert.match(oauth, /maxPages: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS/);
    assert.match(oauth, /maxEvents: GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS/);
    assert.match(oauth, /No future timeMax/);
    const packageJson = read('server/package.json');
    const n = (packageJson.match(/googleCalendar\.previewMissingEvents\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
