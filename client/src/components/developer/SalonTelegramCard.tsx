import { Bot } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import IntegrationStatusBadge from '@/components/developer/IntegrationStatusBadge';
import IntegrationHealthBadge from '@/components/developer/IntegrationHealthBadge';
import type { DeveloperTelegramIntegration } from '@/types';
import { DEFAULT_SALON_SLUG } from '@/types';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SalonTelegramCardProps {
  integration: DeveloperTelegramIntegration;
  onEditSalonName: () => void;
  onManage: () => void;
}

export default function SalonTelegramCard({
  integration,
  onEditSalonName,
  onManage,
}: SalonTelegramCardProps) {
  const { t } = useLanguage();
  const isConnected = integration.status === 'connected';
  const isNonDefaultRuntime = integration.slug !== DEFAULT_SALON_SLUG;

  return (
    <div className="card flex w-full min-w-0 max-w-full flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-950/50">
            <Bot className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-gray-900 dark:text-white">
              {integration.salonName}
            </h3>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">
              {t('developer.integrations.slug')}: {integration.slug}
            </p>
          </div>
        </div>
        <IntegrationStatusBadge status={integration.status} />
      </div>

      <dl className="mt-4 grid gap-3 text-sm">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">{t('developer.integrations.healthLabel')}</dt>
          <dd>
            <IntegrationHealthBadge health={integration.health} />
          </dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="shrink-0 text-gray-500 dark:text-gray-400">
            {t('developer.integrations.botDisplayName')}
          </dt>
          <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
            {integration.botDisplayName ?? '—'}
          </dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="shrink-0 text-gray-500 dark:text-gray-400">
            {t('developer.integrations.botUsername')}
          </dt>
          <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
            {integration.botUsername ? `@${integration.botUsername}` : '—'}
          </dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="shrink-0 text-gray-500 dark:text-gray-400">
            {t('developer.integrations.connectedAt')}
          </dt>
          <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
            {formatDateTime(integration.connectedAt)}
          </dd>
        </div>
      </dl>

      {integration.lastError && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {integration.lastError}
        </p>
      )}

      {isNonDefaultRuntime && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          {t('developer.integrations.runtimeFutureNote')}
        </p>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onEditSalonName}
          className="btn-secondary w-full min-h-[44px] sm:flex-1"
        >
          {t('developer.integrations.editSalonName')}
        </button>
        <button type="button" onClick={onManage} className="btn-primary w-full min-h-[44px] sm:flex-1">
          {isConnected ? t('developer.integrations.manageTelegram') : t('developer.integrations.connectTelegram')}
        </button>
      </div>
    </div>
  );
}
