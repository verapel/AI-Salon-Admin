import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WeeklyHoursEditor from '@/components/schedule/WeeklyHoursEditor';
import ExceptionsPanel from '@/components/schedule/ExceptionsPanel';
import { api } from '@/lib/api';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import {
  dayEditsToPayload,
  emptyWeekOpen,
  formatExceptionRange,
  rowsToDayEdits,
  type DayHoursEdit,
  validateWeeklyHours,
} from '@/lib/scheduleUi';
import type {
  CreateScheduleExceptionInput,
  ScheduleException,
  StaffPortalCreateExceptionInput,
  StaffPortalSchedule,
  WeeklyHoursRow,
} from '@/types';

const HOURS_VALIDATION_KEY: Record<string, TranslationKey> = {
  missingTimes: 'schedule.error.missingTimes',
  closeAfterOpen: 'schedule.error.closeAfterOpen',
};

const TOAST_MS = 3500;

/** Stable snapshot for dirty comparison (matches PUT body shape). */
function daysSnapshot(days: DayHoursEdit[]): string {
  return JSON.stringify(dayEditsToPayload(days));
}

/**
 * Map GET schedule into editor days.
 * staffWeekly: [] → inherit salon (or legacy fallback if salon also empty).
 * Does not invent open days for missing weekdays when configured rows exist.
 */
function scheduleToEditorDays(schedule: StaffPortalSchedule): DayHoursEdit[] {
  if (schedule.staffWeekly.length > 0) {
    return rowsToDayEdits(schedule.staffWeekly);
  }
  if (schedule.salonWeekly.length > 0) {
    return rowsToDayEdits(schedule.salonWeekly);
  }
  return emptyWeekOpen();
}

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
  const [days, setDays] = useState<DayHoursEdit[]>(emptyWeekOpen);
  const [baselineSnapshot, setBaselineSnapshot] = useState(() => daysSnapshot(emptyWeekOpen()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [hoursError, setHoursError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const applySchedule = useCallback((schedule: StaffPortalSchedule) => {
    const nextDays = scheduleToEditorDays(schedule);
    setData(schedule);
    setDays(nextDays);
    setBaselineSnapshot(daysSnapshot(nextDays));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    setActionError('');
    try {
      applySchedule(await api.staffPortal.getSchedule());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [applySchedule]);

  const refreshSchedule = useCallback(async () => {
    applySchedule(await api.staffPortal.getSchedule());
  }, [applySchedule]);

  useEffect(() => {
    void load();
  }, [load]);

  const isInherited = (data?.staffWeekly.length ?? 0) === 0;
  const usesSystemFallback =
    isInherited && (data?.salonWeekly.length ?? 0) === 0;
  const isDirty = useMemo(
    () => daysSnapshot(days) !== baselineSnapshot,
    [days, baselineSnapshot]
  );

  const saveHours = async () => {
    if (savingHours || !isDirty) return;
    const validation = validateWeeklyHours(days);
    if (validation) {
      setHoursError(t(HOURS_VALIDATION_KEY[validation] ?? 'schedule.error.generic'));
      return;
    }

    const hours = dayEditsToPayload(days);
    if (hours.length !== 7) {
      setHoursError(t('schedule.error.generic'));
      return;
    }

    setSavingHours(true);
    setHoursError('');
    setActionError('');
    try {
      await api.staffPortal.putWeekly(hours);
      await refreshSchedule();
      showToast(t('schedule.saved'));
    } catch (err) {
      console.error(err);
      setHoursError(err instanceof Error ? err.message : t('schedule.error.generic'));
    } finally {
      setSavingHours(false);
    }
  };

  const createException = async (input: CreateScheduleExceptionInput) => {
    setActionError('');
    const kind = input.kind;
    if (kind !== 'closed' && kind !== 'vacation' && kind !== 'custom_hours') {
      throw new Error(t('schedule.error.generic'));
    }
    const body: StaffPortalCreateExceptionInput = {
      kind,
      startDate: input.startDate,
      endDate: input.endDate,
      openTime: kind === 'custom_hours' ? input.openTime ?? null : null,
      closeTime: kind === 'custom_hours' ? input.closeTime ?? null : null,
      note: input.note ?? null,
    };
    await api.staffPortal.createException(body);
    await refreshSchedule();
    showToast(t('staffPortal.schedule.exceptionAdded'));
  };

  const deleteException = async (id: string) => {
    setActionError('');
    try {
      await api.staffPortal.deleteException(id);
      await refreshSchedule();
      showToast(t('staffPortal.schedule.exceptionDeleted'));
    } catch (err) {
      console.error(err);
      setActionError(err instanceof Error ? err.message : t('schedule.error.generic'));
      throw err;
    }
  };

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

  const salonWeekly = [...data.salonWeekly].sort((a, b) => a.weekday - b.weekday);
  const salonExceptions = data.exceptions.filter((ex) => ex.scope === 'salon');
  const staffExceptions = data.exceptions.filter((ex) => ex.scope === 'staff');
  const busy = savingHours;

  return (
    <div className="w-full min-w-0 max-w-full space-y-6 overflow-x-clip">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t('staffPortal.schedule.title')}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('staffPortal.schedule.subtitle')}
        </p>
      </div>

      {toast ? (
        <div
          className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {actionError}
        </div>
      ) : null}

      <section className="min-w-0 space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.myHours')}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.myHoursHint')}
          </p>
        </div>

        {isInherited && !usesSystemFallback ? (
          <div
            className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100"
            role="status"
          >
            <p className="font-medium">{t('staffPortal.schedule.inheritedBadge')}</p>
            <p className="mt-1 text-xs text-sky-800 dark:text-sky-200/90">
              {t('staffPortal.schedule.inheritedHint')}
            </p>
          </div>
        ) : null}

        {usesSystemFallback ? (
          <div
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
            role="status"
          >
            <p className="font-medium">{t('staffPortal.schedule.fallbackBadge')}</p>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-200/90">
              {t('staffPortal.schedule.fallbackHint')}
            </p>
          </div>
        ) : null}

        <WeeklyHoursEditor days={days} onChange={setDays} disabled={busy} />
        {hoursError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {hoursError}
          </p>
        ) : null}
        <button
          type="button"
          className="btn-primary w-full sm:w-auto"
          disabled={busy || !isDirty}
          onClick={() => void saveHours()}
        >
          {savingHours ? t('common.saving') : t('schedule.saveHours')}
        </button>
      </section>

      <section className="min-w-0 space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.myExceptions')}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.myExceptionsHint')}
          </p>
        </div>
        <ExceptionsPanel
          exceptions={staffExceptions}
          kindOptions={['vacation', 'closed', 'custom_hours']}
          scope="staff"
          authScoped
          canDelete={(ex) => ex.scope === 'staff'}
          onCreate={createException}
          onDelete={deleteException}
          busy={busy}
        />
      </section>

      <section className="min-w-0 space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('staffPortal.schedule.salonHours')}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('staffPortal.schedule.salonHoursHint')}
        </p>
        {salonWeekly.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.emptyHours')}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
            {salonWeekly.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <span className="font-medium text-gray-800 dark:text-gray-100">
                  {weekdayLabel(row.weekday, t)}
                </span>
                <span className="shrink-0 text-gray-600 dark:text-gray-400">
                  {formatHoursRow(row, t)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {salonExceptions.length > 0 ? (
        <section className="min-w-0 space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.salonExceptions')}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('staffPortal.schedule.salonExceptionsHint')}
          </p>
          <ul className="space-y-2">
            {salonExceptions.map((ex) => (
              <li
                key={ex.id}
                className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm dark:border-gray-800 dark:bg-gray-900"
              >
                <p className="font-medium text-gray-900 dark:text-white">
                  {kindLabel(ex.kind, t)}
                  <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
                    {formatExceptionRange(ex)}
                  </span>
                </p>
                {ex.kind === 'custom_hours' && ex.openTime && ex.closeTime ? (
                  <p className="mt-1 text-gray-600 dark:text-gray-400">
                    {ex.openTime} – {ex.closeTime}
                  </p>
                ) : null}
                {ex.note ? (
                  <p className="mt-1 text-gray-500 dark:text-gray-400">{ex.note}</p>
                ) : null}
                <p className="mt-1 text-xs text-gray-400">{t('staffPortal.schedule.salonWide')}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
