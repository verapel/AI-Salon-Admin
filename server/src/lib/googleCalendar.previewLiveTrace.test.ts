/**
 * GOOGLE-PREVIEW-LIVE-TRACE: aggregate diagnostics on salon «Показать события».
 * All Google HTTP mocked. No tokens, names, phones, or titles in logs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptCalendarCredential } from './calendarCredentialsCrypto.js';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPE,
  GOOGLE_PREVIEW_LIVE_TRACE_DATES,
  googlePreviewTimedLocalDateKey,
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
const SALON_TZ = 'Asia/Yerevan';
const SELECTED_CALENDAR = 'tatevik.miqaelyan@gmail.com';

const LEAK_ACCESS_TOKEN = 'ya29.leak-access-token';
const LEAK_REFRESH_TOKEN = '1//leak-refresh-token';
const LEAK_CLIENT_SECRET = 'GOCSPX-leak-client-secret';

const CLIENT_NAME = 'Ani Coloring';
const CLIENT_PHONE = '+37499111222';
const EVENT_TITLE = 'Sona manicure secret-title';

const PAGE_LOG_KEYS = [
  'operation',
  'pageNumber',
  'itemsOnPage',
  'hasNextPageToken',
  'firstEventStart',
  'lastEventStart',
];

const SUMMARY_LOG_KEYS = [
  'operation',
  'selectedCalendarId',
  'pagesFetched',
  'rawItemsTotal',
  'uniqueGoogleOccurrences',
  'backendPreviewItems',
  'truncated',
  'firstEventStart',
  'lastEventStart',
];

const DAY_LOG_KEYS = ['operation', 'date', 'rawGoogleTimedEvents', 'backendPreviewEvents'];

const originalConsoleError = console.error;
let capturedLogs: unknown[][] = [];

function installLogCapture() {
  capturedLogs = [];
  console.error = (...args: unknown[]) => {
    capturedLogs.push(args);
  };
}

afterEach(() => {
  console.error = originalConsoleError;
  capturedLogs = [];
});

function logsWithOperation(operation: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const args of capturedLogs) {
    for (const arg of args) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        const row = arg as Record<string, unknown>;
        if (row.operation === operation) rows.push(row);
      }
    }
  }
  return rows;
}

function assertNoSecretsOrPiiInLogs() {
  const serialized = JSON.stringify(capturedLogs);
  assert.equal(serialized.includes(LEAK_ACCESS_TOKEN), false);
  assert.equal(serialized.includes(LEAK_REFRESH_TOKEN), false);
  assert.equal(serialized.includes(LEAK_CLIENT_SECRET), false);
  assert.equal(serialized.includes('Bearer '), false);
  assert.equal(serialized.includes(CLIENT_NAME), false);
  assert.equal(serialized.includes(CLIENT_PHONE), false);
  assert.equal(serialized.includes(EVENT_TITLE), false);
  assert.equal(serialized.includes('secret-title'), false);
  for (const args of capturedLogs) {
    for (const arg of args) {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const keys = Object.keys(arg);
      for (const banned of [
        'access_token',
        'refresh_token',
        'client_secret',
        'Authorization',
        'authorization',
        'summary',
        'description',
        'items',
        'title',
        'phone',
        'clientName',
      ]) {
        assert.equal(keys.includes(banned), false, `logged banned key ${banned}`);
      }
    }
  }
}

function makeCredentialRow() {
  const enc = encryptCalendarCredential(
    serializeGoogleCalendarCredentialBlob({
      refresh_token: LEAK_REFRESH_TOKEN,
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
    selected_calendar_id: SELECTED_CALENDAR,
    selected_calendar_name: SELECTED_CALENDAR,
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

type RawItem = Record<string, unknown>;

function timed(
  id: string | null,
  startLocal: string,
  endLocal: string,
  summary: string,
): RawItem {
  const item: RawItem = {
    summary,
    status: 'confirmed',
    start: { dateTime: `${startLocal}+04:00` },
    end: { dateTime: `${endLocal}+04:00` },
  };
  if (id) item.id = id;
  return item;
}

function paginatedFetch(pages: RawItem[][]): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/token')) {
      return new Response(
        JSON.stringify({
          access_token: LEAK_ACCESS_TOKEN,
          refresh_token: LEAK_REFRESH_TOKEN,
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
    const u = new URL(url);
    const pageToken = u.searchParams.get('pageToken');
    const index = pageToken ? Number(pageToken.replace('p', '')) : 0;
    const items = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    return new Response(
      JSON.stringify({
        items,
        access_token: LEAK_ACCESS_TOKEN,
        ...(hasMore ? { nextPageToken: `p${index + 1}` } : {}),
      }),
      { status: 200 },
    );
  };
}

describe('GOOGLE-PREVIEW-LIVE-TRACE diagnostics', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', LEAK_CLIENT_SECRET);
    setEnv(
      'GOOGLE_CALENDAR_REDIRECT_URI',
      'https://app.example.com/api/calendar/google/callback',
    );
    setEnv('CALENDAR_CREDENTIALS_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  after(() => {
    for (const [k, v] of Object.entries(PREV_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('salon-local date key uses Yerevan, not UTC', () => {
    assert.equal(
      googlePreviewTimedLocalDateKey('2026-08-20T21:00:00.000Z', SALON_TZ),
      '2026-08-21',
    );
    assert.equal(
      googlePreviewTimedLocalDateKey('2026-08-21T02:00:00+04:00', SALON_TZ),
      '2026-08-21',
    );
  });

  it('logs per-page, summary, and Aug20-23 day counts without PII', async () => {
    installLogCapture();
    const pages: RawItem[][] = [
      [
        timed('g-aug19', '2026-08-19T10:00:00', '2026-08-19T11:00:00', CLIENT_NAME),
        timed('g-aug20', '2026-08-20T09:00:00', '2026-08-20T10:00:00', CLIENT_PHONE),
        timed(null, '2026-08-21T08:00:00', '2026-08-21T09:00:00', EVENT_TITLE),
        timed('g-aug21-kept', '2026-08-21T10:00:00', '2026-08-21T11:00:00', CLIENT_NAME),
      ],
      [
        timed('g-aug21-b', '2026-08-21T12:00:00', '2026-08-21T13:00:00', CLIENT_PHONE),
        {
          id: 'g-aug21-allday',
          summary: EVENT_TITLE,
          start: { date: '2026-08-21' },
          end: { date: '2026-08-22' },
        },
        timed('g-aug22-a', '2026-08-22T09:00:00', '2026-08-22T10:00:00', CLIENT_NAME),
      ],
      [
        timed('g-aug22-b', '2026-08-22T11:00:00', '2026-08-22T12:00:00', EVENT_TITLE),
        timed('g-aug23', '2026-08-23T14:00:00', '2026-08-23T15:00:00', CLIENT_PHONE),
      ],
    ];

    const preview = await previewGoogleCalendarEventsForSalon({
      db: dbWithRow(makeCredentialRow()),
      salonId: 'salon-a',
      fetchImpl: paginatedFetch(pages),
      now: NOW,
      salonTimeZone: SALON_TZ,
      matchCatalog: { clients: [], services: [] },
    });

    assert.equal(preview.truncated, false);
    assert.equal(preview.events.length, 9);
    assert.equal(preview.googleReceived, 9);
    assert.equal(preview.previewCards, 9);
    assert.equal(preview.hidden, 0);
    assert.equal(preview.events.some((ev) => !ev.id), false);

    const pageLogs = logsWithOperation('google_preview_page');
    assert.equal(pageLogs.length, 3);
    for (const row of pageLogs) {
      assert.deepEqual(Object.keys(row).sort(), [...PAGE_LOG_KEYS].sort());
    }
    assert.equal(pageLogs[0]?.pageNumber, 1);
    assert.equal(pageLogs[0]?.itemsOnPage, 4);
    assert.equal(pageLogs[0]?.hasNextPageToken, true);
    assert.equal(pageLogs[0]?.firstEventStart, '2026-08-19T10:00:00+04:00');
    assert.equal(pageLogs[0]?.lastEventStart, '2026-08-21T10:00:00+04:00');
    assert.equal(pageLogs[1]?.pageNumber, 2);
    assert.equal(pageLogs[1]?.itemsOnPage, 3);
    assert.equal(pageLogs[1]?.hasNextPageToken, true);
    assert.equal(pageLogs[1]?.firstEventStart, '2026-08-21T12:00:00+04:00');
    assert.equal(pageLogs[1]?.lastEventStart, '2026-08-22T09:00:00+04:00');
    assert.equal(pageLogs[2]?.pageNumber, 3);
    assert.equal(pageLogs[2]?.itemsOnPage, 2);
    assert.equal(pageLogs[2]?.hasNextPageToken, false);
    assert.equal(pageLogs[2]?.firstEventStart, '2026-08-22T11:00:00+04:00');
    assert.equal(pageLogs[2]?.lastEventStart, '2026-08-23T14:00:00+04:00');

    const summaryLogs = logsWithOperation('google_preview_summary');
    assert.equal(summaryLogs.length, 1);
    const summary = summaryLogs[0]!;
    assert.deepEqual(Object.keys(summary).sort(), [...SUMMARY_LOG_KEYS].sort());
    assert.equal(summary.selectedCalendarId, SELECTED_CALENDAR);
    assert.equal(summary.pagesFetched, 3);
    assert.equal(summary.rawItemsTotal, 9);
    assert.equal(summary.uniqueGoogleOccurrences, 9);
    assert.equal(summary.backendPreviewItems, 9);
    assert.equal(summary.truncated, false);
    assert.equal(summary.firstEventStart, '2026-08-19T10:00:00+04:00');
    assert.equal(summary.lastEventStart, '2026-08-23T14:00:00+04:00');

    const dayLogs = logsWithOperation('google_preview_day');
    assert.equal(dayLogs.length, 4);
    assert.deepEqual(
      dayLogs.map((row) => row.date),
      [...GOOGLE_PREVIEW_LIVE_TRACE_DATES],
    );
    for (const row of dayLogs) {
      assert.deepEqual(Object.keys(row).sort(), [...DAY_LOG_KEYS].sort());
    }
    const byDate = Object.fromEntries(dayLogs.map((row) => [row.date, row]));
    assert.equal(byDate['2026-08-20']?.rawGoogleTimedEvents, 1);
    assert.equal(byDate['2026-08-20']?.backendPreviewEvents, 1);
    assert.equal(byDate['2026-08-21']?.rawGoogleTimedEvents, 3);
    assert.equal(byDate['2026-08-21']?.backendPreviewEvents, 3);
    assert.equal(byDate['2026-08-22']?.rawGoogleTimedEvents, 2);
    assert.equal(byDate['2026-08-22']?.backendPreviewEvents, 2);
    assert.equal(byDate['2026-08-23']?.rawGoogleTimedEvents, 1);
    assert.equal(byDate['2026-08-23']?.backendPreviewEvents, 1);

    assertNoSecretsOrPiiInLogs();
  });

  it('list/backfill path does not emit preview live-trace logs', async () => {
    installLogCapture();
    await listGoogleCalendarEventsPreview({
      accessToken: LEAK_ACCESS_TOKEN,
      calendarId: SELECTED_CALENDAR,
      timeMin: '2026-07-25T00:00:00.000Z',
      fetchImpl: paginatedFetch([
        [timed('g1', '2026-08-21T10:00:00', '2026-08-21T11:00:00', CLIENT_NAME)],
      ]),
      onPage: () => undefined,
    });
    assert.equal(logsWithOperation('google_preview_page').length, 0);
    assert.equal(logsWithOperation('google_preview_summary').length, 0);
    assert.equal(logsWithOperation('google_preview_day').length, 0);
  });

  it('frontend still assigns and renders data.events with no extra filter', () => {
    const integrations = read('client/src/pages/SalonIntegrations.tsx');
    const setCall = integrations.slice(
      integrations.indexOf('const data = await api.calendar.getGoogleEventsPreview();'),
      integrations.indexOf('const data = await api.calendar.getGoogleEventsPreview();') + 220,
    );
    assert.match(setCall, /setGooglePreviewEvents\(data\.events\)/);
    const start = integrations.indexOf('{googlePreviewEvents.map((ev) => {');
    assert.ok(start > 0);
    const slice = integrations.slice(start, start + 1800);
    assert.doesNotMatch(slice, /\.filter\(/);
    assert.doesNotMatch(slice, /\.slice\(/);
  });

  it('registers the focused diagnostic test in server/package.json', () => {
    const packageJson = read('server/package.json');
    const n = (packageJson.match(/googleCalendar\.previewLiveTrace\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
