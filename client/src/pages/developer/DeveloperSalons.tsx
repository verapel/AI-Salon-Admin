import { useEffect, useState } from 'react';
import { Building2, AlertCircle } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DeveloperSalon } from '@/types';

function formatCreatedAt(iso: string): string {
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

  const fields: { label: string; value: string }[] = [
    { label: t('developer.salons.slug'), value: salon.slug },
    { label: t('developer.salons.timezone'), value: salon.timezone },
    { label: t('developer.salons.country'), value: salon.country || '—' },
    { label: t('developer.salons.currency'), value: salon.currency },
    { label: t('developer.salons.language'), value: salon.language },
    { label: t('developer.salons.createdAt'), value: formatCreatedAt(salon.createdAt) },
  ];

  return (
    <div className="card w-full min-w-0 max-w-full p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-950/50">
            <Building2 className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <h3 className="truncate text-base font-semibold text-gray-900 dark:text-white">
            {salon.name}
          </h3>
        </div>
        <ActiveBadge active={salon.active} />
      </div>

      <dl className="mt-4 grid gap-2.5">
        {fields.map(({ label, value }) => (
          <div key={label} className="flex min-w-0 justify-between gap-3 text-sm">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {value}
            </dd>
          </div>
        ))}
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

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip animate-fade-in">
      {/* Mobile + tablet: cards */}
      <div className="grid gap-4 lg:hidden">
        {salons.map((salon) => (
          <SalonCard key={salon.id} salon={salon} />
        ))}
      </div>

      {/* Desktop: table */}
      <div className="card hidden w-full min-w-0 max-w-full lg:block">
        <div className="w-full min-w-0 overflow-x-auto">
          <table className="w-full min-w-0 table-fixed text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left dark:border-gray-700">
                <th className="w-[18%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.name')}
                </th>
                <th className="w-[12%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.slug')}
                </th>
                <th className="w-[14%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.timezone')}
                </th>
                <th className="w-[8%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.country')}
                </th>
                <th className="w-[8%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.currency')}
                </th>
                <th className="w-[8%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.language')}
                </th>
                <th className="w-[10%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.active')}
                </th>
                <th className="w-[12%] px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  {t('developer.salons.createdAt')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {salons.map((salon) => (
                <tr key={salon.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="truncate px-4 py-3 font-medium text-gray-900 dark:text-white">
                    {salon.name}
                  </td>
                  <td className="truncate px-4 py-3 text-gray-600 dark:text-gray-300">
                    {salon.slug}
                  </td>
                  <td className="truncate px-4 py-3 text-gray-600 dark:text-gray-300">
                    {salon.timezone}
                  </td>
                  <td className="truncate px-4 py-3 text-gray-600 dark:text-gray-300">
                    {salon.country || '—'}
                  </td>
                  <td className="truncate px-4 py-3 text-gray-600 dark:text-gray-300">
                    {salon.currency}
                  </td>
                  <td className="truncate px-4 py-3 text-gray-600 dark:text-gray-300">
                    {salon.language}
                  </td>
                  <td className="px-4 py-3">
                    <ActiveBadge active={salon.active} />
                  </td>
                  <td className="truncate px-4 py-3 text-gray-600 dark:text-gray-300">
                    {formatCreatedAt(salon.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
