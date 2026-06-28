import { useEffect, useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import { formatTime, getStatusColor } from '@/lib/utils';
import type { Appointment } from '@/types';

// Mobile-only helpers (desktop uses formatTime from utils)
const WEEKDAYS_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** "Вт, 30 июня" */
const formatMobileDate = (date: Date) =>
  `${WEEKDAYS_RU[date.getDay()]}, ${date.getDate()} ${MONTHS_RU[date.getMonth()]}`;

/** "14:00" — 24-часовой формат из "HH:MM:SS" или "HH:MM" */
const formatTime24 = (time: string) => time.slice(0, 5);

const HOURS = Array.from({ length: 12 }, (_, i) => i + 8);

export default function Calendar() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());

  // Desktop: 7 дней текущей недели
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

  // Mobile: записи выбранного дня, отсортированные по времени
  const dayAppointments = useMemo(() => {
    const dateStr = currentDate.toISOString().split('T')[0];
    return appointments
      .filter((a) => a.date === dateStr && a.status !== 'cancelled')
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }, [appointments, currentDate]);

  useEffect(() => {
    api.appointments.getAll()
      .then(setAppointments)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const getAppointmentsForDay = (date: Date) => {
    const dateStr = date.toISOString().split('T')[0];
    return appointments.filter((a) => a.date === dateStr && a.status !== 'cancelled');
  };

  // Desktop: навигация по неделям (±7 дней)
  const navigateWeek = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction * 7);
    setCurrentDate(newDate);
  };

  // Mobile: навигация по дням (±1 день)
  const navigateDay = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction);
    setCurrentDate(newDate);
  };

  const isToday = (date: Date) =>
    date.toDateString() === new Date().toDateString();

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4 animate-fade-in">

      {/* ══════════════════════════════════════
          MOBILE HEADER — только ниже lg (< 1024px)
          Враппер lg:hidden полностью скрывает блок на desktop
      ══════════════════════════════════════ */}
      <div className="lg:hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button onClick={() => navigateDay(-1)} className="btn-ghost p-1.5" aria-label="Previous day">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <p className={`px-1 text-sm font-semibold ${
              isToday(currentDate)
                ? 'text-brand-600 dark:text-brand-400'
                : 'text-gray-900 dark:text-white'
            }`}>
              {formatMobileDate(currentDate)}
            </p>
            <button onClick={() => navigateDay(1)} className="btn-ghost p-1.5" aria-label="Next day">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={() => setCurrentDate(new Date())}
            className="btn-secondary shrink-0 px-2.5 py-1 text-xs"
          >
            Today
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════
          DESKTOP HEADER — только lg+ (≥ 1024px)
          Враппер hidden lg:block показывает блок только на desktop
      ══════════════════════════════════════ */}
      <div className="hidden lg:block">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => navigateWeek(-1)} className="btn-ghost">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              {weekDays[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h3>
            <button onClick={() => navigateWeek(1)} className="btn-ghost">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button onClick={() => setCurrentDate(new Date())} className="btn-secondary text-xs">
            Today
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════
          MOBILE: дневной список карточками — только ниже lg
      ══════════════════════════════════════ */}
      <div className="lg:hidden">
        <div className="space-y-3">
          {dayAppointments.length === 0 ? (
            <div className="card py-12 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {isToday(currentDate) ? 'No appointments today' : 'No appointments on this day'}
              </p>
            </div>
          ) : (
            dayAppointments.map((apt) => (
              <div key={apt.id} className="card flex items-start gap-3 p-4">
                {/* Время — 24ч формат */}
                <div className="flex shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 px-3 py-2 text-center dark:bg-brand-950/30">
                  <span className="whitespace-nowrap text-sm font-bold text-brand-700 dark:text-brand-300">
                    {formatTime24(apt.startTime)}
                  </span>
                </div>
                {/* Детали */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-base font-semibold text-gray-900 dark:text-white">
                      {apt.clientName}
                    </p>
                    <span className={`badge shrink-0 text-xs ${getStatusColor(apt.status)}`}>
                      {apt.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-gray-600 dark:text-gray-400">
                    {apt.serviceName}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                    Мастер: {apt.staffName}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════
          DESKTOP: недельная сетка — только lg+ (≥ 1024px)
          card и grid-cols-8 в отдельном div, чтобы
          hidden/lg:block не конфликтовали с card-классом
      ══════════════════════════════════════ */}
      <div className="hidden lg:block">
        <div className="card overflow-hidden p-0">
          <div className="grid grid-cols-8 border-b">
            <div className="border-r p-3 text-xs font-medium text-gray-500">Time</div>
            {weekDays.map((day) => (
              <div
                key={day.toISOString()}
                className={`border-r p-3 text-center last:border-r-0 ${
                  isToday(day) ? 'bg-brand-50 dark:bg-brand-950/30' : ''
                }`}
              >
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {day.toLocaleDateString('en-US', { weekday: 'short' })}
                </p>
                <p className={`text-lg font-bold ${
                  isToday(day)
                    ? 'text-brand-600 dark:text-brand-400'
                    : 'text-gray-900 dark:text-white'
                }`}>
                  {day.getDate()}
                </p>
              </div>
            ))}
          </div>

          <div className="max-h-[600px] overflow-y-auto">
            {HOURS.map((hour) => (
              <div key={hour} className="grid grid-cols-8 border-b last:border-b-0">
                <div className="border-r p-3 text-xs text-gray-500">
                  {hour > 12 ? `${hour - 12} PM` : `${hour} AM`}
                </div>
                {weekDays.map((day) => {
                  const dayAppts = getAppointmentsForDay(day).filter((a) => {
                    const aptHour = parseInt(a.startTime.split(':')[0]);
                    return aptHour === hour;
                  });
                  return (
                    <div key={day.toISOString() + hour} className="min-h-[60px] border-r p-1 last:border-r-0">
                      {dayAppts.map((apt) => (
                        <div
                          key={apt.id}
                          className={`mb-1 rounded-md p-1.5 text-xs ${getStatusColor(apt.status)}`}
                        >
                          <p className="truncate font-medium">{apt.clientName}</p>
                          <p className="truncate opacity-75">{apt.serviceName}</p>
                          <p className="opacity-60">{formatTime(apt.startTime)}</p>
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

    </div>
  );
}
