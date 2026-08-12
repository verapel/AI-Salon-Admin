import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import IntegrationTabs, {
  INTEGRATION_TABS,
  type IntegrationTabId,
} from '@/components/developer/IntegrationTabs';
import TelegramIntegrationsTab from '@/components/developer/TelegramIntegrationsTab';
import WhatsAppIntegrationsTab from '@/components/developer/WhatsAppIntegrationsTab';
import InstagramIntegrationsTab from '@/components/developer/InstagramIntegrationsTab';
import ComingSoonTab from '@/components/developer/ComingSoonTab';
import AddIntegrationModal from '@/components/developer/AddIntegrationModal';
import { useDeveloperTelegramConnect } from '@/hooks/useDeveloperTelegramConnect';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';

const DEFAULT_TAB: IntegrationTabId = 'telegram';

function isIntegrationTabId(value: string | null): value is IntegrationTabId {
  return INTEGRATION_TABS.some((tab) => tab.id === value);
}

export default function DeveloperIntegrations() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [instagramAdding, setInstagramAdding] = useState(false);
  const [instagramAddError, setInstagramAddError] = useState('');
  const [whatsappAdding, setWhatsappAdding] = useState(false);
  const [whatsappAddError, setWhatsappAddError] = useState('');

  const { connecting, connectError, connect, updateMetadata, clearConnectError } =
    useDeveloperTelegramConnect();

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

  async function handleCreateConnect(params: {
    salonName: string;
    botDisplayName: string;
    token: string;
  }) {
    const success = await connect({
      salonName: params.salonName,
      token: params.token,
      botDisplayName: params.botDisplayName,
    });
    if (success) {
      setRefreshKey((key) => key + 1);
    }
    return success;
  }

  async function handleAddInstagram(salonId: string) {
    setInstagramAdding(true);
    setInstagramAddError('');
    try {
      await api.developer.prepareInstagram(salonId);
      setRefreshKey((key) => key + 1);
      if (activeTab !== 'instagram') {
        setSearchParams({ tab: 'instagram' });
      }
      return true;
    } catch {
      setInstagramAddError(t('developer.integrations.instagram.genericError'));
      return false;
    } finally {
      setInstagramAdding(false);
    }
  }

  async function handleAddWhatsApp(salonId: string) {
    setWhatsappAdding(true);
    setWhatsappAddError('');
    try {
      await api.developer.prepareWhatsApp(salonId);
      setRefreshKey((key) => key + 1);
      if (activeTab !== 'whatsapp') {
        setSearchParams({ tab: 'whatsapp' });
      }
      return true;
    } catch {
      setWhatsappAddError(t('integrations.whatsapp.genericError'));
      return false;
    } finally {
      setWhatsappAdding(false);
    }
  }

  function handleAddSuccess() {
    setRefreshKey((key) => key + 1);
  }

  function clearErrors() {
    clearConnectError();
    setInstagramAddError('');
    setWhatsappAddError('');
  }

  const modalBusy = connecting || instagramAdding || whatsappAdding;
  const modalError = connectError || instagramAddError || whatsappAddError;
  const initialChannel =
    activeTab === 'instagram' ? 'instagram' : activeTab === 'whatsapp' ? 'whatsapp' : 'telegram';

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
              connecting={connecting}
              connectError={connectError}
              onConnect={connect}
              onUpdateMetadata={updateMetadata}
              onClearError={clearConnectError}
            />
          ) : activeTab === 'whatsapp' ? (
            <WhatsAppIntegrationsTab refreshKey={refreshKey} />
          ) : activeTab === 'instagram' ? (
            <InstagramIntegrationsTab refreshKey={refreshKey} />
          ) : null
        ) : (
          <ComingSoonTab tabId={activeTab} />
        )}
      </div>

      <AddIntegrationModal
        open={addModalOpen}
        initialChannel={initialChannel}
        onClose={() => setAddModalOpen(false)}
        connecting={modalBusy}
        connectError={modalError}
        onConnectTelegram={handleCreateConnect}
        onAddInstagram={handleAddInstagram}
        onAddWhatsApp={handleAddWhatsApp}
        onClearError={clearErrors}
        onSuccess={handleAddSuccess}
      />
    </div>
  );
}
