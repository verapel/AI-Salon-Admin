/**
 * GOOGLE-CAL-FAST-4: Read-only salon-scoped client/service matching (preview only).
 * Pure unit tests — no DB writes, Google writes, OpenRouter, or network.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseExternalCalendarEvent,
  type ExternalCalendarEventInput,
} from './calendarEventParser.js';
import {
  CALENDAR_MATCH_CATALOG_FAILED_CODE,
  CalendarMatchCatalogError,
  loadSalonCalendarMatchCatalog,
  matchParsedCalendarEvent,
  matchServiceCandidate,
  phoneDigitsKey,
  type CalendarMatchCatalog,
  type MatchableClient,
  type MatchableService,
} from './calendarEventMatcher.js';
import { previewGoogleCalendarEventsForSalon } from './googleCalendarOAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function timedEvent(
  summary: string | null,
  overrides: Partial<ExternalCalendarEventInput> = {},
): ExternalCalendarEventInput {
  return {
    summary,
    description: null,
    status: 'confirmed',
    start: {
      dateTime: '2026-07-19T05:00:00Z',
      date: null,
      timeZone: 'UTC',
      allDay: false,
    },
    end: {
      dateTime: '2026-07-19T07:00:00Z',
      date: null,
      timeZone: 'UTC',
      allDay: false,
    },
    ...overrides,
  };
}

function matchTitle(title: string, catalog: CalendarMatchCatalog) {
  const parsed = parseExternalCalendarEvent(timedEvent(title), 'Asia/Yerevan');
  const matching = matchParsedCalendarEvent({
    parsed,
    originalTitle: title,
    catalog,
  });
  return { parsed, matching };
}

describe('GOOGLE-CAL-FAST-4 calendarEventMatcher (executed)', () => {
  it('CASE A — exact phone recovers full client name + contained service', () => {
    const title = 'Agunik Yeganian +380 63 202 2810 окрашивание воде дома';
    const catalog: CalendarMatchCatalog = {
      clients: [
        { id: 'c1', name: 'Agunik Yeganian', phone: '+380632022810' },
      ],
      services: [{ id: 's1', name: 'Окрашивание' }],
    };
    const { parsed, matching } = matchTitle(title, catalog);

    // FAST-3B may split name early — matcher must not rewrite parsed fields.
    assert.equal(parsed.clientNameCandidate, 'Agunik');
    assert.equal(parsed.phone.normalized, '+380632022810');
    assert.equal(parsed.phone.confidence, 'exact');
    assert.match(parsed.serviceCandidate ?? '', /Yeganian/i);

    assert.equal(matching.client.status, 'matched');
    assert.equal(matching.client.confidence, 'exact_phone');
    assert.equal(matching.client.displayName, 'Agunik Yeganian');
    assert.equal(matching.client.clientId, 'c1');
    assert.equal(matching.client.matchedPhone, '+380632022810');
    assert.equal(matching.recognizedClientText, 'Agunik Yeganian');
    assert.equal(matching.serviceSearchText, 'окрашивание воде дома');
    assert.equal(matching.service.status, 'matched');
    assert.equal(matching.service.confidence, 'contained_name');
    assert.equal(matching.service.displayName, 'Окрашивание');
    assert.equal(matching.serviceResidualText, 'воде дома');
    assert.equal(matching.staff, null);
    assert.equal(matching.matchingStatus, 'matched');
  });

  it('CASE B — unique exact name Maria; no invented service', () => {
    const { matching } = matchTitle('Maria', {
      clients: [{ id: 'c1', name: 'Maria', phone: '' }],
      services: [{ id: 's1', name: 'Coloring' }],
    });
    assert.equal(matching.client.status, 'matched');
    assert.equal(matching.client.confidence, 'exact_name');
    assert.equal(matching.client.displayName, 'Maria');
    assert.equal(matching.service.status, 'not_attempted');
    assert.equal(matching.matchingStatus, 'partial');
    assert.equal(matching.staff, null);
  });

  it('CASE C — duplicate Maria → ambiguous, no silent pick', () => {
    const { matching } = matchTitle('Maria', {
      clients: [
        { id: 'c1', name: 'Maria', phone: '' },
        { id: 'c2', name: 'Maria', phone: '' },
      ],
      services: [],
    });
    assert.equal(matching.client.status, 'ambiguous');
    assert.equal(matching.client.clientId, null);
    assert.equal(matching.matchingStatus, 'review');
  });

  it('CASE D — phone not found; service matched → partial', () => {
    const { matching } = matchTitle('Sara +37499123456 coloring', {
      clients: [{ id: 'c1', name: 'Other', phone: '+37400000000' }],
      services: [{ id: 's1', name: 'Coloring' }],
    });
    assert.equal(matching.client.status, 'not_found');
    assert.equal(matching.client.matchedPhone, '+37499123456');
    assert.equal(matching.service.status, 'matched');
    assert.equal(matching.service.confidence, 'exact_name');
    assert.equal(matching.matchingStatus, 'partial');
  });

  it('CASE E — service exact_name', () => {
    const result = matchServiceCandidate('Окрашивание', [
      { id: 's1', name: 'Окрашивание' },
    ]);
    assert.equal(result.match.status, 'matched');
    assert.equal(result.match.confidence, 'exact_name');
    assert.equal(result.residual, null);
  });

  it('CASE F — contained service + residual', () => {
    const result = matchServiceCandidate('окрашивание воде дома', [
      { id: 's1', name: 'Окрашивание' },
    ]);
    assert.equal(result.match.status, 'matched');
    assert.equal(result.match.confidence, 'contained_name');
    assert.equal(result.match.displayName, 'Окрашивание');
    assert.equal(result.residual, 'воде дома');
  });

  it('CASE G — prefer longer competing service phrase', () => {
    const services: MatchableService[] = [
      { id: 's1', name: 'Окрашивание' },
      { id: 's2', name: 'Сложное окрашивание' },
    ];
    const result = matchServiceCandidate('сложное окрашивание', services);
    assert.equal(result.match.status, 'matched');
    assert.equal(result.match.displayName, 'Сложное окрашивание');
    assert.equal(result.match.serviceId, 's2');
    assert.notEqual(result.match.status, 'ambiguous');
  });

  it('CASE H — salon isolation via catalog scope (Salon B catalog empty for Salon A client)', () => {
    const title = 'Agunik Yeganian +380 63 202 2810 окрашивание';
    // Salon B catalog does not include Salon A client.
    const salonB: CalendarMatchCatalog = {
      clients: [],
      services: [{ id: 's1', name: 'Окрашивание' }],
    };
    const { matching } = matchTitle(title, salonB);
    assert.equal(matching.client.status, 'not_found');
    assert.equal(matching.client.clientId, null);
    assert.equal(matching.service.status, 'matched');
    assert.equal(matching.matchingStatus, 'partial');
  });

  it('CASE I — phone normalization ignores formatting differences', () => {
    const title = 'Agunik Yeganian +380 63 202 2810 coloring';
    const clients: MatchableClient[] = [
      { id: 'c1', name: 'Agunik Yeganian', phone: '+380 (63) 202-28-10' },
    ];
    const { matching } = matchTitle(title, { clients, services: [] });
    assert.equal(phoneDigitsKey('+380 (63) 202-28-10'), '380632022810');
    assert.equal(matching.client.status, 'matched');
    assert.equal(matching.client.confidence, 'exact_phone');
    assert.equal(matching.client.displayName, 'Agunik Yeganian');
  });

  it('duplicate exact phone → ambiguous, no silent first-row pick', () => {
    const title = 'Agunik Yeganian +380 63 202 2810 окрашивание';
    const { matching } = matchTitle(title, {
      clients: [
        { id: 'c1', name: 'Agunik Yeganian', phone: '+380632022810' },
        { id: 'c2', name: 'Other', phone: '+380 (63) 202-28-10' },
      ],
      services: [{ id: 's1', name: 'Окрашивание' }],
    });
    assert.equal(matching.client.status, 'ambiguous');
    assert.equal(matching.client.clientId, null);
    assert.equal(matching.client.displayName, null);
    assert.equal(matching.matchingStatus, 'review');
  });

  it('Ann must not be recognized inside Hannah (boundary-safe name recovery)', () => {
    const title = 'Hannah Smith +380 63 202 2810 окрашивание воде дома';
    const { matching } = matchTitle(title, {
      clients: [{ id: 'c1', name: 'Ann', phone: '+380632022810' }],
      services: [{ id: 's1', name: 'Окрашивание' }],
    });
    assert.equal(matching.client.status, 'matched');
    assert.equal(matching.client.confidence, 'exact_phone');
    assert.equal(matching.client.displayName, 'Ann');
    assert.equal(matching.recognizedClientText, null);
    assert.notEqual(matching.serviceSearchText, 'H ah Smith окрашивание воде дома');
    assert.match(matching.serviceSearchText ?? '', /Hannah/i);
    assert.equal(matching.service.status, 'matched');
    assert.equal(matching.service.displayName, 'Окрашивание');
  });

  it('service contained match rejects Art⊂Marta, Color⊂coloring, Cut⊂shortcut', () => {
    assert.equal(
      matchServiceCandidate('Marta', [{ id: '1', name: 'Art' }]).match.status,
      'not_found',
    );
    assert.equal(
      matchServiceCandidate('coloring', [{ id: '1', name: 'Color' }]).match.status,
      'not_found',
    );
    assert.equal(
      matchServiceCandidate('shortcut', [{ id: '1', name: 'Cut' }]).match.status,
      'not_found',
    );
  });

  it('equal-length contained services → ambiguous', () => {
    const result = matchServiceCandidate('foo bar', [
      { id: '1', name: 'foo' },
      { id: '2', name: 'bar' },
    ]);
    assert.equal(result.match.status, 'ambiguous');
    assert.equal(result.match.serviceId, null);
  });

  it('CASE J — Armenian / Unicode safety (no corruption)', () => {
    const title = 'Անի Մատնահարդարում';
    const { parsed, matching } = matchTitle(title, {
      clients: [{ id: 'c1', name: 'Անի', phone: '' }],
      services: [{ id: 's1', name: 'Մատնահարդարում' }],
    });
    assert.ok((parsed.clientNameCandidate || parsed.serviceCandidate || '').includes('Անի') ||
      (parsed.serviceCandidate || '').includes('Մատնահարդարում') ||
      matching.client.displayName === 'Անի' ||
      matching.service.displayName === 'Մատնահարդարում');
    // Matcher must not mangle Armenian characters in outputs it does produce.
    const blob = JSON.stringify({ parsed, matching });
    assert.equal(blob.includes('Անի') || blob.includes('Մատնահարդարում'), true);
    assert.equal(matching.staff, null);
  });

  it('CASE K — matcher source has no insert/update/upsert/delete', () => {
    const src = read('server/src/lib/calendarEventMatcher.ts');
    assert.doesNotMatch(src, /\.insert\s*\(/);
    assert.doesNotMatch(src, /\.update\s*\(/);
    assert.doesNotMatch(src, /\.upsert\s*\(/);
    assert.doesNotMatch(src, /\.delete\s*\(/);
    assert.match(src, /READ ONLY|read-only|read only/i);
    assert.match(src, /staff:\s*null/);
  });

  it('CASE L — FAST-3B parser still behaves (Agunik split unchanged)', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Agunik Yeganian +380 63 202 2810 окрашивание воде дома'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.clientNameCandidate, 'Agunik');
    assert.equal(parsed.phone.normalized, '+380632022810');
    assert.match(parsed.serviceCandidate ?? '', /Yeganian/);
    assert.equal(parsed.staffCandidate, null);
  });

  it('does not silently match first-name candidate to longer DB name', () => {
    const { matching } = matchTitle('Maria', {
      clients: [{ id: 'c1', name: 'Maria Petrosyan', phone: '' }],
      services: [],
    });
    assert.equal(matching.client.status, 'not_found');
    assert.equal(matching.client.clientId, null);
  });

  it('loadSalonCalendarMatchCatalog scopes by salon_id, active services, minimal columns', async () => {
    const seen: Array<{ table: string; cols: string; filters: Array<[string, unknown]> }> =
      [];
    const db = {
      from(table: string) {
        return {
          select(cols: string) {
            const filters: Array<[string, unknown]> = [];
            const chain: any = {
              eq(col: string, val: unknown) {
                filters.push([col, val]);
                return chain;
              },
              then(resolve: (v: unknown) => void) {
                seen.push({ table, cols, filters: [...filters] });
                if (table === 'clients') {
                  resolve({
                    data: [
                      {
                        id: 'c1',
                        name: 'A',
                        phone: '+1',
                        notes: 'SECRET',
                        birthday: '2000-01-01',
                      },
                    ],
                    error: null,
                  });
                  return;
                }
                resolve({
                  data: [{ id: 's1', name: 'Cut', price: 999 }],
                  error: null,
                });
              },
            };
            return chain;
          },
        };
      },
    };
    const catalog = await loadSalonCalendarMatchCatalog(db, 'salon-only');
    const clientCall = seen.find((s) => s.table === 'clients');
    const serviceCall = seen.find((s) => s.table === 'services');
    assert.ok(clientCall);
    assert.ok(serviceCall);
    assert.equal(clientCall!.cols, 'id, name, phone');
    assert.equal(serviceCall!.cols, 'id, name');
    assert.deepEqual(clientCall!.filters, [['salon_id', 'salon-only']]);
    assert.deepEqual(serviceCall!.filters, [
      ['salon_id', 'salon-only'],
      ['active', true],
    ]);
    assert.deepEqual(catalog.clients, [{ id: 'c1', name: 'A', phone: '+1' }]);
    assert.deepEqual(catalog.services, [{ id: 's1', name: 'Cut' }]);
    assert.equal(JSON.stringify(catalog).includes('SECRET'), false);
    assert.equal(JSON.stringify(catalog).includes('birthday'), false);
  });

  it('FIX-1B A — client catalog SELECT error throws safe catalog error (no empty catalog)', async () => {
    const db = {
      from(table: string) {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then(resolve: (v: unknown) => void) {
                if (table === 'clients') {
                  resolve({ data: null, error: { message: 'clients-boom SECRET_SQL' } });
                  return;
                }
                resolve({ data: [], error: null });
              },
            };
            return chain;
          },
        };
      },
    };
    await assert.rejects(
      () => loadSalonCalendarMatchCatalog(db, 'salon-err'),
      (err: unknown) =>
        err instanceof CalendarMatchCatalogError &&
        err.code === CALENDAR_MATCH_CATALOG_FAILED_CODE &&
        err.catalog === 'clients' &&
        err.salonId === 'salon-err' &&
        !String(err.message).includes('SECRET_SQL'),
    );
  });

  it('FIX-1B B — service catalog SELECT error throws safe catalog error', async () => {
    const db = {
      from(table: string) {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then(resolve: (v: unknown) => void) {
                if (table === 'services') {
                  resolve({ data: null, error: { message: 'services-boom' } });
                  return;
                }
                resolve({ data: [], error: null });
              },
            };
            return chain;
          },
        };
      },
    };
    await assert.rejects(
      () => loadSalonCalendarMatchCatalog(db, 'salon-err'),
      (err: unknown) =>
        err instanceof CalendarMatchCatalogError &&
        err.catalog === 'services' &&
        err.code === CALENDAR_MATCH_CATALOG_FAILED_CODE,
    );
  });

  it('FIX-1B C — client success + service failure → whole catalog load fails', async () => {
    const db = {
      from(table: string) {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then(resolve: (v: unknown) => void) {
                if (table === 'clients') {
                  resolve({
                    data: [{ id: 'c1', name: 'A', phone: '+1' }],
                    error: null,
                  });
                  return;
                }
                resolve({ data: null, error: { message: 'services-down' } });
              },
            };
            return chain;
          },
        };
      },
    };
    await assert.rejects(
      () => loadSalonCalendarMatchCatalog(db, 'salon-partial'),
      (err: unknown) =>
        err instanceof CalendarMatchCatalogError && err.catalog === 'services',
    );
  });

  it('FIX-1B D — service success + client failure → whole catalog load fails', async () => {
    const db = {
      from(table: string) {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then(resolve: (v: unknown) => void) {
                if (table === 'clients') {
                  resolve({ data: null, error: { message: 'clients-down' } });
                  return;
                }
                resolve({
                  data: [{ id: 's1', name: 'Cut' }],
                  error: null,
                });
              },
            };
            return chain;
          },
        };
      },
    };
    await assert.rejects(
      () => loadSalonCalendarMatchCatalog(db, 'salon-partial'),
      (err: unknown) =>
        err instanceof CalendarMatchCatalogError && err.catalog === 'clients',
    );
  });

  it('FIX-1B E — successful SELECT returning [] is a valid empty catalog', async () => {
    const db = {
      from(_table: string) {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              then(resolve: (v: unknown) => void) {
                resolve({ data: [], error: null });
              },
            };
            return chain;
          },
        };
      },
    };
    const catalog = await loadSalonCalendarMatchCatalog(db, 'salon-empty');
    assert.deepEqual(catalog, { clients: [], services: [] });
  });

  it('FIX-1B preview propagates catalog failure (does not match against fake empty catalog)', async () => {
    const { encryptCalendarCredential } = await import('./calendarCredentialsCrypto.js');
    const { serializeGoogleCalendarCredentialBlob, GOOGLE_CALENDAR_OAUTH_SCOPE } =
      await import('./googleCalendarOAuth.js');
    const prevKey = process.env.CALENDAR_CREDENTIALS_ENCRYPTION_KEY;
    const prevCid = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const prevSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const prevRedirect = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
    process.env.CALENDAR_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_CALENDAR_REDIRECT_URI =
      'https://app.example.com/api/calendar/google/callback';
    try {
      const enc = encryptCalendarCredential(
        serializeGoogleCalendarCredentialBlob({
          refresh_token: 'rt-secret',
          scope: GOOGLE_CALENDAR_OAUTH_SCOPE,
          token_type: 'Bearer',
        }),
      );
      const row = {
        id: 'row1',
        credential_ciphertext: enc.ciphertext,
        credential_iv: enc.iv,
        credential_auth_tag: enc.authTag,
        status: 'connected',
        selected_calendar_id: 'primary',
        selected_calendar_name: 'cal',
        provider_config: {},
      };
      await assert.rejects(
        () =>
          previewGoogleCalendarEventsForSalon({
            db: {
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
            },
            salonId: 'salon-x',
            salonTimeZone: 'Asia/Yerevan',
            now: new Date('2026-08-16T12:00:00.000Z'),
            fetchImpl: async (input) => {
              const url = String(input);
              if (url.includes('/token')) {
                return new Response(
                  JSON.stringify({ access_token: 'at-live', expires_in: 3600 }),
                  { status: 200 },
                );
              }
              return new Response(JSON.stringify({ items: [] }), { status: 200 });
            },
            loadMatchCatalog: async () => {
              throw new CalendarMatchCatalogError({
                catalog: 'clients',
                salonId: 'salon-x',
              });
            },
          }),
        (err: unknown) =>
          err instanceof CalendarMatchCatalogError &&
          err.code === CALENDAR_MATCH_CATALOG_FAILED_CODE &&
          err.catalog === 'clients',
      );
    } finally {
      if (prevKey === undefined) delete process.env.CALENDAR_CREDENTIALS_ENCRYPTION_KEY;
      else process.env.CALENDAR_CREDENTIALS_ENCRYPTION_KEY = prevKey;
      if (prevCid === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
      else process.env.GOOGLE_CALENDAR_CLIENT_ID = prevCid;
      if (prevSecret === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
      else process.env.GOOGLE_CALENDAR_CLIENT_SECRET = prevSecret;
      if (prevRedirect === undefined) delete process.env.GOOGLE_CALENDAR_REDIRECT_URI;
      else process.env.GOOGLE_CALENDAR_REDIRECT_URI = prevRedirect;
    }
  });
});

describe('GOOGLE-CAL-FAST-4 static contracts', () => {
  const matcher = read('server/src/lib/calendarEventMatcher.ts');
  const oauth = read('server/src/lib/googleCalendarOAuth.ts');
  const routes = read('server/src/routes/calendarConnections.ts');
  const integrations = read('client/src/pages/SalonIntegrations.tsx');
  const index = read('server/src/index.ts');
  const packageJson = read('server/package.json');

  it('preview wires matcher; no import writes; staff null', () => {
    assert.match(oauth, /matchParsedCalendarEvent/);
    assert.match(oauth, /loadSalonCalendarMatchCatalog/);
    assert.match(oauth, /matchingStatus/);
    assert.match(matcher, /\.eq\('active',\s*true\)/);
    assert.match(matcher, /findBoundedPhraseSpan/);
    assert.match(matcher, /CalendarMatchCatalogError/);
    assert.match(routes, /calendar_match_catalog_failed|CALENDAR_MATCH_CATALOG_FAILED_CODE/);
    assert.match(routes, /CalendarMatchCatalogError/);
    assert.doesNotMatch(oauth, /import_enabled:\s*true/);
    assert.doesNotMatch(matcher, /\.insert\s*\(|\.update\s*\(|\.upsert\s*\(|\.delete\s*\(/);
    assert.doesNotMatch(routes, /from\('appointments'\)|from\('reminders'\)|appointment_external_links|calendar_mapping_rules|calendar_import_issues/);
    // Route still must not query clients directly (catalog load lives in oauth/matcher).
    assert.doesNotMatch(routes, /from\('clients'\)/);
  });

  it('UI has matching section; no Import/Save/Confirm/Match action buttons', () => {
    assert.match(integrations, /matchingSection|integrations\.google\.matchingSection/);
    assert.match(integrations, /previewMatchNote/);
    assert.doesNotMatch(
      integrations,
      /Import events|Save import|Confirm match|Enable import|import_enabled/i,
    );
  });

  it('protected systems untouched by this patch surface', () => {
    // index.ts not required to change for FAST-4
    assert.ok(index.length > 0);
    assert.match(packageJson, /calendarEventMatcher\.fast4\.test\.ts/);
    assert.doesNotMatch(matcher, /openrouter|openai|OpenAI|OpenRouter/i);
    assert.doesNotMatch(oauth, /openrouter|openai/i);
  });
});
