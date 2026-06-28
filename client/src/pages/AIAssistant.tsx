import { useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';

interface BotInfo {
  username: string;
  name: string;
}

type ConnectionStatus = 'checking' | 'connected' | 'disconnected' | 'error';

export default function AIAssistant() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<ConnectionStatus>('checking');
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  useEffect(() => {
    checkStatus();
  }, []);

  async function checkStatus() {
    setStatus('checking');
    try {
      const res = await fetch('http://localhost:3001/api/telegram/status');
      const data = await res.json();
      if (data.connected) {
        setBotInfo({ username: data.bot, name: data.name });
        setStatus('connected');
      } else {
        setStatus('disconnected');
      }
    } catch {
      setStatus('error');
    }
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    setConnecting(true);
    setConnectError('');

    try {
      const res = await fetch('http://localhost:3001/api/integrations/telegram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });

      const data = await res.json();

      if (data.success) {
        setBotInfo({ username: data.username, name: data.name });
        setStatus('connected');
        setModalOpen(false);
        setToken('');
      } else {
        setConnectError(data.error ?? t('ai.connectionFailed'));
      }
    } catch {
      setConnectError(t('ai.serverError'));
    } finally {
      setConnecting(false);
    }
  }

  function openModal() {
    setToken('');
    setConnectError('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setToken('');
    setConnectError('');
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

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closeModal}
          />

          <div className="relative w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-1">
              {status === 'connected' ? t('ai.manageBot') : t('ai.connectBot')}
            </h3>
            <p className="text-sm text-gray-400 mb-5">
              {t('ai.botTokenHint')}{' '}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="text-purple-400 underline hover:text-purple-300"
              >
                @BotFather
              </a>
              {' '}{t('ai.botTokenHintSuffix')}
            </p>

            {status === 'connected' && botInfo && (
              <div className="mb-4 rounded-lg bg-slate-800 px-4 py-3 text-sm">
                <p className="text-gray-400">{t('ai.currentlyConnected')}</p>
                <p className="mt-0.5 font-medium text-green-400">@{botInfo.username}</p>
              </div>
            )}

            <form onSubmit={handleConnect} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-300">
                  {status === 'connected' ? t('ai.newBotToken') : t('ai.botToken')}
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="1234567890:AAF..."
                  autoComplete="off"
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                />
                <p className="mt-1.5 text-xs text-gray-500">
                  {t('ai.tokenNote')}
                </p>
              </div>

              {connectError && (
                <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-400">
                  {connectError}
                </div>
              )}

              <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeModal}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-slate-700 transition-colors sm:w-auto"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={connecting || !token.trim()}
                  className="w-full min-h-[40px] rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 transition-colors sm:w-auto"
                >
                  {connecting
                    ? t('common.connecting')
                    : status === 'connected'
                    ? t('common.reconnect')
                    : t('common.connect')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
