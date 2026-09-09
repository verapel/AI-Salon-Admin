/**
 * Calendar-month period arithmetic in UTC.
 * Uses civil months (not a hardcoded 30-day length). Month-end days clamp
 * (e.g. 31 Jan → last day of February).
 */

export function addCalendarMonthUtc(start: Date): Date {
  if (Number.isNaN(start.getTime())) {
    throw new RangeError('Invalid date');
  }
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  const hours = start.getUTCHours();
  const minutes = start.getUTCMinutes();
  const seconds = start.getUTCSeconds();
  const ms = start.getUTCMilliseconds();

  const totalMonths = year * 12 + month + 1;
  const endYear = Math.floor(totalMonths / 12);
  const endMonth = totalMonths % 12;
  const lastDayOfEndMonth = new Date(Date.UTC(endYear, endMonth + 1, 0)).getUTCDate();
  const endDay = Math.min(day, lastDayOfEndMonth);

  return new Date(Date.UTC(endYear, endMonth, endDay, hours, minutes, seconds, ms));
}

export function computeMonthlyPeriod(now: Date = new Date()): {
  currentPeriodStart: string;
  currentPeriodEnd: string;
} {
  const start = new Date(now.getTime());
  const end = addCalendarMonthUtc(start);
  return {
    currentPeriodStart: start.toISOString(),
    currentPeriodEnd: end.toISOString(),
  };
}
