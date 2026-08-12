import { Camera } from 'lucide-react';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import type { DeveloperInstagramIntegration, InstagramConnectionStatus } from '@/types';

interface SalonInstagramCardProps {
  integration: DeveloperInstagramIntegration;
  connecting?: boolean;
  connectError?: string | null;
  onConnect: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

const WEBHOOK_PATH = '/api/webhooks/instagram';

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
      return 'developer.integrations.instagram.reconnectRequired';
    case 'disabled':
      return 'developer.integrations.status.disabled';
    default:
      return 'developer.integrations.status.notConnected';
  }
}

function formatTokenExpiry(
  expiresAt: string | null | undefined,
  t: (key: TranslationKey) => string,
): string {
  if (!expiresAt) return t('developer.integrations.instagram.tokenExpiryUnknown');
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return t('developer.integrations.instagram.tokenExpiryUnknown');
  if (ms <= Date.now()) return t('developer.integrations.instagram.tokenExpired');
  return new Date(ms).toLocaleString();
}

export default function SalonInstagramCard({
  integration,
  connecting = false,
  connectError = null,
  onConnect,
  onReconnect,
  onDisconnect,
}: SalonInstagramCardProps) {
  const { t } = useLanguage();
  const connection = integration.connection;
  const status = connection?.status ?? 'not_connected';
  const canDisconnect =
    Boolean(connection) && (status === 'connected' || status === 'error' || status === 'disabled');
  const isConnected = integration.connected || status === 'connected';
  const needsReconnect = status === 'error';
  const outboundEnabled = integration.outboundEnabled === true;
  const webhookSeen = Boolean(connection?.lastWebhookAt);

  return (
    <div className="card flex w-full min-w-0 max-w-full flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-100 dark:bg-rose-950/50">
            <Camera className="h-5 w-5 text-rose-600 dark:text-rose-400" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
              {t('developer.integrations.instagram.title')}
            </p>
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

      {connection && (isConnected || needsReconnect) ? (
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
              {t('developer.integrations.instagram.updatedAt')}
            </dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.updatedAt
                ? new Date(connection.updatedAt).toLocaleString()
                : '—'}
            </dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.tokenExpires')}
            </dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {formatTokenExpiry(connection.tokenExpiresAt, t)}
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

      <div className="mt-4 space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900/40">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('developer.integrations.instagram.messagingSection')}
          </p>
          <div className="mt-2 flex min-w-0 justify-between gap-3">
            <span className="text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.outbound')}
            </span>
            <span className="font-medium text-gray-900 dark:text-gray-200">
              {outboundEnabled
                ? t('developer.integrations.instagram.outboundEnabled')
                : t('developer.integrations.instagram.outboundDisabled')}
            </span>
          </div>
          {!outboundEnabled ? (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.outboundDisabledHint')}
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('developer.integrations.instagram.technicalSection')}
          </p>
          <div className="mt-2 flex min-w-0 justify-between gap-3">
            <span className="text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.webhook')}
            </span>
            <span className="text-right font-medium text-gray-900 dark:text-gray-200">
              {webhookSeen
                ? t('developer.integrations.instagram.webhookActivitySeen')
                : t('developer.integrations.instagram.webhookReady')}
            </span>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-gray-500 dark:text-gray-400">
            {WEBHOOK_PATH}
          </p>
          {webhookSeen && connection?.lastWebhookAt ? (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('developer.integrations.instagram.lastWebhookAt')}:{' '}
              {new Date(connection.lastWebhookAt).toLocaleString()}
            </p>
          ) : null}
        </div>
      </div>

      {connectError ? (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{connectError}</p>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
        {isConnected || needsReconnect ? (
          <button
            type="button"
            className="btn-secondary w-full sm:w-auto"
            disabled={connecting}
            onClick={onReconnect}
          >
            {connecting
              ? t('developer.integrations.instagram.connecting')
              : t('developer.integrations.instagram.reconnect')}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            disabled={connecting}
            onClick={onConnect}
          >
            {connecting
              ? t('developer.integrations.instagram.connecting')
              : t('developer.integrations.instagram.connect')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary w-full sm:w-auto"
          disabled={!canDisconnect || connecting}
          onClick={onDisconnect}
        >
          {t('developer.integrations.instagram.disconnect')}
        </button>
      </div>
    </div>
  );
}
