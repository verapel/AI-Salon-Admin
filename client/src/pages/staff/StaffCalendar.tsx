import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useLanguage, type LangCode, type TranslationKey } from '@/context/LanguageContext';
import { getStatusColor } from '@/lib/utils';
import type { StaffPortalAppointment } from '@/types';
import StaffAppointmentDetailsModal from './StaffAppointmentDetailsModal';
import {
  STAFF_CALENDAR_HOURS,
  addDaysIso,
  clampToCalendarHour,
  formatTime24,
  parseIsoDate,
  parseStartHour,
  startOfWeekSunday,
  todayIso,
  weekDaysFrom,
} from './dateUtils';

const LOCALE: Record<LangCode, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  hy: 'hy-AM',
};

/** Shared desktop week grid: fixed time column + 7 equal day columns (matches owner Calendar). */
const WEEK_GRID_CLASS = 'grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]';

/** Mobile day grid: time column + one day column */
const DAY_GRID_CLASS = 'grid grid-cols-[3.5rem_minmax(0,1fr)]';

function statusLabel(status: string, t: (key: TranslationKey) => string) {
  return t(`appointmentStatus.${status}` as TranslationKey);
}

function sortAppointments(a: StaffPortalAppointment, b: StaffPortalAppointment): number {
  const byDate = (a.date || '').localeCompare(b.date || '');
  if (byDate !== 0) return byDate;
  const byStart = formatTime24(a.startTime).localeCompare(formatTime24(b.startTime));
  if (byStart !== 0) return byStart;
  return (a.id || '').localeCompare(b.id || '');
}

function appointmentsForDay(
  appointments: StaffPortalAppointment[],
  dateIso: string
): StaffPortalAppointment[] {
  return appointments.filter((a) => a.date === dateIso).sort(sortAppointments);
}

function appointmentsInHour(
  appointments: StaffPortalAppointment[],
  hour: number
): StaffPortalAppointment[] {
  return appointments
    .filter((a) => {
      const parsed = parseStartHour(a.startTime);
      if (parsed === null) return hour === STAFF_CALENDAR_HOURS[0];
      return clampToCalendarHour(parsed) === hour;
    })
    .sort(sortAppointments);
}

function CompactEvent({
  apt,
  onOpen,
}: {
  apt: StaffPortalAppointment;
  onOpen: (apt: StaffPortalAppointment) => void;
}) {
  const { t } = useLanguage();
  const start = formatTime24(apt.startTime);
  const end = formatTime24(apt.endTime);
  const timeLine = start && end ? `${start}–${end}` : start || '—';

  return (
    <button
      type="button"
      onClick={() => onOpen(apt)}
      className={`relative w-full shrink-0 rounded-md p-1.5 text-left text-xs leading-tight transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${getStatusColor(apt.status)}`}
    >
      <p className="truncate font-medium">{apt.clientName || '—'}</p>
      <p className="truncate opacity-75">{apt.serviceName || '—'}</p>
      <p className="tabular-nums opacity-60">{timeLine}</p>
      <p className="truncate opacity-70">{statusLabel(apt.status, t)}</p>
    </button>
  );
}

export default function StaffCalendar() {
  const { language, t } = useLanguage();
  const locale = LOCALE[language];

  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeekSunday(todayIso()));
  const [selectedDay, setSelectedDay] = useState(todayIso);
  const [appointments, setAppointments] = useState<StaffPortalAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedApt, setSelectedApt] = useState<StaffPortalAppointment | null>(null);

  const weekDays = useMemo(() => weekDaysFrom(weekAnchor), [weekAnchor]);
  const weekEnd = weekDays[6];

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true);
    setError(false);
    try {
      const list = await api.staffPortal.getAppointments({ from, to });
      const safe = Array.isArray(list) ? [...list].sort(sortAppointments) : [];
      setAppointments(safe);
    } catch {
      setError(true);
      setAppointments([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(weekAnchor, weekEnd);
  }, [load, weekAnchor, weekEnd]);

  useEffect(() => {
    if (!weekDays.includes(selectedDay)) {
      setSelectedDay(weekDays.includes(todayIso()) ? todayIso() : weekAnchor);
    }
  }, [weekDays, weekAnchor, selectedDay]);

  const navigateWeek = (direction: number) => {
    const next = addDaysIso(weekAnchor, direction * 7);
    setWeekAnchor(next);
    setSelectedDay((prev) => {
      const shifted = addDaysIso(prev, direction * 7);
      return weekDaysFrom(next).includes(shifted) ? shifted : next;
    });
  };

  const goToday = () => {
    const today = todayIso();
    setWeekAnchor(startOfWeekSunday(today));
    setSelectedDay(today);
  };

  const isToday = (iso: string) => iso === todayIso();

  const formatDayHeader = (iso: string) => {
    const d = parseIsoDate(iso);
    if (!d) return iso;
    return {
      weekday: d.toLocaleDateString(locale, { weekday: 'short' }),
      dayNum: d.getDate(),
    };
  };

  const weekRangeLabel = useMemo(() => {
    const start = parseIsoDate(weekAnchor);
    const end = parseIsoDate(weekEnd);
    if (!start || !end) return '';
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      return `${start.toLocaleDateString(locale, { month: 'long', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }, [weekAnchor, weekEnd, locale]);

  const selectedDayAppts = useMemo(
    () => appointmentsForDay(appointments, selectedDay),
    [appointments, selectedDay]
  );

  const weekHasAppointments = appointments.length > 0;

  const renderHourRows = (days: string[], gridClass: string) =>
    STAFF_CALENDAR_HOURS.map((hour) => (
      <div
        key={hour}
        className={`${gridClass} border-b last:border-b-0 dark:border-gray-700`}
      >
        <div className="border-r p-3 text-xs tabular-nums text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {`${String(hour).padStart(2, '0')}:00`}
        </div>
        {days.map((dayIso) => {
          const dayAppts = appointmentsInHour(appointmentsForDay(appointments, dayIso), hour);
          return (
            <div
              key={dayIso + hour}
              className={`flex min-h-[60px] min-w-0 flex-col gap-1 border-r p-1 last:border-r-0 dark:border-gray-700 ${
                isToday(dayIso) ? 'bg-brand-50/40 dark:bg-brand-950/20' : ''
              }`}
            >
              {dayAppts.map((apt) => (
                <CompactEvent key={apt.id} apt={apt} onOpen={setSelectedApt} />
              ))}
            </div>
          );
        })}
      </div>
    ));

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t('staffPortal.calendar.title')}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('staffPortal.calendar.subtitle')}
        </p>
      </div>

      {/* Desktop week nav */}
      <div className="hidden items-center justify-between lg:flex">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigateWeek(-1)}
            className="btn-ghost"
            aria-label={t('calendar.prevWeek')}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">{weekRangeLabel}</h3>
          <button
            type="button"
            onClick={() => navigateWeek(1)}
            className="btn-ghost"
            aria-label={t('calendar.nextWeek')}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        <button type="button" onClick={goToday} className="btn-secondary text-xs">
          {t('calendar.today')}
        </button>
      </div>

      {/* Mobile week + day nav */}
      <div className="space-y-3 lg:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => navigateWeek(-1)}
              className="btn-ghost shrink-0 p-1.5"
              aria-label={t('calendar.prevWeek')}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <p className="min-w-0 truncate px-1 text-sm font-semibold text-gray-900 dark:text-white">
              {weekRangeLabel}
            </p>
            <button
              type="button"
              onClick={() => navigateWeek(1)}
              className="btn-ghost shrink-0 p-1.5"
              aria-label={t('calendar.nextWeek')}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button type="button" onClick={goToday} className="btn-secondary shrink-0 px-2.5 py-1 text-xs">
            {t('calendar.today')}
          </button>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          {weekDays.map((iso) => {
            const header = formatDayHeader(iso);
            const selected = iso === selectedDay;
            return (
              <button
                key={iso}
                type="button"
                onClick={() => setSelectedDay(iso)}
                className={`flex min-w-[3rem] flex-col items-center rounded-lg px-2 py-1.5 text-center ${
                  selected
                    ? 'bg-brand-600 text-white'
                    : isToday(iso)
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                      : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                }`}
              >
                <span className="text-[10px] font-medium uppercase opacity-80">
                  {typeof header === 'string' ? '' : header.weekday}
                </span>
                <span className="text-sm font-bold">
                  {typeof header === 'string' ? header : header.dayNum}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
          <p className="text-sm text-red-700 dark:text-red-300">{t('staffPortal.error.load')}</p>
          <button type="button" onClick={() => void load(weekAnchor, weekEnd)} className="btn-primary mt-3">
            {t('staffPortal.retry')}
          </button>
        </div>
      ) : (
        <>
          {/* Mobile: single-day time grid */}
          <div className="lg:hidden">
            {!weekHasAppointments ? (
              <p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                {t('staffPortal.calendar.emptyWeek')}
              </p>
            ) : selectedDayAppts.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                {t('staffPortal.calendar.empty')}
              </p>
            ) : null}
            <div className="card mt-3 overflow-hidden p-0">
              <div className="max-h-[70vh] overflow-y-auto overflow-x-clip">
                <div
                  className={`sticky top-0 z-10 border-b bg-white dark:border-gray-700 dark:bg-gray-900 ${DAY_GRID_CLASS}`}
                >
                  <div className="border-r p-3 text-xs font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    {t('calendar.timeColumn')}
                  </div>
                  <div
                    className={`min-w-0 p-3 text-center ${
                      isToday(selectedDay) ? 'bg-brand-50 dark:bg-brand-950/30' : ''
                    }`}
                  >
                    {(() => {
                      const header = formatDayHeader(selectedDay);
                      return (
                        <>
                          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                            {typeof header === 'string' ? '' : header.weekday}
                          </p>
                          <p
                            className={`text-lg font-bold ${
                              isToday(selectedDay)
                                ? 'text-brand-600 dark:text-brand-400'
                                : 'text-gray-900 dark:text-white'
                            }`}
                          >
                            {typeof header === 'string' ? header : header.dayNum}
                          </p>
                        </>
                      );
                    })()}
                  </div>
                </div>
                {renderHourRows([selectedDay], DAY_GRID_CLASS)}
              </div>
            </div>
          </div>

          {/* Desktop: week grid */}
          <div className="hidden lg:block">
            {!weekHasAppointments ? (
              <p className="mb-3 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                {t('staffPortal.calendar.emptyWeek')}
              </p>
            ) : null}
            <div className="card overflow-hidden p-0">
              <div className="max-h-[600px] overflow-y-auto overflow-x-clip">
                <div
                  className={`sticky top-0 z-10 border-b bg-white dark:border-gray-700 dark:bg-gray-900 ${WEEK_GRID_CLASS}`}
                >
                  <div className="border-r p-3 text-xs font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    {t('calendar.timeColumn')}
                  </div>
                  {weekDays.map((iso) => {
                    const header = formatDayHeader(iso);
                    return (
                      <div
                        key={iso}
                        className={`min-w-0 border-r p-3 text-center last:border-r-0 dark:border-gray-700 ${
                          isToday(iso) ? 'bg-brand-50 dark:bg-brand-950/30' : ''
                        }`}
                      >
                        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                          {typeof header === 'string' ? '' : header.weekday}
                        </p>
                        <p
                          className={`text-lg font-bold ${
                            isToday(iso)
                              ? 'text-brand-600 dark:text-brand-400'
                              : 'text-gray-900 dark:text-white'
                          }`}
                        >
                          {typeof header === 'string' ? header : header.dayNum}
                        </p>
                      </div>
                    );
                  })}
                </div>
                {renderHourRows(weekDays, WEEK_GRID_CLASS)}
              </div>
            </div>
          </div>
        </>
      )}

      {selectedApt ? (
        <StaffAppointmentDetailsModal apt={selectedApt} onClose={() => setSelectedApt(null)} />
      ) : null}
    </div>
  );
}
