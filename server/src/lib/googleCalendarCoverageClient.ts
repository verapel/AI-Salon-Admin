/**
 * GOOGLE-CAL-FAST-7D: Resolve or create a salon client for every represented Google event.
 * No fake phones/emails. No migration. Stable identity via notes + overlay parsed_event.
 */

import { randomUUID } from 'node:crypto';
import { collapseWhitespace } from './calendarEventParser.js';
import {
  normalizeMatchName,
  phoneDigitsKey,
  type CalendarMatchCatalog,
  type MatchableClient,
} from './calendarEventMatcher.js';
import type { GoogleEventPreviewItem } from './googleCalendarOAuth.js';
import { buildGoogleOccurrenceRecurrenceId } from './googleCalendarImport.js';
import { pickGoogleIssueRow } from './googleCalendarReviewOverlay.js';

export const GOOGLE_PROVISIONAL_NOTE = 'Создано из Google Calendar — требуется проверка';
export const GOOGLE_PROVISIONAL_KEY_PREFIX = 'google_provisional_key:';

const SERVICE_LIKE_TOKENS = new Set([
  'coloring',
  'colouring',
  'haircut',
  'manicure',
  'pedicure',
  'massage',
  'makeup',
  'окрашивание',
  'стрижка',
  'маникюр',
  'педикюр',
  'массаж',
  'макияж',
  'client',
  'клиент',
  'test',
  'тест',
  'new',
  'новый',
  'новая',
  'color',
  'colour',
  'hair',
  'волосы',
]);

const NAME_WORD_RE = /^[\p{L}][\p{L}'’\-]*$/u;

export type CoverageClientRecord = {
  id: string;
  name: string;
  phone: string;
  notes: string;
};

export type GoogleCoverageClientDecision =
  | { action: 'reuse'; clientId: string; reason: 'remembered' | 'phone' | 'name' | 'provisional_key' }
  | { action: 'create'; name: string; phone: string; provisional: boolean; identityKey: string };

export function looksLikeGooglePersonName(name: string): boolean {
  const cleaned = collapseWhitespace(name);
  if (!cleaned || /\d/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => {
    if (!NAME_WORD_RE.test(word)) return false;
    return !SERVICE_LIKE_TOKENS.has(word.toLocaleLowerCase('und'));
  });
}

export function pickGoogleCoverageDisplayName(params: {
  clientNameCandidate?: string | null;
  title?: string | null;
}): string {
  const candidate = collapseWhitespace(params.clientNameCandidate || '');
  if (looksLikeGooglePersonName(candidate)) return candidate;
  const title = collapseWhitespace(params.title || '');
  const words: string[] = [];
  for (const word of title.split(/\s+/).filter(Boolean)) {
    const folded = word.toLocaleLowerCase('und');
    if (SERVICE_LIKE_TOKENS.has(folded) || /\d/.test(word)) break;
    if (!NAME_WORD_RE.test(word)) break;
    words.push(word);
    if (words.length === 4) break;
  }
  const extracted = words.join(' ');
  if (looksLikeGooglePersonName(extracted)) return extracted;
  if (candidate && /[\p{L}]/u.test(candidate)) return candidate;
  return title || 'Google';
}

export function googleProvisionalIdentityKey(params: {
  phoneDigits: string;
  displayName: string;
  eventId: string;
  eventScoped?: boolean;
}): string {
  if (params.phoneDigits) return `${GOOGLE_PROVISIONAL_KEY_PREFIX}phone:${params.phoneDigits}`;
  if (!params.eventScoped && looksLikeGooglePersonName(params.displayName)) {
    return `${GOOGLE_PROVISIONAL_KEY_PREFIX}name:${normalizeMatchName(params.displayName)}`;
  }
  return `${GOOGLE_PROVISIONAL_KEY_PREFIX}event:${params.eventId}`;
}

export function coverageClientBelongsToGoogleEvent(
  notes: string | null | undefined,
  eventId: string,
): boolean {
  const id = (eventId || '').trim();
  if (!id) return false;
  return notesContainIdentityKey(notes, `${GOOGLE_PROVISIONAL_KEY_PREFIX}event:${id}`);
}

export function notesContainIdentityKey(notes: string | null | undefined, key: string): boolean {
  if (!notes || !key) return false;
  return notes.includes(key);
}

export function decideGoogleCoverageClient(params: {
  clients: CoverageClientRecord[];
  phoneDigits: string;
  displayName: string;
  eventId: string;
  rememberedClientId?: string | null;
  eventScoped?: boolean;
}): GoogleCoverageClientDecision {
  const phoneDigits = params.phoneDigits.replace(/\D/g, '');
  const displayName = pickGoogleCoverageDisplayName({ title: params.displayName });
  const identityKey = googleProvisionalIdentityKey({
    phoneDigits,
    displayName,
    eventId: params.eventId,
    eventScoped: params.eventScoped,
  });

  if (params.rememberedClientId) {
    const remembered = params.clients.find((row) => row.id === params.rememberedClientId);
    // Loader is already scoped to this Google event id; reuse is not cross-event.
    if (remembered) {
      return { action: 'reuse', clientId: remembered.id, reason: 'remembered' };
    }
  }

  if (phoneDigits) {
    const phoneMatches = params.clients.filter((row) => phoneDigitsKey(row.phone) === phoneDigits);
    if (phoneMatches.length === 1 && phoneMatches[0]) {
      return { action: 'reuse', clientId: phoneMatches[0].id, reason: 'phone' };
    }
  }

  const nameMatches = params.clients.filter(
    (row) => normalizeMatchName(row.name) === normalizeMatchName(displayName),
  );
  if (
    !params.eventScoped &&
    nameMatches.length === 1 &&
    nameMatches[0] &&
    looksLikeGooglePersonName(displayName)
  ) {
    return { action: 'reuse', clientId: nameMatches[0].id, reason: 'name' };
  }

  const keyMatches = params.clients.filter((row) => notesContainIdentityKey(row.notes, identityKey));
  if (keyMatches.length === 1 && keyMatches[0]) {
    return { action: 'reuse', clientId: keyMatches[0].id, reason: 'provisional_key' };
  }

  const uniquePhone =
    Boolean(phoneDigits) &&
    params.clients.filter((row) => phoneDigitsKey(row.phone) === phoneDigits).length === 0;
  const provisional = !(uniquePhone && looksLikeGooglePersonName(displayName));
  return {
    action: 'create',
    name: displayName,
    phone: uniquePhone ? phoneDigits : '',
    provisional,
    identityKey,
  };
}

function seedSessionFromCatalog(
  session: CoverageClientRecord[],
  catalog?: CalendarMatchCatalog,
): void {
  for (const row of catalog?.clients ?? []) {
    if (session.some((existing) => existing.id === row.id)) continue;
    session.push({ id: row.id, name: row.name, phone: row.phone, notes: '' });
  }
}

export async function loadGoogleCoverageClientSession(params: {
  db: any;
  salonId: string;
  catalog?: CalendarMatchCatalog;
}): Promise<CoverageClientRecord[]> {
  const session: CoverageClientRecord[] = [];
  try {
    const { data, error } = await params.db
      .from('clients')
      .select('id, name, phone, notes, deleted_at')
      .eq('salon_id', params.salonId);
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        if (row?.deleted_at) continue;
        if (typeof row?.id !== 'string' || !row.id) continue;
        session.push({
          id: row.id,
          name: typeof row.name === 'string' ? row.name : '',
          phone: typeof row.phone === 'string' ? row.phone : '',
          notes: typeof row.notes === 'string' ? row.notes : '',
        });
      }
    }
  } catch {
    // Catalog seed still allows in-memory reuse for tests / read failures.
  }
  seedSessionFromCatalog(session, params.catalog);
  return session;
}

type RememberedGoogleIssueRow = {
  parsed_event?: unknown;
  raw_event?: unknown;
  external_calendar_id?: string | null;
};

function clientIdFromRememberedIssue(row: RememberedGoogleIssueRow | null): string | null {
  if (!row) return null;
  for (const payload of [row.parsed_event, row.raw_event]) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const clientId = (payload as { clientId?: unknown }).clientId;
    if (typeof clientId === 'string' && clientId) return clientId;
  }
  return null;
}

export async function loadRememberedGoogleCoverageClientId(params: {
  db: any;
  salonId: string;
  calendarConnectionId: string;
  ev: Pick<GoogleEventPreviewItem, 'id' | 'calendarId' | 'recurringEventId' | 'originalStartTime'>;
}): Promise<string | null> {
  const recurrenceId = buildGoogleOccurrenceRecurrenceId(params.ev);
  try {
    const listed = await params.db
      .from('calendar_import_issues')
      .select('parsed_event, raw_event, external_calendar_id')
      .eq('salon_id', params.salonId)
      .eq('calendar_connection_id', params.calendarConnectionId)
      .eq('external_uid', params.ev.id)
      .eq('recurrence_id', recurrenceId);
    const rows: RememberedGoogleIssueRow[] = Array.isArray(listed?.data) ? listed.data : [];
    return clientIdFromRememberedIssue(pickGoogleIssueRow(rows, params.ev.calendarId));
  } catch {
    return null;
  }
}

export async function resolveOrCreateGoogleCoverageClient(params: {
  db: any;
  salonId: string;
  session: CoverageClientRecord[];
  catalog?: CalendarMatchCatalog;
  ev: Pick<GoogleEventPreviewItem, 'id' | 'summary'>;
  displayName: string;
  phoneDigits: string;
  rememberedClientId?: string | null;
  eventScoped?: boolean;
}): Promise<{ clientId: string; created: boolean } | null> {
  seedSessionFromCatalog(params.session, params.catalog);
  const decision = decideGoogleCoverageClient({
    clients: params.session,
    phoneDigits: params.phoneDigits,
    displayName: params.displayName,
    eventId: params.ev.id,
    rememberedClientId: params.rememberedClientId,
    eventScoped: params.eventScoped,
  });
  if (decision.action === 'reuse') {
    return { clientId: decision.clientId, created: false };
  }

  const notes = decision.provisional
    ? `${GOOGLE_PROVISIONAL_NOTE}\n${decision.identityKey}`
    : '';
  const insertRow = {
    id: randomUUID(),
    salon_id: params.salonId,
    name: decision.name,
    email: '',
    phone: decision.phone,
    notes,
    total_visits: 0,
    last_visit: null,
  };

  try {
    const insertQuery = params.db.from('clients').insert(insertRow);
    let inserted: { data?: { id?: string } | null; error?: unknown } | null = null;
    if (insertQuery && typeof insertQuery.select === 'function') {
      inserted = await insertQuery.select('id').single();
    } else if (insertQuery && typeof insertQuery.then === 'function') {
      inserted = await insertQuery;
    }
    const id =
      (typeof inserted?.data?.id === 'string' && inserted.data.id) ||
      (!inserted?.error ? insertRow.id : '');
    if (!id) return null;
    const record: CoverageClientRecord = {
      id,
      name: decision.name,
      phone: decision.phone,
      notes,
    };
    params.session.push(record);
    if (params.catalog) {
      const matchable: MatchableClient = { id, name: decision.name, phone: decision.phone };
      if (!params.catalog.clients.some((row) => row.id === id)) {
        params.catalog.clients.push(matchable);
      }
    }
    return { clientId: id, created: true };
  } catch {
    return null;
  }
}
