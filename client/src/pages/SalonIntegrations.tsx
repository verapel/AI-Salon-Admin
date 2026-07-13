import { MessageCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

/**
 * Legacy salon Integrations page (not mounted in App routes).
 * Telegram bot connect/test are developer-only after Security-2a.
 */
export default function SalonIntegrations() {
  const { t } = useLanguage();

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-6 animate-fade-in">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('integrations.subtitle')}</p>

      <div className="card min-w-0 max-w-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/50">
            <MessageCircle className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('ai.telegram')}</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('integrations.telegramDesc')}</p>
            <p className="mt-4 text-sm text-amber-700 dark:text-amber-400">
              {t('integrations.managedByDeveloper')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
