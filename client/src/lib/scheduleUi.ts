import type {
  ScheduleException,
  ScheduleExceptionKind,
  WeeklyHoursInput,
  WeeklyHoursRow,
} from '@/types';

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface DayHoursEdit {
  weekday: Weekday;
  isClosed: boolean;
  openTime: string;
  closeTime: string;
}

export const DEFAULT_OPEN = '08:00';
export const DEFAULT_CLOSE = '18:00';

export function emptyWeekOpen(): DayHoursEdit[] {
  return WEEKDAYS.map((weekday) => ({
    weekday,
    isClosed: false,
    openTime: DEFAULT_OPEN,
    closeTime: DEFAULT_CLOSE,
  }));
}

/** Map API rows to a full Mon–Sun editor state. */
export function rowsToDayEdits(rows: WeeklyHoursRow[]): DayHoursEdit[] {
  if (rows.length === 0) return emptyWeekOpen();

  return WEEKDAYS.map((weekday) => {
    const row = rows.find((r) => r.weekday === weekday);
    if (!row) {
      return { weekday, isClosed: true, openTime: DEFAULT_OPEN, closeTime: DEFAULT_CLOSE };
    }
    return {
      weekday,
      isClosed: row.isClosed,
      openTime: row.openTime ?? DEFAULT_OPEN,
      closeTime: row.closeTime ?? DEFAULT_CLOSE,
    };
  });
}

export function dayEditsToPayload(days: DayHoursEdit[]): WeeklyHoursInput[] {
  return days.map((d) => ({
    weekday: d.weekday,
    isClosed: d.isClosed,
    openTime: d.isClosed ? null : d.openTime,
    closeTime: d.isClosed ? null : d.closeTime,
  }));
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

export function validateWeeklyHours(days: DayHoursEdit[]): string | null {
  for (const day of days) {
    if (day.isClosed) continue;
    if (!/^\d{2}:\d{2}$/.test(day.openTime) || !/^\d{2}:\d{2}$/.test(day.closeTime)) {
      return 'missingTimes';
    }
    if (timeToMinutes(day.closeTime) <= timeToMinutes(day.openTime)) {
      return 'closeAfterOpen';
    }
  }
  return null;
}

export function validateExceptionForm(input: {
  kind: ScheduleExceptionKind;
  startDate: string;
  endDate: string;
  openTime: string;
  closeTime: string;
}): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    return 'invalidDates';
  }
  if (input.endDate < input.startDate) return 'endBeforeStart';
  if (input.kind === 'custom_hours') {
    if (!/^\d{2}:\d{2}$/.test(input.openTime) || !/^\d{2}:\d{2}$/.test(input.closeTime)) {
      return 'missingTimes';
    }
    if (timeToMinutes(input.closeTime) <= timeToMinutes(input.openTime)) {
      return 'closeAfterOpen';
    }
  }
  return null;
}

export function formatExceptionRange(ex: ScheduleException): string {
  if (ex.startDate === ex.endDate) return ex.startDate;
  return `${ex.startDate} – ${ex.endDate}`;
}
