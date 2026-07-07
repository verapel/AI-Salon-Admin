import { useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';

interface ConnectSalonTelegramModalProps {
  isOpen: boolean;
  salonId: string;
  salonName: string;
  onClose: () => void;
  onConnected: () => void;
}

export default function ConnectSalonTelegramModal({
  isOpen,
  salonId,
  salonName,
  onClose,
  onConnected,
}: ConnectSalonTelegramModalProps) {
  const { t } = useLanguage();
  const [token, setToken] = useState('');
  const [botDisplayName, setBotDisplayName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setToken('');
    setBotDisplayName('');
    setConnectError('');
  }, [isOpen, salonId]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setConnectError('');

    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setConnectError(t('developer.salons.botTokenRequired'));
      return;
    }

    setConnecting(true);
    try {
      await api.developer.connectTelegram({
        salonId,
        token: trimmedToken,
        botDisplayName: botDisplayName.trim() || undefined,
      });
      setToken('');
      setBotDisplayName('');
      onConnected();
      onClose();
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : t('developer.salons.telegramConnectError'));
    } finally {
      setConnecting(false);
    }
  }

  const inputClassName =
    'w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20';

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
      >
        <h3 className="mb-5 text-lg font-semibold text-white">
          {t('developer.salons.connectTelegram')}
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <span className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.salons.selectedSalon')}
            </span>
            <p className="text-sm text-gray-400">{salonName}</p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.salons.botToken')}
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              className={inputClassName}
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.salons.botDisplayName')}
            </label>
            <input
              type="text"
              value={botDisplayName}
              onChange={(e) => setBotDisplayName(e.target.value)}
              className={inputClassName}
            />
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
              disabled={connecting}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={connecting || !token.trim()}
              className="w-full min-h-[40px] rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {connecting ? t('developer.salons.connectingTelegram') : t('developer.salons.connectTelegram')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
