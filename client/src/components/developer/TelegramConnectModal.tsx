import { useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { TelegramBotInfo, TelegramConnectionStatus } from '@/hooks/useTelegramConnection';

interface TelegramConnectModalProps {
  open: boolean;
  onClose: () => void;
  status: TelegramConnectionStatus;
  botInfo: TelegramBotInfo | null;
  connecting: boolean;
  connectError: string;
  onConnect: (token: string) => Promise<boolean>;
  onClearError?: () => void;
}

export default function TelegramConnectModal({
  open,
  onClose,
  status,
  botInfo,
  connecting,
  connectError,
  onConnect,
  onClearError,
}: TelegramConnectModalProps) {
  const { t } = useLanguage();
  const [token, setToken] = useState('');

  useEffect(() => {
    if (open) {
      setToken('');
      onClearError?.();
    }
  }, [open, onClearError]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    const success = await onConnect(token);
    if (success) {
      setToken('');
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
      >
        <h3 className="mb-1 text-lg font-semibold text-white">
          {status === 'connected' ? t('ai.manageBot') : t('ai.connectBot')}
        </h3>
        <p className="mb-5 text-sm text-gray-400">
          {t('ai.botTokenHint')}{' '}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer"
            className="text-purple-400 underline hover:text-purple-300"
          >
            @BotFather
          </a>{' '}
          {t('ai.botTokenHintSuffix')}
        </p>

        {status === 'connected' && botInfo && (
          <div className="mb-4 rounded-lg bg-slate-800 px-4 py-3 text-sm">
            <p className="text-gray-400">{t('ai.currentlyConnected')}</p>
            <p className="mt-0.5 font-medium text-green-400">@{botInfo.username}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
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
            <p className="mt-1.5 text-xs text-gray-500">{t('ai.tokenNote')}</p>
          </div>

          {connectError && (
            <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-400">
              {connectError}
            </div>
          )}

          <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 sm:w-auto"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={connecting || !token.trim()}
              className="w-full min-h-[40px] rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50 sm:w-auto"
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
  );
}
