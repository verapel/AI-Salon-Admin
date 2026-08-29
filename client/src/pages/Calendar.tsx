import { useEffect, useState, useMemo, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Modal from '@/components/ui/Modal';
import { useLanguage, type LangCode, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { getStatusColor } from '@/lib/utils';
import {
  DESKTOP_HOUR_HEIGHT_PX,
  MOBILE_DAY_HEADER_HEIGHT_PX,
  MOBILE_HOUR_HEIGHT_PX,
  TIMED_EVENTS_LAYER_OFFSET_PX,
  WEEK_DAY_HEADER_HEIGHT_PX,
  isNowWithinHours,
  layoutDayEvents,
  nowLineOffset,
} from '@/lib/calendarLayout';
import type { Appointment, GoogleReviewCalendarItem, Staff } from '@/types';

type CalendarBlock = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  staffId: string;
  staffName?: string;
  title: string;
  subtitle?: string;
  kind: 'appointment' | 'google_review';
  status?: Appointment['status'];
  clientBirthday?: string | null;
  review?: GoogleReviewCalendarItem;
};

function appointmentToBlock(apt: Appointment): CalendarBlock {
  return {
    id: apt.id,
    date: apt.date,
    startTime: apt.startTime,
    endTime: apt.endTime,
    staffId: apt.staffId,
    staffName: apt.staffName,
    title: apt.clientName || '—',
    subtitle: apt.serviceName,
    kind: 'appointment',
    status: apt.status,
    clientBirthday: apt.clientBirthday,
  };
}

function reviewToBlock(ev: GoogleReviewCalendarItem): CalendarBlock {
  return {
    id: ev.id,
    date: ev.date,
    startTime: ev.startTime,
    endTime: ev.endTime,
    staffId: ev.staffId,
    staffName: ev.staffName,
    title: ev.title,
    subtitle: undefined,
    kind: 'google_review',
    review: ev,
  };
}

const LOCALE: Record<LangCode, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  hy: 'hy-AM',
};

/** Local YYYY-MM-DD — avoids UTC shift from toISOString() */
const toLocalDateStr = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** "14:00" — 24-hour format from "HH:MM:SS" or "HH:MM" */
const formatTime24 = (time: string) => time.slice(0, 5);

const DEFAULT_HOUR_START = 8;
const DEFAULT_HOUR_END = 19;

/** Default 08–19, expanded so early/late timed Google (or salon) blocks stay visible. */
function hoursForVisibleDays(
  blocks: Array<{ date: string; startTime: string; endTime?: string }>,
  days: Date[],
): number[] {
  const daySet = new Set(days.map(toLocalDateStr));
  let min = DEFAULT_HOUR_START;
  let max = DEFAULT_HOUR_END;
  for (const block of blocks) {
    if (!daySet.has(block.date)) continue;
    const startHour = parseInt(block.startTime.split(':')[0], 10);
    const endHour = parseInt((block.endTime || block.startTime).split(':')[0], 10);
    if (Number.isFinite(startHour) && startHour < min) min = startHour;
    if (Number.isFinite(endHour) && endHour > max) max = endHour;
  }
  min = Math.max(0, min);
  max = Math.min(23, max);
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/** Shared desktop week grid: fixed time column + 7 equal day columns */
const WEEK_GRID_CLASS = 'grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))]';

type MobileCalendarView = 'today' | 'week' | 'month';

function startOfWeekSunday(anchor: Date): Date {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function weekDaysFrom(anchor: Date): Date[] {
  const start = startOfWeekSunday(anchor);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function monthGridFrom(anchor: Date): (Date | null)[] {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const days = new Date(y, m + 1, 0).getDate();
  const leading = new Date(y, m, 1).getDay();
  const cells: (Date | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(new Date(y, m, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function statusLabel(status: Appointment['status'], t: (key: TranslationKey) => string) {
  return t(`appointmentStatus.${status}` as TranslationKey);
}

function sortBlocksForDisplay(a: CalendarBlock, b: CalendarBlock): number {
  const byTime = a.startTime.localeCompare(b.startTime);
  if (byTime !== 0) return byTime;
  return (a.staffName ?? '').localeCompare(b.staffName ?? '');
}

function groupBlocksByTime(blocks: CalendarBlock[]): [string, CalendarBlock[]][] {
  const groups = new Map<string, CalendarBlock[]>();
  for (const apt of blocks) {
    const timeKey = formatTime24(apt.startTime);
    const list = groups.get(timeKey) ?? [];
    list.push(apt);
    groups.set(timeKey, list);
  }
  return Array.from(groups.entries()).map(([time, appts]) => [
    time,
    appts.sort(sortBlocksForDisplay),
  ]);
}

function matchesStaffFilter(apt: CalendarBlock, staffFilter: 'all' | string): boolean {
  if (staffFilter === 'all') return true;
  if (!apt.staffId?.trim()) return false;
  return apt.staffId === staffFilter;
}

function monthDayFromDateStr(dateStr: string): { month: number; day: number } | null {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { month: Number(match[2]), day: Number(match[3]) };
}

function nextCalendarDayMonthDay(dateStr: string): { month: number; day: number } | null {
  const parts = monthDayFromDateStr(dateStr);
  if (!parts) return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), parts.month - 1, parts.day);
  date.setDate(date.getDate() + 1);
  return { month: date.getMonth() + 1, day: date.getDate() };
}

/** Show 🎂 when birthday is on the appointment date or the next calendar day. */
function isBirthdayIndicatorVisible(
  appointmentDate: string,
  clientBirthday: string | null | undefined
): boolean {
  if (!clientBirthday) return false;

  const birthdayMd = monthDayFromDateStr(clientBirthday);
  const appointmentMd = monthDayFromDateStr(appointmentDate);
  const nextDayMd = nextCalendarDayMonthDay(appointmentDate);
  if (!birthdayMd || !appointmentMd || !nextDayMd) return false;

  const sameDay =
    birthdayMd.month === appointmentMd.month && birthdayMd.day === appointmentMd.day;
  const nextDay =
    birthdayMd.month === nextDayMd.month && birthdayMd.day === nextDayMd.day;

  return sameDay || nextDay;
}

function BirthdayIndicator({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span
      className="pointer-events-none absolute right-0.5 top-0.5 text-[10px] leading-none"
      aria-hidden="true"
    >
      🎂
    </span>
  );
}

function eventCardClass(block: CalendarBlock): string {
  if (block.kind === 'google_review') {
    return 'bg-amber-100 text-amber-900 ring-1 ring-amber-200/80 dark:bg-amber-950/50 dark:text-amber-100 dark:ring-amber-800/60';
  }
  return `${getStatusColor(block.status || 'scheduled')} ring-1 ring-black/5 dark:ring-white/10`;
}

function CalendarEventCard({
  block,
  compact,
  showStaff,
  onReview,
}: {
  block: CalendarBlock;
  compact?: boolean;
  showStaff: boolean;
  onReview: (review: GoogleReviewCalendarItem) => void;
}) {
  const { t } = useLanguage();
  return (
    <div
      className={`relative h-full overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight ${eventCardClass(block)}`}
      role={block.kind === 'google_review' ? 'button' : undefined}
      onClick={
        block.kind === 'google_review' && block.review ? () => onReview(block.review!) : undefined
      }
    >
      <BirthdayIndicator visible={isBirthdayIndicatorVisible(block.date, block.clientBirthday)} />
      <p className="truncate font-semibold">{block.title}</p>
      {!compact && block.kind === 'google_review' ? (
        <p className="truncate opacity-80">{t('calendar.googleNeedsReview')}</p>
      ) : null}
      {!compact && block.kind !== 'google_review' && block.subtitle ? (
        <p className="truncate opacity-80">{block.subtitle}</p>
      ) : null}
      {showStaff && block.staffName ? <p className="truncate opacity-70">{block.staffName}</p> : null}
      <p className="tabular-nums opacity-70">
        {formatTime24(block.startTime)}–{formatTime24(block.endTime)}
      </p>
    </div>
  );
}

function DayTimeline({
  hours,
  blocks,
  hourHeight,
  showNow,
  now,
  showStaff,
  onReview,
  compact,
}: {
  hours: number[];
  blocks: CalendarBlock[];
  hourHeight: number;
  showNow: boolean;
  now: Date;
  showStaff: boolean;
  onReview: (review: GoogleReviewCalendarItem) => void;
  compact?: boolean;
}) {
  const hourStart = hours[0] ?? DEFAULT_HOUR_START;
  const hourEnd = hours[hours.length - 1] ?? DEFAULT_HOUR_END;
  const laidOut = layoutDayEvents(blocks, hourStart, hourEnd, hourHeight);
  const totalHeight = hours.length * hourHeight;
  const nowTop = nowLineOffset(hourStart, hourHeight, now);
  const nowVisible = showNow && isNowWithinHours(hourStart, hourEnd, now);

  return (
    <div className="relative z-0 min-w-0 overflow-hidden" style={{ height: totalHeight }}>
      {hours.map((hour, index) => (
        <div
          key={hour}
          className="absolute inset-x-0 border-t border-gray-200 dark:border-gray-800"
          style={{ top: index * hourHeight, height: hourHeight }}
        >
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-gray-100 dark:border-gray-800/80" />
        </div>
      ))}
      {laidOut.map((laid) => {
        const style: CSSProperties = {
          top: laid.top,
          height: laid.height,
          left: `calc(${(laid.column / laid.columnCount) * 100}% + 1px)`,
          width: `calc(${100 / laid.columnCount}% - 2px)`,
        };
        return (
          <div key={laid.item.id} className="absolute z-[1] min-w-0" style={style}>
            <CalendarEventCard
              block={laid.item}
              compact={compact || laid.height < 36}
              showStaff={showStaff}
              onReview={onReview}
            />
          </div>
        );
      })}
      {nowVisible ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-[2] flex items-center"
          style={{ top: nowTop }}
        >
          <span className="h-2 w-2 shrink-0 -translate-x-1 rounded-full bg-red-500" />
          <span className="h-px flex-1 bg-red-500" />
        </div>
      ) : null}
    </div>
  );
}

function TimeGutter({ hours, hourHeight }: { hours: number[]; hourHeight: number }) {
  return (
    <div className="relative z-0 shrink-0" style={{ height: hours.length * hourHeight }}>
      {hours.map((hour, index) => (
        <div
          key={hour}
          className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-gray-400 dark:text-gray-500"
          style={{ top: index * hourHeight }}
        >
          {`${String(hour).padStart(2, '0')}:00`}
        </div>
      ))}
    </div>
  );
}

export default function Calendar() {
  const { language, t } = useLanguage();
  const locale = LOCALE[language];
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [reviewEvents, setReviewEvents] = useState<GoogleReviewCalendarItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffFilter, setStaffFilter] = useState<'all' | string>('all');
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [mobileView, setMobileView] = useState<MobileCalendarView>('today');
  const [mobileMonthDay, setMobileMonthDay] = useState(() => toLocalDateStr(new Date()));
  const [reviewOpen, setReviewOpen] = useState<GoogleReviewCalendarItem | null>(null);
  const [now, setNow] = useState(() => new Date());

  const calendarBlocks = useMemo(() => {
    return [
      ...appointments.filter((a) => a.status !== 'cancelled').map(appointmentToBlock),
      ...reviewEvents.map(reviewToBlock),
    ];
  }, [appointments, reviewEvents]);

  const filteredAppointments = useMemo(
    () => calendarBlocks.filter((apt) => matchesStaffFilter(apt, staffFilter)),
    [calendarBlocks, staffFilter]
  );

  const weekDays = useMemo(() => weekDaysFrom(currentDate), [currentDate]);

  const mobileWeekDays = useMemo(() => weekDaysFrom(currentDate), [currentDate]);
  const mobileMonthCells = useMemo(() => monthGridFrom(currentDate), [currentDate]);
  const weekHours = useMemo(
    () => hoursForVisibleDays(filteredAppointments, weekDays),
    [filteredAppointments, weekDays],
  );

  const navigateMonth = (direction: number) => {
    const next = new Date(currentDate);
    next.setMonth(next.getMonth() + direction);
    setCurrentDate(next);
  };

  const navigateDay = (direction: number) => {
    const next = new Date(currentDate);
    next.setDate(next.getDate() + direction);
    setCurrentDate(next);
  };

  const todayAppointments = useMemo(
    () => filteredAppointments.filter((a) => a.date === toLocalDateStr(currentDate)).sort(sortBlocksForDisplay),
    [filteredAppointments, currentDate]
  );

  const monthSelectedAppointments = useMemo(
    () =>
      filteredAppointments
        .filter((a) => a.date === mobileMonthDay)
        .sort(sortBlocksForDisplay),
    [filteredAppointments, mobileMonthDay]
  );

  const monthSelectedTimeGroups = useMemo(
    () => groupBlocksByTime(monthSelectedAppointments),
    [monthSelectedAppointments]
  );

  const showStaffOnCards = staffFilter === 'all';
  const todayHours = useMemo(
    () => hoursForVisibleDays(todayAppointments, [currentDate]),
    [todayAppointments, currentDate]
  );

  useEffect(() => {
    Promise.all([
      api.appointments.getAll(),
      api.staff.getAll(),
      api.calendar.getGoogleReviewEvents().catch(() => ({ events: [] })),
    ])
      .then(([apptData, staffData, reviewData]) => {
        setAppointments(apptData);
        setStaff(staffData.filter((member) => member.active).sort((a, b) => a.name.localeCompare(b.name)));
        setReviewEvents(reviewData.events ?? []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const getAppointmentsForDay = (date: Date) => {
    const dateStr = toLocalDateStr(date);
    return filteredAppointments.filter((a) => a.date === dateStr);
  };

  const navigateWeek = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction * 7);
    setCurrentDate(newDate);
  };

  const isToday = (date: Date) => date.toDateString() === new Date().toDateString();

  const formatMobileDate = (date: Date) =>
    date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long' });

  const emptyDayMessage =
    staffFilter !== 'all' ? t('calendar.noAppointmentsForStaff') : t('calendar.noAppointmentsDay');
  const emptyTodayMessage =
    staffFilter !== 'all' ? t('calendar.noAppointmentsForStaff') : t('calendar.noAppointmentsToday');

  const renderMobileBlocks = (blocks: CalendarBlock[], groups: [string, CalendarBlock[]][], emptyMessage: string) => {
    if (blocks.length === 0) {
      return (
        <div className="card py-12 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">{emptyMessage}</p>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {groups.map(([time, appts]) => (
          <div key={time} className="card flex w-full min-w-0 max-w-full items-start gap-3 p-4">
            <div className="flex shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 px-3 py-2 text-center dark:bg-brand-950/30">
              <span className="whitespace-nowrap text-sm font-bold tabular-nums text-brand-700 dark:text-brand-300">
                {time}
              </span>
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              {appts.map((apt, index) => (
                <div
                  key={apt.id}
                  className={`relative ${index > 0 ? 'border-t border-gray-100 pt-3 dark:border-gray-800' : ''}`}
                  role={apt.kind === 'google_review' ? 'button' : undefined}
                  onClick={
                    apt.kind === 'google_review' && apt.review
                      ? () => setReviewOpen(apt.review ?? null)
                      : undefined
                  }
                >
                  <BirthdayIndicator
                    visible={isBirthdayIndicatorVisible(apt.date, apt.clientBirthday)}
                  />
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-base font-semibold text-gray-900 dark:text-white">
                      {apt.title}
                    </p>
                    {apt.kind === 'google_review' ? (
                      <span className="badge shrink-0 text-xs bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                        {t('calendar.googleNeedsReview')}
                      </span>
                    ) : (
                      <span className={`badge shrink-0 text-xs ${getStatusColor(apt.status || 'scheduled')}`}>
                        {statusLabel(apt.status || 'scheduled', t)}
                      </span>
                    )}
                  </div>
                  {apt.kind === 'google_review' ? (
                    <p className="mt-1 truncate text-sm text-gray-600 dark:text-gray-400">
                      {formatTime24(apt.startTime)}–{formatTime24(apt.endTime)} · {t('calendar.googleSource')}
                    </p>
                  ) : (
                    <p className="mt-1 truncate text-sm text-gray-600 dark:text-gray-400">
                      {apt.subtitle}
                    </p>
                  )}
                  {showStaffOnCards && apt.staffName && (
                    <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">
                      {t('calendar.staffPrefix')} {apt.staffName}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">

      {/* MOBILE HEADER — below lg */}
      <div className="lg:hidden">
        <div className="flex w-full min-w-0 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
          {([
            ['today', 'calendar.today'],
            ['week', 'calendar.week'],
            ['month', 'calendar.month'],
          ] as const).map(([view, key]) => (
            <button
              key={view}
              type="button"
              onClick={() => setMobileView(view)}
              className={`min-h-[44px] min-w-0 flex-1 truncate rounded-md px-2 text-sm font-medium ${
                mobileView === view
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                  : 'text-gray-600 dark:text-gray-400'
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      {/* DESKTOP HEADER — lg+ */}
      <div className="hidden lg:block">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigateWeek(-1)}
              className="btn-ghost"
              aria-label={t('calendar.prevWeek')}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              {weekDays[0].toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
            </h3>
            <button
              onClick={() => navigateWeek(1)}
              className="btn-ghost"
              aria-label={t('calendar.nextWeek')}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button onClick={() => setCurrentDate(new Date())} className="btn-secondary text-xs">
            {t('calendar.today')}
          </button>
        </div>
      </div>

      {/* Staff filter — below calendar navigation */}
      <div className="w-full min-w-0">
        <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          {t('calendar.staffFilter')}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setStaffFilter('all')}
            className={staffFilter === 'all' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
          >
            {t('calendar.allStaff')}
          </button>
          {staff.map((member) => (
            <button
              key={member.id}
              type="button"
              onClick={() => setStaffFilter(member.id)}
              className={staffFilter === member.id ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
            >
              {member.name}
            </button>
          ))}
        </div>
      </div>

      {/* MOBILE: today / week / month */}
      <div className="lg:hidden">
        {mobileView === 'today'
          ? (
            <div className="w-full min-w-0 space-y-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => navigateDay(-1)}
                  className="btn-ghost"
                  aria-label={t('calendar.prevDay')}
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <h3
                  className={`min-w-0 truncate text-sm font-semibold ${
                    isToday(currentDate) ? 'text-brand-600 dark:text-brand-400' : 'text-gray-900 dark:text-white'
                  }`}
                >
                  {formatMobileDate(currentDate)}
                </h3>
                <button
                  type="button"
                  onClick={() => navigateDay(1)}
                  className="btn-ghost"
                  aria-label={t('calendar.nextDay')}
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
              {todayAppointments.length === 0 ? (
                <div className="card py-12 text-center">
                  <p className="text-sm text-gray-500 dark:text-gray-400">{emptyTodayMessage}</p>
                </div>
              ) : (
                <div className="card overflow-hidden p-0">
                  <div
                    className="relative z-0 flex min-w-0"
                    data-calendar-timed-events
                    style={{ paddingTop: TIMED_EVENTS_LAYER_OFFSET_PX }}
                  >
                    <div className="w-12 shrink-0 border-r dark:border-gray-800">
                      <TimeGutter hours={todayHours} hourHeight={MOBILE_HOUR_HEIGHT_PX} />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <DayTimeline
                        hours={todayHours}
                        blocks={todayAppointments}
                        hourHeight={MOBILE_HOUR_HEIGHT_PX}
                        showNow={isToday(currentDate)}
                        now={now}
                        showStaff={showStaffOnCards}
                        onReview={setReviewOpen}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
          : null}

        {mobileView === 'week' ? (
          <div className="w-full min-w-0 space-y-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => navigateWeek(-1)}
                className="btn-ghost"
                aria-label={t('calendar.prevWeek')}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                {mobileWeekDays[0].toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
              </h3>
              <button
                type="button"
                onClick={() => navigateWeek(1)}
                className="btn-ghost"
                aria-label={t('calendar.nextWeek')}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
            {mobileWeekDays.map((day) => {
              const dayBlocks = getAppointmentsForDay(day).sort(sortBlocksForDisplay);
              const dayHours = hoursForVisibleDays(dayBlocks, [day]);
              return (
                <div key={toLocalDateStr(day)} className="w-full min-w-0">
                  {dayBlocks.length === 0 ? (
                    <>
                      <p
                        className={`mb-2 truncate text-sm font-semibold ${
                          isToday(day)
                            ? 'text-brand-600 dark:text-brand-400'
                            : 'text-gray-900 dark:text-white'
                        }`}
                      >
                        {formatMobileDate(day)}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{emptyDayMessage}</p>
                    </>
                  ) : (
                    <div className="card overflow-hidden p-0">
                      <div
                        data-calendar-day-header
                        className={`flex items-center border-b px-3 dark:border-gray-700 ${
                          isToday(day)
                            ? 'bg-brand-50 dark:bg-brand-950/30'
                            : 'bg-white dark:bg-gray-900'
                        }`}
                        style={{ height: MOBILE_DAY_HEADER_HEIGHT_PX }}
                      >
                        <p
                          className={`truncate text-sm font-semibold ${
                            isToday(day)
                              ? 'text-brand-600 dark:text-brand-400'
                              : 'text-gray-900 dark:text-white'
                          }`}
                        >
                          {formatMobileDate(day)}
                        </p>
                      </div>
                      <div
                        className="relative z-0 flex min-w-0"
                        data-calendar-timed-events
                        style={{ paddingTop: TIMED_EVENTS_LAYER_OFFSET_PX }}
                      >
                        <div className="w-12 shrink-0 border-r dark:border-gray-800">
                          <TimeGutter hours={dayHours} hourHeight={MOBILE_HOUR_HEIGHT_PX} />
                        </div>
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <DayTimeline
                            hours={dayHours}
                            blocks={dayBlocks}
                            hourHeight={MOBILE_HOUR_HEIGHT_PX}
                            showNow={isToday(day)}
                            now={now}
                            showStaff={showStaffOnCards}
                            onReview={setReviewOpen}
                            compact
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}

        {mobileView === 'month' ? (
          <div className="w-full min-w-0 space-y-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => navigateMonth(-1)}
                className="btn-ghost"
                aria-label={t('calendar.prevMonth')}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                {currentDate.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
              </p>
              <button
                type="button"
                onClick={() => navigateMonth(1)}
                className="btn-ghost"
                aria-label={t('calendar.nextMonth')}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
            <div className="grid w-full min-w-0 grid-cols-7 gap-1">
              {mobileWeekDays.map((day) => (
                <div
                  key={`lbl-${day.toISOString()}`}
                  className="min-w-0 truncate text-center text-[11px] font-medium text-gray-500 dark:text-gray-400"
                >
                  {day.toLocaleDateString(locale, { weekday: 'narrow' })}
                </div>
              ))}
              {mobileMonthCells.map((day, index) => {
                if (!day) {
                  return <div key={`empty-${index}`} className="min-h-[40px] min-w-0" />;
                }
                const dateStr = toLocalDateStr(day);
                const hasEvents = filteredAppointments.some((apt) => apt.date === dateStr);
                const selected = dateStr === mobileMonthDay;
                return (
                  <button
                    key={dateStr}
                    type="button"
                    onClick={() => setMobileMonthDay(dateStr)}
                    className={`flex min-h-[40px] min-w-0 flex-col items-center justify-center rounded-md text-xs tabular-nums ${
                      selected
                        ? 'bg-brand-600 text-white'
                        : isToday(day)
                          ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                          : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {day.getDate()}
                    {hasEvents ? (
                      <span
                        className={`mt-0.5 h-1 w-1 rounded-full ${selected ? 'bg-white' : 'bg-brand-500'}`}
                      />
                    ) : (
                      <span className="mt-0.5 h-1 w-1" />
                    )}
                  </button>
                );
              })}
            </div>
            {renderMobileBlocks(
              monthSelectedAppointments,
              monthSelectedTimeGroups,
              emptyDayMessage
            )}
          </div>
        ) : null}
      </div>

      {/* DESKTOP: week grid — lg+ */}
      <div className="hidden lg:block">
        <div className="card overflow-hidden p-0">
          <div className="max-h-[min(70vh,720px)] overflow-y-auto overflow-x-clip">
            <div
              data-calendar-day-header
              className={`sticky top-0 z-30 isolate border-b bg-white dark:border-gray-700 dark:bg-gray-900 ${WEEK_GRID_CLASS}`}
              style={{ height: WEEK_DAY_HEADER_HEIGHT_PX }}
            >
              <div className="flex h-full items-center justify-center border-r p-2 text-xs font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {t('calendar.timeColumn')}
              </div>
              {weekDays.map((day) => (
                <div
                  key={day.toISOString()}
                  className={`flex h-full min-w-0 flex-col items-center justify-center border-r px-1 py-1 text-center last:border-r-0 dark:border-gray-700 ${
                    isToday(day) ? 'bg-brand-50 dark:bg-brand-950/30' : ''
                  }`}
                >
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {day.toLocaleDateString(locale, { weekday: 'short' })}
                  </p>
                  <p
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-lg font-bold ${
                      isToday(day)
                        ? 'bg-brand-600 text-white'
                        : 'text-gray-900 dark:text-white'
                    }`}
                  >
                    {day.getDate()}
                  </p>
                </div>
              ))}
            </div>

            <div
              data-calendar-timed-events
              className={`relative z-0 ${WEEK_GRID_CLASS}`}
              style={{ paddingTop: TIMED_EVENTS_LAYER_OFFSET_PX }}
            >
              <div className="border-r dark:border-gray-700">
                <TimeGutter hours={weekHours} hourHeight={DESKTOP_HOUR_HEIGHT_PX} />
              </div>
              {weekDays.map((day) => {
                const dayBlocks = getAppointmentsForDay(day);
                return (
                  <div
                    key={day.toISOString()}
                    className={`min-w-0 overflow-hidden border-r last:border-r-0 dark:border-gray-700 ${
                      isToday(day) ? 'bg-brand-50/40 dark:bg-brand-950/20' : ''
                    }`}
                  >
                    <DayTimeline
                      hours={weekHours}
                      blocks={dayBlocks}
                      hourHeight={DESKTOP_HOUR_HEIGHT_PX}
                      showNow={isToday(day)}
                      now={now}
                      showStaff={showStaffOnCards}
                      onReview={setReviewOpen}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={Boolean(reviewOpen)}
        onClose={() => setReviewOpen(null)}
        title={t('calendar.reviewTitle')}
        size="sm"
      >
        {reviewOpen ? (
          <div className="space-y-2 text-sm text-gray-800 dark:text-gray-200">
            <p>
              <span className="text-gray-500 dark:text-gray-400">
                {t('calendar.reviewOriginalTitle')}:
              </span>{' '}
              <span className="font-medium">{reviewOpen.title}</span>
            </p>
            <p>
              <span className="text-gray-500 dark:text-gray-400">
                {t('calendar.reviewDateTime')}:
              </span>{' '}
              <span className="font-medium">
                {reviewOpen.date} {formatTime24(reviewOpen.startTime)}–{formatTime24(reviewOpen.endTime)}
              </span>
            </p>
            <p>
              <span className="text-gray-500 dark:text-gray-400">
                {t('calendar.reviewClientCandidate')}:
              </span>{' '}
              {reviewOpen.clientCandidate || t('calendar.reviewEmptyValue')}
            </p>
            <p>
              <span className="text-gray-500 dark:text-gray-400">
                {t('calendar.reviewPhoneCandidate')}:
              </span>{' '}
              {reviewOpen.phoneCandidate || t('calendar.reviewEmptyValue')}
            </p>
            <p>
              <span className="text-gray-500 dark:text-gray-400">
                {t('calendar.reviewServiceCandidate')}:
              </span>{' '}
              {reviewOpen.serviceCandidate || t('calendar.reviewEmptyValue')}
            </p>
            <p>
              <span className="text-gray-500 dark:text-gray-400">{t('calendar.reviewStaff')}:</span>{' '}
              {reviewOpen.staffName}
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-200">
              {t('calendar.googleNeedsReview')}
            </p>
            <div className="flex justify-end pt-2">
              <button type="button" className="btn-secondary" onClick={() => setReviewOpen(null)}>
                {t('calendar.reviewClose')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

    </div>
  );
}
