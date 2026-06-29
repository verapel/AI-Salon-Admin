import { useEffect, useState } from 'react';
import { Building2, AlertCircle } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DeveloperSalon } from '@/types';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useLanguage();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
        active
          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
      )}
    >
      {active ? t('developer.salons.active') : t('developer.salons.inactive')}
    </span>
  );
}

function SalonCard({ salon }: { salon: DeveloperSalon }) {
  const { t } = useLanguage();

  return (
    <div className="card w-full min-w-0 max-w-full p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-950/50">
            <Building2 className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <h3 className="truncate text-base font-semibold text-gray-900 dark:text-white">{salon.name}</h3>
        </div>
        <ActiveBadge active={salon.active} />
      </div>

      <dl className="mt-4 grid gap-2.5 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">{t('developer.salons.connectedAt')}</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-200">{formatDate(salon.connectedAt)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">{t('developer.salons.clientCount')}</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-200">{salon.clientCount}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">{t('developer.salons.appointmentCount')}</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-200">{salon.appointmentCount}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function DeveloperSalons() {
  const { t } = useLanguage();
  const [salons, setSalons] = useState<DeveloperSalon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.developer
      .getSalons()
      .then(setSalons)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3">
        <LoadingSpinner />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('developer.salons.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card flex w-full min-w-0 max-w-full items-start gap-3 border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30 sm:p-5">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <p className="text-sm text-red-700 dark:text-red-300">{t('developer.salons.error')}</p>
      </div>
    );
  }

  if (salons.length === 0) {
    return (
      <div className="card w-full min-w-0 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
        {t('developer.salons.empty')}
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip animate-fade-in">
      <div className="grid gap-4 lg:hidden">
        {salons.map((salon) => (
          <SalonCard key={salon.id} salon={salon} />
        ))}
      </div>

      <div className="card hidden w-full min-w-0 max-w-full lg:block">
        <div className="w-full min-w-0 overflow-x-auto">
          <table className="w-full min-w-0 text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left dark:border-gray-700">
                <th className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.name')}
                </th>
                <th className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.status')}
                </th>
                <th className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.connectedAt')}
                </th>
                <th className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.clientCount')}
                </th>
                <th className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.appointmentCount')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {salons.map((salon) => (
                <tr key={salon.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{salon.name}</td>
                  <td className="px-4 py-3">
                    <ActiveBadge active={salon.active} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {formatDate(salon.connectedAt)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{salon.clientCount}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{salon.appointmentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
