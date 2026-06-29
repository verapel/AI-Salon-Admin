import { useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import TelegramConnectModal from '@/components/developer/TelegramConnectModal';
import { useTelegramConnection } from '@/hooks/useTelegramConnection';

export default function AIAssistant() {
  const { t } = useLanguage();
  const [modalOpen, setModalOpen] = useState(false);
  const {
    status,
    botInfo,
    connecting,
    connectError,
    connect,
    clearConnectError,
  } = useTelegramConnection();

  function openModal() {
    clearConnectError();
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    clearConnectError();
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in sm:p-6">
      <h1 className="text-2xl font-bold">{t('pages.aiAssistant.title')}</h1>

      <p className="mb-6 text-gray-400">
        {t('ai.subtitle')}
      </p>

      <div className="w-full min-w-0 max-w-full grid gap-4 md:grid-cols-3">

        <div className="w-full min-w-0 max-w-full rounded-xl bg-slate-800 p-4">
          <h2 className="text-xl font-semibold">{t('ai.telegram')}</h2>

          <div className="mt-2">
            {status === 'checking' && (
              <p className="text-gray-400 text-sm">{t('common.checking')}</p>
            )}
            {status === 'connected' && botInfo && (
              <>
                <p className="text-green-400 text-sm font-medium">● {t('common.connected')}</p>
                <p className="mt-1 truncate text-gray-300 text-sm">@{botInfo.username}</p>
              </>
            )}
            {status === 'disconnected' && (
              <p className="text-yellow-400 text-sm">● {t('common.notConnected')}</p>
            )}
            {status === 'error' && (
              <p className="text-red-400 text-sm">● {t('common.serverUnavailable')}</p>
            )}
          </div>

          <button
            onClick={openModal}
            disabled={status === 'checking'}
            className="mt-4 w-full min-h-[36px] rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-purple-700 transition-colors"
          >
            {status === 'connected' ? t('ai.manageTelegram') : t('ai.connectTelegram')}
          </button>
        </div>

        <div className="w-full min-w-0 max-w-full rounded-xl bg-slate-800 p-4">
          <h2 className="text-xl font-semibold">{t('ai.whatsapp')}</h2>
          <p className="mt-2 text-gray-400 text-sm">{t('ai.statusLabel')} {t('common.notConnected')}</p>
        </div>

        <div className="w-full min-w-0 max-w-full rounded-xl bg-slate-800 p-4">
          <h2 className="text-xl font-semibold">{t('ai.instagram')}</h2>
          <p className="mt-2 text-gray-400 text-sm">{t('ai.statusLabel')} {t('common.notConnected')}</p>
        </div>
      </div>

      <TelegramConnectModal
        open={modalOpen}
        onClose={closeModal}
        status={status}
        botInfo={botInfo}
        connecting={connecting}
        connectError={connectError}
        onConnect={connect}
        onClearError={clearConnectError}
      />
    </div>
  );
}
