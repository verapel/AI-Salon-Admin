import { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import TelegramConnectModal from '@/components/developer/TelegramConnectModal';
import SalonTelegramCard from '@/components/developer/SalonTelegramCard';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { DeveloperTelegramIntegration } from '@/types';
import type { TelegramBotInfo, TelegramConnectionStatus } from '@/hooks/useTelegramConnection';

interface TelegramIntegrationsTabProps {
  refreshKey?: number;
  status: TelegramConnectionStatus;
  botInfo: TelegramBotInfo | null;
  connecting: boolean;
  connectError: string;
  onConnect: (token: string) => Promise<boolean>;
  onClearError: () => void;
}

export default function TelegramIntegrationsTab({
  refreshKey = 0,
  status,
  botInfo,
  connecting,
  connectError,
  onConnect,
  onClearError,
}: TelegramIntegrationsTabProps) {
  const { t } = useLanguage();
  const [integrations, setIntegrations] = useState<DeveloperTelegramIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const loadIntegrations = useCallback(() => {
    setError(false);
    setLoading(true);
    api.developer
      .getTelegramIntegrations()
      .then(setIntegrations)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations, refreshKey]);

  function openManage() {
    onClearError();
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    onClearError();
  }

  async function handleConnect(token: string) {
    const success = await onConnect(token);
    if (success) {
      loadIntegrations();
    }
    return success;
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

  return (
    <>
      <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integration) => (
          <SalonTelegramCard
            key={integration.salonId}
            integration={integration}
            onManage={openManage}
          />
        ))}
      </div>

      <TelegramConnectModal
        open={modalOpen}
        onClose={closeModal}
        status={status}
        botInfo={botInfo}
        connecting={connecting}
        connectError={connectError}
        onConnect={handleConnect}
        onClearError={onClearError}
      />
    </>
  );
}
