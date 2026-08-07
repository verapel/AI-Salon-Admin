import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Camera } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import SalonInstagramCard from '@/components/developer/SalonInstagramCard';
import { useLanguage } from '@/context/LanguageContext';
import { ApiError, api } from '@/lib/api';
import type { DeveloperInstagramIntegration } from '@/types';

interface InstagramIntegrationsTabProps {
  refreshKey?: number;
}

export default function InstagramIntegrationsTab({
  refreshKey = 0,
}: InstagramIntegrationsTabProps) {
  const { t } = useLanguage();
  const [integrations, setIntegrations] = useState<DeveloperInstagramIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<DeveloperInstagramIntegration | null>(
    null
  );
  const [disconnectSubmitting, setDisconnectSubmitting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

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

  async function handleDisconnect() {
    if (!disconnectTarget || disconnectSubmitting) return;
    setDisconnectSubmitting(true);
    setDisconnectError(null);
    try {
      await api.developer.disconnectInstagram(disconnectTarget.salonId);
      setDisconnectOpen(false);
      setDisconnectTarget(null);
      loadIntegrations();
    } catch (err) {
      if (err instanceof ApiError) {
        setDisconnectError(t('developer.integrations.instagram.genericError'));
      } else {
        setDisconnectError(t('developer.integrations.instagram.genericError'));
      }
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

      <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integration) => (
          <SalonInstagramCard
            key={integration.salonId}
            integration={integration}
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
