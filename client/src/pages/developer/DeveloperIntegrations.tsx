import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import IntegrationTabs, {
  INTEGRATION_TABS,
  type IntegrationTabId,
} from '@/components/developer/IntegrationTabs';
import TelegramIntegrationsTab from '@/components/developer/TelegramIntegrationsTab';
import ComingSoonTab from '@/components/developer/ComingSoonTab';
import AddIntegrationModal from '@/components/developer/AddIntegrationModal';
import { useTelegramConnection } from '@/hooks/useTelegramConnection';
import { useLanguage } from '@/context/LanguageContext';

const DEFAULT_TAB: IntegrationTabId = 'telegram';

function isIntegrationTabId(value: string | null): value is IntegrationTabId {
  return INTEGRATION_TABS.some((tab) => tab.id === value);
}

export default function DeveloperIntegrations() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const {
    status,
    botInfo,
    connecting,
    connectError,
    connect,
    clearConnectError,
    refreshStatus,
  } = useTelegramConnection();

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

  async function handleConnect(token: string) {
    const success = await connect(token);
    if (success) {
      await refreshStatus();
      setRefreshKey((key) => key + 1);
    }
    return success;
  }

  function handleAddSuccess() {
    setRefreshKey((key) => key + 1);
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip animate-fade-in">
      <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={() => setAddModalOpen(true)}
          className="btn-primary w-full sm:w-auto"
        >
          <Plus className="h-4 w-4" />
          {t('developer.integrations.addIntegration')}
        </button>
      </div>

      <IntegrationTabs activeTab={activeTab} onTabChange={handleTabChange} />

      <div role="tabpanel" className="w-full min-w-0 max-w-full">
        {activeTabConfig.available ? (
          activeTab === 'telegram' ? (
            <TelegramIntegrationsTab
              refreshKey={refreshKey}
              status={status}
              botInfo={botInfo}
              connecting={connecting}
              connectError={connectError}
              onConnect={handleConnect}
              onClearError={clearConnectError}
            />
          ) : null
        ) : (
          <ComingSoonTab tabId={activeTab} />
        )}
      </div>

      <AddIntegrationModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        status={status}
        botInfo={botInfo}
        connecting={connecting}
        connectError={connectError}
        onConnect={handleConnect}
        onClearError={clearConnectError}
        onSuccess={handleAddSuccess}
      />
    </div>
  );
}
