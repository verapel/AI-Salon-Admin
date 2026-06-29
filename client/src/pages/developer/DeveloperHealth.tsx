import { useEffect, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, Server, Database, Bot } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DeveloperHealth } from '@/types';

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        ok ? 'bg-green-500' : 'bg-red-500'
      )}
    />
  );
}

interface HealthRowProps {
  icon: typeof Server;
  label: string;
  value: string;
  ok: boolean;
  detail?: string;
}

function HealthRow({ icon: Icon, label, value, ok, detail }: HealthRowProps) {
  return (
    <div className="flex min-w-0 items-start gap-3 border-b border-gray-100 py-4 last:border-0 dark:border-gray-800">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
        <Icon className="h-5 w-5 text-gray-600 dark:text-gray-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusDot ok={ok} />
          <p className="font-medium text-gray-900 dark:text-white">{label}</p>
        </div>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300">{value}</p>
        {detail && (
          <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{detail}</p>
        )}
      </div>
    </div>
  );
}

export default function DeveloperHealth() {
  const { t } = useLanguage();
  const [health, setHealth] = useState<DeveloperHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.developer
      .getHealth()
      .then(setHealth)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3">
        <LoadingSpinner />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('developer.health.loading')}</p>
      </div>
    );
  }

  if (error || !health) {
    return (
      <div className="card flex w-full min-w-0 max-w-full items-start gap-3 border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30 sm:p-5">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <p className="text-sm text-red-700 dark:text-red-300">{t('developer.health.error')}</p>
      </div>
    );
  }

  const telegramOk = health.telegram.status === 'connected';
  const supabaseOk = health.supabase.status === 'connected';

  const telegramValue =
    health.telegram.status === 'connected'
      ? t('developer.health.telegramConnected')
      : health.telegram.status === 'error'
        ? t('developer.health.telegramError')
        : t('developer.health.telegramNotConnected');

  const allOk = health.api.status === 'ok' && supabaseOk && telegramOk;

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip animate-fade-in">
      <div
        className={cn(
          'card flex items-center gap-3 p-4 sm:p-5',
          allOk
            ? 'border-green-200 bg-green-50 dark:border-green-900/40 dark:bg-green-950/20'
            : 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20'
        )}
      >
        {allOk ? (
          <CheckCircle2 className="h-6 w-6 shrink-0 text-green-600 dark:text-green-400" />
        ) : (
          <Activity className="h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <div>
          <p className="font-semibold text-gray-900 dark:text-white">
            {allOk ? t('developer.health.allOk') : t('developer.health.issues')}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('developer.health.summary')}</p>
        </div>
      </div>

      <div className="card w-full min-w-0 max-w-2xl px-4 sm:px-5">
        <HealthRow
          icon={Server}
          label={t('developer.health.api')}
          value={t('developer.health.apiOk')}
          ok={health.api.status === 'ok'}
        />
        <HealthRow
          icon={Database}
          label={t('developer.health.supabase')}
          value={
            supabaseOk
              ? t('developer.health.supabaseConnected')
              : t('developer.health.supabaseDisconnected')
          }
          ok={supabaseOk}
        />
        <HealthRow
          icon={Bot}
          label={t('developer.health.telegram')}
          value={telegramValue}
          ok={telegramOk}
          detail={health.telegram.bot ? `@${health.telegram.bot}` : health.telegram.error ?? undefined}
        />
        <HealthRow
          icon={Activity}
          label={t('developer.health.version')}
          value={`v${health.version}`}
          ok
        />
      </div>
    </div>
  );
}
