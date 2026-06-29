import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { cn } from '@/lib/utils';
import type { IntegrationConnectionStatus } from '@/types';

const statusStyles: Record<IntegrationConnectionStatus, string> = {
  connected:
    'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  not_connected:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  disabled: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const statusKeys: Record<IntegrationConnectionStatus, TranslationKey> = {
  connected: 'developer.integrations.status.connected',
  not_connected: 'developer.integrations.status.notConnected',
  error: 'developer.integrations.status.error',
  disabled: 'developer.integrations.status.disabled',
};

interface IntegrationStatusBadgeProps {
  status: IntegrationConnectionStatus;
  className?: string;
}

export default function IntegrationStatusBadge({ status, className }: IntegrationStatusBadgeProps) {
  const { t } = useLanguage();

  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
        statusStyles[status],
        className
      )}
    >
      {t(statusKeys[status])}
    </span>
  );
}
