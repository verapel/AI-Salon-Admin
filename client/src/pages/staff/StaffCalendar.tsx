import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useLanguage } from '@/context/LanguageContext';
import type { StaffPortalAppointment } from '@/types';
import StaffAppointmentCard from './StaffAppointmentCard';
import { addDaysIso, todayIso } from './dateUtils';

export default function StaffCalendar() {
  const { t } = useLanguage();
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [appointments, setAppointments] = useState<StaffPortalAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setError(false);
    try {
      const list = await api.staffPortal.getAppointments({ from: date, to: date });
      setAppointments(list);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(selectedDate);
  }, [load, selectedDate]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t('staffPortal.calendar.title')}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('staffPortal.calendar.subtitle')}
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900">
        <button
          type="button"
          className="btn-ghost rounded-lg p-2"
          onClick={() => setSelectedDate((d) => addDaysIso(d, -1))}
          aria-label={t('staffPortal.calendar.prevDay')}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => {
            if (e.target.value) setSelectedDate(e.target.value);
          }}
          className="input-field flex-1 text-center"
        />
        <button
          type="button"
          className="btn-ghost rounded-lg p-2"
          onClick={() => setSelectedDate((d) => addDaysIso(d, 1))}
          aria-label={t('staffPortal.calendar.nextDay')}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <button
        type="button"
        className="text-sm font-medium text-brand-700 dark:text-brand-300"
        onClick={() => setSelectedDate(todayIso())}
      >
        {t('staffPortal.calendar.jumpToday')}
      </button>

      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
          <p className="text-sm text-red-700 dark:text-red-300">{t('staffPortal.error.load')}</p>
          <button type="button" onClick={() => void load(selectedDate)} className="btn-primary mt-3">
            {t('staffPortal.retry')}
          </button>
        </div>
      ) : appointments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          {t('staffPortal.calendar.empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {appointments.map((apt) => (
            <li key={apt.id}>
              <StaffAppointmentCard apt={apt} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
