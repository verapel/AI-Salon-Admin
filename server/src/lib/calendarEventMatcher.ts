/**
 * GOOGLE-CAL-FAST-4: Salon-scoped READ-ONLY client/service matching for calendar preview.
 * Pure in-memory matcher — no DB writes, no AI, no staff inference, no Google I/O.
 * Provider-neutral: works on FAST-3B parsed output + original title.
 */

import {
  collapseWhitespace,
  type CalendarEventParsedPreview,
} from './calendarEventParser.js';

/** Minimal salon client row for matching (never expose notes/birthday/etc.). */
export type MatchableClient = {
  id: string;
  name: string;
  phone: string;
};

/** Minimal salon service row for matching. */
export type MatchableService = {
  id: string;
  name: string;
};

export type CalendarClientMatchStatus =
  | 'matched'
  | 'possible'
  | 'ambiguous'
  | 'not_found'
  | 'not_attempted';

export type CalendarClientMatchConfidence =
  | 'exact_phone'
  | 'exact_name'
  | 'possible_name'
  | 'none';

export type CalendarServiceMatchStatus =
  | 'matched'
  | 'ambiguous'
  | 'not_found'
  | 'not_attempted';

export type CalendarServiceMatchConfidence =
  | 'exact_name'
  | 'contained_name'
  | 'none';

export type CalendarMatchingStatus = 'matched' | 'partial' | 'review';

export type CalendarEventClientMatch = {
  status: CalendarClientMatchStatus;
  confidence: CalendarClientMatchConfidence;
  clientId: string | null;
  displayName: string | null;
  matchedPhone: string | null;
};

export type CalendarEventServiceMatch = {
  status: CalendarServiceMatchStatus;
  confidence: CalendarServiceMatchConfidence;
  serviceId: string | null;
  displayName: string | null;
};

export type CalendarEventMatchingPreview = {
  client: CalendarEventClientMatch;
  service: CalendarEventServiceMatch;
  recognizedClientText: string | null;
  serviceSearchText: string | null;
  serviceResidualText: string | null;
  /** Always null in FAST-4 — staff must not be inferred. */
  staff: null;
  reasons: string[];
  matchingStatus: CalendarMatchingStatus;
};

export type CalendarMatchCatalog = {
  clients: MatchableClient[];
  services: MatchableService[];
};

const EMPTY_CLIENT: CalendarEventClientMatch = {
  status: 'not_attempted',
  confidence: 'none',
  clientId: null,
  displayName: null,
  matchedPhone: null,
};

const EMPTY_SERVICE: CalendarEventServiceMatch = {
  status: 'not_attempted',
  confidence: 'none',
  serviceId: null,
  displayName: null,
};

/** Digits-only phone key for exact comparison (formatting-insensitive). */
export function phoneDigitsKey(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\D/g, '');
}

/** Trim + collapse whitespace + Unicode-safe lowercase. */
export function normalizeMatchName(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return collapseWhitespace(value).toLocaleLowerCase('und');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLetterOrNumber(ch: string | undefined): boolean {
  if (!ch) return false;
  return /\p{L}|\p{N}/u.test(ch);
}

/**
 * Find a phrase in haystack with Unicode letter/number boundaries
 * (same safety policy as contained service matching).
 * Returns the original casing span; does not match inside longer words
 * (e.g. "Ann" must not match inside "Hannah").
 */
export function findBoundedPhraseSpan(
  haystack: string | null | undefined,
  phrase: string | null | undefined,
): { start: number; end: number; text: string } | null {
  const raw = typeof haystack === 'string' ? haystack : '';
  const needle = collapseWhitespace(phrase ?? '');
  if (!raw || !needle) return null;
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const pattern = tokens.map(escapeRegExp).join('\\s+');
  const re = new RegExp(pattern, 'giu');
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const beforeOk = start === 0 || !isLetterOrNumber(raw[start - 1]);
    const afterOk = end >= raw.length || !isLetterOrNumber(raw[end]);
    if (beforeOk && afterOk) {
      return { start, end, text: match[0] };
    }
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return null;
}

/**
 * Find the matched client name as a contiguous phrase in the original title
 * (case-insensitive, Unicode-safe, token/phrase-boundary safe).
 * Returns the original title casing span.
 */
export function findRecognizedClientText(
  title: string | null | undefined,
  clientName: string | null | undefined,
): string | null {
  return findBoundedPhraseSpan(title, clientName)?.text ?? null;
}

/** Strip a known phone (by digit identity) from free text. */
export function stripPhoneByDigits(text: string, phoneNormalized: string | null): string {
  const digits = phoneDigitsKey(phoneNormalized);
  if (!digits || digits.length < 8) return text;
  return text.replace(/\+?\d[\d\s\-().]{5,}\d/g, (span) => {
    return phoneDigitsKey(span) === digits ? ' ' : span;
  });
}

/**
 * Strip the first boundary-safe occurrence of a phrase (case-insensitive).
 * Does not strip substrings embedded inside longer words.
 */
function stripBoundedPhraseOnce(text: string, phrase: string | null | undefined): string {
  const span = findBoundedPhraseSpan(text, phrase);
  if (!span) return text;
  return `${text.slice(0, span.start)} ${text.slice(span.end)}`;
}

/**
 * After exact-phone client match: derive residual service-search text from the
 * original title by removing recognized client name, phone, and optional price.
 * Does NOT mutate FAST-3B parsed fields.
 */
export function deriveServiceSearchText(params: {
  originalTitle: string | null | undefined;
  recognizedClientText: string | null;
  phoneNormalized: string | null;
  priceRaw?: string | null;
}): string | null {
  let text = typeof params.originalTitle === 'string' ? params.originalTitle : '';
  if (!text.trim()) return null;
  text = stripPhoneByDigits(text, params.phoneNormalized);
  text = stripBoundedPhraseOnce(text, params.recognizedClientText);
  text = stripBoundedPhraseOnce(text, params.priceRaw);
  const residual = collapseWhitespace(text);
  return residual || null;
}

/**
 * Contained phrase match with Unicode letter/number boundaries.
 * Returns start index in the normalized haystack, or -1.
 */
export function findContainedPhraseIndex(haystack: string, needle: string): number {
  const h = normalizeMatchName(haystack);
  const n = normalizeMatchName(needle);
  if (!h || !n) return -1;
  let from = 0;
  while (from <= h.length - n.length) {
    const idx = h.indexOf(n, from);
    if (idx < 0) return -1;
    const beforeOk = idx === 0 || !isLetterOrNumber(h[idx - 1]);
    const afterIdx = idx + n.length;
    const afterOk = afterIdx >= h.length || !isLetterOrNumber(h[afterIdx]);
    if (beforeOk && afterOk) return idx;
    from = idx + 1;
  }
  return -1;
}

function residualAfterContainedMatch(candidate: string, serviceName: string): string | null {
  if (findContainedPhraseIndex(candidate, serviceName) < 0) return null;
  const residual = collapseWhitespace(stripBoundedPhraseOnce(candidate, serviceName));
  return residual || null;
}

function emptyMatching(reasons: string[] = []): CalendarEventMatchingPreview {
  return {
    client: { ...EMPTY_CLIENT },
    service: { ...EMPTY_SERVICE },
    recognizedClientText: null,
    serviceSearchText: null,
    serviceResidualText: null,
    staff: null,
    reasons,
    matchingStatus: 'review',
  };
}

function matchClientByExactPhone(
  phoneNormalized: string,
  clients: MatchableClient[],
): { matches: MatchableClient[]; digits: string } {
  const digits = phoneDigitsKey(phoneNormalized);
  if (!digits) return { matches: [], digits: '' };
  const matches = clients.filter((c) => phoneDigitsKey(c.phone) === digits);
  return { matches, digits };
}

function matchClientByExactName(
  nameCandidate: string,
  clients: MatchableClient[],
): MatchableClient[] {
  const key = normalizeMatchName(nameCandidate);
  if (!key) return [];
  return clients.filter((c) => normalizeMatchName(c.name) === key);
}

export function matchServiceCandidate(
  candidate: string | null | undefined,
  services: MatchableService[],
): {
  match: CalendarEventServiceMatch;
  residual: string | null;
  reasons: string[];
} {
  const text = collapseWhitespace(candidate ?? '');
  if (!text) {
    return {
      match: { ...EMPTY_SERVICE, status: 'not_attempted' },
      residual: null,
      reasons: ['service_not_attempted'],
    };
  }
  if (!services.length) {
    return {
      match: {
        status: 'not_found',
        confidence: 'none',
        serviceId: null,
        displayName: null,
      },
      residual: null,
      reasons: ['service_not_found'],
    };
  }

  const normCandidate = normalizeMatchName(text);
  const exactHits = services.filter((s) => normalizeMatchName(s.name) === normCandidate);
  if (exactHits.length === 1) {
    return {
      match: {
        status: 'matched',
        confidence: 'exact_name',
        serviceId: exactHits[0]!.id,
        displayName: exactHits[0]!.name,
      },
      residual: null,
      reasons: ['service_exact_name'],
    };
  }
  if (exactHits.length > 1) {
    return {
      match: {
        status: 'ambiguous',
        confidence: 'none',
        serviceId: null,
        displayName: null,
      },
      residual: null,
      reasons: ['service_ambiguous_exact_name'],
    };
  }

  // Contained: prefer longest service-name phrase.
  const byLength = [...services].sort(
    (a, b) => normalizeMatchName(b.name).length - normalizeMatchName(a.name).length,
  );
  const containedHits: MatchableService[] = [];
  let bestLen = -1;
  for (const svc of byLength) {
    const nLen = normalizeMatchName(svc.name).length;
    if (nLen === 0) continue;
    if (bestLen >= 0 && nLen < bestLen) break;
    if (findContainedPhraseIndex(text, svc.name) >= 0) {
      if (bestLen < 0) bestLen = nLen;
      if (nLen === bestLen) containedHits.push(svc);
    }
  }

  if (containedHits.length === 1) {
    const svc = containedHits[0]!;
    return {
      match: {
        status: 'matched',
        confidence: 'contained_name',
        serviceId: svc.id,
        displayName: svc.name,
      },
      residual: residualAfterContainedMatch(text, svc.name),
      reasons: ['service_contained_name'],
    };
  }
  if (containedHits.length > 1) {
    return {
      match: {
        status: 'ambiguous',
        confidence: 'none',
        serviceId: null,
        displayName: null,
      },
      residual: null,
      reasons: ['service_ambiguous_contained_name'],
    };
  }

  return {
    match: {
      status: 'not_found',
      confidence: 'none',
      serviceId: null,
      displayName: null,
    },
    residual: null,
    reasons: ['service_not_found'],
  };
}

function resolveMatchingStatus(
  client: CalendarEventClientMatch,
  service: CalendarEventServiceMatch,
): CalendarMatchingStatus {
  if (client.status === 'ambiguous' || service.status === 'ambiguous') return 'review';
  const clientExact =
    client.status === 'matched' &&
    (client.confidence === 'exact_phone' || client.confidence === 'exact_name');
  const serviceOk = service.status === 'matched';
  if (clientExact && serviceOk) return 'matched';
  if (clientExact || serviceOk) return 'partial';
  return 'review';
}

/**
 * Match one parsed calendar event against a salon-scoped catalog (in memory).
 * Never mutates parsed FAST-3B fields or catalog rows.
 */
export function matchParsedCalendarEvent(params: {
  parsed: CalendarEventParsedPreview;
  originalTitle: string | null | undefined;
  catalog: CalendarMatchCatalog;
}): CalendarEventMatchingPreview {
  const { parsed, originalTitle, catalog } = params;
  const reasons: string[] = [];
  let client: CalendarEventClientMatch = { ...EMPTY_CLIENT };
  let recognizedClientText: string | null = null;
  let serviceSearchText: string | null = null;

  const clients = Array.isArray(catalog.clients) ? catalog.clients : [];
  const services = Array.isArray(catalog.services) ? catalog.services : [];

  // --- Client matching (phone strongest) ---
  const exactPhone =
    parsed.phone.confidence === 'exact' && parsed.phone.normalized
      ? parsed.phone.normalized
      : null;

  if (exactPhone) {
    const { matches } = matchClientByExactPhone(exactPhone, clients);
    if (matches.length === 1) {
      const hit = matches[0]!;
      client = {
        status: 'matched',
        confidence: 'exact_phone',
        clientId: hit.id,
        displayName: hit.name,
        matchedPhone: exactPhone,
      };
      reasons.push('client_exact_phone');
      recognizedClientText = findRecognizedClientText(originalTitle, hit.name);
      serviceSearchText = deriveServiceSearchText({
        originalTitle,
        recognizedClientText,
        phoneNormalized: exactPhone,
        priceRaw: parsed.priceCandidate?.raw ?? null,
      });
      if (recognizedClientText) reasons.push('client_name_recovered_from_title');
    } else if (matches.length > 1) {
      client = {
        status: 'ambiguous',
        confidence: 'none',
        clientId: null,
        displayName: null,
        matchedPhone: exactPhone,
      };
      reasons.push('client_ambiguous_phone');
    } else {
      client = {
        status: 'not_found',
        confidence: 'none',
        clientId: null,
        displayName: null,
        matchedPhone: exactPhone,
      };
      reasons.push('client_phone_not_found');
    }
  } else if (parsed.clientNameCandidate && collapseWhitespace(parsed.clientNameCandidate)) {
    const nameHits = matchClientByExactName(parsed.clientNameCandidate, clients);
    if (nameHits.length === 1) {
      const hit = nameHits[0]!;
      client = {
        status: 'matched',
        confidence: 'exact_name',
        clientId: hit.id,
        displayName: hit.name,
        matchedPhone: null,
      };
      reasons.push('client_exact_name');
      recognizedClientText = findRecognizedClientText(originalTitle, hit.name);
    } else if (nameHits.length > 1) {
      client = {
        status: 'ambiguous',
        confidence: 'none',
        clientId: null,
        displayName: null,
        matchedPhone: null,
      };
      reasons.push('client_ambiguous_name');
    } else {
      // First-name-only / partial: do not silently widen to longer DB names.
      client = {
        status: 'not_found',
        confidence: 'none',
        clientId: null,
        displayName: null,
        matchedPhone: null,
      };
      reasons.push('client_name_not_found');
    }
  } else {
    client = { ...EMPTY_CLIENT, status: 'not_attempted' };
    reasons.push('client_not_attempted');
  }

  // --- Service matching ---
  // Prefer title residual after phone-based name recovery; else FAST-3B serviceCandidate.
  // serviceSearchText is only set when derived (debugging distinction from parsed.serviceCandidate).
  const serviceCandidateForMatch =
    (serviceSearchText && serviceSearchText.trim()) ||
    parsed.serviceCandidate ||
    null;

  const serviceResult = matchServiceCandidate(serviceCandidateForMatch, services);
  for (const r of serviceResult.reasons) {
    if (!reasons.includes(r)) reasons.push(r);
  }

  const matchingStatus = resolveMatchingStatus(client, serviceResult.match);
  reasons.push(`matching_status_${matchingStatus}`);

  return {
    client,
    service: serviceResult.match,
    recognizedClientText,
    serviceSearchText,
    serviceResidualText: serviceResult.residual,
    staff: null,
    reasons,
    matchingStatus,
  };
}

/**
 * Batch-match preview events in memory (after one catalog load).
 */
export function matchParsedCalendarEvents(
  items: Array<{
    parsed: CalendarEventParsedPreview;
    originalTitle: string | null | undefined;
  }>,
  catalog: CalendarMatchCatalog,
): CalendarEventMatchingPreview[] {
  return items.map((item) =>
    matchParsedCalendarEvent({
      parsed: item.parsed,
      originalTitle: item.originalTitle,
      catalog,
    }),
  );
}

/**
 * Load minimal salon clients + services for matching.
 * READ ONLY — select only id/name/phone and id/name (active services only).
 * Caller must pass authenticated salonId.
 */
export async function loadSalonCalendarMatchCatalog(
  db: any,
  salonId: string,
): Promise<CalendarMatchCatalog> {
  const sid = typeof salonId === 'string' ? salonId.trim() : '';
  if (!sid) return { clients: [], services: [] };

  const clientsRes = await db
    .from('clients')
    .select('id, name, phone')
    .eq('salon_id', sid);
  const servicesRes = await db
    .from('services')
    .select('id, name')
    .eq('salon_id', sid)
    .eq('active', true);

  if (clientsRes?.error) {
    console.error('[calendar/match-catalog] clients load failed', {
      salonId: sid,
      message: clientsRes.error?.message ?? String(clientsRes.error),
    });
  }
  if (servicesRes?.error) {
    console.error('[calendar/match-catalog] services load failed', {
      salonId: sid,
      message: servicesRes.error?.message ?? String(servicesRes.error),
    });
  }

  const clientsRaw = Array.isArray(clientsRes?.data) ? clientsRes.data : [];
  const servicesRaw = Array.isArray(servicesRes?.data) ? servicesRes.data : [];

  const clients: MatchableClient[] = clientsRaw
    .map((row: any) => ({
      id: typeof row?.id === 'string' ? row.id : '',
      name: typeof row?.name === 'string' ? row.name : '',
      phone: typeof row?.phone === 'string' ? row.phone : '',
    }))
    .filter((c: MatchableClient) => Boolean(c.id));

  const services: MatchableService[] = servicesRaw
    .map((row: any) => ({
      id: typeof row?.id === 'string' ? row.id : '',
      name: typeof row?.name === 'string' ? row.name : '',
    }))
    .filter((s: MatchableService) => Boolean(s.id));

  return { clients, services };
}
