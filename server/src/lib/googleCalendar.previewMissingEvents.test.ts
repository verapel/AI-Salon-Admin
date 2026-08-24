/**
 * GOOGLE-PREVIEW-MISSING-EVENTS: overlapping timed events across many days
 * must each remain their own preview item. Parsing/matching is metadata only.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptCalendarCredential } from './calendarCredentialsCrypto.js';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPE,
  buildGooglePreviewDayWindows,
  googlePreviewItemIdentity,
  listGoogleCalendarEventsPreview,
  listGoogleCalendarEventsPreviewForSalon,
  mergeGooglePreviewEventsByIdentity,
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
  start: { dateTime: string };
  end: { dateTime: string };
};

function yerevanRange(
  id: string,
  summary: string,
  startLocal: string,
  endLocal: string,
): RawGoogleEvent {
  return {
    id,
    summary,
    status: 'confirmed',
    start: { dateTime: `${startLocal}+04:00` },
    end: { dateTime: `${endLocal}+04:00` },
  };
}

/** 9 unique Google events across 3 days, including overlapping times. */
const NINE_EVENTS: RawGoogleEvent[] = [
  yerevanRange('g-d1-a', 'Ani coloring', '2026-08-21T08:50:00', '2026-08-21T10:50:00'),
  yerevanRange('g-d1-b', 'Lilit haircut', '2026-08-21T09:15:00', '2026-08-21T11:15:00'),
  yerevanRange('g-d1-c', 'Mariam manicure', '2026-08-21T10:00:00', '2026-08-21T12:00:00'),
  yerevanRange('g-d1-d', 'Nareh massage', '2026-08-21T11:00:00', '2026-08-21T13:00:00'),
  yerevanRange('g-d2-a', 'Sona +37499111111 coloring', '2026-08-22T09:00:00', '2026-08-22T11:00:00'),
  yerevanRange('g-d2-b', 'Tatev pedicure', '2026-08-22T12:00:00', '2026-08-22T13:30:00'),
  yerevanRange('g-d2-c', 'Arpi makeup', '2026-08-22T15:00:00', '2026-08-22T16:00:00'),
  yerevanRange('g-d3-a', 'incomplete title only', '2026-08-23T10:00:00', '2026-08-23T11:00:00'),
  yerevanRange('g-d3-b', 'Vera окрашивание', '2026-08-23T14:00:00', '2026-08-23T16:00:00'),
];

function overlapsGoogleWindow(
  ev: RawGoogleEvent,
  timeMin: string | null,
  timeMax: string | null,
): boolean {
  const start = Date.parse(ev.start.dateTime);
  const end = Date.parse(ev.end.dateTime);
  if (timeMin) {
    const min = Date.parse(timeMin);
    if (Number.isFinite(min) && !(end > min)) return false;
  }
  if (timeMax) {
    const max = Date.parse(timeMax);
    if (Number.isFinite(max) && !(start < max)) return false;
  }
  return true;
}

function utcDayKey(ev: RawGoogleEvent): string {
  return new Date(ev.start.dateTime).toISOString().slice(0, 10);
}

/** Simulate Google dropping overlapping siblings in a wide events.list window. */
function applyWideWindowOverlapLoss(
  events: RawGoogleEvent[],
  timeMin: string | null,
  timeMax: string | null,
): RawGoogleEvent[] {
  const matching = events.filter((ev) => overlapsGoogleWindow(ev, timeMin, timeMax));
  const minMs = timeMin ? Date.parse(timeMin) : NaN;
  const maxMs = timeMax ? Date.parse(timeMax) : minMs + 400 * 86400000;
  const span = maxMs - minMs;
  if (!Number.isFinite(span) || span <= 36 * 3600000) return matching;
  const kept: RawGoogleEvent[] = [];
  const seenDays = new Set<string>();
  for (const ev of matching) {
    const day = utcDayKey(ev);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    kept.push(ev);
  }
  return kept;
}

function parseListWindow(url: string): { timeMin: string | null; timeMax: string | null; pageToken: string | null } {
  const u = new URL(url);
  return {
    timeMin: u.searchParams.get('timeMin'),
    timeMax: u.searchParams.get('timeMax'),
    pageToken: u.searchParams.get('pageToken'),
  };
}

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

describe('GOOGLE-PREVIEW-MISSING-EVENTS identity + day windows', () => {
  it('identity is Google event id + start, not date/client/match', () => {
    const a = {
      id: 'g1',
      start: { dateTime: '2026-08-21T04:50:00.000Z', date: null, timeZone: null, allDay: false },
    };
    const b = {
      id: 'g2',
      start: { dateTime: '2026-08-21T05:15:00.000Z', date: null, timeZone: null, allDay: false },
    };
    assert.notEqual(googlePreviewItemIdentity(a), googlePreviewItemIdentity(b));
    assert.match(googlePreviewItemIdentity(a), /^g1::/);
    const merged = mergeGooglePreviewEventsByIdentity([
      [
        { id: 'g1', start: a.start, summary: 'one' } as any,
        { id: 'g2', start: b.start, summary: 'two' } as any,
      ],
    ]);
    assert.equal(merged.length, 2);
  });

  it('day windows are 24h UTC slices covering lookback through +1y', () => {
    const windows = buildGooglePreviewDayWindows({
      timeMin: '2026-07-25T00:00:00.000Z',
      now: NOW,
      futureDays: 366,
    });
    assert.equal(windows[0]?.timeMin, '2026-07-25T00:00:00.000Z');
    assert.equal(windows[0]?.timeMax, '2026-07-26T00:00:00.000Z');
    assert.ok(windows.length >= 30 + 365);
    assert.ok(windows.some((w) => w.timeMin === '2026-08-21T00:00:00.000Z'));
    assert.ok(windows.some((w) => w.timeMin === '2027-08-24T00:00:00.000Z'));
  });
});

describe('GOOGLE-PREVIEW-MISSING-EVENTS 9 events / 3 days (mock Google)', () => {
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

  function overlappingFetch(events: RawGoogleEvent[], paginateDay2 = false): typeof fetch {
    return async (input) => {
      const url = String(input);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      const { timeMin, timeMax, pageToken } = parseListWindow(url);
      let items = applyWideWindowOverlapLoss(events, timeMin, timeMax);
      if (paginateDay2 && timeMin === '2026-08-22T00:00:00.000Z') {
        if (pageToken === 'd2p2') {
          items = items.filter((ev) => ev.id === 'g-d2-c');
        } else {
          return new Response(
            JSON.stringify({
              items: items.filter((ev) => ev.id !== 'g-d2-c'),
              nextPageToken: 'd2p2',
            }),
            { status: 200 },
          );
        }
      }
      return new Response(JSON.stringify({ items }), { status: 200 });
    };
  }

  it('wide events.list overlap-loss keeps 3; day windows restore all 9', async () => {
    const wide = applyWideWindowOverlapLoss(
      NINE_EVENTS,
      '2026-07-25T00:00:00.000Z',
      null,
    );
    assert.equal(wide.length, 3, 'fixture: one Google item per date in a wide window');

    const listed = await listGoogleCalendarEventsPreviewForSalon({
      accessToken: 'at',
      calendarId: 'tatevik.miqaelyan@gmail.com',
      calendarName: 'tatevik.miqaelyan@gmail.com',
      timeMin: '2026-07-25T00:00:00.000Z',
      now: NOW,
      fetchImpl: overlappingFetch(NINE_EVENTS),
    });
    assert.equal(listed.events.length, 9);
    assert.equal(new Set(listed.events.map((e) => e.id)).size, 9);
  });

  it('salon preview API keeps 9 events; incomplete parse still listed', async () => {
    const preview = await previewGoogleCalendarEventsForSalon({
      db: dbWithRow(makeCredentialRow()),
      salonId: 'salon-a',
      fetchImpl: overlappingFetch(NINE_EVENTS),
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: [] },
    });
    assert.equal(preview.count, 9);
    assert.equal(preview.events.length, 9);
    const ids = preview.events.map((e) => e.id);
    assert.deepEqual(
      [...ids].sort(),
      NINE_EVENTS.map((e) => e.id).sort(),
    );
    const incomplete = preview.events.find((e) => e.id === 'g-d3-a');
    assert.ok(incomplete);
    assert.ok(incomplete?.parsed);
    assert.equal(incomplete?.summary, 'incomplete title only');
    const renderKeys = preview.events.map((e) => googlePreviewItemIdentity(e));
    assert.equal(new Set(renderKeys).size, 9);
  });

  it('day-window pagination still returns every overlapping event', async () => {
    const listed = await listGoogleCalendarEventsPreviewForSalon({
      accessToken: 'at',
      calendarId: 'tatevik.miqaelyan@gmail.com',
      timeMin: '2026-07-25T00:00:00.000Z',
      now: NOW,
      fetchImpl: overlappingFetch(NINE_EVENTS, true),
    });
    assert.equal(listed.events.length, 9);
    assert.ok(listed.events.some((e) => e.id === 'g-d2-c'));
  });

  it('import listing helper is unchanged: one wide window still loses overlaps', async () => {
    const listed = await listGoogleCalendarEventsPreview({
      accessToken: 'at',
      calendarId: 'tatevik.miqaelyan@gmail.com',
      timeMin: '2026-07-25T00:00:00.000Z',
      fetchImpl: overlappingFetch(NINE_EVENTS),
    });
    assert.equal(listed.events.length, 3);
  });
});

describe('GOOGLE-PREVIEW-MISSING-EVENTS frontend cards', () => {
  it('integrations preview maps every event with Google identity keys; no eligibility filter', () => {
    const integrations = read('client/src/pages/SalonIntegrations.tsx');
    const start = integrations.indexOf('{googlePreviewEvents.map((ev) => {');
    assert.ok(start > 0);
    const slice = integrations.slice(start, start + 1800);
    assert.match(
      slice,
      /key=\{`\$\{ev\.id\}::\$\{ev\.start\.dateTime \|\| ev\.start\.date \|\| ''\}`\}/,
    );
    assert.doesNotMatch(slice, /\.filter\(/);
    assert.doesNotMatch(slice, /importability === 'ready'|matchingStatus === 'matched'/);
    const setCall = integrations.slice(
      integrations.indexOf('const data = await api.calendar.getGoogleEventsPreview();'),
      integrations.indexOf('const data = await api.calendar.getGoogleEventsPreview();') + 220,
    );
    assert.match(setCall, /setGooglePreviewEvents\(data\.events\)/);
  });

  it('package registers this suite once', () => {
    const packageJson = read('server/package.json');
    const n = (packageJson.match(/googleCalendar\.previewMissingEvents\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
