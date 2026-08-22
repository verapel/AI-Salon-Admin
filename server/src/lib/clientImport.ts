/**
 * DIKIDI Excel/CSV client import: parse, preview plan, and reuse/create rules.
 * Does not write appointments, calendars, or messenger data.
 */

import * as XLSX from 'xlsx';
import { optionalClientText } from './clientWrite.js';

export type ClientImportDraft = {
  name: string;
  phone: string;
  email: string;
  birthday: string | null;
  notes: string;
};

export type ClientImportExisting = {
  id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  birthday: string | null;
};

export type ClientImportActionKind = 'create' | 'reuse' | 'skip';

export type ClientImportReason =
  | 'new'
  | 'phone_match'
  | 'email_match'
  | 'missing_name'
  | 'empty';

export type ClientImportPreviewRow = {
  draft: ClientImportDraft;
  action: ClientImportActionKind;
  reason: ClientImportReason;
  existingClientId: string | null;
  existingClientName: string | null;
  willUpdate: boolean;
};

export type ClientImportResult = {
  created: number;
  reused: number;
  updated: number;
  skipped: number;
  errors: { name: string; message: string }[];
};

type MappedRow = {
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  email: string;
  birthday: unknown;
  comment: string;
  source: string;
  discount: string;
  spent: string;
  averageCheck: string;
  visitCount: string;
  lastVisit: unknown;
  gender: string;
  blacklisted: string;
};

const HEADER_ALIASES: Record<keyof MappedRow, string[]> = {
  firstName: [
    'имя клиента',
    'имя',
    'first name',
    'firstname',
    'client first name',
    'անուն',
  ],
  lastName: [
    'фамилия клиента',
    'фамилия',
    'last name',
    'lastname',
    'surname',
    'client last name',
    'ազգանուն',
  ],
  fullName: ['имя фам', 'фио', 'клиент', 'client', 'client name', 'full name', 'name', 'հաճախորդ'],
  phone: [
    'мобильный номер',
    'мобильный',
    'телефон',
    'номер телефона',
    'phone',
    'mobile',
    'mobile phone',
    'հեռախոս',
  ],
  email: [
    'электронная почта',
    'электроннаяпочта',
    'email',
    'e mail',
    'почта',
    'mail',
  ],
  birthday: ['день рождения', 'дата рождения', 'birthday', 'birth date', 'dob', 'ծննդյան օր'],
  comment: ['комментарий', 'комментарии', 'примечание', 'comment', 'notes', 'note', 'նշումներ'],
  source: ['источник', 'source', 'источник клиента'],
  discount: ['скидка', 'скидка %', 'discount', 'discount %'],
  spent: ['потрачено', 'сумма', 'spent', 'total spent'],
  averageCheck: ['средний чек', 'среднийчек', 'average check', 'avg check'],
  visitCount: [
    'количество записей',
    'кол во записей',
    'визиты',
    'visits',
    'appointments count',
  ],
  lastVisit: ['последний визит', 'последнее посещение', 'last visit', 'last appointment'],
  gender: ['пол', 'gender'],
  blacklisted: ['в черном списке', 'черный список', 'blacklist', 'blacklisted'],
};

export function normalizeHeader(value: string): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_./\\|,%]+/g, ' ')
    .replace(/[()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldForHeader(header: string): keyof MappedRow | null {
  const normalized = normalizeHeader(header);
  if (!normalized) return null;
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof MappedRow, string[]][]) {
    if (aliases.includes(normalized)) return field;
  }
  return null;
}

export function emptyDraft(): ClientImportDraft {
  return { name: '', phone: '', email: '', birthday: null, notes: '' };
}

export function phoneDigits(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\D/g, '');
}

/** Formatting-insensitive key: last 10 digits when present (+380 vs 063, +7 vs 8). */
export function phoneMatchKey(value: string | null | undefined): string {
  const digits = phoneDigits(value);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

export function normalizeStoredPhone(value: unknown): string {
  const raw =
    typeof value === 'number' && Number.isFinite(value)
      ? String(Math.trunc(value))
      : optionalClientText(value);
  const digits = phoneDigits(raw);
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith('380')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('0')) return `+38${digits}`;
  return raw.replace(/[()\s-]+/g, '').trim() || digits;
}

export function normalizeImportEmail(value: unknown): string {
  return optionalClientText(value).toLowerCase();
}

export function isRealEmail(value: string | null | undefined): boolean {
  const email = optionalClientText(value).toLowerCase();
  if (!email) return false;
  if (['нет', 'no', '-', 'n/a', 'na', 'none', 'null', 'undefined'].includes(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function localISODate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function utcISODate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function parseClientDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return localISODate(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 80000) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return utcISODate(new Date(excelEpoch + value * 86400000));
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${pad2(Number(dmy[2]))}-${pad2(Number(dmy[1]))}`;
  }
  return null;
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return localISODate(value);
  return String(value).trim();
}

export function buildImportNotes(input: {
  comment?: string;
  source?: string;
  discount?: string;
  spent?: string;
  averageCheck?: string;
  visitCount?: string;
  lastVisit?: string | null;
  gender?: string;
  blacklisted?: string;
}): string {
  const lines: string[] = [];
  const comment = optionalClientText(input.comment);
  if (comment) lines.push(comment);
  const extras: [string, string | null | undefined][] = [
    ['Источник', input.source],
    ['Скидка, %', input.discount],
    ['Потрачено', input.spent],
    ['Средний чек', input.averageCheck],
    ['Количество записей', input.visitCount],
    ['Последний визит', input.lastVisit],
    ['Пол', input.gender],
    ['В черном списке', input.blacklisted],
  ];
  for (const [label, value] of extras) {
    const text = optionalClientText(value);
    if (text) lines.push(`${label}: ${text}`);
  }
  return lines.join('\n');
}

export function joinClientName(firstName: string, lastName: string, fullName = ''): string {
  const joined = [optionalClientText(firstName), optionalClientText(lastName)].filter(Boolean).join(' ');
  return joined || optionalClientText(fullName);
}

export function sanitizeClientDraft(
  input: Partial<ClientImportDraft> | Record<string, unknown>
): ClientImportDraft {
  const birthdayRaw =
    (input as { birthday?: unknown }).birthday ?? (input as { birthDay?: unknown }).birthDay;
  const email = isRealEmail(String((input as { email?: unknown }).email ?? ''))
    ? normalizeImportEmail((input as { email?: unknown }).email)
    : '';
  return {
    name: joinClientName(
      String((input as { firstName?: unknown }).firstName ?? ''),
      String((input as { lastName?: unknown }).lastName ?? ''),
      optionalClientText((input as { name?: unknown }).name)
    ),
    phone: normalizeStoredPhone((input as { phone?: unknown }).phone),
    email,
    birthday: parseClientDate(birthdayRaw),
    notes: optionalClientText((input as { notes?: unknown }).notes),
  };
}

export function draftHasContent(draft: ClientImportDraft): boolean {
  return Boolean(draft.name || draft.phone || draft.email || draft.birthday || draft.notes);
}

function emptyMapped(): MappedRow {
  return {
    firstName: '',
    lastName: '',
    fullName: '',
    phone: '',
    email: '',
    birthday: '',
    comment: '',
    source: '',
    discount: '',
    spent: '',
    averageCheck: '',
    visitCount: '',
    lastVisit: '',
    gender: '',
    blacklisted: '',
  };
}

function mappedToDraft(mapped: MappedRow): ClientImportDraft {
  const lastVisit = parseClientDate(mapped.lastVisit) ?? (cellText(mapped.lastVisit) || null);
  return sanitizeClientDraft({
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    name: mapped.fullName,
    phone: mapped.phone,
    email: mapped.email,
    birthday: mapped.birthday,
    notes: buildImportNotes({
      comment: mapped.comment,
      source: mapped.source,
      discount: mapped.discount,
      spent: mapped.spent,
      averageCheck: mapped.averageCheck,
      visitCount: mapped.visitCount,
      lastVisit,
      gender: mapped.gender,
      blacklisted: mapped.blacklisted,
    }),
  });
}

export function mapSpreadsheetObject(row: Record<string, unknown>): ClientImportDraft {
  const mapped = emptyMapped();
  for (const [key, value] of Object.entries(row)) {
    const field = fieldForHeader(key);
    if (!field) continue;
    if (field === 'birthday' || field === 'lastVisit') {
      mapped[field] = value;
    } else {
      mapped[field] = cellText(value);
    }
  }
  return mappedToDraft(mapped);
}

function headerMatchCount(cells: unknown[]): number {
  return cells.reduce<number>(
    (count, cell) => (fieldForHeader(String(cell ?? '')) ? count + 1 : count),
    0
  );
}

function findHeaderRowIndex(rows: unknown[][]): number {
  const limit = Math.min(rows.length, 12);
  let best = 0;
  let bestCount = -1;
  for (let i = 0; i < limit; i++) {
    const count = headerMatchCount(rows[i] ?? []);
    if (count > bestCount) {
      best = i;
      bestCount = count;
    }
    if (count >= 4) return i;
  }
  return bestCount >= 2 ? best : 0;
}

function rowFromCells(headers: unknown[], cells: unknown[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  headers.forEach((header, index) => {
    row[String(header ?? '')] = cells[index];
  });
  return row;
}

function isZipXlsx(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function decodeCsvText(buffer: Buffer): string {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD') && /[А-Яа-яЁё]/.test(utf8)) return utf8;
  try {
    const win = new TextDecoder('windows-1251').decode(buffer);
    if (/[А-Яа-яЁё]/.test(win)) return win;
  } catch {
    /* keep utf8 */
  }
  return utf8;
}

function detectCsvDelimiter(text: string): string {
  const first = (text.split(/\r?\n/, 1)[0] ?? '').replace(/"[^"]*"/g, '');
  const semi = (first.match(/;/g) || []).length;
  const comma = (first.match(/,/g) || []).length;
  return semi > comma ? ';' : ',';
}

function isOleXls(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0
  );
}

function readWorkbook(buffer: Buffer): XLSX.WorkBook {
  if (isZipXlsx(buffer) || isOleXls(buffer)) {
    return XLSX.read(buffer, { type: 'buffer', cellDates: true });
  }
  const text = decodeCsvText(buffer);
  return XLSX.read(text, {
    type: 'string',
    cellDates: false,
    FS: detectCsvDelimiter(text),
  });
}

export function parseClientSpreadsheetBuffer(buffer: Buffer): ClientImportDraft[] {
  const workbook = readWorkbook(buffer);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
  }) as unknown[][];
  if (!aoa.length) return [];
  const headerIdx = findHeaderRowIndex(aoa);
  const headers = aoa[headerIdx] ?? [];
  return aoa
    .slice(headerIdx + 1)
    .map((cells) => mapSpreadsheetObject(rowFromCells(headers, cells ?? [])))
    .filter(draftHasContent);
}

export function reuseFillUpdates(
  existing: ClientImportExisting,
  draft: ClientImportDraft
): Partial<Pick<ClientImportDraft, 'email' | 'birthday' | 'notes' | 'phone'>> {
  const updates: Partial<Pick<ClientImportDraft, 'email' | 'birthday' | 'notes' | 'phone'>> = {};
  if (!optionalClientText(existing.email) && isRealEmail(draft.email)) {
    updates.email = normalizeImportEmail(draft.email);
  }
  if (!optionalClientText(existing.birthday) && draft.birthday) {
    updates.birthday = draft.birthday;
  }
  if (!optionalClientText(existing.notes) && optionalClientText(draft.notes)) {
    updates.notes = draft.notes;
  }
  if (!optionalClientText(existing.phone) && draft.phone) {
    updates.phone = draft.phone;
  }
  return updates;
}

export function matchExistingClient(
  existing: ClientImportExisting[],
  draft: ClientImportDraft
): { client: ClientImportExisting; reason: 'phone_match' | 'email_match' } | null {
  const phoneKey = phoneMatchKey(draft.phone);
  if (phoneKey) {
    const byPhone = existing.find((row) => phoneMatchKey(row.phone) === phoneKey);
    if (byPhone) return { client: byPhone, reason: 'phone_match' };
  }
  if (isRealEmail(draft.email)) {
    const email = normalizeImportEmail(draft.email);
    const byEmail = existing.find(
      (row) => isRealEmail(row.email) && normalizeImportEmail(row.email) === email
    );
    if (byEmail) return { client: byEmail, reason: 'email_match' };
  }
  return null;
}

function toPreviewRow(
  draft: ClientImportDraft,
  action: ClientImportActionKind,
  reason: ClientImportReason,
  existing: ClientImportExisting | null,
  willUpdate: boolean
): ClientImportPreviewRow {
  return {
    draft,
    action,
    reason,
    existingClientId: existing?.id ?? null,
    existingClientName: existing?.name ?? null,
    willUpdate,
  };
}

export function planImportClients(
  existing: ClientImportExisting[],
  drafts: ClientImportDraft[]
): ClientImportPreviewRow[] {
  const working = existing.map((row) => ({ ...row }));
  const actions: ClientImportPreviewRow[] = [];
  let createdSeq = 0;

  for (const raw of drafts) {
    const draft = sanitizeClientDraft(raw);
    if (!draftHasContent(draft)) {
      actions.push(toPreviewRow(draft, 'skip', 'empty', null, false));
      continue;
    }
    if (!draft.name) {
      actions.push(toPreviewRow(draft, 'skip', 'missing_name', null, false));
      continue;
    }

    const match = matchExistingClient(working, draft);
    if (match) {
      const updates = reuseFillUpdates(match.client, draft);
      const willUpdate = Object.keys(updates).length > 0;
      if (willUpdate) {
        Object.assign(match.client, updates);
      }
      actions.push(toPreviewRow(draft, 'reuse', match.reason, match.client, willUpdate));
      continue;
    }

    createdSeq += 1;
    working.push({
      id: `new:${createdSeq}`,
      name: draft.name,
      email: draft.email,
      phone: draft.phone,
      notes: draft.notes,
      birthday: draft.birthday,
    });
    actions.push(toPreviewRow(draft, 'create', 'new', null, false));
  }

  return actions;
}

export function emptyImportResult(): ClientImportResult {
  return { created: 0, reused: 0, updated: 0, skipped: 0, errors: [] };
}
