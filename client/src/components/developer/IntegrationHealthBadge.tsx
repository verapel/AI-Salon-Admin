import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { cn } from '@/lib/utils';
import type { IntegrationHealthStatus } from '@/types';

const healthStyles: Record<IntegrationHealthStatus, string> = {
  healthy:
    'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  unknown: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const healthKeys: Record<IntegrationHealthStatus, TranslationKey> = {
  healthy: 'developer.integrations.health.healthy',
  error: 'developer.integrations.health.error',
  unknown: 'developer.integrations.health.unknown',
};

interface IntegrationHealthBadgeProps {
  health: IntegrationHealthStatus;
  className?: string;
}

export default function IntegrationHealthBadge({ health, className }: IntegrationHealthBadgeProps) {
  const { t } = useLanguage();

  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
        healthStyles[health],
        className
      )}
    >
      {t(healthKeys[health])}
    </span>
  );
}
