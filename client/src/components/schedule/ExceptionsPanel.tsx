import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import {
  DEFAULT_CLOSE,
  DEFAULT_OPEN,
  formatExceptionRange,
  validateExceptionForm,
} from '@/lib/scheduleUi';
import type {
  CreateScheduleExceptionInput,
  ScheduleException,
  ScheduleExceptionKind,
} from '@/types';

export type ExceptionKindOption = Extract<
  ScheduleExceptionKind,
  'holiday' | 'closed' | 'vacation' | 'custom_hours'
>;

interface ExceptionsPanelProps {
  exceptions: ScheduleException[];
  kindOptions: ExceptionKindOption[];
  scope: 'salon' | 'staff';
  staffId?: string;
  /** When true, identity comes from auth — staffId not required in the form. */
  authScoped?: boolean;
  /** Defaults to allowing delete for every row. */
  canDelete?: (ex: ScheduleException) => boolean;
  onCreate: (input: CreateScheduleExceptionInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  busy?: boolean;
}

const NOTE_MAX_LENGTH = 500;

const KIND_LABEL: Record<ExceptionKindOption, TranslationKey> = {
  holiday: 'schedule.kind.holiday',
  closed: 'schedule.kind.closed',
  vacation: 'schedule.kind.vacation',
  custom_hours: 'schedule.kind.customHours',
};

const VALIDATION_KEY: Record<string, TranslationKey> = {
  invalidDates: 'schedule.error.invalidDates',
  endBeforeStart: 'schedule.error.endBeforeStart',
  missingTimes: 'schedule.error.missingTimes',
  closeAfterOpen: 'schedule.error.closeAfterOpen',
  noteTooLong: 'schedule.error.noteTooLong',
};

export default function ExceptionsPanel({
  exceptions,
  kindOptions,
  scope,
  staffId,
  authScoped = false,
  canDelete,
  onCreate,
  onDelete,
  busy,
}: ExceptionsPanelProps) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<ExceptionKindOption>(kindOptions[0]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [openTime, setOpenTime] = useState(DEFAULT_OPEN);
  const [closeTime, setCloseTime] = useState(DEFAULT_CLOSE);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const resetForm = () => {
    setKind(kindOptions[0]);
    setStartDate('');
    setEndDate('');
    setOpenTime(DEFAULT_OPEN);
    setCloseTime(DEFAULT_CLOSE);
    setNote('');
    setError('');
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || busy) return;

    const validation = validateExceptionForm({ kind, startDate, endDate, openTime, closeTime });
    if (validation) {
      setError(t(VALIDATION_KEY[validation] ?? 'schedule.error.generic'));
      return;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length > NOTE_MAX_LENGTH) {
      setError(t('schedule.error.noteTooLong'));
      return;
    }
    if (scope === 'staff' && !staffId && !authScoped) {
      setError(t('schedule.error.generic'));
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await onCreate({
        scope,
        staffId: scope === 'staff' && !authScoped ? staffId : null,
        kind,
        startDate,
        endDate,
        openTime: kind === 'custom_hours' ? openTime : null,
        closeTime: kind === 'custom_hours' ? closeTime : null,
        note: trimmedNote || null,
      });
      resetForm();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : t('schedule.error.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('schedule.deleteExceptionConfirm'))) return;
    if (deletingId || busy) return;
    setDeletingId(id);
    try {
      await onDelete(id);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : t('schedule.error.generic'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {exceptions.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('schedule.noExceptions')}</p>
      ) : (
        <ul className="space-y-2">
          {exceptions.map((ex) => (
            <li
              key={ex.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-700"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  {t(KIND_LABEL[ex.kind as ExceptionKindOption] ?? 'schedule.kind.closed')}
                  <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
                    {formatExceptionRange(ex)}
                  </span>
                </p>
                {ex.kind === 'custom_hours' && ex.openTime && ex.closeTime && (
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {ex.openTime} – {ex.closeTime}
                  </p>
                )}
                {ex.note && (
                  <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{ex.note}</p>
                )}
              </div>
              {(canDelete ? canDelete(ex) : true) ? (
                <button
                  type="button"
                  className="btn-ghost shrink-0 p-2 text-red-500"
                  disabled={deletingId === ex.id || busy}
                  onClick={() => handleDelete(ex.id)}
                  aria-label={t('schedule.deleteException')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} className="space-y-3 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-600">
        <p className="text-sm font-medium text-gray-900 dark:text-white">{t('schedule.addException')}</p>

        <div>
          <label className="mb-1.5 block text-sm font-medium">{t('schedule.exceptionType')}</label>
          <select
            className="input-field"
            value={kind}
            disabled={submitting || busy}
            onChange={(e) => setKind(e.target.value as ExceptionKindOption)}
          >
            {kindOptions.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('schedule.startDate')}</label>
            <input
              type="date"
              className="input-field"
              value={startDate}
              required
              disabled={submitting || busy}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('schedule.endDate')}</label>
            <input
              type="date"
              className="input-field"
              value={endDate}
              required
              disabled={submitting || busy}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        {kind === 'custom_hours' && (
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('schedule.openTime')}</label>
              <input
                type="time"
                className="input-field w-auto"
                value={openTime}
                disabled={submitting || busy}
                onChange={(e) => setOpenTime(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('schedule.closeTime')}</label>
              <input
                type="time"
                className="input-field w-auto"
                value={closeTime}
                disabled={submitting || busy}
                onChange={(e) => setCloseTime(e.target.value)}
              />
            </div>
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-sm font-medium">{t('schedule.note')}</label>
          <input
            className="input-field"
            value={note}
            maxLength={NOTE_MAX_LENGTH}
            disabled={submitting || busy}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('schedule.notePlaceholder')}
          />
        </div>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary w-full sm:w-auto" disabled={submitting || busy}>
          {submitting ? t('common.saving') : t('schedule.addException')}
        </button>
      </form>
    </div>
  );
}
