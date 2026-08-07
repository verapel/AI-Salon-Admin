import { Camera } from 'lucide-react';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import type { DeveloperInstagramIntegration, InstagramConnectionStatus } from '@/types';

interface SalonInstagramCardProps {
  integration: DeveloperInstagramIntegration;
  onDisconnect: () => void;
}

function maskInstagramUserId(userId: string | null | undefined): string {
  if (typeof userId !== 'string') return '—';
  const trimmed = userId.trim();
  if (!trimmed) return '—';
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function statusLabelKey(status: InstagramConnectionStatus | undefined): TranslationKey {
  switch (status) {
    case 'connected':
      return 'developer.integrations.status.connected';
    case 'error':
      return 'developer.integrations.status.error';
    case 'disabled':
      return 'developer.integrations.status.disabled';
    default:
      return 'developer.integrations.status.notConnected';
  }
}

export default function SalonInstagramCard({
  integration,
  onDisconnect,
}: SalonInstagramCardProps) {
  const { t } = useLanguage();
  const connection = integration.connection;
  const status = connection?.status ?? 'not_connected';
  const canDisconnect =
    Boolean(connection) && (status === 'connected' || status === 'error' || status === 'disabled');

  return (
    <div className="card flex w-full min-w-0 max-w-full flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-100 dark:bg-rose-950/50">
            <Camera className="h-5 w-5 text-rose-600 dark:text-rose-400" />
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
        <span
          className={
            status === 'connected'
              ? 'inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
              : status === 'error'
                ? 'inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/60 dark:text-red-300'
                : 'inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300'
          }
        >
          {t(statusLabelKey(status))}
        </span>
      </div>

      {connection ? (
        <dl className="mt-4 grid gap-3 text-sm">
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.username')}
            </dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.instagramUsername || '—'}
            </dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.professionalAccountId')}
            </dt>
            <dd className="break-all text-right font-medium text-gray-900 dark:text-gray-200">
              {maskInstagramUserId(connection.instagramUserId)}
            </dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('developer.integrations.connectedAt')}
            </dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.connectedAt
                ? new Date(connection.connectedAt).toLocaleString()
                : '—'}
            </dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.lastWebhookAt')}
            </dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.lastWebhookAt
                ? new Date(connection.lastWebhookAt).toLocaleString()
                : '—'}
            </dd>
          </div>
          {connection.lastError ? (
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="shrink-0 text-gray-500 dark:text-gray-400">
                {t('developer.integrations.instagram.lastError')}
              </dt>
              <dd className="break-words text-sm text-red-700 dark:text-red-300">
                {connection.lastError}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          {t('developer.integrations.instagram.notConnectedHint')}
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
        <button
          type="button"
          className="btn-secondary w-full sm:w-auto"
          disabled={!canDisconnect}
          onClick={onDisconnect}
        >
          {t('developer.integrations.instagram.disconnect')}
        </button>
      </div>
    </div>
  );
}
