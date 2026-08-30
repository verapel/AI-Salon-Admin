/**
 * Master-specific Telegram booking notification routing.
 * Does not execute SQL or call live Telegram.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BIRTHDAY_PROMPT_MESSAGE,
  buildNewBookingInternalNotification,
  getBirthdaySkipKeyboard,
  parseStaffTelegramChatId,
  resolveAssignedMasterNotifyChatId,
} from './telegramBooking.ts';
import {
  isMissingStaffTelegramChatIdColumn,
  parseStaffTelegramChatIdBody,
} from './staffTelegramChatId.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const CLIENT_CHAT = 111000111;
const MASTER_A_CHAT = 555000555;
const MASTER_B_CHAT = 777000777;

type Outbound = { chatId: number; text: string };

function simulateSuccessfulTelegramBooking(params: {
  clientChatId: number;
  clientName: string;
  serviceName: string;
  date: string;
  time: string;
  phone: string;
  assignedStaffId: string;
  staffById: Record<string, { telegram_chat_id: number | string | null | undefined }>;
  otherStaffIds?: string[];
  isNewClient: boolean;
}): { appointmentCreated: true; outbound: Outbound[]; birthdayPrompted: boolean } {
  const assigned = params.staffById[params.assignedStaffId];
  assert.ok(assigned, 'assigned staff must exist');

  const outbound: Outbound[] = [];
  outbound.push({
    chatId: params.clientChatId,
    text: `Готово, ${params.clientName}! Записала вас на ${params.serviceName} — ${params.date} в ${params.time} ✨\nБудем ждать вас!`,
  });

  const masterChatId = resolveAssignedMasterNotifyChatId({
    staffTelegramChatId: assigned.telegram_chat_id,
    clientChatId: params.clientChatId,
  });
  if (masterChatId != null) {
    outbound.push({
      chatId: masterChatId,
      text: buildNewBookingInternalNotification({
        serviceName: params.serviceName,
        date: params.date,
        time: params.time,
        clientName: params.clientName,
        phone: params.phone,
      }),
    });
  }

  let birthdayPrompted = false;
  if (params.isNewClient) {
    outbound.push({
      chatId: params.clientChatId,
      text: BIRTHDAY_PROMPT_MESSAGE,
    });
    birthdayPrompted = true;
  }

  for (const otherId of params.otherStaffIds ?? []) {
    const other = params.staffById[otherId];
    const otherChat = resolveAssignedMasterNotifyChatId({
      staffTelegramChatId: other?.telegram_chat_id,
      clientChatId: params.clientChatId,
    });
    assert.notEqual(
      otherChat,
      masterChatId === null ? undefined : masterChatId,
      'other staff must not receive this booking notify'
    );
    void otherChat;
  }

  return { appointmentCreated: true, outbound, birthdayPrompted };
}

describe('staff telegram_chat_id schema + staff UI', () => {
  it('adds nullable staff.telegram_chat_id via migration conventions', () => {
    const mig = read('supabase/migrations/20260829000001_staff_telegram_chat_id.sql');
    assert.match(mig, /ALTER TABLE staff/);
    assert.match(mig, /telegram_chat_id BIGINT NULL/);
    assert.doesNotMatch(mig, /telegram_chat_id BIGINT NOT NULL/);
    assert.doesNotMatch(mig, /555000555|111000111|TELEGRAM_CHAT_ID/);
  });

  it('staff card CRUD saves core fields even if telegram_chat_id is unsupported', () => {
    const staffPage = read('client/src/pages/Staff.tsx');
    assert.match(staffPage, /telegramChatId/);
    assert.match(staffPage, /staff\.fieldTelegramChatId/);
    assert.match(staffPage, /staff\.fieldTelegramChatIdHelp/);
    assert.match(staffPage, /api\.staff\.update\(editing\.id, data\)/);
    assert.match(staffPage, /api\.staff\.updateServices\(staffId, selectedServiceIds\)/);
    assert.match(staffPage, /specialties: member\.specialties\.join\(', '\)/);
    assert.match(staffPage, /setSelectedServiceIds\(member\.serviceIds \?\? \[\]\)/);

    const ru = read('client/src/i18n/translations.ts');
    assert.match(ru, /Telegram ID мастера для уведомлений/);
    assert.match(ru, /Личный Telegram chat ID, куда бот отправляет уведомления о новых записях\./);

    const routes = read('server/src/routes/staff.ts');
    assert.match(routes, /persistStaffTelegramChatIdIfSupported/);
    assert.doesNotMatch(routes, /telegram_chat_id: telegramChatId/);
    assert.doesNotMatch(routes, /updates\.telegram_chat_id/);
    assert.match(routes, /if \(specialties !== undefined\) updates\.specialties = specialties/);
    assert.match(routes, /router\.put\('\/:id\/services'/);

    const persist = read('server/src/lib/staffTelegramChatId.ts');
    assert.match(persist, /telegram_chat_id persist skipped/);
    assert.doesNotMatch(persist, /Staff member not found/);

    assert.equal(parseStaffTelegramChatIdBody({}).provided, false);
    assert.deepEqual(parseStaffTelegramChatIdBody({ telegramChatId: '' }), {
      provided: true,
      ok: true,
      value: null,
    });
    assert.deepEqual(parseStaffTelegramChatIdBody({ telegramChatId: '555000555' }), {
      provided: true,
      ok: true,
      value: 555000555,
    });
    assert.equal(parseStaffTelegramChatIdBody({ telegramChatId: 'abc' }).ok, false);
    assert.equal(
      isMissingStaffTelegramChatIdColumn({
        message: "Could not find the 'telegram_chat_id' column of 'staff' in the schema cache",
      }),
      true
    );
    assert.equal(isMissingStaffTelegramChatIdColumn({ message: 'Staff member not found' }), false);
  });
});

describe('assigned master Telegram notify routing', () => {
  it('sends internal notification to assigned master chat only', () => {
    const result = simulateSuccessfulTelegramBooking({
      clientChatId: CLIENT_CHAT,
      clientName: 'Анна',
      serviceName: 'Стрижка',
      date: 'сегодня',
      time: '11:00',
      phone: '+374000000',
      assignedStaffId: 'master-a',
      staffById: {
        'master-a': { telegram_chat_id: MASTER_A_CHAT },
        'master-b': { telegram_chat_id: MASTER_B_CHAT },
      },
      otherStaffIds: ['master-b'],
      isNewClient: true,
    });

    assert.equal(result.appointmentCreated, true);
    const internal = result.outbound.filter((m) => m.text.includes('🔔 Новая запись!'));
    assert.equal(internal.length, 1);
    assert.equal(internal[0].chatId, MASTER_A_CHAT);
    assert.notEqual(internal[0].chatId, CLIENT_CHAT);
    assert.notEqual(internal[0].chatId, MASTER_B_CHAT);
    assert.match(internal[0].text, /💇 Услуга: Стрижка/);
    assert.match(internal[0].text, /📅 День: сегодня/);
    assert.match(internal[0].text, /🕒 Время: 11:00/);
    assert.match(internal[0].text, /👤 Клиент: Анна/);
    assert.match(internal[0].text, /📞 Телефон: \+374000000/);
  });

  it('does not send the internal notification to the client', () => {
    const result = simulateSuccessfulTelegramBooking({
      clientChatId: CLIENT_CHAT,
      clientName: 'Анна',
      serviceName: 'Стрижка',
      date: 'сегодня',
      time: '11:00',
      phone: '+374000000',
      assignedStaffId: 'master-a',
      staffById: { 'master-a': { telegram_chat_id: MASTER_A_CHAT } },
      isNewClient: true,
    });

    const clientTexts = result.outbound.filter((m) => m.chatId === CLIENT_CHAT).map((m) => m.text);
    assert.equal(clientTexts.some((t) => t.includes('🔔 Новая запись!')), false);
    assert.equal(clientTexts.some((t) => t.startsWith('Готово, Анна!')), true);
  });

  it('uses the assigned master telegram_chat_id, not another staff member', () => {
    assert.equal(parseStaffTelegramChatId(MASTER_A_CHAT), MASTER_A_CHAT);
    assert.equal(
      resolveAssignedMasterNotifyChatId({
        staffTelegramChatId: MASTER_A_CHAT,
        clientChatId: CLIENT_CHAT,
      }),
      MASTER_A_CHAT
    );
    assert.notEqual(
      resolveAssignedMasterNotifyChatId({
        staffTelegramChatId: MASTER_A_CHAT,
        clientChatId: CLIENT_CHAT,
      }),
      MASTER_B_CHAT
    );
  });

  it('skips internal notify when telegram_chat_id is empty and still succeeds', () => {
    for (const empty of [null, undefined, '', '   '] as const) {
      const result = simulateSuccessfulTelegramBooking({
        clientChatId: CLIENT_CHAT,
        clientName: 'Анна',
        serviceName: 'Стрижка',
        date: 'сегодня',
        time: '11:00',
        phone: '+374000000',
        assignedStaffId: 'master-a',
        staffById: { 'master-a': { telegram_chat_id: empty } },
        isNewClient: true,
      });

      assert.equal(result.appointmentCreated, true);
      assert.equal(
        result.outbound.some((m) => m.text.includes('🔔 Новая запись!')),
        false
      );
      assert.equal(
        resolveAssignedMasterNotifyChatId({
          staffTelegramChatId: empty,
          clientChatId: CLIENT_CHAT,
        }),
        null
      );
      assert.equal(result.outbound.some((m) => m.chatId === CLIENT_CHAT && m.text.startsWith('Готово,')), true);
      assert.equal(result.birthdayPrompted, true);
    }
  });

  it('never falls back to the client chat id', () => {
    assert.equal(
      resolveAssignedMasterNotifyChatId({
        staffTelegramChatId: null,
        clientChatId: CLIENT_CHAT,
      }),
      null
    );
    assert.notEqual(
      resolveAssignedMasterNotifyChatId({
        staffTelegramChatId: null,
        clientChatId: CLIENT_CHAT,
      }),
      CLIENT_CHAT
    );
  });

  it('preserves normal client confirmation and birthday prompt', () => {
    const result = simulateSuccessfulTelegramBooking({
      clientChatId: CLIENT_CHAT,
      clientName: 'Анна',
      serviceName: 'Стрижка',
      date: 'сегодня',
      time: '11:00',
      phone: '+374000000',
      assignedStaffId: 'master-a',
      staffById: { 'master-a': { telegram_chat_id: MASTER_A_CHAT } },
      isNewClient: true,
    });

    const confirmation = result.outbound.find((m) => m.text.startsWith('Готово, Анна!'));
    assert.ok(confirmation);
    assert.equal(confirmation.chatId, CLIENT_CHAT);
    assert.match(confirmation.text, /Записала вас на Стрижка/);
    assert.match(confirmation.text, /Будем ждать вас!/);

    assert.equal(result.birthdayPrompted, true);
    const birthday = result.outbound.find((m) => m.text === BIRTHDAY_PROMPT_MESSAGE);
    assert.ok(birthday);
    assert.equal(birthday.chatId, CLIENT_CHAT);
    assert.match(BIRTHDAY_PROMPT_MESSAGE, /Пропустить/);
    assert.deepEqual(getBirthdaySkipKeyboard(), [[{ text: 'Пропустить', callback_data: 'birthday:skip' }]]);
  });
});

describe('Telegram booking path contracts', () => {
  it('routes new-booking notify through assigned master, not notifySalonAdmin', () => {
    const index = read('server/src/index.ts');
    const phoneStart = index.indexOf("currentState.step === 'phone'");
    assert.ok(phoneStart > 0);
    const phoneBlock = index.slice(phoneStart, index.indexOf('// --- конец шаг-машины ---', phoneStart));

    assert.match(phoneBlock, /Готово, \$\{name\}! Записала вас на/);
    assert.match(phoneBlock, /resolveAssignedMasterNotifyChatId/);
    assert.match(phoneBlock, /staffRow\.telegram_chat_id/);
    assert.match(phoneBlock, /buildNewBookingInternalNotification/);
    assert.match(phoneBlock, /birthdayState\.set/);
    assert.match(phoneBlock, /BIRTHDAY_PROMPT_MESSAGE/);
    assert.match(phoneBlock, /getBirthdaySkipKeyboard/);
    assert.doesNotMatch(phoneBlock, /notifySalonAdmin\(\s*ctx,\s*`🔔 Новая запись!/);
    assert.match(phoneBlock, /from\("appointments"\)/);
    assert.match(phoneBlock, /staff_id: staffRow\.id/);
    assert.match(phoneBlock, /const staffRow = finalState\.staffId/);
    assert.match(phoneBlock, /if \(!staffRow\) \{\s*[\s\S]*?return STAFF_UNAVAILABLE_MESSAGE;/);
    assert.doesNotMatch(phoneBlock, /if \(!staffRow\.telegram_chat_id\)/);
  });

  it('resolves assigned master without requiring telegram_chat_id', () => {
    const booking = read('server/src/lib/telegramBooking.ts');
    const fnStart = booking.indexOf('export async function getActiveStaffById');
    assert.ok(fnStart >= 0);
    const fn = booking.slice(fnStart, booking.indexOf('export function buildStaffSelectionKeyboard'));
    assert.match(fn, /\.select\('id, name, specialties'\)/);
    assert.doesNotMatch(fn, /\.select\('id, name, specialties, telegram_chat_id'\)/);
    assert.match(booking, /async function loadStaffTelegramChatId/);
    assert.match(booking, /\.select\('telegram_chat_id'\)/);
    assert.match(fn, /telegram_chat_id: await loadStaffTelegramChatId/);
    assert.match(booking, /if \(error \|\| !data\) return null;/);
  });

  it('does not change WhatsApp commit or Google calendar files', () => {
    const wa = read('server/src/lib/whatsappBookingCommit.ts');
    assert.doesNotMatch(wa, /buildNewBookingInternalNotification|resolveAssignedMasterNotifyChatId/);

    const google = read('server/src/lib/googleCalendarReconcile.ts');
    assert.doesNotMatch(google, /resolveAssignedMasterNotifyChatId/);
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    assert.doesNotMatch(auto, /resolveAssignedMasterNotifyChatId/);
  });
});
