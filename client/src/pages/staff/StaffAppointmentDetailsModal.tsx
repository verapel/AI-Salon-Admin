import type { StaffPortalAppointment } from '@/types';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { getStatusColor } from '@/lib/utils';
import { formatTime24 } from './dateUtils';

function statusKey(status: string): TranslationKey {
  return `appointmentStatus.${status}` as TranslationKey;
}

export default function StaffAppointmentDetailsModal({
  apt,
  onClose,
}: {
  apt: StaffPortalAppointment;
  onClose: () => void;
}) {
  const { t, language } = useLanguage();
  const locale = language === 'ru' ? 'ru-RU' : language === 'hy' ? 'hy-AM' : 'en-US';
  const start = formatTime24(apt.startTime);
  const end = formatTime24(apt.endTime);
  const timeLabel = start && end ? `${start} – ${end}` : start || end || '—';
  const phone = apt.clientPhone?.trim();
  const notes = apt.notes?.trim();

  let dateLabel = apt.date;
  try {
    const d = new Date(apt.date + 'T12:00:00');
    if (!Number.isNaN(d.getTime())) {
      dateLabel = d.toLocaleDateString(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    }
  } catch {
    /* keep raw date */
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-apt-details-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="staff-apt-details-title"
          className="text-lg font-semibold text-gray-900 dark:text-white"
        >
          {t('staffPortal.calendar.detailsTitle')}
        </h2>

        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('staffPortal.calendar.field.date')}
            </dt>
            <dd className="mt-0.5 text-gray-900 dark:text-gray-100">{dateLabel}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('staffPortal.calendar.field.time')}
            </dt>
            <dd className="mt-0.5 tabular-nums text-gray-900 dark:text-gray-100">{timeLabel}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('staffPortal.calendar.field.client')}
            </dt>
            <dd className="mt-0.5 text-gray-900 dark:text-gray-100">{apt.clientName || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('staffPortal.calendar.field.service')}
            </dt>
            <dd className="mt-0.5 text-gray-900 dark:text-gray-100">{apt.serviceName || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('staffPortal.calendar.field.phone')}
            </dt>
            <dd className="mt-0.5 text-gray-900 dark:text-gray-100">
              {phone || t('staffPortal.phoneMissing')}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('staffPortal.calendar.field.status')}
            </dt>
            <dd className="mt-1">
              <span className={`badge text-xs ${getStatusColor(apt.status)}`}>
                {t(statusKey(apt.status))}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('staffPortal.calendar.field.notes')}
            </dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-gray-900 dark:text-gray-100">
              {notes || '—'}
            </dd>
          </div>
        </dl>

        <div className="mt-5 flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            {t('staffPortal.calendar.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
