/**
 * GOOGLE-CAL-FAST-3B: Pure deterministic calendar event parser (preview only).
 * Provider-neutral input shape. No DB, fetch, Google API, AI/LLM, or secrets.
 */

/** Minimal time shape compatible with Google FAST-2 preview (and future Apple). */
export type ExternalEventTimeInput = {
  dateTime: string | null;
  date: string | null;
  timeZone: string | null;
  allDay: boolean;
};

/** Minimal external event shape for parsing (Google FAST-2 fields). */
export type ExternalCalendarEventInput = {
  summary: string | null;
  description: string | null;
  status: string | null;
  start: ExternalEventTimeInput;
  end: ExternalEventTimeInput;
};

export type CalendarParseImportability = 'ready' | 'review' | 'not_importable';

export type CalendarPhoneConfidence = 'exact' | 'possible' | 'none';

export type CalendarPriceConfidence = 'likely' | 'possible' | 'none';

export type CalendarParsedPhone = {
  value: string | null;
  normalized: string | null;
  confidence: CalendarPhoneConfidence;
};

export type CalendarParsedPrice = {
  value: number | null;
  raw: string | null;
  confidence: CalendarPriceConfidence;
};

export type CalendarEventParsedPreview = {
  classification: string[];
  importability: CalendarParseImportability;
  localDate: string | null;
  localStartTime: string | null;
  localEndTime: string | null;
  durationMinutes: number | null;
  clientNameCandidate: string | null;
  phone: CalendarParsedPhone;
  serviceCandidate: string | null;
  priceCandidate: CalendarParsedPrice;
  /** Always null in FAST-3B — staff must not be inferred from Google account. */
  staffCandidate: null;
  reasons: string[];
};

/** Matches scheduleSlots FALLBACK_TIMEZONE without importing that module (keeps parser pure). */
export const CALENDAR_PARSER_FALLBACK_TIMEZONE = 'Europe/Moscow';

const PRICE_CURRENCY_RE =
  /(\d{1,3}(?:[ \u00a0]\d{3})+|\d{4,7})\s*(?:AMD|amd|֏|драм(?:ов|а)?|драм|RUB|rub|руб(?:\.|лей|ля)?|EUR|eur|€|USD|usd|\$)/gi;

const TRAILING_PRICE_RE =
  /(?:^|[\s,;|/(\-–—])(\d{4,7})(?=\s*$|[\s,;.!?)]|$)/g;

const URL_RE = /https?:\/\/\S+/gi;

/** ISO-like date tokens (must never be phones). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Clock time HH:MM (must never be phones). */
const CLOCK_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

function isValidIanaTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Same semantics as scheduleSlots.resolveTimezone (fallback Europe/Moscow). */
export function resolveParserTimezone(raw: string | null | undefined): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed && isValidIanaTimeZone(trimmed)) return trimmed;
  return CALENDAR_PARSER_FALLBACK_TIMEZONE;
}

/**
 * Display timezone for a Google timed event.
 * Prefer the event's own IANA zone (what Google Calendar shows), then salon.
 */
export function resolveGoogleEventDisplayTimezone(
  eventTimeZone: string | null | undefined,
  salonTimeZone: string | null | undefined,
): string {
  const eventTz = typeof eventTimeZone === 'string' ? eventTimeZone.trim() : '';
  if (eventTz && eventTz !== 'UTC' && isValidIanaTimeZone(eventTz)) return eventTz;
  return resolveParserTimezone(salonTimeZone);
}

/**
 * Wall clock already encoded in an RFC3339 dateTime with a numeric offset
 * (not Z). Used only when the event has no IANA timeZone, so we do not
 * re-project that offset through a different salon zone.
 */
export function wallClockFromOffsetDateTime(
  iso: string | null | undefined,
): { date: string; time: string } | null {
  const raw = typeof iso === 'string' ? iso.trim() : '';
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?([+-]\d{2}:?\d{2})$/.exec(
    raw,
  );
  if (!m) return null;
  return { date: m[1], time: `${m[2]}:${m[3]}` };
}

/**
 * Convert a Google dateTime instant to the local clock Google Calendar shows.
 * Event IANA zone wins; else numeric-offset wall clock; else salon zone.
 */
export function localClockForExternalInstant(
  dateTime: string,
  eventTimeZone: string | null | undefined,
  salonTimeZone: string | null | undefined,
): { date: string; time: string } | null {
  const eventTz = typeof eventTimeZone === 'string' ? eventTimeZone.trim() : '';
  // UTC on the event is the instant's zone, not the salon/calendar display zone.
  if (eventTz && eventTz !== 'UTC' && isValidIanaTimeZone(eventTz)) {
    return instantToSalonLocal(dateTime, eventTz);
  }
  const fromOffset = wallClockFromOffsetDateTime(dateTime);
  if (fromOffset) return fromOffset;
  return instantToSalonLocal(dateTime, resolveParserTimezone(salonTimeZone));
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function normalizeCalendarTitle(text: string | null | undefined): string {
  if (typeof text !== 'string') return '';
  return collapseWhitespace(text);
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function formatHhMm(hour: number, minute: number): string {
  const h = hour === 24 ? 0 : hour;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Convert an ISO / RFC3339 instant to salon-local date + HH:MM via IANA timezone.
 */
export function instantToSalonLocal(
  iso: string,
  timeZoneRaw: string,
): { date: string; time: string } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const timeZone = resolveParserTimezone(timeZoneRaw);
  const d = new Date(ms);

  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const date = dateFmt.format(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { date, time: formatHhMm(hour, minute) };
}

function emptyPhone(): CalendarParsedPhone {
  return { value: null, normalized: null, confidence: 'none' };
}

function emptyPrice(): CalendarParsedPrice {
  return { value: null, raw: null, confidence: 'none' };
}

type PhoneHit = {
  raw: string;
  normalized: string | null;
  confidence: CalendarPhoneConfidence;
  index: number;
  length: number;
};

function isDateOrTimeToken(token: string): boolean {
  const t = token.trim();
  return ISO_DATE_RE.test(t) || CLOCK_TIME_RE.test(t);
}

/**
 * True when a whitespace-separated digit group after an already-valid phone
 * looks like an unrelated trailing price / numeric note (not more phone digits).
 */
function looksLikeTrailingNumericToken(
  currentDigits: string,
  nextDigitGroup: string,
): boolean {
  if (!/^\d{3,7}$/.test(nextDigitGroup)) return false;
  // Once we already have a plausible international length, stop before short/mid tokens.
  if (currentDigits.length >= 10) return true;
  // If adding the next group would leave us past E.164 max, it cannot be phone continuation.
  if (currentDigits.length + nextDigitGroup.length > 15) return true;
  return false;
}

/**
 * True when text at `index` starts an HH:MM(-style) clock token (e.g. 15:00, 9:30).
 * Used to stop phone capture before hour digits of a trailing time.
 */
function startsWithClockTimeToken(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  return /^\d{1,2}:\d{2}(?!\d)/.test(text.slice(index));
}

/**
 * After an already-valid phone (≥8 digits), stop before trailing price OR clock time.
 */
function shouldStopBeforeTrailingToken(
  currentDigits: string,
  text: string,
  nextTokenIndex: number,
  nextDigitGroup: string,
): boolean {
  if (currentDigits.length < 8) return false;
  if (startsWithClockTimeToken(text, nextTokenIndex)) return true;
  return looksLikeTrailingNumericToken(currentDigits, nextDigitGroup);
}

/**
 * From a '+' at `plusIndex`, consume phone separators/digits but stop before an
 * unrelated trailing numeric token (e.g. price) or HH:MM clock time.
 * Returns null if not 8–15 digits.
 */
function extractExactPhoneFromPlus(text: string, plusIndex: number): PhoneHit | null {
  if (text[plusIndex] !== '+') return null;

  let i = plusIndex + 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;

  let digits = '';
  let lastAcceptedEnd = plusIndex + 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (/[()\-.]/.test(ch)) {
      i += 1;
      continue;
    }

    if (/\d/.test(ch)) {
      let j = i;
      while (j < text.length && /\d/.test(text[j]!)) j += 1;
      const group = text.slice(i, j);

      if (shouldStopBeforeTrailingToken(digits, text, i, group)) {
        break;
      }
      if (digits.length + group.length > 15) {
        // Contiguous overflow: do not accept a truncated ambiguous run as exact.
        if (digits.length < 8) return null;
        break;
      }

      digits += group;
      i = j;
      lastAcceptedEnd = j;

      // After a complete 8–15 digit phone, peek: whitespace + trailing price/time → stop.
      if (digits.length >= 8 && digits.length <= 15) {
        let k = i;
        while (k < text.length && /\s/.test(text[k]!)) k += 1;
        if (k < text.length && /\d/.test(text[k]!)) {
          let m = k;
          while (m < text.length && /\d/.test(text[m]!)) m += 1;
          const nextGroup = text.slice(k, m);
          if (shouldStopBeforeTrailingToken(digits, text, k, nextGroup)) {
            break;
          }
        }
      }
      continue;
    }

    if (/\s/.test(ch)) {
      let k = i;
      while (k < text.length && /\s/.test(text[k]!)) k += 1;
      // Allow grouping parentheses between digit runs: "+7 (916) 123-45-67".
      while (k < text.length && /[()]/.test(text[k]!)) k += 1;
      while (k < text.length && /\s/.test(text[k]!)) k += 1;
      if (k >= text.length || !/\d/.test(text[k]!)) break;

      let m = k;
      while (m < text.length && /\d/.test(text[m]!)) m += 1;
      const nextGroup = text.slice(k, m);

      if (shouldStopBeforeTrailingToken(digits, text, k, nextGroup)) {
        break;
      }
      if (digits.length + nextGroup.length > 15) {
        if (digits.length < 8) return null;
        break;
      }

      // Jump to next digit group; separators already skipped.
      i = k;
      continue;
    }

    // Any other character ends the phone candidate.
    break;
  }

  if (digits.length < 8 || digits.length > 15) return null;

  const raw = text.slice(plusIndex, lastAcceptedEnd);
  return {
    raw: collapseWhitespace(raw),
    normalized: `+${digits}`,
    confidence: 'exact',
    index: plusIndex,
    length: lastAcceptedEnd - plusIndex,
  };
}

function collectExactPhones(text: string): PhoneHit[] {
  const hits: PhoneHit[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '+') continue;
    if (hits.some((h) => i >= h.index && i < h.index + h.length)) continue;
    const hit = extractExactPhoneFromPlus(text, i);
    if (hit) hits.push(hit);
  }
  return hits;
}

/**
 * Bare digit clusters that look phone-sized but lack '+' — possible only, never exact.
 * Dates/times are excluded. Never invents country codes / normalized +.
 */
function collectPossiblePhones(text: string, exact: PhoneHit[]): PhoneHit[] {
  const covered = exact.map((h) => [h.index, h.index + h.length] as const);
  const hits: PhoneHit[] = [];
  // Contiguous digit runs only (no internal spaces) to avoid date/price mashups.
  const re = /(?<![\d+])(\d{8,15})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const start = m.index;
    const end = start + raw.length;
    if (covered.some(([a, b]) => start < b && end > a)) continue;
    // Reject runs adjacent to date punctuation (e.g. fragments of ISO dates).
    const before = text.slice(Math.max(0, start - 1), start);
    const after = text.slice(end, end + 1);
    if (before === '-' || after === '-') continue;
    if (isDateOrTimeToken(raw)) continue;
    hits.push({
      raw,
      normalized: null,
      confidence: 'possible',
      index: start,
      length: raw.length,
    });
  }
  return hits;
}

type PriceHit = {
  raw: string;
  value: number;
  confidence: CalendarPriceConfidence;
  index: number;
  length: number;
};

function collectPrices(text: string, phoneSpans: Array<{ index: number; length: number }>): PriceHit[] {
  const hits: PriceHit[] = [];
  const coveredByPhone = (start: number, end: number) =>
    phoneSpans.some((p) => start < p.index + p.length && end > p.index);

  PRICE_CURRENCY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRICE_CURRENCY_RE.exec(text)) !== null) {
    const raw = m[0];
    const numRaw = m[1].replace(/[ \u00a0]/g, '');
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (coveredByPhone(m.index, m.index + raw.length)) continue;
    hits.push({
      raw: collapseWhitespace(raw),
      value,
      confidence: 'likely',
      index: m.index,
      length: raw.length,
    });
  }

  TRAILING_PRICE_RE.lastIndex = 0;
  while ((m = TRAILING_PRICE_RE.exec(text)) !== null) {
    const numTok = m[1];
    const start = m.index + (m[0].length - numTok.length);
    const end = start + numTok.length;
    if (coveredByPhone(start, end)) continue;
    if (hits.some((h) => start < h.index + h.length && end > h.index)) continue;
    const value = Number(numTok);
    if (!Number.isFinite(value) || value < 1000) continue;
    // 4–7 digit trailing numbers without currency: possible price (e.g. 50000).
    hits.push({
      raw: numTok,
      value,
      confidence: 'possible',
      index: start,
      length: numTok.length,
    });
  }

  hits.sort((a, b) => a.index - b.index);
  return hits;
}

function removeSpans(text: string, spans: Array<{ index: number; length: number }>): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.index - a.index);
  let out = text;
  for (const s of sorted) {
    out = out.slice(0, s.index) + ' ' + out.slice(s.index + s.length);
  }
  return collapseWhitespace(out);
}

function hasScript(text: string, re: RegExp): boolean {
  return re.test(text);
}

function detectScripts(text: string): { latin: boolean; cyrillic: boolean; armenian: boolean } {
  return {
    latin: hasScript(text, /[A-Za-z]/),
    cyrillic: hasScript(text, /[\u0400-\u04FF]/),
    armenian: hasScript(text, /[\u0530-\u058F]/),
  };
}

function looksLikePersonNameToken(token: string): boolean {
  if (!token || token.length > 40) return false;
  // Single personal-name-like token: letters (any script) + optional hyphen/apostrophe.
  return /^[\p{L}][\p{L}'’\-]{0,39}$/u.test(token);
}

/**
 * Valid standalone HH:MM clock token (hours 0–23, minutes 0–59).
 * Invalid examples (25:00, 12:99, 123:45, 1:2) return false.
 */
export function isValidStandaloneClockToken(token: string): boolean {
  const t = token.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return false;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return false;
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

/**
 * Remove valid standalone HH:MM tokens from residual title text before
 * name/service split. Does not touch Google event start/end fields.
 */
export function stripStandaloneClockTokens(text: string): string {
  const collapsed = collapseWhitespace(text);
  if (!collapsed) return '';
  const kept = collapsed
    .split(' ')
    .filter(Boolean)
    .filter((tok) => !isValidStandaloneClockToken(tok));
  return collapseWhitespace(kept.join(' '));
}

function extractNameAndService(residual: string): {
  clientNameCandidate: string | null;
  serviceCandidate: string | null;
  ambiguous: boolean;
} {
  const text = stripStandaloneClockTokens(residual);
  if (!text) {
    return { clientNameCandidate: null, serviceCandidate: null, ambiguous: false };
  }

  const scripts = detectScripts(text);
  const tokens = text.split(' ').filter(Boolean);

  // Pure Cyrillic and/or Armenian multi-word residual → treat as service phrase.
  if (!scripts.latin && (scripts.cyrillic || scripts.armenian) && tokens.length >= 1) {
    return {
      clientNameCandidate: null,
      serviceCandidate: text,
      ambiguous: false,
    };
  }

  // Single token Latin/any-script name-like → name only.
  if (tokens.length === 1 && looksLikePersonNameToken(tokens[0])) {
    return {
      clientNameCandidate: tokens[0],
      serviceCandidate: null,
      ambiguous: false,
    };
  }

  // "Name rest…" with Latin first token name-like and remaining content → name + service.
  if (tokens.length >= 2 && looksLikePersonNameToken(tokens[0]) && scripts.latin) {
    const name = tokens[0];
    const rest = tokens.slice(1).join(' ');
    // Avoid claiming service when rest is only punctuation-ish.
    if (rest && /[\p{L}\p{N}]/u.test(rest)) {
      return {
        clientNameCandidate: name,
        serviceCandidate: rest,
        ambiguous: false,
      };
    }
  }

  // Latin-only multi-word without clear name/service split → ambiguous (do not fabricate).
  if (scripts.latin && !scripts.cyrillic && !scripts.armenian && tokens.length >= 2) {
    // Two Title-Case words only → name candidate (e.g. "Mary Jane"), no service.
    if (tokens.length <= 2 && tokens.every((t) => looksLikePersonNameToken(t))) {
      return {
        clientNameCandidate: text,
        serviceCandidate: null,
        ambiguous: false,
      };
    }
    return { clientNameCandidate: null, serviceCandidate: null, ambiguous: true };
  }

  // Mixed scripts without clear structure → do not guess.
  if (
    [scripts.latin, scripts.cyrillic, scripts.armenian].filter(Boolean).length >= 2
  ) {
    return { clientNameCandidate: null, serviceCandidate: null, ambiguous: true };
  }

  // Fallback: if residual has letters, leave unresolved rather than invent.
  return { clientNameCandidate: null, serviceCandidate: null, ambiguous: true };
}

function parseTimes(
  start: ExternalEventTimeInput,
  end: ExternalEventTimeInput,
  salonTimeZone: string,
): {
  localDate: string | null;
  localStartTime: string | null;
  localEndTime: string | null;
  durationMinutes: number | null;
  allDay: boolean;
  reasons: string[];
  timedOk: boolean;
} {
  const reasons: string[] = [];
  const startDt =
    typeof start.dateTime === 'string' &&
    start.dateTime.trim() &&
    Number.isFinite(Date.parse(start.dateTime.trim()));
  const endDt =
    typeof end.dateTime === 'string' &&
    end.dateTime.trim() &&
    Number.isFinite(Date.parse(end.dateTime.trim()));
  const allDay = !(startDt && endDt) &&
    Boolean(
      ((!startDt && start.allDay) ||
        (!endDt && end.allDay) ||
        (start.date && !startDt) ||
        (end.date && !endDt)),
    );

  if (allDay) {
    return {
      localDate: start.date,
      localStartTime: null,
      localEndTime: null,
      durationMinutes: null,
      allDay: true,
      reasons: ['all_day_event'],
      timedOk: false,
    };
  }

  if (!start.dateTime) {
    reasons.push('missing_start_datetime');
    return {
      localDate: null,
      localStartTime: null,
      localEndTime: null,
      durationMinutes: null,
      allDay: false,
      reasons,
      timedOk: false,
    };
  }

  const startLocal = localClockForExternalInstant(
    start.dateTime,
    start.timeZone || end.timeZone,
    salonTimeZone,
  );
  if (!startLocal) {
    reasons.push('invalid_start_datetime');
    return {
      localDate: null,
      localStartTime: null,
      localEndTime: null,
      durationMinutes: null,
      allDay: false,
      reasons,
      timedOk: false,
    };
  }

  let localEndTime: string | null = null;
  let durationMinutes: number | null = null;

  if (!end.dateTime) {
    reasons.push('missing_end_datetime');
  } else {
    const endLocal = localClockForExternalInstant(
      end.dateTime,
      end.timeZone || start.timeZone,
      salonTimeZone,
    );
    if (!endLocal) {
      reasons.push('invalid_end_datetime');
    } else {
      localEndTime = endLocal.time;
      const startMs = Date.parse(start.dateTime);
      const endMs = Date.parse(end.dateTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        reasons.push('invalid_duration');
      } else if (endMs <= startMs) {
        reasons.push('end_before_or_equal_start');
        durationMinutes = null;
      } else {
        durationMinutes = Math.round((endMs - startMs) / 60000);
      }
    }
  }

  const timedOk =
    startLocal !== null &&
    localEndTime !== null &&
    durationMinutes !== null &&
    durationMinutes > 0;

  return {
    localDate: startLocal.date,
    localStartTime: startLocal.time,
    localEndTime,
    durationMinutes,
    allDay: false,
    reasons,
    timedOk,
  };
}

/**
 * Pure deterministic parse of one external calendar event for preview.
 */
export function parseExternalCalendarEvent(
  event: ExternalCalendarEventInput,
  salonTimeZoneRaw: string | null | undefined,
): CalendarEventParsedPreview {
  const reasons: string[] = ['staff_requires_future_mapping'];
  const classification = new Set<string>();
  const salonTimeZone = resolveParserTimezone(salonTimeZoneRaw);

  const status = (event.status ?? '').trim().toLowerCase();
  const cancelled = status === 'cancelled';
  if (cancelled) {
    classification.add('cancelled');
    reasons.push('cancelled_event');
  }

  const times = parseTimes(event.start, event.end, salonTimeZone);
  for (const r of times.reasons) {
    if (!reasons.includes(r)) reasons.push(r);
  }
  if (times.allDay) classification.add('all_day');
  else classification.add('timed');

  const summary = normalizeCalendarTitle(event.summary);
  const descriptionRaw = typeof event.description === 'string' ? event.description : '';
  // Strip URLs before phone/name scans; do not treat URLs as phones.
  const summaryForScan = summary.replace(URL_RE, ' ');
  // Description: only scan for exact international phones if summary has none.
  const descriptionForScan = collapseWhitespace(descriptionRaw.replace(URL_RE, ' ')).slice(
    0,
    500,
  );

  if (!summary) {
    classification.add('missing_summary');
    reasons.push('missing_summary');
  }

  const scripts = detectScripts(summary);
  const scriptCount = [scripts.latin, scripts.cyrillic, scripts.armenian].filter(Boolean)
    .length;
  if (scriptCount >= 2) classification.add('multilingual');

  let exactPhones = collectExactPhones(summaryForScan);
  let scanText = summaryForScan;
  if (exactPhones.length === 0 && descriptionForScan) {
    const fromDesc = collectExactPhones(descriptionForScan);
    if (fromDesc.length > 0) {
      exactPhones = fromDesc;
      scanText = descriptionForScan;
      reasons.push('phone_from_description');
    }
  }

  const possiblePhones =
    exactPhones.length === 0 ? collectPossiblePhones(scanText, exactPhones) : [];

  let phone: CalendarParsedPhone = emptyPhone();
  if (exactPhones.length > 0) {
    const best = exactPhones[0];
    phone = {
      value: best.raw,
      normalized: best.normalized,
      confidence: 'exact',
    };
    classification.add('has_exact_phone');
  } else if (possiblePhones.length > 0) {
    const best = possiblePhones[0];
    phone = {
      value: best.raw,
      normalized: null,
      confidence: 'possible',
    };
    classification.add('has_possible_phone');
    reasons.push('phone_possible_only');
  }

  const phoneSpans = [...exactPhones, ...possiblePhones];
  const prices = collectPrices(summaryForScan, phoneSpans);
  let priceCandidate = emptyPrice();
  if (prices.length > 0) {
    const best = prices[0];
    priceCandidate = {
      value: best.value,
      raw: best.raw,
      confidence: best.confidence,
    };
    classification.add('has_price');
  }

  const residual = removeSpans(summaryForScan, [
    ...phoneSpans,
    ...prices.map((p) => ({ index: p.index, length: p.length })),
  ]);

  const { clientNameCandidate, serviceCandidate, ambiguous } =
    extractNameAndService(residual);

  if (clientNameCandidate) classification.add('name_candidate');
  if (serviceCandidate) classification.add('service_candidate');
  if (ambiguous) {
    classification.add('ambiguous');
    reasons.push('ambiguous_title_structure');
  }

  let importability: CalendarParseImportability = 'review';

  if (cancelled || times.allDay) {
    importability = 'not_importable';
  } else if (!times.timedOk) {
    importability = 'not_importable';
    if (!reasons.includes('invalid_or_incomplete_time')) {
      reasons.push('invalid_or_incomplete_time');
    }
  } else {
    const hasExactPhone = phone.confidence === 'exact';
    const hasName = Boolean(clientNameCandidate);
    const hasService = Boolean(serviceCandidate);
    // Structural "ready" requires a service candidate plus at least one identity signal
    // (exact phone and/or name). Exact phone alone, or name+phone without service → review.
    const structurallyUseful =
      hasService && (hasExactPhone || hasName);
    if (structurallyUseful) {
      importability = 'ready';
      reasons.push('structurally_useful_for_future_matching');
    } else {
      importability = 'review';
      reasons.push('unresolved_fields_for_future_matching');
      if (!hasName) reasons.push('needs_client_review');
      if (!hasService) reasons.push('needs_service_review');
      if (!hasExactPhone) reasons.push('needs_phone_or_identity_review');
    }
  }

  return {
    classification: [...classification],
    importability,
    localDate: times.localDate,
    localStartTime: times.localStartTime,
    localEndTime: times.localEndTime,
    durationMinutes: times.durationMinutes,
    clientNameCandidate,
    phone,
    serviceCandidate,
    priceCandidate,
    staffCandidate: null,
    reasons,
  };
}
