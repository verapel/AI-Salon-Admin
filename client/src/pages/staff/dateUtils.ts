/** Local calendar date as YYYY-MM-DD (no timezone shift). */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function addDaysIso(iso: string, delta: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return toIsoDate(d);
}

/** Parse local YYYY-MM-DD at noon to avoid DST edge shifts. */
export function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(iso + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Sunday-start week (matches owner Calendar). */
export function startOfWeekSunday(iso: string): string {
  const d = parseIsoDate(iso) ?? new Date();
  d.setDate(d.getDate() - d.getDay());
  return toIsoDate(d);
}

export function weekDaysFrom(weekStartIso: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysIso(weekStartIso, i));
}

/** "14:00" from "HH:MM:SS" or "HH:MM"; empty/invalid → "". */
export function formatTime24(time: string | null | undefined): string {
  if (!time || typeof time !== 'string') return '';
  const trimmed = time.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return '';
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Hour 0–23 from start time, or null if invalid. */
export function parseStartHour(time: string | null | undefined): number | null {
  const formatted = formatTime24(time);
  if (!formatted) return null;
  return Number(formatted.slice(0, 2));
}

/** Owner Calendar hours: 08:00–19:00 inclusive. */
export const STAFF_CALENDAR_HOURS = Array.from({ length: 12 }, (_, i) => i + 8);

export function clampToCalendarHour(hour: number): number {
  const min = STAFF_CALENDAR_HOURS[0];
  const max = STAFF_CALENDAR_HOURS[STAFF_CALENDAR_HOURS.length - 1];
  return Math.min(max, Math.max(min, hour));
}
