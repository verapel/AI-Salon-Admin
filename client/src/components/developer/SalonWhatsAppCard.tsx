import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { DeveloperWhatsAppIntegration } from '@/types';

interface SalonWhatsAppCardProps {
  integration: DeveloperWhatsAppIntegration;
  onConnect: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onPrepare: () => Promise<boolean>;
  preparing?: boolean;
  prepareError?: string | null;
}

export default function SalonWhatsAppCard({
  integration,
  onConnect,
  onReconnect,
  onDisconnect,
  onPrepare,
  preparing = false,
  prepareError = null,
}: SalonWhatsAppCardProps) {
  const { t } = useLanguage();
  const connected = integration.connected;
  const connection = integration.connection;
  const webhookCallbackUrl = connection?.webhookCallbackUrl?.trim() || null;
  const webhookKey = connection?.webhookKey?.trim() || null;
  const needsPrepare = !connection;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  async function handleCopyWebhookUrl() {
    if (!webhookCallbackUrl) return;
    try {
      if (!navigator.clipboard?.writeText) {
        setCopyState('error');
        return;
      }
      await navigator.clipboard.writeText(webhookCallbackUrl);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
    }
  }

  async function handlePrepare() {
    if (preparing || !needsPrepare) return;
    await onPrepare();
  }

  return (
    <div className="card flex w-full min-w-0 max-w-full flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-950/50">
            <MessageCircle className="h-5 w-5 text-violet-600 dark:text-violet-400" />
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
            connected
              ? 'inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
              : 'inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300'
          }
        >
          {connected
            ? t('integrations.whatsapp.connected')
            : t('integrations.whatsapp.disconnected')}
        </span>
      </div>

      {connected && connection ? (
        <dl className="mt-4 grid gap-3 text-sm">
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('integrations.whatsapp.verifiedName')}
            </dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.verifiedName || '—'}
            </dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('integrations.whatsapp.displayPhoneNumber')}
            </dt>
            <dd className="truncate text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.displayPhoneNumber || '—'}
            </dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('integrations.whatsapp.businessAccountId')}
            </dt>
            <dd className="break-all text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.businessAccountId || '—'}
            </dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('integrations.whatsapp.phoneNumberId')}
            </dt>
            <dd className="break-all text-right font-medium text-gray-900 dark:text-gray-200">
              {connection.phoneNumberId || '—'}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          {t('developer.integrations.whatsapp.notConnectedHint')}
        </p>
      )}

      <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('developer.integrations.whatsapp.webhookCallbackUrl')}
        </p>
        {webhookCallbackUrl ? (
          <>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('developer.integrations.whatsapp.webhookCallbackHint')}
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="text"
                readOnly
                value={webhookCallbackUrl}
                className="input-field min-w-0 flex-1 font-mono text-xs"
                aria-label={t('developer.integrations.whatsapp.webhookCallbackUrl')}
              />
              <button
                type="button"
                className="btn-secondary w-full shrink-0 sm:w-auto"
                onClick={() => void handleCopyWebhookUrl()}
              >
                {copyState === 'copied'
                  ? t('developer.integrations.whatsapp.webhookCopied')
                  : t('developer.integrations.whatsapp.webhookCopy')}
              </button>
            </div>
            {copyState === 'error' ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {t('developer.integrations.whatsapp.webhookCopyFailed')}
              </p>
            ) : null}
          </>
        ) : webhookKey ? (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('developer.integrations.whatsapp.webhookAppUrlMissing')}
          </p>
        ) : (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('developer.integrations.whatsapp.webhookUnavailable')}
          </p>
        )}
      </div>

      {prepareError ? (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{prepareError}</p>
      ) : null}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {connected ? (
          <>
            <button
              type="button"
              className="btn-secondary w-full sm:w-auto"
              disabled={preparing}
              onClick={onReconnect}
            >
              {t('integrations.whatsapp.reconnect')}
            </button>
            <button
              type="button"
              className="btn-secondary w-full sm:w-auto"
              disabled={preparing}
              onClick={onDisconnect}
            >
              {t('integrations.whatsapp.disconnect')}
            </button>
          </>
        ) : (
          <>
            {needsPrepare ? (
              <button
                type="button"
                className="btn-secondary w-full sm:w-auto"
                disabled={preparing}
                onClick={() => void handlePrepare()}
              >
                {preparing
                  ? t('developer.integrations.whatsapp.preparing')
                  : t('developer.integrations.whatsapp.prepare')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn-primary w-full sm:w-auto"
              disabled={preparing}
              onClick={onConnect}
            >
              {t('integrations.whatsapp.connect')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
