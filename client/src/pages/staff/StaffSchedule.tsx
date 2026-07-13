import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import type { ScheduleException, StaffPortalSchedule, WeeklyHoursRow } from '@/types';

function weekdayLabel(weekday: number, t: (k: TranslationKey) => string): string {
  if (weekday >= 1 && weekday <= 7) {
    return t(`schedule.weekday.${weekday}` as TranslationKey);
  }
  return String(weekday);
}

function kindLabel(kind: ScheduleException['kind'], t: (k: TranslationKey) => string): string {
  if (kind === 'custom_hours') return t('schedule.kind.customHours');
  return t(`schedule.kind.${kind}` as TranslationKey);
}

function formatHoursRow(row: WeeklyHoursRow, t: (k: TranslationKey) => string): string {
  if (row.isClosed) return t('staffPortal.schedule.closed');
  if (row.openTime && row.closeTime) return `${row.openTime} – ${row.closeTime}`;
  return t('staffPortal.schedule.hoursUnknown');
}

export default function StaffSchedule() {
  const { t } = useLanguage();
  const [data, setData] = useState<StaffPortalSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setData(await api.staffPortal.getSchedule());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>;
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
        <p className="text-sm text-red-700 dark:text-red-300">{t('staffPortal.error.load')}</p>
        <button type="button" onClick={() => void load()} className="btn-primary mt-3">
          {t('staffPortal.retry')}
        </button>
      </div>
    );
  }

  const staffWeekly = [...data.staffWeekly].sort((a, b) => a.weekday - b.weekday);
  const salonWeekly = [...data.salonWeekly].sort((a, b) => a.weekday - b.weekday);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t('staffPortal.schedule.title')}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('staffPortal.schedule.subtitle')}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('staffPortal.schedule.myHours')}
        </h2>
        {staffWeekly.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('staffPortal.schedule.emptyHours')}</p>
        ) : (
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
            {staffWeekly.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="font-medium text-gray-800 dark:text-gray-100">
                  {weekdayLabel(row.weekday, t)}
                </span>
                <span className="text-gray-600 dark:text-gray-400">{formatHoursRow(row, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('staffPortal.schedule.salonHours')}
        </h2>
        {salonWeekly.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('staffPortal.schedule.emptyHours')}</p>
        ) : (
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
            {salonWeekly.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="font-medium text-gray-800 dark:text-gray-100">
                  {weekdayLabel(row.weekday, t)}
                </span>
                <span className="text-gray-600 dark:text-gray-400">{formatHoursRow(row, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('staffPortal.schedule.exceptions')}
        </h2>
        {data.exceptions.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.emptyExceptions')}
          </p>
        ) : (
          <ul className="space-y-2">
            {data.exceptions.map((ex) => (
              <li
                key={ex.id}
                className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm dark:border-gray-800 dark:bg-gray-900"
              >
                <p className="font-medium text-gray-900 dark:text-white">{kindLabel(ex.kind, t)}</p>
                <p className="mt-0.5 text-gray-600 dark:text-gray-400">
                  {ex.startDate}
                  {ex.endDate !== ex.startDate ? ` – ${ex.endDate}` : ''}
                  {ex.scope === 'salon' ? ` · ${t('staffPortal.schedule.salonWide')}` : ''}
                </p>
                {ex.kind === 'custom_hours' && ex.openTime && ex.closeTime ? (
                  <p className="mt-1 text-gray-600 dark:text-gray-400">
                    {ex.openTime} – {ex.closeTime}
                  </p>
                ) : null}
                {ex.note ? (
                  <p className="mt-1 text-gray-500 dark:text-gray-400">{ex.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
