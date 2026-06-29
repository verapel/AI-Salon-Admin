import { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import SalonTelegramCard from '@/components/developer/SalonTelegramCard';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { DeveloperTelegramIntegration } from '@/types';

interface TelegramIntegrationsTabProps {
  readOnly?: boolean;
}

export default function TelegramIntegrationsTab({ readOnly = false }: TelegramIntegrationsTabProps) {
  const { t } = useLanguage();
  const [integrations, setIntegrations] = useState<DeveloperTelegramIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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
  }, [loadIntegrations]);

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
    <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {integrations.map((integration) => (
        <SalonTelegramCard key={integration.salonId} integration={integration} readOnly={readOnly} />
      ))}
    </div>
  );
}
