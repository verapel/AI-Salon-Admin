import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Camera } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import SalonInstagramCard from '@/components/developer/SalonInstagramCard';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { ApiError, api } from '@/lib/api';
import type { DeveloperInstagramIntegration } from '@/types';

interface InstagramIntegrationsTabProps {
  refreshKey?: number;
}

function mapStartError(
  code: string | undefined,
  t: (key: TranslationKey) => string,
): string {
  switch (code) {
    case 'INSTAGRAM_NOT_CONFIGURED':
    case 'INSTAGRAM_OAUTH_NOT_CONFIGURED':
      return t('developer.integrations.instagram.notConfigured');
    default:
      return t('developer.integrations.instagram.genericError');
  }
}

function mapOauthBanner(
  result: string | null,
  errorCode: string | null,
  confirmation: string | null,
  t: (key: TranslationKey) => string,
): { tone: 'ok' | 'err' | 'info'; text: string } | null {
  if (result === 'connected') {
    if (confirmation === 'pending') {
      return {
        tone: 'ok',
        text: t('developer.integrations.instagram.oauthConnectedPending'),
      };
    }
    return { tone: 'ok', text: t('developer.integrations.instagram.oauthConnected') };
  }
  if (result === 'cancelled') {
    return { tone: 'info', text: t('developer.integrations.instagram.oauthCancelled') };
  }
  if (result === 'error') {
    switch (errorCode) {
      case 'permission_denied':
        return { tone: 'err', text: t('developer.integrations.instagram.oauthPermissionDenied') };
      case 'account_in_use':
        return { tone: 'err', text: t('developer.integrations.instagram.oauthAccountInUse') };
      case 'not_professional':
        return { tone: 'err', text: t('developer.integrations.instagram.oauthNotProfessional') };
      case 'not_configured':
        return { tone: 'err', text: t('developer.integrations.instagram.notConfigured') };
      default:
        return { tone: 'err', text: t('developer.integrations.instagram.oauthFailed') };
    }
  }
  return null;
}

export default function InstagramIntegrationsTab({
  refreshKey = 0,
}: InstagramIntegrationsTabProps) {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [integrations, setIntegrations] = useState<DeveloperInstagramIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<DeveloperInstagramIntegration | null>(
    null
  );
  const [disconnectSubmitting, setDisconnectSubmitting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const [connectingSalonId, setConnectingSalonId] = useState<string | null>(null);
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(
    null
  );

  const loadIntegrations = useCallback(() => {
    setError(false);
    setLoading(true);
    api.developer
      .getInstagramIntegrations()
      .then(setIntegrations)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations, refreshKey]);

  useEffect(() => {
    const result = searchParams.get('instagram');
    const err = searchParams.get('instagram_error');
    const confirmation = searchParams.get('instagram_confirmation');
    const mapped = mapOauthBanner(result, err, confirmation, t);
    if (!mapped) return;

    setBanner(mapped);
    const next = new URLSearchParams(searchParams);
    next.delete('instagram');
    next.delete('instagram_error');
    next.delete('instagram_registry');
    next.delete('instagram_confirmation');
    if (!next.get('tab')) next.set('tab', 'instagram');
    setSearchParams(next, { replace: true });
    if (result === 'connected') {
      loadIntegrations();
    }
  }, [searchParams, setSearchParams, t, loadIntegrations]);

  async function startConnect(integration: DeveloperInstagramIntegration) {
    if (connectingSalonId) return;
    setConnectingSalonId(integration.salonId);
    setConnectErrors((prev) => {
      const next = { ...prev };
      delete next[integration.salonId];
      return next;
    });
    try {
      const started = await api.developer.startInstagramConnect(integration.salonId);
      if (!started.authorizationUrl) {
        throw new Error('missing authorizationUrl');
      }
      // Full-page navigate to Meta — no token/credential fields in the browser.
      window.location.assign(started.authorizationUrl);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setConnectErrors((prev) => ({
        ...prev,
        [integration.salonId]: mapStartError(code, t),
      }));
      setConnectingSalonId(null);
    }
  }

  async function handleDisconnect() {
    if (!disconnectTarget || disconnectSubmitting) return;
    setDisconnectSubmitting(true);
    setDisconnectError(null);
    try {
      await api.developer.disconnectInstagram(disconnectTarget.salonId);
      setDisconnectOpen(false);
      setDisconnectTarget(null);
      loadIntegrations();
    } catch {
      setDisconnectError(t('developer.integrations.instagram.genericError'));
    } finally {
      setDisconnectSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[240px] flex-col items-center justify-center gap-3">
        <LoadingSpinner />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('developer.integrations.loading')}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card flex w-full min-w-0 max-w-full items-start gap-3 border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30 sm:p-5">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <p className="text-sm text-red-700 dark:text-red-300">{t('developer.integrations.error')}</p>
      </div>
    );
  }

  if (integrations.length === 0) {
    return (
      <EmptyState
        icon={<Camera className="h-8 w-8 text-gray-400" />}
        title={t('developer.integrations.instagram.emptyTitle')}
        description={t('developer.integrations.instagram.emptyDesc')}
      />
    );
  }

  return (
    <>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        {t('developer.integrations.instagram.description')}
      </p>

      {banner ? (
        <div
          className={
            banner.tone === 'ok'
              ? 'mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200'
              : banner.tone === 'info'
                ? 'mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200'
                : 'mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300'
          }
        >
          {banner.text}
        </div>
      ) : null}

      <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integration) => (
          <SalonInstagramCard
            key={integration.salonId}
            integration={integration}
            connecting={connectingSalonId === integration.salonId}
            connectError={connectErrors[integration.salonId] ?? null}
            onConnect={() => void startConnect(integration)}
            onReconnect={() => void startConnect(integration)}
            onDisconnect={() => {
              setDisconnectError(null);
              setDisconnectTarget(integration);
              setDisconnectOpen(true);
            }}
          />
        ))}
      </div>

      <Modal
        open={disconnectOpen}
        onClose={() => {
          if (disconnectSubmitting) return;
          setDisconnectOpen(false);
          setDisconnectTarget(null);
          setDisconnectError(null);
        }}
        title={t('developer.integrations.instagram.disconnect')}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t('developer.integrations.instagram.disconnectConfirm')}
        </p>
        {disconnectTarget ? (
          <p className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
            {disconnectTarget.salonName}
          </p>
        ) : null}
        {disconnectError ? (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{disconnectError}</p>
        ) : null}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="btn-secondary"
            disabled={disconnectSubmitting}
            onClick={() => {
              setDisconnectOpen(false);
              setDisconnectTarget(null);
              setDisconnectError(null);
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={disconnectSubmitting}
            onClick={() => void handleDisconnect()}
          >
            {disconnectSubmitting
              ? t('developer.integrations.instagram.disconnecting')
              : t('developer.integrations.instagram.disconnect')}
          </button>
        </div>
      </Modal>
    </>
  );
}
