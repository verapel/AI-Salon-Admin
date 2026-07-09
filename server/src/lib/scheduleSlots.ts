/**
 * Schedule-aware slot engine (Stage J2a).
 * Not wired to Telegram yet — Telegram keeps hardcoded getAvailableSlots.
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/;

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

/**
 * Compute free HH:MM starts for a staff member on a date.
 * Safe Tatev fallback: no salon_weekly_hours rows → 08:00–18:00 list.
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
    // Match current Telegram list; duration>60 may drop late starts that cannot finish by 19:00.
    candidates = FALLBACK_SLOT_STARTS.filter((start) => {
      if (durationMinutes <= 60) return true;
      return timeToMinutes(start) + durationMinutes <= timeToMinutes(FALLBACK_DURATION_LIMIT);
    });
  } else if (!working) {
    return [];
  } else if (salonUnconfigured && staffUnconfigured) {
    // Exceptions may have applied custom hours; generate from window.
    candidates = generateStarts(working, durationMinutes);
  } else {
    candidates = generateStarts(working, durationMinutes);
  }

  const baseQ = (supabase as any)
    .from('appointments')
    .select('id, start_time, end_time')
    .eq('salon_id', salonId)
    .eq('date', date)
    .eq('staff_id', staffId)
    .in('status', ACTIVE_SLOT_STATUSES);

  const { data: booked, error: bookedError } = await (
    excludeAppointmentId ? baseQ.neq('id', excludeAppointmentId) : baseQ
  );

  if (bookedError) {
    console.error('[scheduleSlots] appointments load error:', bookedError.message);
    return [];
  }

  const busy: Array<{ start: number; end: number }> = (booked ?? []).map(
    (row: { start_time: string; end_time: string }) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    })
  );

  return candidates.filter((start) => {
    const cStart = timeToMinutes(start);
    const cEnd = cStart + durationMinutes;
    return !busy.some((b) => intervalsOverlap(cStart, cEnd, b.start, b.end));
  });
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
