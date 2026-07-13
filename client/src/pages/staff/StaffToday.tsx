import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLanguage } from '@/context/LanguageContext';
import type { StaffPortalAppointment } from '@/types';
import StaffAppointmentCard from './StaffAppointmentCard';
import { todayIso } from './dateUtils';

export default function StaffToday() {
  const { t } = useLanguage();
  const [staffName, setStaffName] = useState('');
  const [appointments, setAppointments] = useState<StaffPortalAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const day = todayIso();
    try {
      const [me, list] = await Promise.all([
        api.staffPortal.getMe(),
        api.staffPortal.getAppointments({ from: day, to: day }),
      ]);
      setStaffName(me.staffName);
      setAppointments(list);
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

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
        <p className="text-sm text-red-700 dark:text-red-300">{t('staffPortal.error.load')}</p>
        <button type="button" onClick={() => void load()} className="btn-primary mt-3">
          {t('staffPortal.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t('staffPortal.today.title')}
        </h1>
        {staffName ? (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{staffName}</p>
        ) : null}
      </div>

      {appointments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          {t('staffPortal.today.empty')}
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
