import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

console.log("CURRENT DIR =", process.cwd());

import express, { type RequestHandler } from 'express';
import cors from 'cors';
import fs from 'fs';
import clientsRouter from './routes/clients.js';
import servicesRouter from './routes/services.js';
import staffRouter from './routes/staff.js';
import appointmentsRouter from './routes/appointments.js';
import statsRouter from './routes/stats.js';
import scheduleRouter from './routes/schedule.js';
import developerRouter from './routes/developer.js';
import authRouter from './routes/auth.js';
import { requireDeveloperAuth, requireSalonAuth } from './middleware/auth.js';
import { supabase, checkSupabaseConnection } from './lib/supabase.js';
import { loadTelegramTokenFromDb, saveTelegramTokenToDb } from './lib/telegramToken.js';
import { registerTelegramPollingRestarter } from './lib/telegramPollingControl.js';
import {
  defaultTelegramSalonContext,
  getTelegramStateKey,
  type TelegramSalonContext,
} from './lib/telegramContext.js';
import {
  isMultiTelegramEnabled,
  telegramBotManager,
} from './lib/telegramBotManager.js';
import {
  ACTIVE_SLOT_STATUSES,
  buildServiceKeyboard,
  buildStaffSelectionKeyboard,
  computeAppointmentEndTime,
  findStaffForServiceSpecialization,
  getActiveStaffById,
  localDateStr,
  resolveServiceById,
  resolveServiceByName,
  STAFF_UNAVAILABLE_MESSAGE,
  BLOCKED_CLIENT_BOOKING_MESSAGE,
  BIRTHDAY_PROMPT_MESSAGE,
  BIRTHDAY_INVALID_MESSAGE,
  BIRTHDAY_SAVED_MESSAGE,
  BIRTHDAY_SKIPPED_MESSAGE,
  getBirthdaySkipKeyboard,
  parseBirthdayDate,
} from './lib/telegramBooking.js';
import {
  computeAvailableSlots,
  dateStrInTimezone,
  findNextAvailableDates,
  formatTelegramDateLabel,
  getSalonTimezone,
  NO_AVAILABLE_DATES_MESSAGE,
} from './lib/scheduleSlots.js';

const app = express();

const chatHistory = new Map<string, any[]>();
type BookingStep = 'service' | 'staff' | 'date' | 'time' | 'name' | 'phone';

interface BookingData {
  step?: BookingStep;
  service: string;
  staffId: string;
  date: string;
  time: string;
  name: string;
  phone: string;
}

const bookingState = new Map<string, BookingData>();

type ManageAction = 'cancel' | 'reschedule';
type ManageStep = 'ask_phone' | 'confirm_appointment' | 'select_new_date' | 'select_new_time';

interface ManageData {
  action: ManageAction;
  step: ManageStep;
  phone?: string;
  clientId?: string;
  appointmentId?: string;
  newDate?: string;
}

const manageState = new Map<string, ManageData>();

interface BirthdayCollectionState {
  clientId: string;
  invalidAttempts: number;
}

const birthdayState = new Map<string, BirthdayCollectionState>();

const PORT = process.env.PORT || 3001;

// Маппинг русских месяцев (родительный + именительный падеж)
const MONTH_MAP: Record<string, number> = {
  'январь': 1, 'января': 1,
  'февраль': 2, 'февраля': 2,
  'март': 3, 'марта': 3,
  'апрель': 4, 'апреля': 4,
  'май': 5, 'мая': 5,
  'июнь': 6, 'июня': 6,
  'июль': 7, 'июля': 7,
  'август': 8, 'августа': 8,
  'сентябрь': 9, 'сентября': 9,
  'октябрь': 10, 'октября': 10,
  'ноябрь': 11, 'ноября': 11,
  'декабрь': 12, 'декабря': 12,
};

function parseAppointmentDate(input: string, timeZone?: string): string {
  const trimmed = input.trim();
  console.log(`[parseDate] raw input: "${trimmed}"`);

  // Если уже ISO-формат YYYY-MM-DD (например, из кнопки) — вернуть как есть
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    console.log(`[parseDate] ISO detected, returning: "${trimmed}"`);
    return trimmed;
  }

  const tz = timeZone?.trim() || undefined;
  const text = trimmed.toLowerCase();

  // "сегодня" / "завтра" — salon timezone when provided
  if (text.includes('сегодня')) {
    const result = tz ? dateStrInTimezone(tz, 0) : (() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    })();
    console.log(`[parseDate] сегодня -> ${result}`);
    return result;
  }
  if (text.includes('завтра')) {
    const result = tz ? dateStrInTimezone(tz, 1) : (() => {
      const now = new Date();
      now.setDate(now.getDate() + 1);
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    })();
    console.log(`[parseDate] завтра -> ${result}`);
    return result;
  }

  const todayYmd = tz
    ? dateStrInTimezone(tz, 0)
    : (() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      })();
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);

  // "DD месяц" / "DD-го месяц" — например "2 августа", "30 июня", "1 июля"
  const match = text.match(/(\d{1,2})(?:-?го)?\s+([а-яё]+)/);
  if (match) {
    const day = parseInt(match[1], 10);
    const monthName = match[2];
    const monthNum = MONTH_MAP[monthName];
    if (monthNum) {
      let year = ty;
      let candidate = Date.UTC(year, monthNum - 1, day);
      if (candidate < todayUtc) {
        year += 1;
        candidate = Date.UTC(year, monthNum - 1, day);
      }
      const formatted = `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      console.log(`[parseDate] parsed "DD месяц": day=${day}, month=${monthNum}, result=${formatted}`);
      return formatted;
    }
  }

  console.log(`[parseDate] result: "${todayYmd}"`);
  return todayYmd;
}

async function parseAppointmentDateForSalon(salonId: string, input: string): Promise<string> {
  const tz = await getSalonTimezone(salonId);
  return parseAppointmentDate(input, tz);
}

// Форматирует дату для пользователя: ISO → "29 июня", всё остальное — как есть
function formatDateForUser(input: string): string {
  const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [, m, d] = trimmed.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  }
  return trimmed;
}

/** Read-only service duration lookup (does not create services). Fallback 60. */
async function resolveBookingDurationMinutes(
  salonId: string,
  serviceName?: string
): Promise<number> {
  const trimmed = serviceName?.trim();
  if (!trimmed) return 60;

  const { data, error } = await supabase
    .from('services')
    .select('duration')
    .eq('salon_id', salonId)
    .ilike('name', trimmed)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error('[slots] duration lookup error:', error.message);
    return 60;
  }
  const duration = (data as { duration?: number } | null)?.duration;
  return typeof duration === 'number' && duration > 0 ? duration : 60;
}

async function resolveAppointmentDurationMinutes(
  salonId: string,
  appointmentId: string
): Promise<number> {
  const { data, error } = await (supabase as any)
    .from('appointments')
    .select('service_id, services(duration)')
    .eq('id', appointmentId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    console.error('[slots] appointment duration lookup error:', error.message);
    return 60;
  }
  const duration = data?.services?.duration;
  return typeof duration === 'number' && duration > 0 ? duration : 60;
}

function layoutDateButtons(
  buttons: { text: string; callback_data: string }[]
): { text: string; callback_data: string }[][] {
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  return keyboard;
}

/** Next open dates for staff/service (skip closed) + manual entry. */
async function getDateKeyboard(
  salonId: string,
  staffId: string,
  durationMinutes: number
): Promise<{ text: string; callback_data: string }[][]> {
  const tz = await getSalonTimezone(salonId);
  const dates = await findNextAvailableDates({
    salonId,
    staffId,
    durationMinutes,
    count: 4,
    maxDays: 30,
  });
  const buttons = dates.map((iso) => ({
    text: formatTelegramDateLabel(iso, tz),
    callback_data: `date:${iso}`,
  }));
  buttons.push({ text: '✍️ Ввести дату', callback_data: 'date:manual' });
  return layoutDateButtons(buttons);
}

/** Reschedule date keyboard — same open-date logic, rdate: callbacks. */
async function getRescheduleDateKeyboard(
  salonId: string,
  appointmentId: string,
  staffId: string,
  durationMinutes: number
): Promise<{ text: string; callback_data: string }[][]> {
  const tz = await getSalonTimezone(salonId);
  const dates = await findNextAvailableDates({
    salonId,
    staffId,
    durationMinutes,
    excludeAppointmentId: appointmentId,
    count: 4,
    maxDays: 30,
  });
  const buttons = dates.map((iso) => ({
    text: formatTelegramDateLabel(iso, tz),
    callback_data: `rdate:${appointmentId}:${iso}`,
  }));
  buttons.push({ text: '✍️ Ввести дату', callback_data: `rdate_manual:${appointmentId}` });
  return layoutDateButtons(buttons);
}

async function sendBookingDatePrompt(
  chatId: number,
  message: string,
  salonId: string,
  staffId: string,
  durationMinutes: number,
  botToken?: string
): Promise<void> {
  const keyboard = await getDateKeyboard(salonId, staffId, durationMinutes);
  const datesOnly = keyboard.flat().filter((b) => b.callback_data.startsWith('date:') && b.callback_data !== 'date:manual');
  const text =
    datesOnly.length === 0
      ? `${message}\n\n${NO_AVAILABLE_DATES_MESSAGE}`
      : message;
  await sendTelegramMessageWithKeyboard(chatId, text, keyboard, botToken);
}

// Форматирует запись для отображения клиенту
function formatAppointmentForUser(appt: any): string {
  const date = formatDateForUser((appt.date as string) ?? '');
  const time = appt.start_time ? (appt.start_time as string).slice(0, 5) : '?';
  const notes = (appt.notes as string) ?? '';
  // Новый формат: "Услуга: Стрижка\n..."
  // Старый формат (обратная совместимость): "Telegram: Стрижка, ..."
  const serviceNew = notes.match(/Услуга: (.+)/m)?.[1]?.trim();
  const serviceOld = notes.match(/Telegram: (.+?),/)?.[1];
  const service = serviceNew ?? serviceOld ?? 'услуга';
  return `📅 ${date} в ${time} — ${service}`;
}

// Клавиатура выбора даты при переносе — see getRescheduleDateKeyboard above (schedule-aware).

function parseAppointmentTime(input: string): string {
  const match = input.match(/(\d{1,2})[:. ]?(\d{2})?/);
  if (!match) return "10:00";

  const hours = match[1].padStart(2, "0");
  const minutes = match[2] || "00";

  return `${hours}:${minutes}`;
}

function isServiceSelectionPrompt(text: string): boolean {
  const normalized = text.toLowerCase();
  return /на какую услугу/.test(normalized) || /какую услугу/.test(normalized);
}

async function handleBirthdayCollection(
  ctx: TelegramSalonContext,
  chatId: number,
  text: string
): Promise<string | null> {
  const stateKey = getTelegramStateKey(ctx.salonId, chatId);
  const state = birthdayState.get(stateKey);
  if (!state) return null;

  const botToken = resolveTelegramBotToken(ctx);

  const parsed = parseBirthdayDate(text);
  if (!parsed) {
    if (state.invalidAttempts >= 1) {
      birthdayState.delete(stateKey);
      return BIRTHDAY_SKIPPED_MESSAGE;
    }
    birthdayState.set(stateKey, { ...state, invalidAttempts: state.invalidAttempts + 1 });
    await sendTelegramMessageWithKeyboard(chatId, BIRTHDAY_INVALID_MESSAGE, getBirthdaySkipKeyboard(), botToken);
    return null;
  }

  const { error } = await (supabase as any)
    .from('clients')
    .update({ birthday: parsed })
    .eq('id', state.clientId)
    .eq('salon_id', ctx.salonId);

  birthdayState.delete(stateKey);
  if (error) {
    console.error('[birthday] save error:', error);
    return BIRTHDAY_SKIPPED_MESSAGE;
  }
  return BIRTHDAY_SAVED_MESSAGE;
}

app.use(cors());
app.use(express.json());
async function generateAIResponse(
  ctx: TelegramSalonContext,
  chatId: number,
  text: string
): Promise<string | null> {
  const stateKey = getTelegramStateKey(ctx.salonId, chatId);
  const botToken = resolveTelegramBotToken(ctx);
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterKey) {
    return 'OpenRouter API key not configured';
  }

  if (birthdayState.has(stateKey)) {
    return handleBirthdayCollection(ctx, chatId, text);
  }

  const history = [...(chatHistory.get(stateKey) || [])];

  history.push({
    role: 'user',
    content: text
  });

  // --- 0. Определяем intent: отмена / перенос ---
  const lowerText = text.toLowerCase().trim();
  if (!manageState.has(stateKey)) {
    const isCancelIntent = /отмен|cancel/.test(lowerText);
    const isRescheduleIntent = /перенос|перенес|перенести/.test(lowerText);
    if (isCancelIntent || isRescheduleIntent) {
      bookingState.delete(stateKey);
      birthdayState.delete(stateKey);
      const action: ManageAction = isCancelIntent ? 'cancel' : 'reschedule';
      manageState.set(stateKey, { action, step: 'ask_phone' });
      const msg = action === 'cancel'
        ? 'Конечно, помогу отменить запись. Введите номер телефона, по которому вы записаны.'
        : 'Конечно, помогу перенести запись. Введите номер телефона, по которому вы записаны.';
      history.push({ role: 'assistant', content: msg });
      chatHistory.set(stateKey, history.slice(-10));
      return msg;
    }
  }

  // --- 1. Обработка шагов manage (отмена / перенос) ---
  const manage = manageState.get(stateKey);
  if (manage) {
    if (manage.step === 'ask_phone') {
      const phone = text;
      const { data: client } = await (supabase as any)
        .from('clients').select('id').eq('phone', phone).eq('salon_id', ctx.salonId).maybeSingle();
      if (!client) {
        manageState.delete(stateKey);
        const msg = 'Не нашла запись с таким номером. Если хотите записаться, напишите название услуги.';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(stateKey, history.slice(-10));
        return msg;
      }
      const today = localDateStr(0);
      const { data: appointments } = await (supabase as any)
        .from('appointments')
        .select('id, date, start_time, notes')
        .eq('salon_id', ctx.salonId)
        .eq('client_id', client.id)
        .gte('date', today)
        .in('status', ACTIVE_SLOT_STATUSES)
        .order('date', { ascending: true });
      if (!appointments || appointments.length === 0) {
        manageState.delete(stateKey);
        const msg = 'Будущих записей не найдено. Если хотите записаться, напишите название услуги.';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(stateKey, history.slice(-10));
        return msg;
      }
      manageState.set(stateKey, { ...manage, step: 'confirm_appointment', phone, clientId: client.id });
      if (appointments.length === 1) {
        const appt = appointments[0];
        const apptText = formatAppointmentForUser(appt);
        if (manage.action === 'cancel') {
          const msg = `Ваша запись:\n${apptText}\n\nОтменить её?`;
          const keyboard = [[
            { text: '✅ Да, отменить', callback_data: `cancel_confirm:${appt.id}` },
            { text: '❌ Нет, оставить', callback_data: 'cancel_keep' }
          ]];
          history.push({ role: 'assistant', content: msg });
          chatHistory.set(stateKey, history.slice(-10));
          await sendTelegramMessageWithKeyboard(chatId, msg, keyboard, botToken);
          return null;
        } else {
          manageState.set(stateKey, { ...manage, step: 'select_new_date', phone, clientId: client.id, appointmentId: appt.id });
          const msg = `Ваша запись:\n${apptText}\n\nВыберите новую дату:`;
          history.push({ role: 'assistant', content: msg });
          chatHistory.set(stateKey, history.slice(-10));
          const rescheduleStaffId = await getAppointmentStaffId(ctx.salonId, appt.id);
          const rescheduleDuration = await resolveAppointmentDurationMinutes(ctx.salonId, appt.id);
          const rescheduleKb = rescheduleStaffId
            ? await getRescheduleDateKeyboard(ctx.salonId, appt.id, rescheduleStaffId, rescheduleDuration)
            : [[{ text: '✍️ Ввести дату', callback_data: `rdate_manual:${appt.id}` }]];
          await sendTelegramMessageWithKeyboard(chatId, msg, rescheduleKb, botToken);
          return null;
        }
      } else {
        const keyboard = (appointments as any[]).map(a => [{
          text: formatAppointmentForUser(a),
          callback_data: manage.action === 'cancel' ? `select_cancel:${a.id}` : `select_reschedule:${a.id}`
        }]);
        const msg = manage.action === 'cancel' ? 'Какую запись вы хотите отменить?' : 'Какую запись вы хотите перенести?';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(stateKey, history.slice(-10));
        await sendTelegramMessageWithKeyboard(chatId, msg, keyboard, botToken);
        return null;
      }
    }

    if (manage.step === 'select_new_date') {
      // Пользователь ввёл дату вручную при переносе
      const parsedDate = await parseAppointmentDateForSalon(ctx.salonId, text);
      manageState.set(stateKey, { ...manage, newDate: parsedDate });
      const staffId = await getAppointmentStaffId(ctx.salonId, manage.appointmentId!);
      if (!staffId) {
        manageState.delete(stateKey);
        return 'Не удалось определить мастера для этой записи. Обратитесь к администратору.';
      }
      // Исключаем саму переносимую запись из занятых слотов мастера
      const rescheduleDuration = await resolveAppointmentDurationMinutes(ctx.salonId, manage.appointmentId!);
      const freeSlots = await getAvailableSlots(
        ctx.salonId,
        parsedDate,
        staffId,
        manage.appointmentId,
        rescheduleDuration
      );
      if (freeSlots.length === 0) {
        const msg = 'На эту дату нет свободного времени. Выберите другой день:';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(stateKey, history.slice(-10));
        await sendTelegramMessageWithKeyboard(
          chatId,
          msg,
          await getRescheduleDateKeyboard(ctx.salonId, manage.appointmentId!, staffId, rescheduleDuration),
          botToken
        );
        return null;
      }
      const keyboard: { text: string; callback_data: string }[][] = [];
      for (let i = 0; i < freeSlots.length; i += 3) {
        keyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `rtime:${manage.appointmentId}:${s}` })));
      }
      const msg = 'Выберите удобное время:';
      history.push({ role: 'assistant', content: msg });
      chatHistory.set(stateKey, history.slice(-10));
      await sendTelegramMessageWithKeyboard(chatId, msg, keyboard, botToken);
      return null;
    }

    // Другие шаги manage — ждём кнопок
    return 'Пожалуйста, используйте кнопки для выбора.';
  }

  // --- Шаг-машина: обработка шага ДО вызова OpenRouter ---
  const currentState = bookingState.get(stateKey);

  if (currentState?.step) {
    if (currentState.step === 'service') {
      const serviceName = text.trim();
      const staffMatches = await findStaffForServiceSpecialization(ctx.salonId, serviceName);

      if (staffMatches.length === 0) {
        history.push({ role: 'assistant', content: STAFF_UNAVAILABLE_MESSAGE });
        chatHistory.set(stateKey, history.slice(-10));
        bookingState.delete(stateKey);
        return STAFF_UNAVAILABLE_MESSAGE;
      }

      if (staffMatches.length === 1) {
        bookingState.set(stateKey, {
          ...currentState,
          step: 'date',
          service: serviceName,
          staffId: staffMatches[0].id,
        });
        const datePrompt = 'На какой день вы хотите записаться?';
        history.push({ role: 'assistant', content: datePrompt });
        chatHistory.set(stateKey, history.slice(-10));
        const duration = await resolveBookingDurationMinutes(ctx.salonId, serviceName);
        await sendBookingDatePrompt(chatId, datePrompt, ctx.salonId, staffMatches[0].id, duration, botToken);
        return null;
      } else {
        bookingState.set(stateKey, { ...currentState, step: 'staff', service: serviceName });
        const staffQuestion = 'К какому мастеру хотите записаться?';
        history.push({ role: 'assistant', content: staffQuestion });
        chatHistory.set(stateKey, history.slice(-10));
        await sendTelegramMessageWithKeyboard(
          chatId,
          staffQuestion,
          buildStaffSelectionKeyboard(staffMatches),
          botToken
        );
        return null;
      }

    } else if (currentState.step === 'staff') {
      bookingState.set(stateKey, { ...currentState, step: 'date', staffId: text.trim() });

    } else if (currentState.step === 'date') {
      if (!currentState.staffId?.trim()) {
        bookingState.delete(stateKey);
        history.push({ role: 'assistant', content: STAFF_UNAVAILABLE_MESSAGE });
        chatHistory.set(stateKey, history.slice(-10));
        return STAFF_UNAVAILABLE_MESSAGE;
      }
      console.log(`[step:date] raw text: "${text}" | bookingState before:`, JSON.stringify(currentState));
      const parsedDate = await parseAppointmentDateForSalon(ctx.salonId, text);
      console.log(`[step:date] parsedDate passed to getAvailableSlots: "${parsedDate}"`);
      const duration = await resolveBookingDurationMinutes(ctx.salonId, currentState.service);
      const freeSlots = await getAvailableSlots(ctx.salonId, parsedDate, currentState.staffId, undefined, duration);

      if (freeSlots.length === 0) {
        bookingState.set(stateKey, { ...currentState, step: 'date', date: '' });
        const noSlotsMsg = `К сожалению, на выбранную дату нет свободного времени. Выберите другой день:`;
        history.push({ role: 'assistant', content: noSlotsMsg });
        chatHistory.set(stateKey, history.slice(-10));
        await sendBookingDatePrompt(chatId, noSlotsMsg, ctx.salonId, currentState.staffId, duration, botToken);
        return null;
      }

      bookingState.set(stateKey, { ...currentState, step: 'time', date: text });
      console.log(`[step:date] bookingState after:`, JSON.stringify(bookingState.get(stateKey)));
      const timePrompt = 'На какое время вам удобно записаться?';
      history.push({ role: 'assistant', content: timePrompt });
      chatHistory.set(stateKey, history.slice(-10));
      const timeKeyboard: { text: string; callback_data: string }[][] = [];
      for (let i = 0; i < freeSlots.length; i += 3) {
        timeKeyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `time:${s}` })));
      }
      await sendTelegramMessageWithKeyboard(chatId, timePrompt, timeKeyboard, botToken);
      return null;

    } else if (currentState.step === 'time') {
      if (!currentState.staffId?.trim()) {
        bookingState.delete(stateKey);
        history.push({ role: 'assistant', content: STAFF_UNAVAILABLE_MESSAGE });
        chatHistory.set(stateKey, history.slice(-10));
        return STAFF_UNAVAILABLE_MESSAGE;
      }
      // Проверяем слот СРАЗУ — до того как AI спросит имя
      console.log(`[step:time] raw text: "${text}" | currentState.date: "${currentState.date}"`);
      const appointmentDate = await parseAppointmentDateForSalon(ctx.salonId, currentState.date);
      const appointmentTime = parseAppointmentTime(text);
      console.log(`[step:time] appointmentDate: "${appointmentDate}" | appointmentTime: "${appointmentTime}"`);

      // Authoritative duration-aware check (typed time, stale buttons, overlaps).
      const duration = await resolveBookingDurationMinutes(ctx.salonId, currentState.service);
      const freeSlots = await getAvailableSlots(
        ctx.salonId,
        appointmentDate,
        currentState.staffId,
        undefined,
        duration
      );

      if (!freeSlots.includes(appointmentTime)) {
        if (freeSlots.length === 0) {
          // На эту дату нет ни одного свободного слота — просим выбрать другой день
          bookingState.set(stateKey, { ...currentState, step: 'date', time: '' });
          const noSlotsMsg = `На эту дату свободного времени нет. Пожалуйста, выберите другой день.`;
          history.push({ role: 'assistant', content: noSlotsMsg });
          chatHistory.set(stateKey, history.slice(-10));
          await sendBookingDatePrompt(chatId, noSlotsMsg, ctx.salonId, currentState.staffId, duration, botToken);
          return null;
        }

        // Собираем inline-кнопки: по 3 слота в ряд
        const keyboard: { text: string; callback_data: string }[][] = [];
        for (let i = 0; i < freeSlots.length; i += 3) {
          keyboard.push(
            freeSlots.slice(i, i + 3).map(slot => ({ text: slot, callback_data: `time:${slot}` }))
          );
        }

        const busyMsg = `К сожалению, это время уже занято. Доступное время на ${currentState.date}:`;
        history.push({ role: 'assistant', content: busyMsg });
        chatHistory.set(stateKey, history.slice(-10));

        // Отправляем с кнопками — polling не должен отправлять ещё раз
        await sendTelegramMessageWithKeyboard(chatId, busyMsg, keyboard, botToken);
        return null;
      }

      // Слот свободен — сохраняем время, сразу спрашиваем имя (без OpenRouter)
      bookingState.set(stateKey, { ...currentState, step: 'name', time: text });
      const nameQuestion = "Отлично, записываю. Подскажите, как вас зовут?";
      history.push({ role: 'assistant', content: nameQuestion });
      chatHistory.set(stateKey, history.slice(-10));
      return nameQuestion;

    } else if (currentState.step === 'name') {
      if (/^\d{1,2}:\d{2}$/.test(text.trim())) {
        const nameQuestion = 'Отлично, записываю. Подскажите, как вас зовут?';
        history.push({ role: 'assistant', content: nameQuestion });
        chatHistory.set(stateKey, history.slice(-10));
        return nameQuestion;
      }
      // Сохраняем имя, сразу спрашиваем телефон (без OpenRouter)
      bookingState.set(stateKey, { ...currentState, step: 'phone', name: text });
      const phoneQuestion = "И оставьте, пожалуйста, номер телефона для связи.";
      history.push({ role: 'assistant', content: phoneQuestion });
      chatHistory.set(stateKey, history.slice(-10));
      return phoneQuestion;

    } else if (currentState.step === 'phone') {
      const finalState = { ...currentState, phone: text };
      bookingState.set(stateKey, finalState);

      const { service, date, time, name, phone } = finalState;

      // 1. Сразу говорим клиенту что обрабатываем
      await sendTelegramMessage(chatId, "Секунду, проверяю и записываю вас... 🗓", botToken);

      // 2. Найти или создать клиента
      const { data: existingClient, error: lookupError } = await (supabase as any)
        .from("clients").select("id, is_blocked").eq("phone", phone).eq("salon_id", ctx.salonId).maybeSingle();

      if (lookupError) {
        console.error("Client lookup error:", lookupError);
        bookingState.delete(stateKey); chatHistory.delete(stateKey);
        return "Произошла ошибка при поиске клиента. Попробуйте ещё раз.";
      }

      if (existingClient?.is_blocked) {
        bookingState.delete(stateKey);
        chatHistory.delete(stateKey);
        await sendTelegramMessage(chatId, BLOCKED_CLIENT_BOOKING_MESSAGE, botToken);
        await notifySalonAdmin(
          ctx,
          `⚠️ Заблокированный клиент пытался записаться онлайн\n\n👤 ${name}\n📞 ${phone}\n💇 ${service}\n📅 ${date} ${time}`
        );
        return null;
      }

      let clientId: string;
      let isNewClient = false;
      if (existingClient) {
        clientId = existingClient.id;
      } else {
        const { data: newClient, error: insertClientError } = await (supabase as any)
          .from("clients").insert({ salon_id: ctx.salonId, name, phone, email: "" }).select("id").single();
        if (insertClientError || !newClient) {
          console.error("Client insert error:", insertClientError);
          bookingState.delete(stateKey); chatHistory.delete(stateKey);
          return "Не удалось сохранить данные клиента. Попробуйте ещё раз.";
        }
        clientId = newClient.id;
        isNewClient = true;
      }

      // 3. Получить услугу и мастера из каталога салона
      const serviceRow = await resolveServiceByName(ctx.salonId, service);
      if (!serviceRow) {
        console.error('Service lookup error: no active services in catalog');
        bookingState.delete(stateKey); chatHistory.delete(stateKey);
        return "В салоне пока нет услуг. Добавьте услуги в панели администратора и попробуйте снова.";
      }

      const staffRow = finalState.staffId
        ? await getActiveStaffById(ctx.salonId, finalState.staffId)
        : null;
      if (!staffRow) {
        console.error('Staff lookup error: no staff assigned for booking');
        bookingState.delete(stateKey); chatHistory.delete(stateKey);
        return STAFF_UNAVAILABLE_MESSAGE;
      }

      const appointmentDate = await parseAppointmentDateForSalon(ctx.salonId, date);
      const appointmentTime = parseAppointmentTime(time);
      const endTime = computeAppointmentEndTime(appointmentTime, serviceRow.duration);

      // Final race/stale guard: duration-aware membership before INSERT.
      const duration = serviceRow.duration > 0 ? serviceRow.duration : 60;
      const freeSlots = await getAvailableSlots(
        ctx.salonId,
        appointmentDate,
        staffRow.id,
        undefined,
        duration
      );
      if (!freeSlots.includes(appointmentTime)) {
        bookingState.set(stateKey, { ...finalState, step: 'time', time: '' });
        if (freeSlots.length === 0) {
          bookingState.set(stateKey, { ...finalState, step: 'date', date: '', time: '' });
          const noSlotsMsg = `К сожалению, это время уже занято, и на ${date} у мастера больше нет свободных слотов. Выберите другой день.`;
          history.push({ role: 'assistant', content: noSlotsMsg });
          chatHistory.set(stateKey, history.slice(-10));
          await sendBookingDatePrompt(chatId, noSlotsMsg, ctx.salonId, staffRow.id, duration, botToken);
          return null;
        }
        const keyboard: { text: string; callback_data: string }[][] = [];
        for (let i = 0; i < freeSlots.length; i += 3) {
          keyboard.push(
            freeSlots.slice(i, i + 3).map((slot) => ({ text: slot, callback_data: `time:${slot}` }))
          );
        }
        const busyMsg = `К сожалению, это время уже занято. Доступное время на ${date}:`;
        await sendTelegramMessageWithKeyboard(chatId, busyMsg, keyboard, botToken);
        return null;
      }

      // 5. INSERT appointment
      const { data: appointment, error: appointmentError } = await (supabase as any)
        .from("appointments")
        .insert({
          salon_id: ctx.salonId,
          client_id: clientId,
          service_id: serviceRow.id,
          staff_id: staffRow.id,
          date: appointmentDate,
          start_time: `${appointmentTime}:00`,
          end_time: endTime,
          status: 'scheduled',
          reminder_sent: false,
          notes: `Источник: Telegram\nКлиент: ${name}\nТелефон: ${phone}\nУслуга: ${serviceRow.name}\nДата: ${date}\nВремя: ${time}`
        })
        .select("id").single();

      if (appointmentError || !appointment) {
        console.error("Appointment insert error:", appointmentError);
        bookingState.delete(stateKey); chatHistory.delete(stateKey);
        return "Не удалось создать запись. Попробуйте ещё раз или обратитесь к администратору.";
      }

      await (supabase as any).from('reminders').insert({
        salon_id: ctx.salonId,
        appointment_id: appointment.id,
        type: 'email',
        scheduled_for: `${appointmentDate}T08:00:00`,
        status: 'pending',
        message: `Reminder: Your appointment on ${appointmentDate} at ${appointmentTime}`,
      });

      // 6. Подтверждение клиенту (живым текстом, без служебных данных)
      await sendTelegramMessage(
        chatId,
        `Готово, ${name}! Записала вас на ${serviceRow.name} — ${formatDateForUser(date)} в ${time} ✨\nБудем ждать вас!`,
        botToken
      );

      // 7. Уведомление мастеру/администратору
      await notifySalonAdmin(
        ctx,
        `🔔 Новая запись!\n\n💇 Услуга: ${serviceRow.name}\n📅 День: ${date}\n🕒 Время: ${time}\n👤 Клиент: ${name}\n📞 Телефон: ${phone}`
      );

      bookingState.delete(stateKey);
      chatHistory.delete(stateKey);

      if (isNewClient) {
        birthdayState.set(stateKey, { clientId, invalidAttempts: 0 });
        await sendTelegramMessageWithKeyboard(chatId, BIRTHDAY_PROMPT_MESSAGE, getBirthdaySkipKeyboard(), botToken);
      }

      return null; // OpenRouter не вызывается — всё уже отправлено
    }
  }
  // --- конец шаг-машины ---

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3001',
      'X-Title': 'AI Salon Admin',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Ты AI-администратор салона красоты.

Твоя задача — записать клиента.

Нужно собрать строго в таком порядке:
1. услугу
2. день
3. время
4. имя
5. телефон

Правила:

- Первое сообщение всегда:
"Здравствуйте! На какую услугу вы хотите записаться?"

- После получения услуги спроси:
"На какой день вы хотите записаться?"

- После получения дня спроси:
"На какое время вам удобно записаться?"

- После получения времени спроси имя. Например: "Отлично, записываю. Подскажите, как вас зовут?"

- После получения имени спроси телефон. Например: "И оставьте, пожалуйста, номер телефона для связи."

- После получения телефона НЕ пиши ничего — система сама обработает запись и ответит клиенту.

Очень важно:
- Никогда не повторяй один и тот же вопрос два раза подряд.
- Никогда не спрашивай информацию, которую клиент уже сообщил.
- Не используй фразы "Отличный выбор", "Замечательно", "Прекрасно" перед каждым вопросом.
- Пиши естественно, как живой администратор салона.
- Отвечай коротко и грамотно.
- Пиши на языке клиента.
- НИКОГДА не используй слова "подтверждена", "оформлена", "ждем вас", "ждём вас".`
        },
        ...history
      ]
    })
  });

  const data = await response.json();

  console.log(JSON.stringify(data, null, 2));

  const answer =
  data.choices?.[0]?.message?.content ||
  'Здравствуйте! Чем могу помочь?';

history.push({
  role: 'assistant',
  content: answer
});

chatHistory.set(stateKey, history.slice(-10));

  // Инициализировать step-машину и клавиатуру услуг, когда AI спрашивает услугу
  const existingBooking = bookingState.get(stateKey);
  if (
    existingBooking?.step === 'service' ||
    (!bookingState.has(stateKey) && isServiceSelectionPrompt(answer))
  ) {
    if (!existingBooking) {
      bookingState.set(stateKey, {
        step: 'service',
        service: '',
        staffId: '',
        date: '',
        time: '',
        name: '',
        phone: '',
      });
    }
    const serviceKeyboard = await buildServiceKeyboard(ctx.salonId);
    await sendTelegramMessageWithKeyboard(chatId, answer, serviceKeyboard, botToken);
    return null;
  }

  // Fallback: date keyboard after staff→date via OpenRouter (service→date handled in step machine)
  const currentStepAfterAI = bookingState.get(stateKey)?.step;
  if (currentStepAfterAI === 'date') {
    const stateForDate = bookingState.get(stateKey)!;
    if (!stateForDate.staffId?.trim()) {
      bookingState.delete(stateKey);
      await sendTelegramMessage(chatId, STAFF_UNAVAILABLE_MESSAGE, botToken);
      return null;
    }
    const duration = await resolveBookingDurationMinutes(ctx.salonId, stateForDate.service);
    await sendBookingDatePrompt(chatId, answer, ctx.salonId, stateForDate.staffId, duration, botToken);
    return null;
  }

  // Fallback: time keyboard after staff→date path via OpenRouter (date→time handled in step machine)
  if (currentStepAfterAI === 'time') {
    const stateForTime = bookingState.get(stateKey)!;
    if (!stateForTime.staffId?.trim()) {
      bookingState.delete(stateKey);
      await sendTelegramMessage(chatId, STAFF_UNAVAILABLE_MESSAGE, botToken);
      return null;
    }
    console.log(`[timeKeyboard] stateForTime.date: "${stateForTime.date}"`);
    const parsedDate = await parseAppointmentDateForSalon(ctx.salonId, stateForTime.date);
    console.log(`[timeKeyboard] parsedDate passed to getAvailableSlots: "${parsedDate}"`);
    const duration = await resolveBookingDurationMinutes(ctx.salonId, stateForTime.service);
    const freeSlots = await getAvailableSlots(ctx.salonId, parsedDate, stateForTime.staffId, undefined, duration);

    if (freeSlots.length === 0) {
      // Нет слотов — возвращаем на выбор даты
      bookingState.set(stateKey, { ...stateForTime, step: 'date', date: '' });
      const noSlotsMsg = `К сожалению, на выбранную дату нет свободного времени. Выберите другой день:`;
      await sendBookingDatePrompt(chatId, noSlotsMsg, ctx.salonId, stateForTime.staffId, duration, botToken);
      return null;
    }

    const timeKeyboard: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < freeSlots.length; i += 3) {
      timeKeyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `time:${s}` })));
    }
    await sendTelegramMessageWithKeyboard(chatId, answer, timeKeyboard, botToken);
    return null;
  }

return answer;
}

app.get('/api/health', async (_req, res) => {
  const dbConnected = await checkSupabaseConnection();
  res.json({
    status: dbConnected ? 'ok' : 'degraded',
    name: 'AI Salon Admin API',
    database: dbConnected ? 'connected' : 'disconnected',
  });
});
app.get('/api/telegram/status', async (_req, res) => {
  let token = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    token = (await loadTelegramTokenFromDb()) ?? undefined;
    if (token) process.env.TELEGRAM_BOT_TOKEN = token;
  }

  if (!token) {
    return res.status(400).json({
      connected: false,
      error: 'Telegram token not configured'
    });
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getMe`
    );

    const data = await response.json();

    if (data.ok) {
      return res.json({
        connected: true,
        bot: data.result.username,
        name: data.result.first_name
      });
    }

    return res.json({
      connected: false
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: 'Telegram API error'
    });
  }
});

// POST /api/integrations/telegram/connect
// Принимает { token }, проверяет через getMe, перезапускает polling.
// Токен хранится только в process.env (runtime, до перезапуска сервера).
app.post('/api/integrations/telegram/connect', async (req, res) => {
  const { token } = req.body as { token?: string };

  if (!token || typeof token !== 'string' || token.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  const trimmedToken = token.trim();

  // Логируем только маску токена — никогда не полный
  const masked = `${trimmedToken.slice(0, 4)}${'*'.repeat(Math.max(0, trimmedToken.length - 8))}${trimmedToken.slice(-4)}`;
  console.log(`[telegram/connect] Validating token: ${masked}`);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${trimmedToken}/getMe`);
    const tgData = await tgRes.json() as { ok: boolean; result?: { username: string; first_name: string } };

    if (!tgData.ok || !tgData.result) {
      return res.status(400).json({ success: false, error: 'Invalid Telegram token. Check it in @BotFather.' });
    }

    const { username, first_name } = tgData.result;

    // Обновляем токен в runtime process.env
    process.env.TELEGRAM_BOT_TOKEN = trimmedToken;

    const saved = await saveTelegramTokenToDb(trimmedToken, username, first_name);
    if (!saved) {
      console.warn('[telegram/connect] Token validated but could not persist to database');
    }

    restartTelegramPolling();

    console.log(`[telegram/connect] Connected: @${username} (${first_name})`);

    return res.json({ success: true, username, name: first_name });
  } catch (err) {
    console.error('[telegram/connect] Error:', err);
    return res.status(500).json({ success: false, error: 'Could not reach Telegram API' });
  }
});

app.use('/api/auth', authRouter);

const API_AUTH_REQUIRED = process.env.API_AUTH_REQUIRED === 'true';
const noopAuth: RequestHandler = (_req, _res, next) => next();
const salonAuth = API_AUTH_REQUIRED ? requireSalonAuth : noopAuth;
const developerAuth = API_AUTH_REQUIRED ? requireDeveloperAuth : noopAuth;

app.use('/api/clients', salonAuth, clientsRouter);
app.use('/api/services', salonAuth, servicesRouter);
app.use('/api/staff', salonAuth, staffRouter);
app.use('/api/appointments', salonAuth, appointmentsRouter);
app.use('/api/stats', salonAuth, statsRouter);
app.use('/api/schedule', salonAuth, scheduleRouter);
app.use('/api/developer', developerAuth, developerRouter);

function resolveClientDist(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '../client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

const clientDist = resolveClientDist();
if (clientDist) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`Serving client from ${clientDist}`);
}

async function bootstrap() {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    const dbToken = await loadTelegramTokenFromDb();
    if (dbToken) {
      process.env.TELEGRAM_BOT_TOKEN = dbToken;
      console.log('[telegram] Token loaded from database');
    }
  }

  app.listen(PORT, () => {
    console.log(`AI Salon Admin running on http://localhost:${PORT}`);
    console.log(`Supabase: ${process.env.SUPABASE_URL ?? 'NOT CONFIGURED'}`);
    if (isMultiTelegramEnabled()) {
      console.log('[telegram] MULTI_TELEGRAM_ENABLED=true — starting bot manager');
      void telegramBotManager.startAll(async (runtimeCtx, update) => {
        await processTelegramUpdate(update, {
          salonId: runtimeCtx.salonId,
          salonSlug: runtimeCtx.salonSlug,
          botToken: runtimeCtx.botToken,
          botUsername: runtimeCtx.botUsername,
        });
      });
    } else {
      startTelegramPolling();
    }
  });
}

function resolveTelegramBotToken(ctx: TelegramSalonContext): string | undefined {
  return ctx.botToken?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
}

/** /start or /start@BotUsername, optional payload (case-insensitive). */
const TELEGRAM_START_COMMAND_RE = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;

function isTelegramStartCommand(text: string): boolean {
  return TELEGRAM_START_COMMAND_RE.test(text.trim());
}

/**
 * Persist a temporary admin-chat candidate from /start.
 * Never writes admin_chat_id — developer must confirm explicitly.
 * Failures are logged and swallowed so booking flow continues.
 */
async function captureAdminChatCandidate(
  ctx: TelegramSalonContext,
  chatId: number
): Promise<void> {
  try {
    const { error } = await (supabase as any)
      .from('salon_integrations')
      .update({
        admin_chat_candidate_id: chatId,
        admin_chat_candidate_at: new Date().toISOString(),
      })
      .eq('salon_id', ctx.salonId)
      .eq('provider', 'telegram');

    if (error) {
      console.warn(
        `[admin candidate] salonId=${ctx.salonId} capture failed:`,
        error.message ?? 'unknown error'
      );
      return;
    }

    console.log(`[admin candidate] salonId=${ctx.salonId} captured`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown error';
    console.warn(`[admin candidate] salonId=${ctx.salonId} capture failed:`, errMsg);
  }
}

async function notifySalonAdmin(ctx: TelegramSalonContext, message: string): Promise<void> {
  let salonAdminChatId: number | null = null;

  try {
    const { data, error } = await (supabase as any)
      .from('salon_integrations')
      .select('admin_chat_id')
      .eq('salon_id', ctx.salonId)
      .eq('provider', 'telegram')
      .maybeSingle();

    if (error) {
      console.warn(
        `[admin notify] salonId=${ctx.salonId} query failed:`,
        error.message ?? 'unknown error'
      );
    } else if (data?.admin_chat_id != null) {
      salonAdminChatId = Number(data.admin_chat_id);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown error';
    console.warn(`[admin notify] salonId=${ctx.salonId} query failed:`, errMsg);
  }

  if (salonAdminChatId != null && !Number.isNaN(salonAdminChatId)) {
    await sendTelegramMessage(salonAdminChatId, message, ctx.botToken);
    console.log(`[admin notify] salonId=${ctx.salonId} target=salon`);
    return;
  }

  const envChatId = process.env.TELEGRAM_CHAT_ID;
  if (envChatId) {
    await sendTelegramMessage(Number(envChatId), message);
    console.log(`[admin notify] salonId=${ctx.salonId} target=env`);
    return;
  }

  console.warn(`[admin notify] salonId=${ctx.salonId} target=none`);
}

async function sendTelegramMessage(chatId: number, text: string, botToken?: string) {
  const token = botToken?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

async function sendTelegramMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: { text: string; callback_data: string }[][],
  botToken?: string
) {
  const token = botToken?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: keyboard }
    })
  });
  const data = (await response.json()) as { ok?: boolean; description?: string };
  if (!data.ok) {
    console.error('[telegram/sendKeyboard] failed:', data.description ?? `HTTP ${response.status}`);
  }
}

async function answerCallbackQuery(callbackQueryId: string, botToken?: string) {
  const token = botToken?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}

async function getAppointmentStaffId(salonId: string, appointmentId: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from('appointments')
    .select('staff_id')
    .eq('id', appointmentId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    console.error('[slots] staff lookup error:', JSON.stringify(error));
    return null;
  }

  const staffId = (data?.staff_id as string | undefined)?.trim();
  return staffId || null;
}

async function getAvailableSlots(
  salonId: string,
  date: string,
  staffId: string,
  excludeAppointmentId?: string,
  durationMinutes?: number
): Promise<string[]> {
  const duration =
    typeof durationMinutes === 'number' && durationMinutes > 0 ? durationMinutes : 60;

  console.log(`[slots] date: "${date}"`);
  console.log(`[slots] staffId: "${staffId}"`);
  console.log(`[slots] durationMinutes: ${duration}`);
  console.log(`[slots] excludeAppointmentId: "${excludeAppointmentId ?? 'none'}"`);

  if (!staffId.trim()) {
    console.warn('[slots] missing staffId — returning no slots');
    return [];
  }

  const freeSlots = await computeAvailableSlots({
    salonId,
    staffId,
    date,
    durationMinutes: duration,
    excludeAppointmentId,
  });
  console.log('[slots] freeSlots:', JSON.stringify(freeSlots));
  return freeSlots;
}
app.get('/api/telegram/test', async (_req, res) => {
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!chatId) {
    return res.status(400).json({
      error: 'Chat ID not configured'
    });
  }

  await sendTelegramMessage(
    Number(chatId),
    '🎉 AI Admin подключен к Telegram!'
  );

  res.json({
    success: true
  });
});
let telegramOffset = 0;
let isPolling = false; // предотвращает параллельные тики setInterval
let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

/** Останавливает текущий polling и запускает новый с токеном из process.env */
function restartTelegramPolling() {
  if (isMultiTelegramEnabled()) {
    void telegramBotManager.restartAll();
    return;
  }

  if (pollingIntervalId !== null) {
    clearInterval(pollingIntervalId);
    pollingIntervalId = null;
    isPolling = false;
    console.log('[polling] Previous polling stopped');
  }
  startTelegramPolling();
}

registerTelegramPollingRestarter(restartTelegramPolling);

async function processTelegramUpdate(update: any, ctx: TelegramSalonContext): Promise<void> {
        const botToken = resolveTelegramBotToken(ctx);
        // Нажатие на inline-кнопку (услуга / дата / время)
        if (update.callback_query) {
          const cq = update.callback_query;
          const cqChatId: number = cq.message?.chat?.id;
          const cqData: string = cq.data ?? '';

          await answerCallbackQuery(cq.id, botToken);

          if (!cqChatId) { return; }

          const cqStateKey = getTelegramStateKey(ctx.salonId, cqChatId);
          const tgSalonId = ctx.salonId;

          // --- Отмена записи ---
          if (cqData.startsWith('cancel_confirm:')) {
            const appointmentId = cqData.slice('cancel_confirm:'.length);
            const { data: apptInfo } = await (supabase as any)
              .from('appointments').select('date, start_time, notes').eq('id', appointmentId).eq('salon_id', tgSalonId).maybeSingle();
            const { error } = await (supabase as any)
              .from('appointments')
              .update({ status: 'cancelled' })
              .eq('id', appointmentId)
              .eq('salon_id', tgSalonId);
            if (error) {
              await sendTelegramMessage(cqChatId, 'Не удалось отменить запись. Попробуйте ещё раз.', botToken);
            } else {
              await (supabase as any)
                .from('reminders')
                .update({ status: 'failed', message: 'Cancelled — appointment was cancelled' })
                .eq('salon_id', tgSalonId)
                .eq('appointment_id', appointmentId)
                .eq('status', 'pending');
              manageState.delete(cqStateKey);
              await sendTelegramMessage(cqChatId, 'Запись отменена. Будем рады видеть вас снова! 🌸', botToken);
              const info = apptInfo ? formatAppointmentForUser(apptInfo) : `ID: ${appointmentId}`;
              await notifySalonAdmin(ctx, `❌ Клиент отменил запись.\n${info}`);
            }
            return;
          }

          if (cqData === 'cancel_keep') {
            manageState.delete(cqStateKey);
            await sendTelegramMessage(cqChatId, 'Хорошо, запись оставлена. Будем ждать вас! 🌸', botToken);
            return;
          }

          if (cqData.startsWith('select_cancel:')) {
            const appointmentId = cqData.slice('select_cancel:'.length);
            const { data: appt } = await (supabase as any)
              .from('appointments').select('id, date, start_time, notes').eq('id', appointmentId).eq('salon_id', tgSalonId).maybeSingle();
            const apptText = appt ? formatAppointmentForUser(appt) : `Запись ${appointmentId}`;
            const keyboard = [[
              { text: '✅ Да, отменить', callback_data: `cancel_confirm:${appointmentId}` },
              { text: '❌ Нет, оставить', callback_data: 'cancel_keep' }
            ]];
            await sendTelegramMessageWithKeyboard(cqChatId, `${apptText}\n\nОтменить эту запись?`, keyboard, botToken);
            return;
          }

          // --- Перенос записи ---
          if (cqData.startsWith('select_reschedule:')) {
            const appointmentId = cqData.slice('select_reschedule:'.length);
            const cur = manageState.get(cqStateKey);
            if (cur) manageState.set(cqStateKey, { ...cur, step: 'select_new_date', appointmentId });
            const { data: appt } = await (supabase as any)
              .from('appointments').select('id, date, start_time, notes').eq('id', appointmentId).eq('salon_id', tgSalonId).maybeSingle();
            const apptText = appt ? formatAppointmentForUser(appt) : `Запись ${appointmentId}`;
            const rescheduleStaffId = await getAppointmentStaffId(ctx.salonId, appointmentId);
            const rescheduleDuration = await resolveAppointmentDurationMinutes(ctx.salonId, appointmentId);
            const rescheduleKb = rescheduleStaffId
              ? await getRescheduleDateKeyboard(ctx.salonId, appointmentId, rescheduleStaffId, rescheduleDuration)
              : [[{ text: '✍️ Ввести дату', callback_data: `rdate_manual:${appointmentId}` }]];
            await sendTelegramMessageWithKeyboard(cqChatId, `${apptText}\n\nВыберите новую дату:`, rescheduleKb, botToken);
            return;
          }

          if (cqData.startsWith('rdate_manual:')) {
            // Пользователь хочет ввести дату вручную — не меняем шаг, ждём текст
            await sendTelegramMessage(cqChatId, 'Напишите дату (например: «завтра», «30 июня»).', botToken);
            return;
          }

          if (cqData.startsWith('rdate:')) {
            // rdate:<appointmentId>:<YYYY-MM-DD>
            // lastIndexOf(':') надёжнее split потому что UUID содержит дефисы, но не двоеточия
            const lastColon = cqData.lastIndexOf(':');
            const dateStr = cqData.slice(lastColon + 1);           // '2026-06-30'
            const appointmentId = cqData.slice('rdate:'.length, lastColon); // UUID
            const newDate = await parseAppointmentDateForSalon(ctx.salonId, dateStr);
            console.log(`[rdate] appointmentId="${appointmentId}" dateStr="${dateStr}" parsedDate="${newDate}"`);
            const cur = manageState.get(cqStateKey);
            if (cur) manageState.set(cqStateKey, { ...cur, step: 'select_new_time', appointmentId, newDate });
            const staffId = await getAppointmentStaffId(ctx.salonId, appointmentId);
            if (!staffId) {
              await sendTelegramMessage(cqChatId, 'Не удалось определить мастера для этой записи. Обратитесь к администратору.', botToken);
              return;
            }
            // Исключаем саму переносимую запись, чтобы её слот не блокировался у этого мастера
            const rescheduleDuration = await resolveAppointmentDurationMinutes(ctx.salonId, appointmentId);
            const freeSlots = await getAvailableSlots(ctx.salonId, newDate, staffId, appointmentId, rescheduleDuration);
            if (freeSlots.length === 0) {
              await sendTelegramMessageWithKeyboard(
                cqChatId,
                'На эту дату нет свободного времени. Выберите другой день:',
                await getRescheduleDateKeyboard(ctx.salonId, appointmentId, staffId, rescheduleDuration),
                botToken
              );
            } else {
              const keyboard: { text: string; callback_data: string }[][] = [];
              for (let i = 0; i < freeSlots.length; i += 3) {
                keyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `rtime:${appointmentId}:${s}` })));
              }
              await sendTelegramMessageWithKeyboard(cqChatId, 'Выберите новое время:', keyboard, botToken);
            }
            return;
          }

          if (cqData.startsWith('rtime:')) {
            // rtime:<appointmentId>:<HH>:<MM>  — время HH:MM имеет двоеточие
            const parts = cqData.split(':');
            const appointmentId = parts[1];
            const newTime = `${parts[2]}:${parts[3]}`; // 'HH:MM'
            const cur = manageState.get(cqStateKey);
            const newDate = cur?.newDate;
            if (!newDate) {
              await sendTelegramMessage(cqChatId, 'Ошибка: дата не найдена. Начните перенос заново.', botToken);
              manageState.delete(cqStateKey);
              return;
            }
            const parsedTime = parseAppointmentTime(newTime);
            const staffId = await getAppointmentStaffId(ctx.salonId, appointmentId);
            if (!staffId) {
              await sendTelegramMessage(cqChatId, 'Не удалось определить мастера для этой записи. Обратитесь к администратору.', botToken);
              return;
            }
            // Authoritative duration-aware check before UPDATE (exclude current appointment).
            const rescheduleDuration = await resolveAppointmentDurationMinutes(ctx.salonId, appointmentId);
            const freeSlots = await getAvailableSlots(
              ctx.salonId,
              newDate,
              staffId,
              appointmentId,
              rescheduleDuration
            );
            if (!freeSlots.includes(parsedTime)) {
              if (freeSlots.length === 0) {
                await sendTelegramMessageWithKeyboard(
                  cqChatId,
                  'Это время занято, и других свободных слотов на эту дату нет. Выберите другой день:',
                  await getRescheduleDateKeyboard(ctx.salonId, appointmentId, staffId, rescheduleDuration),
                  botToken
                );
              } else {
                const keyboard: { text: string; callback_data: string }[][] = [];
                for (let i = 0; i < freeSlots.length; i += 3) {
                  keyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `rtime:${appointmentId}:${s}` })));
                }
                await sendTelegramMessageWithKeyboard(cqChatId, 'Это время уже занято. Выберите другое:', keyboard, botToken);
              }
              return;
            }
            const duration = rescheduleDuration;
            const newEndTime = computeAppointmentEndTime(parsedTime, duration);
            const { error } = await (supabase as any).from('appointments').update({
              date: newDate,
              start_time: `${parsedTime}:00`,
              end_time: newEndTime
            }).eq('id', appointmentId).eq('salon_id', tgSalonId);
            if (error) {
              await sendTelegramMessage(cqChatId, 'Не удалось перенести запись. Попробуйте ещё раз.', botToken);
            } else {
              await (supabase as any)
                .from('reminders')
                .update({
                  scheduled_for: `${newDate}T08:00:00`,
                  message: `Reminder: Your appointment on ${newDate} at ${newTime}`,
                })
                .eq('salon_id', tgSalonId)
                .eq('appointment_id', appointmentId)
                .eq('status', 'pending');
              manageState.delete(cqStateKey);
              const formattedDate = formatDateForUser(newDate);
              await sendTelegramMessage(cqChatId, `Готово! Запись перенесена на ${formattedDate} в ${newTime} ✨`, botToken);
              await notifySalonAdmin(
                ctx,
                `🔄 Перенос записи!\n📅 Новая дата: ${formattedDate}\n🕒 Новое время: ${newTime}`
              );
            }
            return;
          }

          // Кнопка "Ввести вручную" — просто подсказка, шаг-машину не трогаем
          if (cqData === 'service:manual') {
            await sendTelegramMessage(cqChatId, 'Напишите, какая услуга вас интересует.', botToken);
            return;
          }
          if (cqData === 'date:manual') {
            await sendTelegramMessage(cqChatId, 'Напишите дату в удобном формате — например: «сегодня», «завтра», «30 июня».', botToken);
            return;
          }

          if (cqData === 'birthday:skip') {
            if (birthdayState.has(cqStateKey)) {
              birthdayState.delete(cqStateKey);
              await sendTelegramMessage(cqChatId, BIRTHDAY_SKIPPED_MESSAGE, botToken);
            }
            return;
          }

          // service: / service_id: / date: / time: / staff: — шаг-машина
          if (
            cqData.startsWith('service_id:') ||
            cqData.startsWith('service:') ||
            cqData.startsWith('date:') ||
            cqData.startsWith('time:') ||
            cqData.startsWith('staff:')
          ) {
            const booking = bookingState.get(cqStateKey);
            const expectedStep =
              cqData.startsWith('service_id:') || cqData.startsWith('service:')
                ? 'service'
                : cqData.startsWith('date:')
                  ? 'date'
                  : cqData.startsWith('time:')
                    ? 'time'
                    : 'staff';
            if (!booking || booking.step !== expectedStep) {
              return;
            }

            let value: string;
            if (cqData.startsWith('service_id:')) {
              const serviceId = cqData.slice('service_id:'.length).trim();
              const resolved = await resolveServiceById(ctx.salonId, serviceId);
              if (!resolved) {
                await sendTelegramMessage(
                  cqChatId,
                  'Эта услуга недоступна. Выберите услугу из списка или напишите название.',
                  botToken
                );
                return;
              }
              value = resolved.name;
            } else if (cqData.startsWith('staff:')) {
              value = cqData.slice('staff:'.length);
            } else {
              value = cqData.slice(cqData.indexOf(':') + 1);
            }

            const answer = await generateAIResponse(ctx, cqChatId, value);
            if (answer !== null) {
              await sendTelegramMessage(cqChatId, answer, botToken);
            }
          }
          return;
        }

        // Обычное текстовое сообщение
        const message = update.message;
        const text = message?.text;
        const chatId = message?.chat?.id;

        if (!text || !chatId) return;

        // /start → candidate only (never admin_chat_id); then continue normal flow
        if (isTelegramStartCommand(text)) {
          await captureAdminChatCandidate(ctx, chatId);
        }

        const answer = await generateAIResponse(ctx, chatId, text);
        if (answer !== null) {
          await sendTelegramMessage(chatId, answer, botToken);
        }
}

async function startTelegramPolling() {
  if (pollingIntervalId !== null) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log('Telegram bot token not configured');
    return;
  }

  console.log('Telegram polling started');

  pollingIntervalId = setInterval(async () => {
    // Если предыдущий тик ещё выполняется — пропустить этот
    if (isPolling) return;
    isPolling = true;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${telegramOffset + 1}`
      );

      const data = await response.json();

      if (!data.ok) return;

      for (const update of data.result) {
        telegramOffset = update.update_id;
        await processTelegramUpdate(update, defaultTelegramSalonContext);
      }
    } catch (error) {
      console.error('Telegram polling error', error);
    } finally {
      isPolling = false; // освобождаем флаг в любом случае
    }
  }, 3000);
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});