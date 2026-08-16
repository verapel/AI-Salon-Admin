/**
 * GOOGLE-CAL-FAST-3B: Deterministic calendar event parser (preview only).
 * Pure unit tests — no DB, Google, OpenRouter, or network.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  instantToSalonLocal,
  isValidStandaloneClockToken,
  parseExternalCalendarEvent,
  type ExternalCalendarEventInput,
} from './calendarEventParser.js';

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

describe('GOOGLE-CAL-FAST-3B calendarEventParser (executed)', () => {
  it('1. Maria +374 phone → exact phone + name; REVIEW without service', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria +374 99 123456'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.clientNameCandidate, 'Maria');
    assert.equal(parsed.serviceCandidate, null);
    assert.equal(parsed.staffCandidate, null);
    assert.equal(parsed.importability, 'review');
    assert.ok(parsed.classification.includes('has_exact_phone'));
    assert.ok(parsed.classification.includes('name_candidate'));
  });

  it('2. Russian service + 50000 → not phone; price + service', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Однотонное окрашивание 50000'),
      'Asia/Yerevan',
    );
    assert.notEqual(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.confidence, 'none');
    assert.ok(parsed.priceCandidate.confidence === 'possible' || parsed.priceCandidate.confidence === 'likely');
    assert.equal(parsed.priceCandidate.value, 50000);
    assert.equal(parsed.serviceCandidate, 'Однотонное окрашивание');
    assert.equal(parsed.clientNameCandidate, null);
    assert.equal(parsed.importability, 'review');
  });

  it('3. Armenian Unicode title preserved', () => {
    const title = 'Մատնահարդարում';
    const parsed = parseExternalCalendarEvent(timedEvent(title), 'Asia/Yerevan');
    assert.equal(parsed.serviceCandidate, title);
    assert.equal(parsed.clientNameCandidate, null);
    assert.ok(!parsed.reasons.some((r) => r.includes('corrupt')));
  });

  it('4. Mixed Armenian + phone → phone exact; Unicode preserved in residual', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Անի +37491111222'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+37491111222');
    const blob = JSON.stringify(parsed);
    assert.ok(blob.includes('Անի') || parsed.serviceCandidate === 'Անի' || parsed.clientNameCandidate === 'Անի');
  });

  it('5. Bare 50000 is NOT exact phone', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('50000'), 'Asia/Yerevan');
    assert.notEqual(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.confidence, 'none');
  });

  it('6. Compact +37499123456 → exact phone; alone is REVIEW', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('+37499123456'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.importability, 'review');
  });

  it('7. All-day → not_importable', () => {
    const parsed = parseExternalCalendarEvent(
      {
        summary: 'Day off',
        description: null,
        status: 'confirmed',
        start: { dateTime: null, date: '2026-07-20', timeZone: null, allDay: true },
        end: { dateTime: null, date: '2026-07-21', timeZone: null, allDay: true },
      },
      'Asia/Yerevan',
    );
    assert.equal(parsed.importability, 'not_importable');
    assert.ok(parsed.classification.includes('all_day'));
    assert.ok(parsed.reasons.includes('all_day_event'));
    assert.equal(parsed.durationMinutes, null);
    assert.equal(parsed.staffCandidate, null);
  });

  it('8. Cancelled → not_importable', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria +37499123456', { status: 'cancelled' }),
      'Asia/Yerevan',
    );
    assert.equal(parsed.importability, 'not_importable');
    assert.ok(parsed.classification.includes('cancelled'));
    assert.ok(parsed.reasons.includes('cancelled_event'));
  });

  it('9. Invalid / missing start datetime → not_importable', () => {
    const parsed = parseExternalCalendarEvent(
      {
        summary: 'Maria',
        description: null,
        status: 'confirmed',
        start: { dateTime: 'not-a-date', date: null, timeZone: null, allDay: false },
        end: { dateTime: '2026-07-19T07:00:00Z', date: null, timeZone: null, allDay: false },
      },
      'Asia/Yerevan',
    );
    assert.equal(parsed.importability, 'not_importable');
    assert.equal(parsed.localStartTime, null);
  });

  it('10. UTC 2026-07-19T05:00:00Z + Asia/Yerevan → 2026-07-19 09:00', () => {
    const local = instantToSalonLocal('2026-07-19T05:00:00Z', 'Asia/Yerevan');
    assert.deepEqual(local, { date: '2026-07-19', time: '09:00' });
    const parsed = parseExternalCalendarEvent(timedEvent('x'), 'Asia/Yerevan');
    assert.equal(parsed.localDate, '2026-07-19');
    assert.equal(parsed.localStartTime, '09:00');
  });

  it('11. duration 05:00Z → 07:00Z = 120 minutes', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('x'), 'Asia/Yerevan');
    assert.equal(parsed.durationMinutes, 120);
    assert.equal(parsed.localEndTime, '11:00');
  });

  it('12. missing summary → no crash; conservative classification', () => {
    const parsed = parseExternalCalendarEvent(timedEvent(null), 'Asia/Yerevan');
    assert.ok(parsed.classification.includes('missing_summary'));
    assert.equal(parsed.staffCandidate, null);
    assert.equal(parsed.importability, 'review');
  });

  it('13. English name + service style → structural ready', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Anna gel manicure'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.clientNameCandidate, 'Anna');
    assert.equal(parsed.serviceCandidate, 'gel manicure');
    assert.equal(parsed.importability, 'ready');
  });

  it('14. Russian title without phone', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Стрижка женская'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.serviceCandidate, 'Стрижка женская');
    assert.equal(parsed.clientNameCandidate, null);
    assert.equal(parsed.importability, 'review');
  });

  it('15. Ambiguous mixed title → does not fabricate phone/price', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Anna Մատնահարդարում color'),
      'Asia/Yerevan',
    );
    assert.ok(parsed.classification.includes('ambiguous') || parsed.classification.includes('multilingual'));
    assert.equal(parsed.phone.confidence, 'none');
    assert.equal(parsed.priceCandidate.confidence, 'none');
    assert.equal(parsed.staffCandidate, null);
  });

  it('staffCandidate always null', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria coloring +37499123456'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.staffCandidate, null);
    assert.ok(parsed.reasons.includes('staff_requires_future_mapping'));
  });

  it('price with AMD currency → likely', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Окрашивание 50000 AMD'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.priceCandidate.confidence, 'likely');
    assert.equal(parsed.priceCandidate.value, 50000);
    assert.notEqual(parsed.phone.confidence, 'exact');
  });
});

describe('GOOGLE-CAL-FAST-3B-FIX-1 phone+price (executed)', () => {
  it('Maria coloring +37499123456 50000 → phone exact, price 50000, service without phone', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria coloring +37499123456 50000'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.priceCandidate.value, 50000);
    assert.equal(parsed.clientNameCandidate, 'Maria');
    assert.equal(parsed.serviceCandidate, 'coloring');
    assert.equal(parsed.serviceCandidate?.includes('374'), false);
    assert.equal(parsed.importability, 'ready');
  });

  it('Sara +46 70 123 45 67 1200 → phone without trailing 1200', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Sara +46 70 123 45 67 1200'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+46701234567');
    assert.notEqual(parsed.phone.normalized, '+467012345671200');
    assert.equal(parsed.priceCandidate.value, 1200);
    assert.equal(parsed.importability, 'review');
  });

  it('Maria +374 99 123456 15000 → exact phone + trailing price', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria +374 99 123456 15000'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.priceCandidate.value, 15000);
    assert.ok(
      parsed.priceCandidate.confidence === 'possible' ||
        parsed.priceCandidate.confidence === 'likely',
    );
    assert.equal(parsed.importability, 'review');
  });

  it('Окрашивание +37499123456 50000 AMD → phone + likely price; service without digits', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Окрашивание +37499123456 50000 AMD'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.priceCandidate.value, 50000);
    assert.equal(parsed.priceCandidate.confidence, 'likely');
    assert.equal(parsed.serviceCandidate, 'Окрашивание');
    assert.equal(parsed.serviceCandidate?.includes('374'), false);
    assert.equal(parsed.importability, 'ready');
  });

  it('ISO date 2026-07-19 is not a phone', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('2026-07-19'), 'Asia/Yerevan');
    assert.equal(parsed.phone.confidence, 'none');
    assert.equal(parsed.phone.normalized, null);
  });

  it('clock time 12:30 is not a phone', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('12:30'), 'Asia/Yerevan');
    assert.equal(parsed.phone.confidence, 'none');
  });

  it('incomplete +46 73 is not exact phone', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('+46 73'), 'Asia/Yerevan');
    assert.notEqual(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, null);
  });

  it('incomplete +374 is not exact phone', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('+374'), 'Asia/Yerevan');
    assert.notEqual(parsed.phone.confidence, 'exact');
  });

  it('spaced +374 99 123456 is exact', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Client +374 99 123456'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+37499123456');
  });

  it('+7 with parentheses/hyphens is exact', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Ivan +7 (916) 123-45-67'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+79161234567');
  });
});

describe('GOOGLE-CAL-FAST-3B-FIX-2 phone + HH:MM (executed)', () => {
  it('1. Maria +37499123456 15:00 → phone exact; not absorb 15; service not :00', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria +37499123456 15:00'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.confidence, 'exact');
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.notEqual(parsed.phone.normalized, '+3749912345615');
    assert.notEqual(parsed.serviceCandidate, ':00');
    assert.equal(parsed.serviceCandidate, null);
  });

  it('2. Maria +374 99 123456 15:00 → spaced phone intact', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria +374 99 123456 15:00'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.phone.confidence, 'exact');
    assert.notEqual(parsed.serviceCandidate, ':00');
    assert.equal(parsed.serviceCandidate, null);
  });

  it('3. Sara +46 70 123 45 67 09:30 → phone without hour digits', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Sara +46 70 123 45 67 09:30'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+46701234567');
    assert.equal(parsed.phone.confidence, 'exact');
    assert.notEqual(parsed.serviceCandidate, ':00');
    assert.notEqual(parsed.serviceCandidate, ':30');
    assert.equal(parsed.serviceCandidate, null);
  });

  it('4. +7 (916) 123-45-67 18:45 → phone exact', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('+7 (916) 123-45-67 18:45'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+79161234567');
    assert.equal(parsed.phone.confidence, 'exact');
    assert.notEqual(parsed.serviceCandidate, ':00');
    assert.notEqual(parsed.serviceCandidate, ':45');
  });

  it('5. 15:00 alone → no phone', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('15:00'), 'Asia/Yerevan');
    assert.equal(parsed.phone.confidence, 'none');
    assert.equal(parsed.phone.normalized, null);
  });

  it('6. 09:30 alone → no phone', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('09:30'), 'Asia/Yerevan');
    assert.equal(parsed.phone.confidence, 'none');
    assert.equal(parsed.phone.normalized, null);
  });
});

describe('GOOGLE-CAL-FAST-3B-FIX-3 clock not a service signal (executed)', () => {
  it('1. Maria +37499123456 15:00 → service null; review', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria +37499123456 15:00'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.clientNameCandidate, 'Maria');
    assert.equal(parsed.serviceCandidate, null);
    assert.equal(parsed.importability, 'review');
  });

  it('2. Sara +46 70 123 45 67 09:30 → service null; review', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Sara +46 70 123 45 67 09:30'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+46701234567');
    assert.equal(parsed.clientNameCandidate, 'Sara');
    assert.equal(parsed.serviceCandidate, null);
    assert.equal(parsed.importability, 'review');
  });

  it('3. Maria coloring +37499123456 15:00 → service exactly coloring; ready', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Maria coloring +37499123456 15:00'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.phone.normalized, '+37499123456');
    assert.equal(parsed.clientNameCandidate, 'Maria');
    assert.equal(parsed.serviceCandidate, 'coloring');
    assert.equal(parsed.importability, 'ready');
  });

  it('4. Vera окрашивание 14:30 → service exactly окрашивание', () => {
    const parsed = parseExternalCalendarEvent(
      timedEvent('Vera окрашивание 14:30'),
      'Asia/Yerevan',
    );
    assert.equal(parsed.clientNameCandidate, 'Vera');
    assert.equal(parsed.serviceCandidate, 'окрашивание');
    assert.equal(parsed.importability, 'ready');
  });

  it('5. 15:00 alone → not a service', () => {
    const parsed = parseExternalCalendarEvent(timedEvent('15:00'), 'Asia/Yerevan');
    assert.equal(parsed.serviceCandidate, null);
    assert.equal(parsed.clientNameCandidate, null);
    assert.notEqual(parsed.importability, 'ready');
  });

  it('6. 25:00 is not a valid clock token (not silently stripped as HH:MM)', () => {
    assert.equal(isValidStandaloneClockToken('25:00'), false);
    assert.equal(isValidStandaloneClockToken('12:99'), false);
    assert.equal(isValidStandaloneClockToken('123:45'), false);
    assert.equal(isValidStandaloneClockToken('1:2'), false);
    assert.equal(isValidStandaloneClockToken('15:00'), true);
    assert.equal(isValidStandaloneClockToken('9:30'), true);
  });
});

describe('GOOGLE-CAL-FAST-3B safety contracts (static)', () => {
  const parser = read('server/src/lib/calendarEventParser.ts');
  const oauth = read('server/src/lib/googleCalendarOAuth.ts');
  const routes = read('server/src/routes/calendarConnections.ts');
  const integrations = read('client/src/pages/SalonIntegrations.tsx');
  const index = read('server/src/index.ts');
  const packageJson = read('server/package.json');

  it('parser module is pure — no supabase/fetch/OpenRouter/env secrets', () => {
    assert.doesNotMatch(parser, /supabase|OPENROUTER|process\.env|fetch\(/);
    assert.doesNotMatch(parser, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    assert.match(parser, /staffCandidate:\s*null/);
  });

  it('preview path does not write business tables', () => {
    assert.doesNotMatch(
      routes,
      /from\('appointments'\)|from\('clients'\)|from\('reminders'\)|appointment_external_links|calendar_mapping_rules|calendar_import_issues/,
    );
    // Preview may read import_enabled for auto-eligibility display; must not mutate it.
    const previewStart = routes.indexOf("/google/events/preview");
    const previewSlice = routes.slice(previewStart, previewStart + 4500);
    assert.doesNotMatch(
      previewSlice,
      /import_enabled\s*:\s*true|import_enabled\s*=\s*true|\.update\([\s\S]*import_enabled/,
    );
    assert.doesNotMatch(previewSlice, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });

  it('no Google write endpoints / AI LLM usage in FAST-3B path', () => {
    assert.doesNotMatch(oauth, /calendar\.events\.insert|events\.patch|events\.update|events\.delete/);
    assert.doesNotMatch(oauth, /OPENROUTER|openrouter|gpt-4o/);
    assert.doesNotMatch(parser, /OPENROUTER|openrouter|gpt-4o|from ['"]openai['"]/i);
  });

  it('UI is observation-only — no import/save/confirm/match actions', () => {
    assert.doesNotMatch(
      integrations,
      /Import all|Import event|Save import|Confirm import|Match service/i,
    );
    assert.match(integrations, /previewParseNote/);
    assert.match(integrations, /parsedStaffUnset/);
    assert.match(integrations, /reasonStaffUnset|parsedReasonLabels/);
    assert.match(integrations, /PARSED|parsedReady/);
  });

  it('package registers FAST-3B suite; calendar route has no Telegram/LLM wiring', () => {
    assert.doesNotMatch(routes, /OPENROUTER|openrouter|TelegramBotManager/);
    assert.match(packageJson, /calendarEventParser\.fast3b\.test\.ts/);
  });

  it('index.ts still has no Google write helpers introduced by 3B', () => {
    assert.doesNotMatch(index, /parseExternalCalendarEvent/);
  });
});
