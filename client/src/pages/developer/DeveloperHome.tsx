import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Plug, Activity, ArrowRight, AlertCircle } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { DeveloperHealth, DeveloperSalon } from '@/types';

interface OverviewCardProps {
  to: string;
  icon: typeof Building2;
  title: string;
  value: string;
  subtitle: string;
}

function OverviewCard({ to, icon: Icon, title, value, subtitle }: OverviewCardProps) {
  return (
    <Link
      to={to}
      className="card group flex min-h-[120px] min-w-0 flex-col justify-between p-4 transition-colors hover:border-violet-200 dark:hover:border-violet-800 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-950/50">
          <Icon className="h-5 w-5 text-violet-600 dark:text-violet-400" />
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5" />
      </div>
      <div className="mt-3">
        <p className="text-sm text-gray-500 dark:text-gray-400">{title}</p>
        <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
      </div>
    </Link>
  );
}

export default function DeveloperHome() {
  const { t } = useLanguage();
  const [salons, setSalons] = useState<DeveloperSalon[]>([]);
  const [health, setHealth] = useState<DeveloperHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    Promise.all([api.developer.getSalons(), api.developer.getHealth()])
      .then(([salonData, healthData]) => {
        setSalons(salonData);
        setHealth(healthData);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3">
        <LoadingSpinner />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('developer.home.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card flex w-full min-w-0 max-w-full items-start gap-3 border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30 sm:p-5">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <p className="text-sm text-red-700 dark:text-red-300">{t('developer.home.error')}</p>
      </div>
    );
  }

  const activeCount = salons.filter((s) => s.active).length;
  const totalClients = salons.reduce((sum, s) => sum + s.clientCount, 0);
  const totalAppointments = salons.reduce((sum, s) => sum + s.appointmentCount, 0);

  const systemOk =
    health?.api.status === 'ok' &&
    health.supabase.status === 'connected' &&
    health.telegram.status === 'connected';

  const telegramLabel =
    health?.telegram.status === 'connected'
      ? `@${health.telegram.bot}`
      : health?.telegram.status === 'error'
        ? t('developer.health.telegramError')
        : t('developer.health.telegramNotConnected');

  return (
    <div className="w-full min-w-0 max-w-full space-y-6 overflow-x-clip animate-fade-in">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('developer.home.description')}</p>

      <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <OverviewCard
          to="/developer/salons"
          icon={Building2}
          title={t('developer.nav.salons')}
          value={String(salons.length)}
          subtitle={`${activeCount} ${t('developer.home.activeLabel')}`}
        />
        <OverviewCard
          to="/developer/integrations"
          icon={Plug}
          title={t('developer.nav.integrations')}
          value={telegramLabel}
          subtitle={t('developer.home.integrationsSubtitle')}
        />
        <OverviewCard
          to="/developer/health"
          icon={Activity}
          title={t('developer.nav.health')}
          value={systemOk ? t('developer.health.allOk') : t('developer.health.issues')}
          subtitle={health ? `v${health.version}` : '—'}
        />
      </div>

      <div className="card w-full min-w-0 max-w-full p-4 sm:p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          {t('developer.home.platformStats')}
        </h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">{t('developer.salons.clientCount')}</dt>
            <dd className="mt-1 text-xl font-bold text-gray-900 dark:text-white">{totalClients}</dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">{t('developer.salons.appointmentCount')}</dt>
            <dd className="mt-1 text-xl font-bold text-gray-900 dark:text-white">{totalAppointments}</dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">{t('developer.salons.status')}</dt>
            <dd className="mt-1 text-xl font-bold text-gray-900 dark:text-white">
              {activeCount} / {salons.length}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
