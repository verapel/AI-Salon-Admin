import { useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';

interface AddIntegrationModalProps {
  open: boolean;
  onClose: () => void;
  connecting: boolean;
  connectError: string;
  onConnect: (params: { salonName: string; token: string }) => Promise<boolean>;
  onClearError: () => void;
  onSuccess: () => void;
}

export default function AddIntegrationModal({
  open,
  onClose,
  connecting,
  connectError,
  onConnect,
  onClearError,
  onSuccess,
}: AddIntegrationModalProps) {
  const { t } = useLanguage();
  const [salonName, setSalonName] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!open) return;
    setSalonName('');
    setToken('');
    onClearError();
  }, [open, onClearError]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = salonName.trim();
    if (!trimmedName || !token.trim()) return;

    const success = await onConnect({ salonName: trimmedName, token });
    if (success) {
      setSalonName('');
      setToken('');
      onSuccess();
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
      >
        <h3 className="mb-5 text-lg font-semibold text-white">
          {t('developer.integrations.modal.title')}
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.integrations.modal.salonName')}
            </label>
            <input
              type="text"
              value={salonName}
              onChange={(e) => setSalonName(e.target.value)}
              placeholder={t('developer.integrations.modal.salonNamePlaceholder')}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('ai.botToken')}
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="1234567890:AAF..."
              autoComplete="off"
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              required
            />
            <p className="mt-1.5 text-xs text-gray-500">
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
              disabled={connecting || !salonName.trim() || !token.trim()}
              className="w-full min-h-[40px] rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {connecting ? t('common.connecting') : t('common.connect')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
