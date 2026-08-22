/**
 * DIKIDI-CLIENT-IMPORT: Excel/CSV parse, preview actions, phone/email dedupe.
 * Does not execute SQL. Does not call Google / messengers / calendars.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import {
  buildImportNotes,
  isRealEmail,
  mapSpreadsheetObject,
  matchExistingClient,
  normalizeStoredPhone,
  parseClientDate,
  parseClientSpreadsheetBuffer,
  phoneMatchKey,
  planImportClients,
  reuseFillUpdates,
  sanitizeClientDraft,
  type ClientImportExisting,
} from './clientImport.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function existing(
  id: string,
  extra: Partial<ClientImportExisting> = {}
): ClientImportExisting {
  return {
    id,
    name: extra.name ?? 'Existing',
    email: extra.email ?? '',
    phone: extra.phone ?? '',
    notes: extra.notes ?? '',
    birthday: extra.birthday ?? null,
  };
}

function dikidiRow(overrides: Record<string, unknown> = {}) {
  return {
    'Имя клиента': 'Анна',
    'Фамилия клиента': 'Иванова',
    'Мобильный номер': '+380 (63) 202-28-10',
    'Электронная почта': 'anna@example.com',
    'Скидка, %': '10',
    Потрачено: '15000',
    'Средний чек': '2500',
    'Количество записей': '6',
    'Последний визит': '12.03.2026',
    'День рождения': '01.05.1990',
    Пол: 'женский',
    'В черном списке': 'нет',
    Комментарий: 'утро',
    Источник: 'Instagram',
    ...overrides,
  };
}

function workbookFromRows(rows: Record<string, unknown>[]) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Клиенты');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

describe('DIKIDI-CLIENT-IMPORT', () => {
  it('maps the confirmed 14-column DIKIDI export into a client draft', () => {
    const draft = mapSpreadsheetObject(dikidiRow());
    assert.equal(draft.name, 'Анна Иванова');
    assert.equal(phoneMatchKey(draft.phone), phoneMatchKey('+380632022810'));
    assert.equal(draft.email, 'anna@example.com');
    assert.equal(draft.birthday, '1990-05-01');
    assert.match(draft.notes, /утро/);
    assert.match(draft.notes, /Источник: Instagram/);
    assert.match(draft.notes, /Количество записей: 6/);
    assert.match(draft.notes, /Последний визит: 2026-03-12/);
    assert.equal(draft.notes.includes('CREATE'), false);
  });

  it('supports the 121-row DIKIDI xlsx/csv format and keeps every phone', () => {
    const rows = Array.from({ length: 121 }, (_, index) =>
      dikidiRow({
        'Имя клиента': `Клиент${index + 1}`,
        'Фамилия клиента': 'Тест',
        'Мобильный номер': `+38067${String(1000000 + index).slice(-7)}`,
        'Электронная почта': index % 4 === 0 ? '' : `c${index + 1}@salon.local`,
      })
    );
    const parsed = parseClientSpreadsheetBuffer(workbookFromRows(rows));
    assert.equal(parsed.length, 121);
    assert.ok(parsed.every((row) => row.phone));
    assert.ok(parsed.every((row) => row.name.startsWith('Клиент')));
    assert.equal(
      parsed.filter((row) => row.email === '').length,
      rows.filter((row) => row['Электронная почта'] === '').length
    );

    const sheet = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Клиенты');
    const fromCsv = parseClientSpreadsheetBuffer(
      Buffer.from(XLSX.write(wb, { type: 'string', bookType: 'csv' }), 'utf8')
    );
    assert.equal(fromCsv.length, 121);
  });

  it('dedupes by normalized phone in the current salon only, never by name', () => {
    const current = [
      existing('a1', { name: 'Анна Иванова', phone: '0632022810', email: '' }),
      existing('other-salon-shape', { name: 'Борис', phone: '+380501111111' }),
    ];
    const planned = planImportClients(current, [
      sanitizeClientDraft({
        name: 'Анна Другая',
        phone: '+380 63 202 28 10',
        email: 'new@example.com',
      }),
      sanitizeClientDraft({
        name: 'Анна Иванова',
        phone: '+380501222333',
        email: '',
      }),
    ]);
    assert.equal(planned[0]?.action, 'reuse');
    assert.equal(planned[0]?.reason, 'phone_match');
    assert.equal(planned[0]?.existingClientId, 'a1');
    assert.equal(planned[1]?.action, 'create');
    assert.equal(planned[1]?.reason, 'new');
    assert.equal(matchExistingClient(current, sanitizeClientDraft({ name: 'Анна Иванова' })), null);
  });

  it('falls back to a real email match and treats email as optional', () => {
    const current = [existing('e1', { name: 'Елена', phone: '', email: 'elena@salon.local' })];
    const reuse = planImportClients(current, [
      sanitizeClientDraft({
        name: 'Елена Новая',
        phone: '',
        email: 'Elena@salon.local',
      }),
    ]);
    assert.equal(reuse[0]?.action, 'reuse');
    assert.equal(reuse[0]?.reason, 'email_match');

    const createWithoutEmail = planImportClients([], [
      sanitizeClientDraft({ name: 'Ольга', phone: '+380670009999', email: '' }),
    ]);
    assert.equal(createWithoutEmail[0]?.action, 'create');
    assert.equal(createWithoutEmail[0]?.draft.email, '');
    assert.equal(isRealEmail(''), false);
    assert.equal(isRealEmail('нет'), false);
    assert.equal(
      matchExistingClient(
        [existing('blank', { email: '' })],
        sanitizeClientDraft({ name: 'X', email: '' })
      ),
      null
    );
  });

  it('preview shows CREATE / REUSE / SKIP with reasons', () => {
    const current = [existing('p1', { phone: '+380670000001' })];
    const planned = planImportClients(current, [
      sanitizeClientDraft({ name: 'Новый', phone: '+380670000002' }),
      sanitizeClientDraft({ name: 'Старый', phone: '0670000001' }),
      sanitizeClientDraft({ name: '', phone: '+380670000003' }),
    ]);
    assert.deepEqual(
      planned.map((row) => [row.action, row.reason]),
      [
        ['create', 'new'],
        ['reuse', 'phone_match'],
        ['skip', 'missing_name'],
      ]
    );
  });

  it('reuses without overwriting good data; fills missing email/birthday/notes only', () => {
    const current = existing('u1', {
      name: 'Мария',
      phone: '+380670001111',
      email: 'keep@salon.local',
      notes: 'уже есть',
      birthday: '1991-01-01',
    });
    const noOverwrite = reuseFillUpdates(
      current,
      sanitizeClientDraft({
        name: 'Другое имя',
        phone: '+380670009999',
        email: 'new@salon.local',
        birthday: '2000-02-02',
        notes: 'DIKIDI note',
      })
    );
    assert.deepEqual(noOverwrite, {});

    const fillMissing = reuseFillUpdates(
      existing('u2', { name: 'Мария', phone: '+380670001111', email: '', notes: '', birthday: null }),
      sanitizeClientDraft({
        name: 'Мария',
        phone: '+380670001111',
        email: 'fill@salon.local',
        birthday: '1995-07-07',
        notes: 'Источник: DIKIDI',
      })
    );
    assert.equal(fillMissing.email, 'fill@salon.local');
    assert.equal(fillMissing.birthday, '1995-07-07');
    assert.equal(fillMissing.notes, 'Источник: DIKIDI');
  });

  it('does not create appointments from historical visit count', () => {
    const notes = buildImportNotes({ visitCount: '12', lastVisit: '2026-01-01' });
    assert.match(notes, /Количество записей: 12/);
    const draft = mapSpreadsheetObject(dikidiRow({ 'Количество записей': '12' }));
    assert.equal('totalVisits' in draft, false);
    const helper = read('server/src/lib/clientImport.ts');
    const route = read('server/src/routes/clients.ts');
    assert.doesNotMatch(helper, /total_visits|last_visit|from\('appointments'\)/);
    const commit = route.slice(route.indexOf("router.post('/import/commit'"));
    assert.doesNotMatch(commit, /total_visits|from\('appointments'\)/);
    assert.match(commit, /buildClientCreateRow/);
  });

  it('keeps in-file phone duplicates as reuse instead of a second create', () => {
    const planned = planImportClients([], [
      sanitizeClientDraft({ name: 'Первая', phone: '+380670001111' }),
      sanitizeClientDraft({ name: 'Вторая', phone: '0670001111' }),
    ]);
    assert.equal(planned[0]?.action, 'create');
    assert.equal(planned[1]?.action, 'reuse');
    assert.equal(planned[1]?.reason, 'phone_match');
  });

  it('normalizes UA/RU phone variants and parses DIKIDI dates', () => {
    assert.equal(phoneMatchKey('+380 (63) 202-28-10'), phoneMatchKey('0632022810'));
    assert.equal(phoneMatchKey('89161234567'), phoneMatchKey('+79161234567'));
    assert.equal(normalizeStoredPhone('0632022810'), '+380632022810');
    assert.equal(parseClientDate('01.05.1990'), '1990-05-01');
    assert.equal(parseClientDate('1990-05-01'), '1990-05-01');
    assert.equal(parseClientDate(36526), '2000-01-01');
  });

  it('parse/preview do not write clients; commit is salon-scoped and has no migration', () => {
    const route = read('server/src/routes/clients.ts');
    const parse = route.slice(
      route.indexOf("router.post('/import/parse'"),
      route.indexOf("router.post('/import/preview'")
    );
    const preview = route.slice(
      route.indexOf("router.post('/import/preview'"),
      route.indexOf("router.post('/import/commit'")
    );
    const commit = route.slice(route.indexOf("router.post('/import/commit'"));
    assert.match(parse, /requireSalonWriteAccess/);
    assert.match(parse, /parseClientSpreadsheetBuffer/);
    assert.match(parse, /planImportClients/);
    assert.doesNotMatch(parse, /\.insert\(/);
    assert.doesNotMatch(parse, /\.update\(/);
    assert.match(preview, /planImportClients/);
    assert.doesNotMatch(preview, /\.insert\(/);
    assert.match(commit, /\.eq\('salon_id',\s*salonId\)/);
    assert.match(commit, /\.is\('deleted_at',\s*null\)/);
    assert.match(commit, /reuseFillUpdates/);
    assert.match(commit, /\.insert\(/);
    assert.doesNotMatch(route, /googleCalendar|telegram|whatsapp|instagram|apple/i);

    const page = read('client/src/pages/Clients.tsx');
    assert.match(page, /api\.clients\.parseImport/);
    assert.match(page, /api\.clients\.previewImport/);
    assert.match(page, /api\.clients\.commitImport/);
    assert.match(page, /clients\.actionCreate/);
    assert.match(page, /clients\.actionReuse/);
    assert.match(page, /clients\.actionSkip/);
    assert.match(page, /clients\.confirmImport/);

    const pkg = read('server/package.json');
    assert.match(pkg, /clientImport\.test\.ts/);
  });

  it('does not add a database migration for this import', () => {
    const helper = read('server/src/lib/clientImport.ts');
    assert.doesNotMatch(helper, /CREATE TABLE|ALTER TABLE|supabase\/migrations/);
  });
});
