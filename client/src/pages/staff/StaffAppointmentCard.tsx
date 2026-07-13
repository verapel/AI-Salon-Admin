import type { StaffPortalAppointment } from '@/types';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';

function statusKey(status: string): TranslationKey {
  const key = `appointmentStatus.${status}` as TranslationKey;
  return key;
}

export default function StaffAppointmentCard({ apt }: { apt: StaffPortalAppointment }) {
  const { t } = useLanguage();
  const phone = apt.clientPhone?.trim();
  const notes = apt.notes?.trim();

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-white">
            {apt.startTime} – {apt.endTime}
          </p>
          <p className="mt-1 text-base font-medium text-gray-800 dark:text-gray-100">{apt.clientName}</p>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{apt.serviceName}</p>
        </div>
        <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
          {t(statusKey(apt.status))}
        </span>
      </div>
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
        {phone || t('staffPortal.phoneMissing')}
      </p>
      {notes ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-gray-500 dark:text-gray-400">{notes}</p>
      ) : null}
    </article>
  );
}
