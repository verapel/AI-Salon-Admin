import { useCallback, useEffect, useState } from 'react';
import { Bell, Mail, MessageSquare } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { useLanguage, type LangCode, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { getStatusColor } from '@/lib/utils';
import type { Reminder } from '@/types';

const LOCALE: Record<LangCode, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  hy: 'hy-AM',
};

type StatusFilter = 'all' | Reminder['status'];

const FILTERS: StatusFilter[] = ['all', 'pending', 'sent', 'failed'];

const FILTER_KEYS: Record<StatusFilter, TranslationKey> = {
  all: 'reminders.filterAll',
  pending: 'reminders.filterPending',
  sent: 'reminders.filterSent',
  failed: 'reminders.filterFailed',
};

const formatTime24 = (time: string) => time.slice(0, 5);

function statusLabel(status: Reminder['status'], t: (key: TranslationKey) => string) {
  return t(`reminders.status.${status}` as TranslationKey);
}

function typeLabel(type: Reminder['type'], t: (key: TranslationKey) => string) {
  return type === 'email' ? t('reminders.typeEmail') : t('reminders.typeSms');
}

export default function Reminders() {
  const { language, t } = useLanguage();
  const locale = LOCALE[language];
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');

  const formatDateLocalized = (dateStr: string) =>
    new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

  const formatScheduledFor = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });

  const loadData = useCallback(() => {
    setError(false);
    api.stats
      .getReminders()
      .then(setReminders)
      .catch((err) => {
        console.error(err);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filtered = filter === 'all' ? reminders : reminders.filter((r) => r.status === filter);

  const emptyTitle =
    reminders.length === 0 ? t('reminders.noReminders') : t('reminders.noResults');

  const emptyDescription =
    reminders.length === 0 ? t('reminders.noRemindersDesc') : t('reminders.noResultsDesc');

  if (loading) return <LoadingSpinner />;

  if (error) {
    return (
      <EmptyState
        icon={<Bell className="h-8 w-8 text-gray-400" />}
        title={t('reminders.loadError')}
        description={t('reminders.loadErrorDesc')}
        action={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              loadData();
            }}
            className="btn-primary"
          >
            {t('reminders.retry')}
          </button>
        }
      />
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === status
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {t(FILTER_KEYS[status])}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-8 w-8 text-gray-400" />}
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((reminder) => (
            <div
              key={reminder.id}
              className="card flex w-full min-w-0 max-w-full items-start gap-3 p-4 hover:shadow-card-hover sm:gap-4 sm:p-6"
            >
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                  reminder.type === 'email'
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400'
                    : 'bg-green-50 text-green-600 dark:bg-green-950/50 dark:text-green-400'
                }`}
              >
                {reminder.type === 'email' ? (
                  <Mail className="h-5 w-5" />
                ) : (
                  <MessageSquare className="h-5 w-5" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-gray-900 dark:text-white">
                      {reminder.clientName}
                    </p>
                    <p className="mt-0.5 line-clamp-2 break-words text-sm text-gray-500 dark:text-gray-400">
                      {reminder.message}
                    </p>
                  </div>
                  <span className={`badge shrink-0 text-xs ${getStatusColor(reminder.status)}`}>
                    {statusLabel(reminder.status, t)}
                  </span>
                </div>

                <div className="mt-2 hidden text-xs text-gray-500 dark:text-gray-400 sm:flex sm:flex-wrap sm:gap-x-3 sm:gap-y-1">
                  {reminder.appointmentDate && reminder.appointmentTime && (
                    <span className="min-w-0 truncate">
                      {t('reminders.appointment')}: {formatDateLocalized(reminder.appointmentDate)}{' '}
                      {t('header.at')} {formatTime24(reminder.appointmentTime)}
                    </span>
                  )}
                  <span>
                    {t('reminders.typeLabel')}: {typeLabel(reminder.type, t)}
                  </span>
                  <span className="min-w-0 truncate">
                    {t('reminders.scheduled')}: {formatScheduledFor(reminder.scheduledFor)}
                  </span>
                </div>

                <div className="mt-2 space-y-0.5 text-xs text-gray-500 dark:text-gray-400 sm:hidden">
                  {reminder.appointmentDate && reminder.appointmentTime && (
                    <p className="truncate">
                      {t('reminders.appointment')}: {formatDateLocalized(reminder.appointmentDate)}{' '}
                      {t('header.at')} {formatTime24(reminder.appointmentTime)}
                    </p>
                  )}
                  <p>
                    {t('reminders.typeLabel')}: {typeLabel(reminder.type, t)}
                  </p>
                  <p className="truncate">
                    {t('reminders.scheduled')}: {formatScheduledFor(reminder.scheduledFor)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
