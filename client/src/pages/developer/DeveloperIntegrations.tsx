import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import IntegrationTabs, {
  INTEGRATION_TABS,
  type IntegrationTabId,
} from '@/components/developer/IntegrationTabs';
import TelegramIntegrationsTab from '@/components/developer/TelegramIntegrationsTab';
import ComingSoonTab from '@/components/developer/ComingSoonTab';
import { useLanguage } from '@/context/LanguageContext';

const DEFAULT_TAB: IntegrationTabId = 'telegram';

function isIntegrationTabId(value: string | null): value is IntegrationTabId {
  return INTEGRATION_TABS.some((tab) => tab.id === value);
}

export default function DeveloperIntegrations() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  const activeTab = isIntegrationTabId(tabParam) ? tabParam : DEFAULT_TAB;
  const activeTabConfig = INTEGRATION_TABS.find((tab) => tab.id === activeTab)!;

  useEffect(() => {
    if (!isIntegrationTabId(tabParam)) {
      setSearchParams({ tab: DEFAULT_TAB }, { replace: true });
    }
  }, [tabParam, setSearchParams]);

  function handleTabChange(tab: IntegrationTabId) {
    setSearchParams({ tab });
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip animate-fade-in">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('developer.integrations.overviewHint')}</p>

      <IntegrationTabs activeTab={activeTab} onTabChange={handleTabChange} />

      <div role="tabpanel" className="w-full min-w-0 max-w-full">
        {activeTabConfig.available ? (
          activeTab === 'telegram' ? (
            <TelegramIntegrationsTab readOnly />
          ) : null
        ) : (
          <ComingSoonTab tabId={activeTab} />
        )}
      </div>
    </div>
  );
}
