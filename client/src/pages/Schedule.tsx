import { useCallback, useEffect, useState } from 'react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import WeeklyHoursEditor from '@/components/schedule/WeeklyHoursEditor';
import ExceptionsPanel from '@/components/schedule/ExceptionsPanel';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import {
  dayEditsToPayload,
  emptyWeekOpen,
  rowsToDayEdits,
  type DayHoursEdit,
  validateWeeklyHours,
} from '@/lib/scheduleUi';
import type { CreateScheduleExceptionInput, ScheduleException } from '@/types';

const VALIDATION_KEY: Record<string, TranslationKey> = {
  missingTimes: 'schedule.error.missingTimes',
  closeAfterOpen: 'schedule.error.closeAfterOpen',
};

export default function Schedule() {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<DayHoursEdit[]>(emptyWeekOpen);
  const [exceptions, setExceptions] = useState<ScheduleException[]>([]);
  const [hoursError, setHoursError] = useState('');
  const [hoursSuccess, setHoursSuccess] = useState('');
  const [savingHours, setSavingHours] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [weekly, allExceptions] = await Promise.all([
        api.schedule.getWeekly(),
        api.schedule.getExceptions(),
      ]);
      setDays(rowsToDayEdits(weekly.salon));
      setExceptions(allExceptions.filter((ex) => ex.scope === 'salon'));
    } catch (err) {
      console.error(err);
      setHoursError(err instanceof Error ? err.message : t('schedule.error.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const saveHours = async () => {
    if (savingHours) return;
    const validation = validateWeeklyHours(days);
    if (validation) {
      setHoursError(t(VALIDATION_KEY[validation] ?? 'schedule.error.generic'));
      setHoursSuccess('');
      return;
    }
    setSavingHours(true);
    setHoursError('');
    setHoursSuccess('');
    try {
      const updated = await api.schedule.putSalonWeekly(dayEditsToPayload(days));
      setDays(rowsToDayEdits(updated));
      setHoursSuccess(t('schedule.saved'));
    } catch (err) {
      console.error(err);
      setHoursError(err instanceof Error ? err.message : t('schedule.error.generic'));
    } finally {
      setSavingHours(false);
    }
  };

  const createException = async (input: CreateScheduleExceptionInput) => {
    const created = await api.schedule.createException(input);
    setExceptions((prev) => [...prev, created].sort((a, b) => a.startDate.localeCompare(b.startDate)));
  };

  const deleteException = async (id: string) => {
    await api.schedule.deleteException(id);
    setExceptions((prev) => prev.filter((ex) => ex.id !== id));
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-8 overflow-x-clip">
      <section className="card space-y-4 p-4 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('schedule.salonHours')}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('schedule.salonHoursHint')}
          </p>
        </div>

        <WeeklyHoursEditor days={days} onChange={setDays} disabled={savingHours} />

        {hoursError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {hoursError}
          </p>
        )}
        {hoursSuccess && (
          <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-300">
            {hoursSuccess}
          </p>
        )}

        <button
          type="button"
          className="btn-primary w-full sm:w-auto"
          disabled={savingHours}
          onClick={saveHours}
        >
          {savingHours ? t('common.saving') : t('schedule.saveHours')}
        </button>
      </section>

      <section className="card space-y-4 p-4 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('schedule.salonExceptions')}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('schedule.salonExceptionsHint')}
          </p>
        </div>

        <ExceptionsPanel
          exceptions={exceptions}
          kindOptions={['holiday', 'closed', 'custom_hours']}
          scope="salon"
          onCreate={createException}
          onDelete={deleteException}
        />
      </section>
    </div>
  );
}
