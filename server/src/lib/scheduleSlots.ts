/**
 * Schedule-aware slot engine (Stage J2a / J2c).
 * Telegram booking uses computeAvailableSlots via getAvailableSlots.
 * When no salon_weekly_hours rows exist, falls back to 08:00–18:00.
 */

import { supabase } from './supabase.js';

/** Same statuses as telegramBooking.ACTIVE_SLOT_STATUSES (avoid circular import). */
const ACTIVE_SLOT_STATUSES = ['scheduled', 'confirmed'] as const;

export const FALLBACK_SLOT_STARTS = [
  '08:00',
  '09:00',
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00',
  '18:00',
] as const;

const FALLBACK_OPEN = '08:00';
const FALLBACK_CLOSE = '18:00';
/** Soft end-of-day for fallback duration fit so duration=60 still allows 18:00. */
const FALLBACK_DURATION_LIMIT = '19:00';

/**
 * Project fallback when salon.timezone is missing/invalid.
 * Matches salons.timezone DB default (Europe/Moscow).
 */
export const FALLBACK_TIMEZONE = 'Europe/Moscow';

export const NO_AVAILABLE_DATES_MESSAGE =
  'К сожалению, в ближайшие 30 дней нет свободного времени для записи. Введите дату вручную или свяжитесь с салоном.';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/;

const MONTHS_RU = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

export interface ComputeAvailableSlotsParams {
  salonId: string;
  staffId: string;
  date: string;
  durationMinutes: number;
  excludeAppointmentId?: string;
}

interface TimeWindow {
  open: string;
  close: string;
}

type ExceptionKind = 'closed' | 'vacation' | 'holiday' | 'custom_hours';

interface ExceptionRow {
  scope: 'salon' | 'staff';
  staff_id: string | null;
  kind: ExceptionKind;
  open_time: string | null;
  close_time: string | null;
}

function normalizeTime(value: string): string {
  return value.slice(0, 5);
}

function timeToMinutes(value: string): number {
  const [h, m] = normalizeTime(value).split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** ISO weekday: 1 Monday … 7 Sunday (from YYYY-MM-DD, UTC calendar day). */
export function isoWeekdayFromDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export type BusyAppointmentRow = {
  start_time: string;
  end_time: string;
};

/**
 * Drop candidate starts that overlap any stored appointment interval.
 * Used by Telegram (and shared messengers) so source=google / owner / telegram
 * rows already on the AI Salon Admin calendar all occupy time.
 */
export function filterSlotsByBusyAppointments(
  candidates: readonly string[],
  durationMinutes: number,
  appointments: readonly BusyAppointmentRow[]
): string[] {
  const busy = appointments.map((row) => ({
    start: timeToMinutes(row.start_time),
    end: timeToMinutes(row.end_time),
  }));
  return candidates.filter((start) => {
    const cStart = timeToMinutes(start);
    const cEnd = cStart + durationMinutes;
    return !busy.some((b) => intervalsOverlap(cStart, cEnd, b.start, b.end));
  });
}

function intersectWindows(a: TimeWindow | null, b: TimeWindow | null): TimeWindow | null {
  if (!a || !b) return null;
  const open = Math.max(timeToMinutes(a.open), timeToMinutes(b.open));
  const close = Math.min(timeToMinutes(a.close), timeToMinutes(b.close));
  if (open >= close) return null;
  return { open: minutesToTime(open), close: minutesToTime(close) };
}

function windowFromWeeklyRow(row: {
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
} | null | undefined): TimeWindow | null {
  if (!row || row.is_closed) return null;
  if (!row.open_time || !row.close_time) return null;
  const open = normalizeTime(row.open_time);
  const close = normalizeTime(row.close_time);
  if (timeToMinutes(open) >= timeToMinutes(close)) return null;
  return { open, close };
}

function applyExceptionsToWindow(
  base: TimeWindow | null,
  exceptions: ExceptionRow[],
  scope: 'salon' | 'staff',
  staffId: string
): TimeWindow | null {
  const relevant = exceptions.filter((ex) => {
    if (ex.scope !== scope) return false;
    if (scope === 'staff' && ex.staff_id !== staffId) return false;
    return true;
  });

  for (const ex of relevant) {
    if (ex.kind === 'closed' || ex.kind === 'vacation' || ex.kind === 'holiday') {
      return null;
    }
  }

  const custom = relevant.filter((ex) => ex.kind === 'custom_hours');
  if (custom.length === 0) return base;

  const last = custom[custom.length - 1];
  if (!last.open_time || !last.close_time) return null;
  const open = normalizeTime(last.open_time);
  const close = normalizeTime(last.close_time);
  if (timeToMinutes(open) >= timeToMinutes(close)) return null;
  return { open, close };
}

function generateStarts(window: TimeWindow, durationMinutes: number, stepMinutes = 60): string[] {
  const openM = timeToMinutes(window.open);
  const closeM = timeToMinutes(window.close);
  const starts: string[] = [];
  for (let t = openM; t + durationMinutes <= closeM; t += stepMinutes) {
    starts.push(minutesToTime(t));
  }
  return starts;
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezone(raw: string | null | undefined): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed && isValidIanaTimeZone(trimmed)) return trimmed;
  return FALLBACK_TIMEZONE;
}

/** Load salon timezone; falls back to Europe/Moscow. */
export async function getSalonTimezone(salonId: string): Promise<string> {
  const { data, error } = await supabase
    .from('salons')
    .select('timezone')
    .eq('id', salonId)
    .maybeSingle();

  if (error) {
    console.error('[scheduleSlots] salon timezone load error:', error.message);
    return FALLBACK_TIMEZONE;
  }
  return resolveTimezone((data as { timezone?: string } | null)?.timezone);
}

/** YYYY-MM-DD for "now" (or offset days) in the given IANA timezone. */
export function dateStrInTimezone(timeZone: string, offsetDays = 0): string {
  const tz = resolveTimezone(timeZone);
  const now = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return addDaysToYmd(todayYmd, offsetDays);
}

export function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Current hour*60+minute in salon timezone. */
export function currentMinutesInTimezone(timeZone: string): number {
  const tz = resolveTimezone(timeZone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // en-GB may yield "24" for midnight in some engines — normalize
  const h = hour === 24 ? 0 : hour;
  return h * 60 + minute;
}

export function formatTelegramDateLabel(isoDate: string, timeZone: string): string {
  const today = dateStrInTimezone(timeZone, 0);
  const tomorrow = addDaysToYmd(today, 1);
  if (isoDate === today) return 'Сегодня';
  if (isoDate === tomorrow) return 'Завтра';
  const [, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS_RU[m - 1]}`;
}

function filterPastSlotsForToday(
  slots: string[],
  date: string,
  timeZone: string
): string[] {
  const today = dateStrInTimezone(timeZone, 0);
  if (date !== today) return slots;
  const nowM = currentMinutesInTimezone(timeZone);
  return slots.filter((start) => timeToMinutes(start) > nowM);
}

/**
 * Compute free HH:MM starts for a staff member on a date.
 * Safe Tatev fallback: no salon_weekly_hours rows → 08:00–18:00 list.
 * Past times on "today" are removed using salon timezone.
 */
export async function computeAvailableSlots(
  params: ComputeAvailableSlotsParams
): Promise<string[]> {
  const { salonId, staffId, date, durationMinutes, excludeAppointmentId } = params;

  if (!DATE_RE.test(date)) {
    console.warn('[scheduleSlots] invalid date:', date);
    return [];
  }
  if (!staffId.trim()) {
    console.warn('[scheduleSlots] missing staffId');
    return [];
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    console.warn('[scheduleSlots] invalid durationMinutes:', durationMinutes);
    return [];
  }

  const timeZone = await getSalonTimezone(salonId);
  const weekday = isoWeekdayFromDate(date);

  const { data: salonRows, error: salonErr } = await (supabase as any)
    .from('salon_weekly_hours')
    .select('weekday, is_closed, open_time, close_time')
    .eq('salon_id', salonId);

  if (salonErr) {
    console.error('[scheduleSlots] salon weekly load error:', salonErr.message);
    return [];
  }

  const salonWeekly = (salonRows ?? []) as Array<{
    weekday: number;
    is_closed: boolean;
    open_time: string | null;
    close_time: string | null;
  }>;
  const salonUnconfigured = salonWeekly.length === 0;

  let salonWindow: TimeWindow | null;
  if (salonUnconfigured) {
    salonWindow = { open: FALLBACK_OPEN, close: FALLBACK_CLOSE };
  } else {
    const dayRow = salonWeekly.find((r) => r.weekday === weekday);
    if (!dayRow) {
      salonWindow = null;
    } else {
      salonWindow = windowFromWeeklyRow(dayRow);
    }
  }

  const { data: staffRows, error: staffErr } = await (supabase as any)
    .from('staff_weekly_hours')
    .select('weekday, is_closed, open_time, close_time')
    .eq('salon_id', salonId)
    .eq('staff_id', staffId);

  if (staffErr) {
    console.error('[scheduleSlots] staff weekly load error:', staffErr.message);
    return [];
  }

  const staffWeekly = (staffRows ?? []) as Array<{
    weekday: number;
    is_closed: boolean;
    open_time: string | null;
    close_time: string | null;
  }>;
  const staffUnconfigured = staffWeekly.length === 0;

  let staffWindow: TimeWindow | null;
  if (staffUnconfigured) {
    staffWindow = salonWindow;
  } else {
    const dayRow = staffWeekly.find((r) => r.weekday === weekday);
    if (!dayRow) {
      staffWindow = null;
    } else {
      staffWindow = windowFromWeeklyRow(dayRow);
    }
  }

  const { data: exceptionRows, error: exErr } = await (supabase as any)
    .from('schedule_exceptions')
    .select('scope, staff_id, kind, open_time, close_time')
    .eq('salon_id', salonId)
    .lte('start_date', date)
    .gte('end_date', date);

  if (exErr) {
    console.error('[scheduleSlots] exceptions load error:', exErr.message);
    return [];
  }

  const exceptions = (exceptionRows ?? []) as ExceptionRow[];

  salonWindow = applyExceptionsToWindow(salonWindow, exceptions, 'salon', staffId);
  staffWindow = applyExceptionsToWindow(staffWindow, exceptions, 'staff', staffId);

  const working = intersectWindows(salonWindow, staffWindow);

  let candidates: string[];
  if (salonUnconfigured && staffUnconfigured && exceptions.length === 0) {
    // Match legacy Telegram list; duration>60 may drop late starts that cannot finish by 19:00.
    candidates = FALLBACK_SLOT_STARTS.filter((start) => {
      if (durationMinutes <= 60) return true;
      return timeToMinutes(start) + durationMinutes <= timeToMinutes(FALLBACK_DURATION_LIMIT);
    });
  } else if (!working) {
    return [];
  } else {
    candidates = generateStarts(working, durationMinutes);
  }

  // Salon-calendar busy set: every active appointment on this date.
  // Do not filter by staff_id or source — Google imports visible in Admin
  // must occupy Telegram slots the same way owner/telegram rows do.
  const baseQ = (supabase as any)
    .from('appointments')
    .select('id, start_time, end_time')
    .eq('salon_id', salonId)
    .eq('date', date)
    .in('status', ACTIVE_SLOT_STATUSES);

  const { data: booked, error: bookedError } = await (
    excludeAppointmentId ? baseQ.neq('id', excludeAppointmentId) : baseQ
  );

  if (bookedError) {
    console.error('[scheduleSlots] appointments load error:', bookedError.message);
    return [];
  }

  const free = filterSlotsByBusyAppointments(
    candidates,
    durationMinutes,
    (booked ?? []) as BusyAppointmentRow[]
  );

  return filterPastSlotsForToday(free, date, timeZone);
}

/**
 * Next open dates (with at least one free slot) from today in salon TZ.
 * Searches at most maxDays calendar days; returns up to count dates.
 */
export async function findNextAvailableDates(params: {
  salonId: string;
  staffId: string;
  durationMinutes: number;
  excludeAppointmentId?: string;
  count?: number;
  maxDays?: number;
}): Promise<string[]> {
  const {
    salonId,
    staffId,
    durationMinutes,
    excludeAppointmentId,
    count = 4,
    maxDays = 30,
  } = params;

  if (!staffId.trim()) return [];

  const timeZone = await getSalonTimezone(salonId);
  const today = dateStrInTimezone(timeZone, 0);
  const found: string[] = [];

  for (let i = 0; i < maxDays && found.length < count; i++) {
    const date = addDaysToYmd(today, i);
    const slots = await computeAvailableSlots({
      salonId,
      staffId,
      date,
      durationMinutes,
      excludeAppointmentId,
    });
    if (slots.length > 0) found.push(date);
  }

  return found;
}

/** Shared HH:MM validation for schedule API. */
export function isValidHhMm(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, m] = value.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTimeValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!TIME_RE.test(value)) return false;
  return isValidHhMm(normalizeTime(value));
}

export function timeOrderOk(openTime: string, closeTime: string): boolean {
  return timeToMinutes(openTime) < timeToMinutes(closeTime);
}
