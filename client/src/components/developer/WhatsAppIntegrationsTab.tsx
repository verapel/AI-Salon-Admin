import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, MessageCircle } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import DeveloperWhatsAppConnectModal from '@/components/developer/DeveloperWhatsAppConnectModal';
import SalonWhatsAppCard from '@/components/developer/SalonWhatsAppCard';
import { useLanguage } from '@/context/LanguageContext';
import type { TranslationKey } from '@/i18n/translations';
import { ApiError, api } from '@/lib/api';
import type { DeveloperWhatsAppIntegration, WhatsAppConnectRequest } from '@/types';

function mapWhatsAppErrorCode(
  code: string | undefined,
  t: (key: TranslationKey) => string
): string {
  switch (code) {
    case 'WHATSAPP_ENCRYPTION_KEY_MISSING':
    case 'WHATSAPP_NOT_CONFIGURED':
      return t('integrations.whatsapp.encryptionNotConfigured');
    case 'WHATSAPP_INVALID_CREDENTIALS':
      return t('integrations.whatsapp.invalidCredentials');
    case 'WHATSAPP_META_API_ERROR':
      return t('integrations.whatsapp.providerUnavailable');
    case 'WHATSAPP_PHONE_NUMBER_NOT_FOUND':
      return t('integrations.whatsapp.phoneNumberNotFound');
    case 'WHATSAPP_WABA_MISMATCH':
      return t('integrations.whatsapp.wabaMismatch');
    case 'WHATSAPP_PHONE_NUMBER_IN_USE':
      return t('integrations.whatsapp.phoneNumberInUse');
    default:
      return t('integrations.whatsapp.genericError');
  }
}

interface WhatsAppIntegrationsTabProps {
  refreshKey?: number;
}

export default function WhatsAppIntegrationsTab({ refreshKey = 0 }: WhatsAppIntegrationsTabProps) {
  const { t } = useLanguage();
  const [integrations, setIntegrations] = useState<DeveloperWhatsAppIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'connect' | 'reconnect'>('connect');
  const [active, setActive] = useState<DeveloperWhatsAppIntegration | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<DeveloperWhatsAppIntegration | null>(
    null
  );
  const [disconnectSubmitting, setDisconnectSubmitting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const [preparingSalonId, setPreparingSalonId] = useState<string | null>(null);
  const [prepareErrors, setPrepareErrors] = useState<Record<string, string>>({});

  const loadIntegrations = useCallback(() => {
    setError(false);
    setLoading(true);
    api.developer
      .getWhatsAppIntegrations()
      .then(setIntegrations)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations, refreshKey]);

  function openConnect(integration: DeveloperWhatsAppIntegration, mode: 'connect' | 'reconnect') {
    setFormError(null);
    setActive(integration);
    setFormMode(mode);
    setFormOpen(true);
  }

  async function handleConnectSubmit(body: WhatsAppConnectRequest): Promise<boolean> {
    if (!active || submitting) return false;
    setSubmitting(true);
    setFormError(null);
    try {
      await api.developer.connectWhatsApp(active.salonId, body);
      setFormOpen(false);
      setActive(null);
      loadIntegrations();
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(mapWhatsAppErrorCode(err.code, t));
      } else {
        setFormError(t('integrations.whatsapp.genericError'));
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisconnect() {
    if (!disconnectTarget || disconnectSubmitting) return;
    setDisconnectSubmitting(true);
    setDisconnectError(null);
    try {
      await api.developer.disconnectWhatsApp(disconnectTarget.salonId);
      setDisconnectOpen(false);
      setDisconnectTarget(null);
      loadIntegrations();
    } catch (err) {
      if (err instanceof ApiError) {
        setDisconnectError(mapWhatsAppErrorCode(err.code, t));
      } else {
        setDisconnectError(t('integrations.whatsapp.genericError'));
      }
    } finally {
      setDisconnectSubmitting(false);
    }
  }

  async function handlePrepare(integration: DeveloperWhatsAppIntegration): Promise<boolean> {
    if (preparingSalonId) return false;
    setPreparingSalonId(integration.salonId);
    setPrepareErrors((prev) => {
      const next = { ...prev };
      delete next[integration.salonId];
      return next;
    });
    try {
      const updated = await api.developer.prepareWhatsApp(integration.salonId);
      setIntegrations((prev) =>
        prev.map((row) => (row.salonId === updated.salonId ? updated : row))
      );
      return true;
    } catch {
      setPrepareErrors((prev) => ({
        ...prev,
        [integration.salonId]: t('developer.integrations.whatsapp.prepareFailed'),
      }));
      return false;
    } finally {
      setPreparingSalonId(null);
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
        icon={<MessageCircle className="h-8 w-8 text-gray-400" />}
        title={t('developer.integrations.whatsapp.emptyTitle')}
        description={t('developer.integrations.whatsapp.emptyDesc')}
      />
    );
  }

  return (
    <>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        {t('developer.integrations.whatsapp.description')}
      </p>

      <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integration) => (
          <SalonWhatsAppCard
            key={integration.salonId}
            integration={integration}
            preparing={preparingSalonId === integration.salonId}
            prepareError={prepareErrors[integration.salonId] ?? null}
            onPrepare={() => handlePrepare(integration)}
            onConnect={() => openConnect(integration, 'connect')}
            onReconnect={() => openConnect(integration, 'reconnect')}
            onDisconnect={() => {
              setDisconnectError(null);
              setDisconnectTarget(integration);
              setDisconnectOpen(true);
            }}
          />
        ))}
      </div>

      <DeveloperWhatsAppConnectModal
        open={formOpen}
        integration={active}
        mode={formMode}
        submitting={submitting}
        error={formError}
        onClose={() => {
          setFormOpen(false);
          setActive(null);
          setFormError(null);
        }}
        onSubmit={handleConnectSubmit}
        onClearError={() => setFormError(null)}
      />

      <Modal
        open={disconnectOpen}
        onClose={() => {
          if (disconnectSubmitting) return;
          setDisconnectOpen(false);
          setDisconnectTarget(null);
        }}
        title={t('integrations.whatsapp.disconnect')}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {disconnectTarget
              ? `${disconnectTarget.salonName} — ${t('integrations.whatsapp.disconnectConfirm')}`
              : t('integrations.whatsapp.disconnectConfirm')}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('integrations.whatsapp.credentialsRemoved')}
          </p>
          {disconnectError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{disconnectError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={disconnectSubmitting}
              onClick={() => setDisconnectOpen(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={disconnectSubmitting}
              onClick={handleDisconnect}
            >
              {t('integrations.whatsapp.disconnect')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
