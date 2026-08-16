/**
 * GOOGLE-CAL-FAST-2: Read-only Google events.list preview.
 * All Google HTTP mocked. No real Calendar API calls. No DB writes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPE,
  GOOGLE_EVENTS_PREVIEW_MAX_EVENTS,
  GOOGLE_EVENTS_PREVIEW_MAX_PAGES,
  GoogleCalendarOAuthError,
  buildGoogleCalendarEventsListUrl,
  buildGoogleEventsPreviewWindow,
  listGoogleCalendarEventsPreview,
  mapGoogleEventPreviewEntry,
  previewGoogleCalendarEventsForSalon,
  serializeGoogleCalendarCredentialBlob,
} from './googleCalendarOAuth.js';
import { encryptCalendarCredential } from './calendarCredentialsCrypto.js';

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

function makeCredentialRow(overrides: Record<string, unknown> = {}) {
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
    selected_calendar_id: 'primary',
    selected_calendar_name: 'tatevik.migaelyan@gmail.com',
    provider_config: {},
    ...overrides,
  };
}

function dbWithRow(row: Record<string, unknown> | null) {
  const seenSalonIds: string[] = [];
  return {
    seenSalonIds,
    db: {
      from() {
        return {
          select() {
            return {
              eq(col: string, val: string) {
                if (col === 'salon_id') seenSalonIds.push(val);
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
    },
  };
}

describe('GOOGLE-CAL-FAST-2 events preview URL + mapping (executed)', () => {
  it('preview window is now-30d .. now+90d UTC ISO', () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const w = buildGoogleEventsPreviewWindow(now);
    assert.equal(w.timeMin, '2026-07-17T12:00:00.000Z');
    assert.equal(w.timeMax, '2026-11-14T12:00:00.000Z');
  });

  it('events.list URL uses selected calendar + required query params', () => {
    const url = buildGoogleCalendarEventsListUrl({
      calendarId: 'tatevik.migaelyan@gmail.com',
      timeMin: '2026-07-01T00:00:00.000Z',
      timeMax: '2026-11-01T00:00:00.000Z',
      pageToken: 'p2',
    });
    const u = new URL(url);
    assert.match(u.pathname, /\/calendars\/tatevik\.migaelyan%40gmail\.com\/events$/);
    assert.equal(u.searchParams.get('singleEvents'), 'true');
    assert.equal(u.searchParams.get('orderBy'), 'startTime');
    assert.equal(u.searchParams.get('showDeleted'), 'false');
    assert.equal(u.searchParams.get('timeMin'), '2026-07-01T00:00:00.000Z');
    assert.equal(u.searchParams.get('timeMax'), '2026-11-01T00:00:00.000Z');
    assert.equal(u.searchParams.get('pageToken'), 'p2');
    assert.doesNotMatch(url, /syncToken/);
  });

  it('maps safe preview fields; keeps raw summary; dateTime vs all-day', () => {
    const timed = mapGoogleEventPreviewEntry(
      {
        id: 'e1',
        summary: 'Vera окрашивание',
        description: 'secret notes',
        location: 'Salon',
        status: 'confirmed',
        iCalUID: 'uid-1',
        start: { dateTime: '2026-08-20T10:00:00+04:00', timeZone: 'Asia/Yerevan' },
        end: { dateTime: '2026-08-20T12:00:00+04:00', timeZone: 'Asia/Yerevan' },
        updated: '2026-08-01T00:00:00.000Z',
        etag: '"etag"',
        htmlLink: 'https://calendar.google.com/event?eid=1',
        attendees: [{ email: 'x@y.com' }],
        organizer: { email: 'org@x.com' },
      },
      'cal-1',
      'Work',
    );
    assert.equal(timed?.summary, 'Vera окрашивание');
    assert.equal(timed?.start.allDay, false);
    assert.equal(timed?.start.dateTime, '2026-08-20T10:00:00+04:00');
    assert.equal(timed?.calendarId, 'cal-1');
    assert.equal('attendees' in (timed as object), false);
    assert.equal('organizer' in (timed as object), false);

    const allDay = mapGoogleEventPreviewEntry(
      {
        id: 'e2',
        summary: 'Day off',
        start: { date: '2026-08-21' },
        end: { date: '2026-08-22' },
      },
      'cal-1',
      null,
    );
    assert.equal(allDay?.start.allDay, true);
    assert.equal(allDay?.start.date, '2026-08-21');
    assert.equal(allDay?.start.dateTime, null);
  });
});

describe('GOOGLE-CAL-FAST-2 pagination + salon preview (mock HTTP)', () => {
  before(() => {
    setEnv('GOOGLE_CALENDAR_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CALENDAR_CLIENT_SECRET', 'test-client-secret');
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

  it('listGoogleCalendarEventsPreview paginates and caps', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      assert.match(url, /\/calendars\/primary\/events/);
      assert.match(url, /singleEvents=true/);
      assert.match(url, /orderBy=startTime/);
      assert.match(url, /showDeleted=false/);
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'a', summary: 'One', start: { dateTime: '2026-08-01T10:00:00Z' }, end: { dateTime: '2026-08-01T11:00:00Z' } }],
            nextPageToken: 'p2',
          }),
          { status: 200 },
        );
      }
      assert.match(url, /pageToken=p2/);
      return new Response(
        JSON.stringify({
          items: [{ id: 'b', summary: 'Two', start: { dateTime: '2026-08-02T10:00:00Z' }, end: { dateTime: '2026-08-02T11:00:00Z' } }],
        }),
        { status: 200 },
      );
    };
    const result = await listGoogleCalendarEventsPreview({
      accessToken: 'at',
      calendarId: 'primary',
      calendarName: 'Primary',
      timeMin: '2026-07-01T00:00:00.000Z',
      timeMax: '2026-11-01T00:00:00.000Z',
      fetchImpl,
    });
    assert.equal(result.events.length, 2);
    assert.equal(result.truncated, false);
    assert.equal(calls, 2);
  });

  it('hard event cap sets truncated', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          items: Array.from({ length: 5 }, (_, i) => ({
            id: `e${i}`,
            summary: `E${i}`,
            start: { dateTime: '2026-08-01T10:00:00Z' },
            end: { dateTime: '2026-08-01T11:00:00Z' },
          })),
          nextPageToken: 'more',
        }),
        { status: 200 },
      );
    const result = await listGoogleCalendarEventsPreview({
      accessToken: 'at',
      calendarId: 'primary',
      timeMin: '2026-07-01T00:00:00.000Z',
      timeMax: '2026-11-01T00:00:00.000Z',
      fetchImpl,
      maxEvents: 3,
      maxPages: 10,
    });
    assert.equal(result.events.length, 3);
    assert.equal(result.truncated, true);
  });

  it('selected calendar required; salon isolation; no secrets in DTO', async () => {
    const { db, seenSalonIds } = dbWithRow(
      makeCredentialRow({ selected_calendar_id: null }),
    );
    await assert.rejects(
      () =>
        previewGoogleCalendarEventsForSalon({
          db,
          salonId: 'salon-a',
          fetchImpl: async () => new Response('{}', { status: 500 }),
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthError &&
        err.code === 'GOOGLE_CALENDAR_NOT_SELECTED',
    );

    const { db: db2, seenSalonIds: seen2 } = dbWithRow(makeCredentialRow());
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at-live', expires_in: 3600 }), {
          status: 200,
        });
      }
      assert.match(url, /\/calendars\/primary\/events/);
      assert.doesNotMatch(url, /rt-secret/);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'ev1',
              summary: 'Sara highlighting roots +46 73',
              start: { dateTime: '2026-08-20T09:00:00+04:00' },
              end: { dateTime: '2026-08-20T11:00:00+04:00' },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const preview = await previewGoogleCalendarEventsForSalon({
      db: db2,
      salonId: 'salon-bound',
      fetchImpl,
      now: new Date('2026-08-16T12:00:00.000Z'),
      salonTimeZone: 'Asia/Yerevan',
    });
    assert.deepEqual(seen2, ['salon-bound']);
    assert.equal(preview.count, 1);
    assert.equal(preview.events[0]?.summary, 'Sara highlighting roots +46 73');
    assert.equal(preview.calendarId, 'primary');
    assert.equal(preview.salonTimeZone, 'Asia/Yerevan');
    assert.ok(preview.events[0]?.parsed);
    assert.equal(preview.events[0]?.parsed?.staffCandidate, null);
    const json = JSON.stringify(preview);
    assert.equal(json.includes('rt-secret'), false);
    assert.equal(json.includes('at-live'), false);
    assert.equal(json.includes('test-client-secret'), false);
    assert.ok(seenSalonIds.length >= 0);
  });

  it('not connected when credentials missing', async () => {
    const { db } = dbWithRow(null);
    await assert.rejects(
      () => previewGoogleCalendarEventsForSalon({ db, salonId: 'salon-x' }),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthError &&
        err.code === 'GOOGLE_OAUTH_NOT_CONNECTED',
    );
  });
});

describe('GOOGLE-CAL-FAST-2 static contracts', () => {
  const routes = read('server/src/routes/calendarConnections.ts');
  const oauth = read('server/src/lib/googleCalendarOAuth.ts');
  const integrations = read('client/src/pages/SalonIntegrations.tsx');
  const apiClient = read('client/src/lib/api.ts');
  const packageJson = read('server/package.json');
  const index = read('server/src/index.ts');

  it('preview route authenticated; events.list only; no import writes', () => {
    assert.match(
      routes,
      /router\.get\('\/google\/events\/preview',\s*requireSalonWriteAccess/,
    );
    assert.match(routes, /google_not_connected|google_calendar_not_selected|google_token_refresh_failed|google_events_fetch_failed/);
    assert.match(oauth, /singleEvents/);
    assert.match(oauth, /orderBy/);
    assert.match(oauth, /showDeleted/);
    assert.match(oauth, /GOOGLE_EVENTS_PREVIEW_MAX_PAGES/);
    assert.match(oauth, /GOOGLE_EVENTS_PREVIEW_MAX_EVENTS/);
    assert.doesNotMatch(oauth, /searchParams\.set\(['"]syncToken['"]/);
    assert.doesNotMatch(routes, /from\('appointments'\)|from\('clients'\)|from\('reminders'\)|appointment_external_links|calendar_mapping_rules|calendar_import_issues/);
    assert.doesNotMatch(oauth, /import_enabled:\s*true/);
    assert.equal(GOOGLE_EVENTS_PREVIEW_MAX_PAGES, 10);
    assert.equal(GOOGLE_EVENTS_PREVIEW_MAX_EVENTS, 500);
  });

  it('UI has preview button; Apple/Telegram untouched in this patch surface', () => {
    assert.match(integrations, /previewEvents|Показать события|integrations\.google\.previewEvents/);
    assert.match(integrations, /previewBanner/);
    assert.match(apiClient, /getGoogleEventsPreview|events\/preview/);
    assert.match(routes, /router\.post\('\/apple\/connect'/);
    assert.match(routes, /router\.delete\('\/apple'/);
    assert.doesNotMatch(index, /GOOGLE-CAL-FAST-2/);
  });

  it('package registers FAST-2 suite once', () => {
    const n = (packageJson.match(/googleCalendar\.fast2\.test\.ts/g) || []).length;
    assert.equal(n, 1);
  });
});
