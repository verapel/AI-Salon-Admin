import { useEffect, useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Modal from '@/components/ui/Modal';
import { useLanguage, type LangCode, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { getStatusColor } from '@/lib/utils';
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

const HOURS = Array.from({ length: 12 }, (_, i) => i + 8);

/** Shared desktop week grid: fixed time column + 7 equal day columns */
const WEEK_GRID_CLASS = 'grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]';

function statusLabel(status: Appointment['status'], t: (key: TranslationKey) => string) {
  return t(`appointmentStatus.${status}` as TranslationKey);
}

function sortBlocksForDisplay(a: CalendarBlock, b: CalendarBlock): number {
  const byTime = a.startTime.localeCompare(b.startTime);
  if (byTime !== 0) return byTime;
  return (a.staffName ?? '').localeCompare(b.staffName ?? '');
}

function blocksInHour(blocks: CalendarBlock[], hour: number): CalendarBlock[] {
  return blocks
    .filter((a) => parseInt(a.startTime.split(':')[0], 10) === hour)
    .sort(sortBlocksForDisplay);
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

export default function Calendar() {
  const { language, t } = useLanguage();
  const locale = LOCALE[language];
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [reviewEvents, setReviewEvents] = useState<GoogleReviewCalendarItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffFilter, setStaffFilter] = useState<'all' | string>('all');
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [reviewOpen, setReviewOpen] = useState<GoogleReviewCalendarItem | null>(null);

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

  const weekDays = useMemo(() => {
    const start = new Date(currentDate);
    const day = start.getDay();
    start.setDate(start.getDate() - day);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [currentDate]);

  const dayAppointments = useMemo(() => {
    const dateStr = toLocalDateStr(currentDate);
    return filteredAppointments
      .filter((a) => a.date === dateStr)
      .sort(sortBlocksForDisplay);
  }, [filteredAppointments, currentDate]);

  const mobileTimeGroups = useMemo(
    () => groupBlocksByTime(dayAppointments),
    [dayAppointments]
  );

  const showStaffOnCards = staffFilter === 'all';

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

  const getAppointmentsForDay = (date: Date) => {
    const dateStr = toLocalDateStr(date);
    return filteredAppointments.filter((a) => a.date === dateStr);
  };

  const navigateWeek = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction * 7);
    setCurrentDate(newDate);
  };

  const navigateDay = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction);
    setCurrentDate(newDate);
  };

  const isToday = (date: Date) => date.toDateString() === new Date().toDateString();

  const formatMobileDate = (date: Date) =>
    date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long' });

  const emptyDayMessage =
    staffFilter !== 'all'
      ? t('calendar.noAppointmentsForStaff')
      : isToday(currentDate)
        ? t('calendar.noAppointmentsToday')
        : t('calendar.noAppointmentsDay');

  if (loading) return <LoadingSpinner />;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">

      {/* MOBILE HEADER — below lg */}
      <div className="lg:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <button
              onClick={() => navigateDay(-1)}
              className="btn-ghost shrink-0 p-1.5"
              aria-label={t('calendar.prevDay')}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <p
              className={`min-w-0 truncate px-1 text-sm font-semibold ${
                isToday(currentDate)
                  ? 'text-brand-600 dark:text-brand-400'
                  : 'text-gray-900 dark:text-white'
              }`}
            >
              {formatMobileDate(currentDate)}
            </p>
            <button
              onClick={() => navigateDay(1)}
              className="btn-ghost shrink-0 p-1.5"
              aria-label={t('calendar.nextDay')}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={() => setCurrentDate(new Date())}
            className="btn-secondary shrink-0 px-2.5 py-1 text-xs"
          >
            {t('calendar.today')}
          </button>
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

      {/* MOBILE: day list */}
      <div className="lg:hidden">
        <div className="space-y-3">
          {dayAppointments.length === 0 ? (
            <div className="card py-12 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">{emptyDayMessage}</p>
            </div>
          ) : (
            mobileTimeGroups.map(([time, appts]) => (
              <div
                key={time}
                className="card flex w-full min-w-0 max-w-full items-start gap-3 p-4"
              >
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
            ))
          )}
        </div>
      </div>

      {/* DESKTOP: week grid — lg+ */}
      <div className="hidden lg:block">
        <div className="card overflow-hidden p-0">
          <div className="max-h-[600px] overflow-y-auto overflow-x-clip">
            <div
              className={`sticky top-0 z-10 border-b bg-white dark:border-gray-700 dark:bg-gray-900 ${WEEK_GRID_CLASS}`}
            >
              <div className="border-r p-3 text-xs font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {t('calendar.timeColumn')}
              </div>
              {weekDays.map((day) => (
                <div
                  key={day.toISOString()}
                  className={`min-w-0 border-r p-3 text-center last:border-r-0 dark:border-gray-700 ${
                    isToday(day) ? 'bg-brand-50 dark:bg-brand-950/30' : ''
                  }`}
                >
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {day.toLocaleDateString(locale, { weekday: 'short' })}
                  </p>
                  <p
                    className={`text-lg font-bold ${
                      isToday(day)
                        ? 'text-brand-600 dark:text-brand-400'
                        : 'text-gray-900 dark:text-white'
                    }`}
                  >
                    {day.getDate()}
                  </p>
                </div>
              ))}
            </div>

            {HOURS.map((hour) => (
              <div
                key={hour}
                className={`${WEEK_GRID_CLASS} border-b last:border-b-0 dark:border-gray-700`}
              >
                <div className="border-r p-3 text-xs tabular-nums text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  {`${String(hour).padStart(2, '0')}:00`}
                </div>
                {weekDays.map((day) => {
                  const dayAppts = blocksInHour(getAppointmentsForDay(day), hour);
                  return (
                    <div
                      key={day.toISOString() + hour}
                      className="flex min-h-[60px] min-w-0 flex-col gap-1 border-r p-1 last:border-r-0 dark:border-gray-700"
                    >
                      {dayAppts.map((apt) => (
                        <div
                          key={apt.id}
                          className={`relative shrink-0 rounded-md p-1.5 text-xs leading-tight ${
                            apt.kind === 'google_review'
                              ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                              : getStatusColor(apt.status || 'scheduled')
                          }`}
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
                          <p className="truncate font-medium">{apt.title}</p>
                          {apt.kind === 'google_review' ? (
                            <p className="truncate opacity-80">{t('calendar.googleNeedsReview')}</p>
                          ) : (
                            <p className="truncate opacity-75">{apt.subtitle}</p>
                          )}
                          {showStaffOnCards && apt.staffName && (
                            <p className="truncate opacity-70">{apt.staffName}</p>
                          )}
                          <p className="tabular-nums opacity-60">
                            {formatTime24(apt.startTime)}–{formatTime24(apt.endTime)}
                          </p>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
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
