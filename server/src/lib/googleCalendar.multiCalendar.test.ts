/**
 * GOOGLE MULTI-CALENDAR: select several calendars; preview and manual sync merge all.
 * FAST-6 auto-import still uses selected_calendar_id (primary). No Google writes.
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
  GOOGLE_SELECTED_CALENDARS_CONFIG_KEY,
  applyCalendarSelectProviderConfig,
  googlePreviewItemIdentity,
  mergeGooglePreviewEventsByOccurrence,
  previewGoogleCalendarEventsForSalon,
  readSelectedGoogleCalendars,
  selectGoogleCalendarForSalon,
  serializeGoogleCalendarCredentialBlob,
  GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY,
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
const CAL_A = 'tatevik.miqaelyan@gmail.com';
const CAL_B = 'SetTime';

type RawItem = Record<string, unknown>;

function timed(
  id: string,
  startLocal: string,
  endLocal: string,
  extra: Record<string, unknown> = {},
): RawItem {
  return {
    id,
    summary: id,
    status: 'confirmed',
    start: { dateTime: `${startLocal}+04:00` },
    end: { dateTime: `${endLocal}+04:00` },
    ...extra,
  };
}

const CAL_A_EVENTS: RawItem[] = [
  timed('a-1', '2026-08-21T08:00:00', '2026-08-21T09:00:00'),
  timed('a-2', '2026-08-21T09:30:00', '2026-08-21T10:30:00'),
  timed('a-3', '2026-08-21T11:00:00', '2026-08-21T12:00:00'),
  timed('a-4', '2026-08-22T09:00:00', '2026-08-22T10:00:00'),
  timed('a-5', '2026-08-22T14:00:00', '2026-08-22T15:00:00'),
  timed(
    'a-6-weekly_20260823T100000',
    '2026-08-23T10:00:00',
    '2026-08-23T11:00:00',
    { recurringEventId: 'a-weekly', originalStartTime: { dateTime: '2026-08-23T10:00:00+04:00' } },
  ),
];

const CAL_B_EVENTS: RawItem[] = [
  timed('b-1', '2026-08-21T08:00:00', '2026-08-21T09:00:00'),
  timed('b-2', '2026-08-21T09:30:00', '2026-08-21T10:30:00'),
  timed('b-3', '2026-08-22T09:00:00', '2026-08-22T10:00:00'),
  timed('b-4', '2026-08-22T12:00:00', '2026-08-22T13:00:00'),
  timed('b-5', '2026-08-23T16:00:00', '2026-08-23T17:00:00'),
];

function makeCredentialRow(extra: Record<string, unknown> = {}) {
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
    selected_calendar_id: CAL_A,
    selected_calendar_name: CAL_A,
    provider_config: {},
    ...extra,
  };
}

function dbWithRow(row: Record<string, unknown>, onUpdate?: (payload: Record<string, unknown>) => void) {
  let current = { ...row };
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: current, error: null }),
                  };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          onUpdate?.(payload);
          current = { ...current, ...payload };
          return {
            eq() {
              return {
                eq: async () => ({ error: null }),
              };
            },
          };
        },
      };
    },
  };
}

function googleFetch(pagesByCalendar: Record<string, RawItem[][]>): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('calendarList')) {
      return new Response(
        JSON.stringify({
          items: [
            { id: CAL_A, summary: CAL_A, primary: true, accessRole: 'owner' },
            { id: CAL_B, summary: 'SetTime', primary: false, accessRole: 'owner' },
          ],
        }),
        { status: 200 },
      );
    }
    assert.match(url, /singleEvents=true/);
    assert.doesNotMatch(url, /timeMax=/);
    const u = new URL(url);
    const encoded = url.split('/calendars/')[1]?.split('/events')[0] ?? '';
    const calendarId = decodeURIComponent(encoded);
    const pages = pagesByCalendar[calendarId] ?? [];
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

describe('GOOGLE MULTI-CALENDAR selection + preview merge', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', 'test-google-client-secret');
    setEnv(
      'GOOGLE_CALENDAR_REDIRECT_URI',
      'https://app.example.com/api/calendar/google/callback',
    );
    setEnv('CALENDAR_CREDENTIALS_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
  });
  after(() => {
    for (const [k, v] of Object.entries(PREV_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('legacy selected_calendar_id remains the only selected calendar', () => {
    const selected = readSelectedGoogleCalendars({
      selectedCalendarId: CAL_A,
      selectedCalendarName: CAL_A,
      providerConfig: {},
    });
    assert.deepEqual(selected, [{ id: CAL_A, name: CAL_A }]);
  });

  it('provider_config.selectedCalendars wins over the legacy column', () => {
    const selected = readSelectedGoogleCalendars({
      selectedCalendarId: CAL_A,
      selectedCalendarName: CAL_A,
      providerConfig: {
        [GOOGLE_SELECTED_CALENDARS_CONFIG_KEY]: [
          { id: CAL_A, summary: CAL_A },
          { id: CAL_B, name: 'SetTime' },
        ],
      },
    });
    assert.equal(selected.length, 2);
    assert.equal(selected[0]?.id, CAL_A);
    assert.equal(selected[1]?.id, CAL_B);
    assert.equal(selected[1]?.name, 'SetTime');
  });

  it('identity includes calendarId so same-time events stay distinct', () => {
    const start = { dateTime: '2026-08-21T08:00:00+04:00', date: null, timeZone: null, allDay: false };
    const a = googlePreviewItemIdentity({ id: 'same', start, calendarId: CAL_A });
    const b = googlePreviewItemIdentity({ id: 'same', start, calendarId: CAL_B });
    assert.notEqual(a, b);
    assert.ok(a.startsWith(`${CAL_A}::`));
    assert.ok(b.startsWith(`${CAL_B}::`));
    assert.equal(
      mergeGooglePreviewEventsByOccurrence([
        [{ id: 'same', calendarId: CAL_A, calendarName: CAL_A, start, end: start, iCalUID: null, summary: null, description: null, location: null, status: null, recurringEventId: null, originalStartTime: null, created: null, updated: null, etag: null, htmlLink: null }],
        [{ id: 'same', calendarId: CAL_B, calendarName: CAL_B, start, end: start, iCalUID: null, summary: null, description: null, location: null, status: null, recurringEventId: null, originalStartTime: null, created: null, updated: null, etag: null, htmlLink: null }],
      ]).length,
      2,
    );
  });

  it('selecting A+B persists both calendars and keeps selected_calendar_id as primary', async () => {
    let saved: Record<string, unknown> | null = null;
    const db = dbWithRow(makeCredentialRow({ selected_calendar_id: CAL_A }), (payload) => {
      saved = payload;
    });
    const result = await selectGoogleCalendarForSalon({
      db,
      salonId: 'salon-a',
      calendarIds: [CAL_A, CAL_B],
      fetchImpl: googleFetch({}),
    });
    assert.equal(result.selectedCalendarId, CAL_A);
    assert.equal(result.selectedCalendars.length, 2);
    assert.ok(saved);
    assert.equal(saved!.selected_calendar_id, CAL_A);
    assert.equal(saved!.import_enabled, false);
    const cfg = saved!.provider_config as Record<string, unknown>;
    const listed = cfg[GOOGLE_SELECTED_CALENDARS_CONFIG_KEY] as Array<{ id: string }>;
    assert.deepEqual(
      listed.map((c) => c.id),
      [CAL_A, CAL_B],
    );
    assert.equal(cfg[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], undefined);
  });

  it('preview merges 6+5 overlapping events into 11 distinct cards', async () => {
    const row = makeCredentialRow({
      provider_config: {
        [GOOGLE_SELECTED_CALENDARS_CONFIG_KEY]: [
          { id: CAL_A, summary: CAL_A },
          { id: CAL_B, summary: 'SetTime' },
        ],
      },
    });
    const preview = await previewGoogleCalendarEventsForSalon({
      db: dbWithRow(row),
      salonId: 'salon-a',
      fetchImpl: googleFetch({
        [CAL_A]: [CAL_A_EVENTS.slice(0, 3), CAL_A_EVENTS.slice(3)],
        [CAL_B]: [CAL_B_EVENTS],
      }),
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: [] },
    });
    assert.equal(CAL_A_EVENTS.length, 6);
    assert.equal(CAL_B_EVENTS.length, 5);
    assert.equal(preview.events.length, 11);
    assert.equal(preview.count, 11);
    assert.equal(preview.truncated, false);
    assert.equal(preview.selectedCalendars?.length, 2);
    const fromA = preview.events.filter((e) => e.calendarId === CAL_A);
    const fromB = preview.events.filter((e) => e.calendarId === CAL_B);
    assert.equal(fromA.length, 6);
    assert.equal(fromB.length, 5);
    assert.ok(fromA.every((e) => e.calendarName === CAL_A));
    assert.ok(fromB.every((e) => e.calendarName === 'SetTime'));
    assert.equal(new Set(preview.events.map((e) => googlePreviewItemIdentity(e))).size, 11);
    const sameTime = preview.events.filter(
      (e) => e.start.dateTime === '2026-08-21T08:00:00+04:00',
    );
    assert.equal(sameTime.length, 2);
    assert.ok(preview.events.some((e) => e.recurringEventId === 'a-weekly'));
    assert.ok(preview.events.every((e) => e.parsed));
  });

  it('existing single-calendar connection still previews only that calendar', async () => {
    const preview = await previewGoogleCalendarEventsForSalon({
      db: dbWithRow(makeCredentialRow()),
      salonId: 'salon-a',
      fetchImpl: googleFetch({
        [CAL_A]: [CAL_A_EVENTS],
        [CAL_B]: [CAL_B_EVENTS],
      }),
      now: NOW,
      salonTimeZone: 'Asia/Yerevan',
      matchCatalog: { clients: [], services: [] },
    });
    assert.equal(preview.events.length, 6);
    assert.ok(preview.events.every((e) => e.calendarId === CAL_A));
    assert.equal(preview.calendarId, CAL_A);
  });

  it('per-calendar safety cap stays 5000 unique occurrences', () => {
    assert.equal(GOOGLE_EVENTS_SALON_PREVIEW_MAX_EVENTS, 5000);
  });

  it('applyCalendarSelectProviderConfig stores selectedCalendars and clears page token', () => {
    const next = applyCalendarSelectProviderConfig(
      { [GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY]: 'stale' },
      [
        { id: CAL_A, summary: CAL_A },
        { id: CAL_B, summary: 'SetTime' },
      ],
    );
    assert.equal(next[GOOGLE_AUTO_IMPORT_PAGE_TOKEN_CONFIG_KEY], undefined);
    assert.deepEqual((next.selectedCalendar as { id: string }).id, CAL_A);
    const listed = next[GOOGLE_SELECTED_CALENDARS_CONFIG_KEY] as Array<{ id: string }>;
    assert.deepEqual(
      listed.map((c) => c.id),
      [CAL_A, CAL_B],
    );
  });

  it('frontend uses multi-select + calendar-scoped keys; FAST-6 stays on selected_calendar_id', () => {
    const integrations = read('client/src/pages/SalonIntegrations.tsx');
    assert.match(integrations, /selectGoogleCalendars\(googleDraftCalendarIds\)/);
    assert.match(integrations, /type="checkbox"/);
    assert.match(integrations, /saveCalendarSelection/);
    assert.doesNotMatch(
      integrations.slice(integrations.indexOf('googleCalendars.map'), integrations.indexOf('googleCalendars.map') + 1800),
      /integrations\.google\.select'\)/,
    );
    const importSrc = read('server/src/lib/googleCalendarImport.ts');
    assert.match(importSrc, /isGoogleCalendarAllowedForManualImport/);
    assert.match(importSrc, /readSelectedGoogleCalendars/);
    const backfill = read('server/src/lib/googleCalendarBackfill.ts');
    assert.match(backfill, /readSelectedGoogleCalendars/);
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.match(auto, /const calendarId = String\(conn\.selected_calendar_id/);
    assert.doesNotMatch(auto, /readSelectedGoogleCalendars/);
    const packageJson = read('server/package.json');
    const n = (packageJson.match(/googleCalendar\.multiCalendar\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
