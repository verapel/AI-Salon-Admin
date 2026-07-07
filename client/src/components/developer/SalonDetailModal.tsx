import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import ConnectSalonTelegramModal from '@/components/developer/ConnectSalonTelegramModal';
import IntegrationStatusBadge from '@/components/developer/IntegrationStatusBadge';
import IntegrationHealthBadge from '@/components/developer/IntegrationHealthBadge';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import type { DeveloperSalonDetail } from '@/types';

interface SalonDetailModalProps {
  salonId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function SalonDetailModal({
  salonId,
  isOpen,
  onClose,
  onUpdated,
}: SalonDetailModalProps) {
  const { t } = useLanguage();
  const [detail, setDetail] = useState<DeveloperSalonDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [connectTelegramOpen, setConnectTelegramOpen] = useState(false);

  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [timezone, setTimezone] = useState('');
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [language, setLanguage] = useState('');

  const populateForm = useCallback((data: DeveloperSalonDetail) => {
    setName(data.name);
    setActive(data.active);
    setTimezone(data.timezone);
    setCountry(data.country);
    setCurrency(data.currency);
    setLanguage(data.language);
  }, []);

  const loadDetail = useCallback(async () => {
    if (!salonId) return;
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.developer.getSalon(salonId);
      setDetail(data);
      populateForm(data);
    } catch (err) {
      setDetail(null);
      setLoadError(err instanceof Error ? err.message : t('developer.salons.detailError'));
    } finally {
      setLoading(false);
    }
  }, [salonId, populateForm, t]);

  useEffect(() => {
    if (!isOpen || !salonId) return;
    setSaveError('');
    setValidationError('');
    setSuccessMessage('');
    setConnectTelegramOpen(false);
    loadDetail();
  }, [isOpen, salonId, loadDetail]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!salonId || !detail) return;

    setValidationError('');
    setSaveError('');
    setSuccessMessage('');

    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setValidationError(t('developer.salons.validationName'));
      return;
    }
    if (!timezone.trim() || !country.trim() || !currency.trim() || !language.trim()) {
      setValidationError(t('developer.salons.updateError'));
      return;
    }

    setSaving(true);
    try {
      await api.developer.updateSalon(salonId, {
        name: trimmedName,
        active,
        timezone: timezone.trim(),
        country: country.trim(),
        currency: currency.trim(),
        language: language.trim(),
      });
      await loadDetail();
      setSuccessMessage(t('developer.salons.updated'));
      onUpdated();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('developer.salons.updateError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTelegramConnected() {
    await loadDetail();
    setSuccessMessage(t('developer.salons.telegramConnectedSuccess'));
    onUpdated();
  }

  const displayError = validationError || saveError;
  const inputClassName =
    'w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      >
        <div className="border-b border-slate-700 px-6 py-5">
          <h3 className="text-lg font-semibold text-white">{t('developer.salons.details')}</h3>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center gap-3">
              <LoadingSpinner />
              <p className="text-sm text-gray-400">{t('developer.salons.loading')}</p>
            </div>
          ) : loadError ? (
            <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-400">
              {loadError}
            </div>
          ) : detail ? (
            <form id="salon-detail-form" onSubmit={handleSubmit} className="space-y-5">
              {successMessage && (
                <div className="rounded-lg border border-green-800 bg-green-950/50 px-4 py-3 text-sm text-green-400">
                  {successMessage}
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-300">
                  {t('developer.salons.salonName')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClassName}
                  required
                />
              </div>

              <div>
                <span className="mb-1.5 block text-sm font-medium text-gray-300">
                  {t('developer.salons.slug')}
                </span>
                <p className="text-sm text-gray-400">{detail.slug}</p>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-3">
                <span className="text-sm font-medium text-gray-300">{t('developer.salons.active')}</span>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={(e) => setActive(e.target.checked)}
                    className="peer sr-only"
                  />
                  <span className="h-6 w-11 rounded-full bg-slate-600 transition-colors peer-checked:bg-purple-600 peer-focus:ring-2 peer-focus:ring-purple-500/30" />
                  <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-300">
                    {t('developer.salons.timezone')}
                  </label>
                  <input
                    type="text"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className={inputClassName}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-300">
                    {t('developer.salons.country')}
                  </label>
                  <input
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className={inputClassName}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-300">
                    {t('developer.salons.currency')}
                  </label>
                  <input
                    type="text"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className={inputClassName}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-300">
                    {t('developer.salons.language')}
                  </label>
                  <input
                    type="text"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className={inputClassName}
                    required
                  />
                </div>
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <h4 className="mb-3 text-sm font-semibold text-white">{t('developer.salons.owner')}</h4>
                <dl className="grid gap-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-400">{t('developer.salons.ownerEmail')}</dt>
                    <dd className="text-right text-gray-200">{detail.owner?.email ?? '—'}</dd>
                  </div>
                  {detail.owner?.fullName && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-gray-400">{t('developer.salons.ownerName')}</dt>
                      <dd className="text-right text-gray-200">{detail.owner.fullName}</dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <h4 className="mb-3 text-sm font-semibold text-white">{t('developer.salons.createdAtLabel')}</h4>
                <p className="text-sm text-gray-300">{formatDate(detail.createdAt)}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 text-center">
                  <p className="text-xs text-gray-400">{t('developer.salons.clientCount')}</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detail.counts.clients}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 text-center">
                  <p className="text-xs text-gray-400">{t('developer.salons.appointmentCount')}</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detail.counts.appointments}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 text-center">
                  <p className="text-xs text-gray-400">{t('developer.salons.servicesCount')}</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detail.counts.services}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 text-center">
                  <p className="text-xs text-gray-400">{t('developer.salons.staffCount')}</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detail.counts.staff}</p>
                </div>
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <h4 className="mb-3 text-sm font-semibold text-white">{t('developer.salons.telegramStatus')}</h4>
                <div className="flex flex-wrap items-center gap-2">
                  <IntegrationStatusBadge status={detail.telegram.status} />
                  <IntegrationHealthBadge health={detail.telegram.health} />
                </div>
                {detail.telegram.status === 'not_connected' ? (
                  <>
                    <p className="mt-2 text-sm text-gray-400">{t('developer.salons.notConnected')}</p>
                    <button
                      type="button"
                      onClick={() => setConnectTelegramOpen(true)}
                      className="mt-3 w-full rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 sm:w-auto"
                    >
                      {t('developer.salons.connectTelegram')}
                    </button>
                  </>
                ) : (
                  <>
                    <dl className="mt-3 grid gap-2 text-sm">
                      {detail.telegram.botUsername && (
                        <div className="flex justify-between gap-3">
                          <dt className="text-gray-400">{t('developer.salons.botUsername')}</dt>
                          <dd className="text-right text-gray-200">@{detail.telegram.botUsername}</dd>
                        </div>
                      )}
                      {detail.telegram.botDisplayName && (
                        <div className="flex justify-between gap-3">
                          <dt className="text-gray-400">{t('developer.salons.botDisplayName')}</dt>
                          <dd className="text-right text-gray-200">{detail.telegram.botDisplayName}</dd>
                        </div>
                      )}
                    </dl>
                    {detail.telegram.livePolling ? (
                      <p className="mt-3 text-sm text-green-400">
                        {t('developer.salons.telegramBookingActive')}
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-amber-400/90">
                        {t('developer.salons.telegramConnectedNotActive')}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => setConnectTelegramOpen(true)}
                      className="mt-3 w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 sm:w-auto"
                    >
                      {t('developer.salons.reconnectTelegram')}
                    </button>
                  </>
                )}
              </div>

              {displayError && (
                <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-400">
                  {displayError}
                </div>
              )}
            </form>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-700 px-6 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 sm:w-auto"
          >
            {t('developer.salons.close')}
          </button>
          {detail && !loadError && (
            <button
              type="submit"
              form="salon-detail-form"
              disabled={saving || loading}
              className="w-full min-h-[40px] rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {saving ? t('developer.salons.saving') : t('developer.salons.save')}
            </button>
          )}
        </div>
      </div>

      {detail && salonId && (
        <ConnectSalonTelegramModal
          isOpen={connectTelegramOpen}
          salonId={salonId}
          salonName={detail.name}
          onClose={() => setConnectTelegramOpen(false)}
          onConnected={handleTelegramConnected}
        />
      )}
    </div>
  );
}
