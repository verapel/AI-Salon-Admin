import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bot } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import DeveloperTelegramManageModal, {
  type TelegramManageSaveParams,
} from '@/components/developer/DeveloperTelegramManageModal';
import EditSalonNameModal from '@/components/developer/EditSalonNameModal';
import SalonTelegramCard from '@/components/developer/SalonTelegramCard';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { DeveloperTelegramIntegration } from '@/types';

interface TelegramIntegrationsTabProps {
  refreshKey?: number;
  connecting: boolean;
  connectError: string;
  onConnect: (params: {
    salonName?: string;
    salonId?: string;
    token: string;
    botDisplayName?: string;
  }) => Promise<boolean>;
  onUpdateMetadata: (
    salonId: string,
    params: { salonName?: string; botDisplayName?: string }
  ) => Promise<boolean>;
  onClearError: () => void;
}

export default function TelegramIntegrationsTab({
  refreshKey = 0,
  connecting,
  connectError,
  onConnect,
  onUpdateMetadata,
  onClearError,
}: TelegramIntegrationsTabProps) {
  const { t } = useLanguage();
  const [integrations, setIntegrations] = useState<DeveloperTelegramIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [manageModalOpen, setManageModalOpen] = useState(false);
  const [editNameModalOpen, setEditNameModalOpen] = useState(false);
  const [managing, setManaging] = useState<DeveloperTelegramIntegration | null>(null);
  const [editing, setEditing] = useState<DeveloperTelegramIntegration | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

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

  function openManage(integration: DeveloperTelegramIntegration) {
    onClearError();
    setManaging(integration);
    setManageModalOpen(true);
  }

  function openEditSalonName(integration: DeveloperTelegramIntegration) {
    setEditError('');
    setEditing(integration);
    setEditNameModalOpen(true);
  }

  function closeManageModal() {
    setManageModalOpen(false);
    setManaging(null);
    onClearError();
  }

  function closeEditModal() {
    setEditNameModalOpen(false);
    setEditing(null);
    setEditError('');
  }

  async function handleManageSave(params: TelegramManageSaveParams) {
    if (!managing) return false;

    if (params.token) {
      const success = await onConnect({
        salonId: managing.salonId,
        salonName: params.salonName,
        token: params.token,
        botDisplayName: params.botDisplayName,
      });
      if (success) loadIntegrations();
      return success;
    }

    const success = await onUpdateMetadata(managing.salonId, {
      salonName: params.salonName,
      botDisplayName: params.botDisplayName,
    });
    if (success) loadIntegrations();
    return success;
  }

  async function handleEditSalonNameSave(salonName: string) {
    if (!editing) return false;

    setEditSaving(true);
    setEditError('');
    try {
      const success = await onUpdateMetadata(editing.salonId, { salonName });
      if (success) loadIntegrations();
      return success;
    } catch (err) {
      setEditError(err instanceof Error ? err.message : t('developer.integrations.updateFailed'));
      return false;
    } finally {
      setEditSaving(false);
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
        icon={<Bot className="h-8 w-8 text-gray-400" />}
        title={t('developer.integrations.emptyTitle')}
        description={t('developer.integrations.emptyDesc')}
      />
    );
  }

  return (
    <>
      <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integration) => (
          <SalonTelegramCard
            key={integration.salonId}
            integration={integration}
            onEditSalonName={() => openEditSalonName(integration)}
            onManage={() => openManage(integration)}
          />
        ))}
      </div>

      <DeveloperTelegramManageModal
        open={manageModalOpen}
        onClose={closeManageModal}
        integration={managing}
        connecting={connecting}
        connectError={connectError}
        onSave={handleManageSave}
        onClearError={onClearError}
      />

      <EditSalonNameModal
        open={editNameModalOpen}
        initialName={editing?.salonName ?? ''}
        saving={editSaving}
        saveError={editError}
        onClose={closeEditModal}
        onSave={handleEditSalonNameSave}
        onClearError={() => setEditError('')}
      />
    </>
  );
}
