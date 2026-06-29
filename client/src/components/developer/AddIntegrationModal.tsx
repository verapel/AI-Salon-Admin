import { useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import {
  INTEGRATION_CHANNELS,
  type IntegrationChannelId,
} from '@/components/developer/IntegrationTabs';
import { DEFAULT_SALON_SLUG, type DeveloperSalon } from '@/types';
import type { TelegramBotInfo, TelegramConnectionStatus } from '@/hooks/useTelegramConnection';

interface AddIntegrationModalProps {
  open: boolean;
  onClose: () => void;
  status: TelegramConnectionStatus;
  botInfo: TelegramBotInfo | null;
  connecting: boolean;
  connectError: string;
  onConnect: (token: string) => Promise<boolean>;
  onClearError: () => void;
  onSuccess: () => void;
}

export default function AddIntegrationModal({
  open,
  onClose,
  status,
  botInfo,
  connecting,
  connectError,
  onConnect,
  onClearError,
  onSuccess,
}: AddIntegrationModalProps) {
  const { t } = useLanguage();
  const [channel, setChannel] = useState<IntegrationChannelId>('telegram');
  const [salonId, setSalonId] = useState('');
  const [salons, setSalons] = useState<DeveloperSalon[]>([]);
  const [salonsLoading, setSalonsLoading] = useState(false);
  const [token, setToken] = useState('');

  const selectedSalon = salons.find((s) => s.id === salonId);
  const isTelegramChannel = channel === 'telegram';
  const isDefaultSalon = selectedSalon?.slug === DEFAULT_SALON_SLUG;
  const canConnect = isTelegramChannel && isDefaultSalon;
  const showChannelComingSoon = !isTelegramChannel;
  const showFutureUpdate = isTelegramChannel && !isDefaultSalon && !!selectedSalon;

  useEffect(() => {
    if (!open) return;

    setChannel('telegram');
    setToken('');
    onClearError();
    setSalonsLoading(true);

    api.developer
      .getSalons()
      .then((data) => {
        setSalons(data);
        const defaultSalon = data.find((s) => s.slug === DEFAULT_SALON_SLUG);
        setSalonId(defaultSalon?.id ?? data[0]?.id ?? '');
      })
      .catch(() => setSalons([]))
      .finally(() => setSalonsLoading(false));
  }, [open, onClearError]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canConnect || !token.trim()) return;

    const success = await onConnect(token);
    if (success) {
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
              {t('developer.integrations.modal.channel')}
            </label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as IntegrationChannelId)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            >
              {INTEGRATION_CHANNELS.map(({ id, labelKey }) => (
                <option key={id} value={id}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.integrations.modal.salon')}
            </label>
            <select
              value={salonId}
              onChange={(e) => setSalonId(e.target.value)}
              disabled={salonsLoading || salons.length === 0}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:opacity-50"
            >
              {salons.map((salon) => (
                <option key={salon.id} value={salon.id}>
                  {salon.name}
                </option>
              ))}
            </select>
          </div>

          {showChannelComingSoon && (
            <div className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-gray-400">
              {t('developer.integrations.comingSoonDescription')}
            </div>
          )}

          {showFutureUpdate && (
            <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-200/90">
              {t('developer.integrations.futureUpdate')}
            </div>
          )}

          {canConnect && (
            <>
              {status === 'connected' && botInfo && (
                <div className="rounded-lg bg-slate-800 px-4 py-3 text-sm">
                  <p className="text-gray-400">{t('ai.currentlyConnected')}</p>
                  <p className="mt-0.5 font-medium text-green-400">@{botInfo.username}</p>
                </div>
              )}

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
            </>
          )}

          {connectError && canConnect && (
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
              disabled={!canConnect || connecting || !token.trim()}
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
