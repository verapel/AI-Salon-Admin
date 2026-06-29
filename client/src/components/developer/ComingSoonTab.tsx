import { Clock } from 'lucide-react';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { INTEGRATION_TABS, type IntegrationTabId } from '@/components/developer/IntegrationTabs';

interface ComingSoonTabProps {
  tabId: IntegrationTabId;
}

function getTabLabelKey(tabId: IntegrationTabId): TranslationKey {
  return INTEGRATION_TABS.find((tab) => tab.id === tabId)?.labelKey ?? 'developer.integrations.tabs.telegram';
}

export default function ComingSoonTab({ tabId }: ComingSoonTabProps) {
  const { t } = useLanguage();

  return (
    <div className="card flex w-full min-w-0 max-w-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 dark:bg-gray-800">
        <Clock className="h-7 w-7 text-gray-400 dark:text-gray-500" />
      </div>
      <h3 className="mt-5 text-lg font-semibold text-gray-900 dark:text-white">
        {t(getTabLabelKey(tabId))}
      </h3>
      <p className="mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
        {t('developer.integrations.comingSoonDescription')}
      </p>
      <span className="mt-4 inline-flex rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
        {t('developer.integrations.comingSoon')}
      </span>
    </div>
  );
}
