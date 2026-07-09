import { useCallback, useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
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
import type { CreateScheduleExceptionInput, ScheduleException, Staff } from '@/types';

const VALIDATION_KEY: Record<string, TranslationKey> = {
  missingTimes: 'schedule.error.missingTimes',
  closeAfterOpen: 'schedule.error.closeAfterOpen',
};

interface StaffScheduleModalProps {
  open: boolean;
  staff: Staff | null;
  onClose: () => void;
}

export default function StaffScheduleModal({ open, staff, onClose }: StaffScheduleModalProps) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState<DayHoursEdit[]>(emptyWeekOpen);
  const [exceptions, setExceptions] = useState<ScheduleException[]>([]);
  const [hoursError, setHoursError] = useState('');
  const [hoursSuccess, setHoursSuccess] = useState('');
  const [savingHours, setSavingHours] = useState(false);

  const load = useCallback(async () => {
    if (!staff) return;
    setLoading(true);
    setHoursError('');
    setHoursSuccess('');
    try {
      const [weekly, staffExceptions] = await Promise.all([
        api.schedule.getWeekly(),
        api.schedule.getExceptions({ staffId: staff.id }),
      ]);
      setDays(rowsToDayEdits(weekly.staff[staff.id] ?? []));
      setExceptions(staffExceptions.filter((ex) => ex.scope === 'staff'));
    } catch (err) {
      console.error(err);
      setHoursError(err instanceof Error ? err.message : t('schedule.error.generic'));
    } finally {
      setLoading(false);
    }
  }, [staff, t]);

  useEffect(() => {
    if (open && staff) {
      load();
    }
  }, [open, staff, load]);

  const saveHours = async () => {
    if (!staff || savingHours) return;
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
      const updated = await api.schedule.putStaffWeekly(staff.id, dayEditsToPayload(days));
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
    if (!staff) return;
    const created = await api.schedule.createException({
      ...input,
      scope: 'staff',
      staffId: staff.id,
    });
    setExceptions((prev) => [...prev, created].sort((a, b) => a.startDate.localeCompare(b.startDate)));
  };

  const deleteException = async (id: string) => {
    await api.schedule.deleteException(id);
    setExceptions((prev) => prev.filter((ex) => ex.id !== id));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={staff ? `${t('schedule.staffTitle')} — ${staff.name}` : t('schedule.staffTitle')}
      size="lg"
    >
      {!staff || loading ? (
        <LoadingSpinner />
      ) : (
        <div className="max-h-[70vh] space-y-6 overflow-y-auto pr-1">
          <section className="space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                {t('schedule.staffHours')}
              </h4>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {t('schedule.staffHoursHint')}
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

          <section className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                {t('schedule.staffExceptions')}
              </h4>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {t('schedule.staffExceptionsHint')}
              </p>
            </div>
            <ExceptionsPanel
              exceptions={exceptions}
              kindOptions={['vacation', 'closed', 'custom_hours']}
              scope="staff"
              staffId={staff.id}
              onCreate={createException}
              onDelete={deleteException}
              busy={savingHours}
            />
          </section>
        </div>
      )}
    </Modal>
  );
}
