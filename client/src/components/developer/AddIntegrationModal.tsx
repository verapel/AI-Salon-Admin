import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type {
  DeveloperInstagramIntegration,
  DeveloperSalon,
  DeveloperWhatsAppIntegration,
} from '@/types';

type AddChannel = 'telegram' | 'instagram' | 'whatsapp';

interface AddIntegrationModalProps {
  open: boolean;
  initialChannel?: AddChannel;
  onClose: () => void;
  connecting: boolean;
  connectError: string;
  onConnectTelegram: (params: {
    salonName: string;
    botDisplayName: string;
    token: string;
  }) => Promise<boolean>;
  onAddInstagram: (salonId: string) => Promise<boolean>;
  onAddWhatsApp: (salonId: string) => Promise<boolean>;
  onClearError: () => void;
  onSuccess: () => void;
}

export default function AddIntegrationModal({
  open,
  initialChannel = 'telegram',
  onClose,
  connecting,
  connectError,
  onConnectTelegram,
  onAddInstagram,
  onAddWhatsApp,
  onClearError,
  onSuccess,
}: AddIntegrationModalProps) {
  const { t } = useLanguage();
  const [channel, setChannel] = useState<AddChannel>(initialChannel);
  const [salonName, setSalonName] = useState('');
  const [botDisplayName, setBotDisplayName] = useState('');
  const [token, setToken] = useState('');
  const [salons, setSalons] = useState<DeveloperSalon[]>([]);
  const [instagramIntegrations, setInstagramIntegrations] = useState<
    DeveloperInstagramIntegration[]
  >([]);
  const [whatsappIntegrations, setWhatsappIntegrations] = useState<
    DeveloperWhatsAppIntegration[]
  >([]);
  const [selectedSalonId, setSelectedSalonId] = useState('');
  const [loadingSalons, setLoadingSalons] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!open) return;
    setChannel(initialChannel);
    setSalonName('');
    setBotDisplayName('');
    setToken('');
    setSelectedSalonId('');
    setLocalError('');
    onClearError();
  }, [open, initialChannel, onClearError]);

  useEffect(() => {
    if (!open || (channel !== 'instagram' && channel !== 'whatsapp')) return;
    let cancelled = false;
    setLoadingSalons(true);
    setLocalError('');
    setSelectedSalonId('');

    const load =
      channel === 'instagram'
        ? Promise.all([api.developer.getSalons(), api.developer.getInstagramIntegrations()])
        : Promise.all([api.developer.getSalons(), api.developer.getWhatsAppIntegrations()]);

    load
      .then(([salonRows, integrationRows]) => {
        if (cancelled) return;
        setSalons(salonRows.filter((s) => s.active));
        if (channel === 'instagram') {
          setInstagramIntegrations(integrationRows as DeveloperInstagramIntegration[]);
        } else {
          setWhatsappIntegrations(integrationRows as DeveloperWhatsAppIntegration[]);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLocalError(
          channel === 'instagram'
            ? t('developer.integrations.instagram.genericError')
            : t('integrations.whatsapp.genericError'),
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingSalons(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, channel, t]);

  const eligibleSalons = useMemo(() => {
    if (channel === 'instagram') {
      const added = new Set(
        instagramIntegrations
          .filter((row) => row.integrationAdded !== false)
          .map((row) => row.salonId),
      );
      // List API only returns added salons; treat all returned as added.
      for (const row of instagramIntegrations) {
        added.add(row.salonId);
      }
      return salons.filter((salon) => !added.has(salon.id));
    }
    if (channel === 'whatsapp') {
      const added = new Set(
        whatsappIntegrations
          .filter((row) => row.integrationAdded !== false)
          .map((row) => row.salonId),
      );
      for (const row of whatsappIntegrations) {
        added.add(row.salonId);
      }
      return salons.filter((salon) => !added.has(salon.id));
    }
    return [];
  }, [channel, salons, instagramIntegrations, whatsappIntegrations]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError('');

    if (channel === 'telegram') {
      const trimmedName = salonName.trim();
      if (!trimmedName || !token.trim()) return;
      const success = await onConnectTelegram({
        salonName: trimmedName,
        botDisplayName: botDisplayName.trim(),
        token,
      });
      if (success) {
        setSalonName('');
        setBotDisplayName('');
        setToken('');
        onSuccess();
        onClose();
      }
      return;
    }

    if (!selectedSalonId) return;
    const success =
      channel === 'instagram'
        ? await onAddInstagram(selectedSalonId)
        : await onAddWhatsApp(selectedSalonId);
    if (success) {
      setSelectedSalonId('');
      onSuccess();
      onClose();
    }
  }

  const telegramReady = salonName.trim().length > 0 && token.trim().length > 0;
  const salonPickerReady = selectedSalonId.length > 0 && !loadingSalons;
  const submitDisabled =
    connecting ||
    (channel === 'telegram' ? !telegramReady : !salonPickerReady);

  const pickerSelectLabel =
    channel === 'whatsapp'
      ? t('developer.integrations.whatsapp.selectSalon')
      : t('developer.integrations.instagram.selectSalon');
  const pickerEmptyHint =
    channel === 'whatsapp'
      ? t('developer.integrations.whatsapp.noEligibleSalons')
      : t('developer.integrations.instagram.noEligibleSalons');
  const pickerHint =
    channel === 'whatsapp'
      ? t('developer.integrations.whatsapp.addHint')
      : t('developer.integrations.instagram.addHint');
  const submitLabel =
    channel === 'instagram'
      ? t('developer.integrations.instagram.add')
      : channel === 'whatsapp'
        ? t('developer.integrations.whatsapp.add')
        : t('common.connect');
  const submittingLabel =
    channel === 'instagram'
      ? t('developer.integrations.instagram.adding')
      : channel === 'whatsapp'
        ? t('developer.integrations.whatsapp.adding')
        : t('common.connecting');

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
              onChange={(e) => setChannel(e.target.value as AddChannel)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            >
              <option value="telegram">{t('developer.integrations.tabs.telegram')}</option>
              <option value="instagram">{t('developer.integrations.tabs.instagram')}</option>
              <option value="whatsapp">{t('developer.integrations.tabs.whatsapp')}</option>
            </select>
          </div>

          {channel === 'telegram' ? (
            <>
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
                  {t('developer.integrations.botDisplayName')}
                </label>
                <input
                  type="text"
                  value={botDisplayName}
                  onChange={(e) => setBotDisplayName(e.target.value)}
                  placeholder={t('developer.integrations.botDisplayNamePlaceholder')}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                />
                <p className="mt-1.5 text-xs text-gray-500">
                  {t('developer.integrations.botDisplayNameHint')}
                </p>
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
            </>
          ) : (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">
                {t('developer.integrations.modal.salon')}
              </label>
              <select
                value={selectedSalonId}
                onChange={(e) => setSelectedSalonId(e.target.value)}
                disabled={loadingSalons || connecting}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:opacity-50"
                required
              >
                <option value="">
                  {loadingSalons ? t('developer.integrations.loading') : pickerSelectLabel}
                </option>
                {eligibleSalons.map((salon) => (
                  <option key={salon.id} value={salon.id}>
                    {salon.name}
                  </option>
                ))}
              </select>
              {!loadingSalons && eligibleSalons.length === 0 ? (
                <p className="mt-1.5 text-xs text-gray-500">{pickerEmptyHint}</p>
              ) : (
                <p className="mt-1.5 text-xs text-gray-500">{pickerHint}</p>
              )}
            </div>
          )}

          {(connectError || localError) && (
            <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-400">
              {connectError || localError}
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
              disabled={submitDisabled}
              className="w-full min-h-[40px] rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {connecting ? submittingLabel : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
