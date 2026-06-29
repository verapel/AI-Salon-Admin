import { useState } from 'react';
import { MessageCircle, Send, ExternalLink } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import TelegramConnectModal from '@/components/developer/TelegramConnectModal';
import { useTelegramConnection } from '@/hooks/useTelegramConnection';

export default function SalonIntegrations() {
  const { t } = useLanguage();
  const [modalOpen, setModalOpen] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const {
    status,
    botInfo,
    connecting,
    connectError,
    connect,
    clearConnectError,
    refreshStatus,
  } = useTelegramConnection();

  function openModal() {
    clearConnectError();
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    clearConnectError();
  }

  async function handleConnect(token: string) {
    const ok = await connect(token);
    if (ok) await refreshStatus();
    return ok;
  }

  async function sendTestNotification() {
    setTestStatus('loading');
    setTestMessage('');
    try {
      const res = await fetch('/api/telegram/test', { method: 'GET' });
      const data = await res.json();
      if (res.ok && data.success) {
        setTestStatus('ok');
        setTestMessage(t('integrations.testSent'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error ?? t('integrations.testFailed'));
      }
    } catch {
      setTestStatus('error');
      setTestMessage(t('integrations.testFailed'));
    }
  }

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

            <div className="mt-4">
              {status === 'checking' && (
                <p className="text-sm text-gray-500">{t('common.checking')}</p>
              )}
              {status === 'connected' && botInfo && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-green-600 dark:text-green-400">
                    ● {t('common.connected')} @{botInfo.username}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{botInfo.name}</p>
                </div>
              )}
              {status === 'disconnected' && (
                <p className="text-sm text-amber-600 dark:text-amber-400">● {t('common.notConnected')}</p>
              )}
              {status === 'error' && (
                <p className="text-sm text-red-600 dark:text-red-400">● {t('common.serverUnavailable')}</p>
              )}
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                onClick={openModal}
                disabled={status === 'checking'}
                className="btn-primary min-h-[44px] px-4 py-2.5 text-sm"
              >
                {status === 'connected' ? t('ai.manageTelegram') : t('ai.connectTelegram')}
              </button>
              {status === 'connected' && botInfo && (
                <a
                  href={`https://t.me/${botInfo.username}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-secondary inline-flex min-h-[44px] items-center justify-center gap-2 px-4 py-2.5 text-sm"
                >
                  <ExternalLink className="h-4 w-4" />
                  {t('integrations.openBot')}
                </a>
              )}
            </div>

            {status === 'connected' && (
              <div className="mt-4 border-t pt-4 dark:border-gray-700">
                <p className="text-sm text-gray-600 dark:text-gray-300">{t('integrations.testHint')}</p>
                <button
                  onClick={sendTestNotification}
                  disabled={testStatus === 'loading'}
                  className="mt-2 inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/50"
                >
                  <Send className="h-4 w-4" />
                  {t('integrations.sendTest')}
                </button>
                {testMessage && (
                  <p
                    className={`mt-2 text-sm ${testStatus === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                  >
                    {testMessage}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <TelegramConnectModal
        open={modalOpen}
        onClose={closeModal}
        status={status}
        botInfo={botInfo}
        connecting={connecting}
        connectError={connectError}
        onConnect={handleConnect}
        onClearError={clearConnectError}
      />
    </div>
  );
}
