import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import ConnectSalonTelegramModal from '@/components/developer/ConnectSalonTelegramModal';
import DeleteSalonModal from '@/components/developer/DeleteSalonModal';
import IntegrationStatusBadge from '@/components/developer/IntegrationStatusBadge';
import IntegrationHealthBadge from '@/components/developer/IntegrationHealthBadge';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import type {
  DeveloperInstagramIntegration,
  DeveloperSalonDetail,
  SalonPermanentDeleteResponse,
  TelegramAdminChatCandidateResponse,
} from '@/types';

interface SalonDetailModalProps {
  salonId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted?: (result: SalonPermanentDeleteResponse) => void;
}

const ADMIN_CHAT_ID_REGEX = /^-?\d+$/;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PILOT_SALON_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';
const DEFAULT_SALON_SLUG = 'default';

export default function SalonDetailModal({
  salonId,
  isOpen,
  onClose,
  onUpdated,
  onDeleted,
}: SalonDetailModalProps) {
  const { t } = useLanguage();
  const [detail, setDetail] = useState<DeveloperSalonDetail | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [connectTelegramOpen, setConnectTelegramOpen] = useState(false);
  const [adminChatIdInput, setAdminChatIdInput] = useState('');
  const [savingAdminChat, setSavingAdminChat] = useState(false);
  const [adminChatValidationError, setAdminChatValidationError] = useState('');
  const [adminChatSaveError, setAdminChatSaveError] = useState('');
  const [adminChatSuccessMessage, setAdminChatSuccessMessage] = useState('');
  const [testingAdminNotification, setTestingAdminNotification] = useState(false);
  const [adminChatTestError, setAdminChatTestError] = useState('');
  const [adminChatTestSuccess, setAdminChatTestSuccess] = useState('');
  const [findingAdminChat, setFindingAdminChat] = useState(false);
  const [confirmingAdminChatCandidate, setConfirmingAdminChatCandidate] = useState(false);
  const [adminChatCandidate, setAdminChatCandidate] =
    useState<TelegramAdminChatCandidateResponse | null>(null);
  const [adminChatCandidateError, setAdminChatCandidateError] = useState('');
  const [adminChatCandidateSuccess, setAdminChatCandidateSuccess] = useState('');
  const [instagram, setInstagram] = useState<DeveloperInstagramIntegration | null>(null);
  const [instagramError, setInstagramError] = useState(false);

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
      setAdminChatIdInput(
        data.telegram.adminChatId != null ? String(data.telegram.adminChatId) : ''
      );
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
    setAdminChatValidationError('');
    setAdminChatSaveError('');
    setAdminChatSuccessMessage('');
    setAdminChatTestError('');
    setAdminChatTestSuccess('');
    setFindingAdminChat(false);
    setConfirmingAdminChatCandidate(false);
    setAdminChatCandidate(null);
    setAdminChatCandidateError('');
    setAdminChatCandidateSuccess('');
    loadDetail();
  }, [isOpen, salonId, loadDetail]);

  // IG-UI-1A: Instagram status loads independently so it cannot delay salon details.
  // Cleanup cancelled flag ignores stale A→B / closed-modal responses.
  useEffect(() => {
    if (!isOpen || !salonId) {
      setInstagram(null);
      setInstagramError(false);
      return;
    }

    let cancelled = false;
    setInstagram(null);
    setInstagramError(false);

    void api.developer
      .getInstagramIntegration(salonId)
      .then((ig) => {
        if (cancelled) return;
        setInstagram(ig);
        setInstagramError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setInstagram(null);
        setInstagramError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, salonId]);

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

  async function handleSaveAdminChat() {
    if (!salonId) return;

    setAdminChatValidationError('');
    setAdminChatSaveError('');
    setAdminChatSuccessMessage('');
    setAdminChatTestError('');
    setAdminChatTestSuccess('');

    const trimmed = adminChatIdInput.trim();
    let adminChatId: number | null;

    if (trimmed === '') {
      adminChatId = null;
    } else if (!ADMIN_CHAT_ID_REGEX.test(trimmed)) {
      setAdminChatValidationError(t('developer.salons.adminChatIdInvalid'));
      return;
    } else {
      const parsed = Number(trimmed);
      if (parsed === 0) {
        setAdminChatValidationError(t('developer.salons.adminChatIdInvalid'));
        return;
      }
      adminChatId = parsed;
    }

    setSavingAdminChat(true);
    try {
      await api.developer.updateTelegramIntegration(salonId, { adminChatId });
      await loadDetail();
      setAdminChatSuccessMessage(t('developer.salons.adminChatIdSaved'));
      onUpdated();
    } catch (err) {
      setAdminChatSaveError(
        err instanceof Error ? err.message : t('developer.salons.updateError')
      );
    } finally {
      setSavingAdminChat(false);
    }
  }

  async function handleTestAdminNotification() {
    if (!salonId || detail?.telegram.adminChatId == null) return;

    setAdminChatTestError('');
    setAdminChatTestSuccess('');

    setTestingAdminNotification(true);
    try {
      const result = await api.developer.testAdminNotification(salonId);
      if (!result.success) {
        setAdminChatTestError(result.error ?? t('developer.salons.testAdminNotificationError'));
        return;
      }
      setAdminChatTestSuccess(t('developer.salons.testAdminNotificationSuccess'));
    } catch (err) {
      setAdminChatTestError(
        err instanceof Error ? err.message : t('developer.salons.testAdminNotificationError')
      );
    } finally {
      setTestingAdminNotification(false);
    }
  }

  async function handleFindAdminChat() {
    if (!salonId) return;

    setAdminChatCandidateError('');
    setAdminChatCandidateSuccess('');
    setAdminChatCandidate(null);
    setFindingAdminChat(true);
    try {
      const result = await api.developer.getTelegramAdminChatCandidate(salonId);
      setAdminChatCandidate(result);
      if (result.found) {
        setAdminChatCandidateSuccess(t('developer.salons.adminChatCandidateFound'));
      } else if (result.expired) {
        setAdminChatCandidateError(t('developer.salons.adminChatCandidateExpired'));
      } else {
        setAdminChatCandidateError(t('developer.salons.adminChatCandidateNotFound'));
      }
    } catch (err) {
      setAdminChatCandidateError(
        err instanceof Error ? err.message : t('developer.salons.adminChatCandidateNotFound')
      );
    } finally {
      setFindingAdminChat(false);
    }
  }

  async function handleUseAdminChatCandidate() {
    if (!salonId || adminChatCandidate?.candidateChatId == null) return;

    setAdminChatCandidateError('');
    setAdminChatCandidateSuccess('');
    setConfirmingAdminChatCandidate(true);
    try {
      const result = await api.developer.confirmTelegramAdminChatCandidate(
        salonId,
        adminChatCandidate.candidateChatId
      );
      if (!result.success) {
        setAdminChatCandidateError(
          result.error ?? t('developer.salons.adminChatCandidateConfirmError')
        );
        return;
      }
      setAdminChatCandidate(null);
      setAdminChatCandidateSuccess(t('developer.salons.adminChatCandidateConfirmed'));
      await loadDetail();
      onUpdated();
    } catch (err) {
      setAdminChatCandidateError(
        err instanceof Error ? err.message : t('developer.salons.adminChatCandidateConfirmError')
      );
    } finally {
      setConfirmingAdminChatCandidate(false);
    }
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

                    <div className="mt-4 border-t border-slate-700 pt-4">
                      <h5 className="mb-2 text-sm font-semibold text-white">
                        {t('developer.salons.adminNotifications')}
                      </h5>
                      <p className="mb-3 text-xs text-gray-400">
                        {t('developer.salons.adminChatIdHint')}
                      </p>

                      <div className="mb-4 space-y-2">
                        <button
                          type="button"
                          onClick={handleFindAdminChat}
                          disabled={findingAdminChat || confirmingAdminChatCandidate || loading}
                          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        >
                          {findingAdminChat
                            ? t('developer.salons.findingAdminChat')
                            : t('developer.salons.findAdminChat')}
                        </button>
                        {adminChatCandidate?.found &&
                          adminChatCandidate.candidateChatId != null && (
                            <div className="rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-3 text-sm text-gray-200">
                              <p className="font-medium text-white">
                                {t('developer.salons.adminChatCandidateFound')}
                              </p>
                              <p className="mt-1 text-gray-300">
                                {t('developer.salons.adminChatId')}:{' '}
                                {adminChatCandidate.candidateChatId}
                              </p>
                              {adminChatCandidate.detectedAt && (
                                <p className="mt-1 text-xs text-gray-400">
                                  {formatDateTime(adminChatCandidate.detectedAt)}
                                </p>
                              )}
                              <button
                                type="button"
                                onClick={handleUseAdminChatCandidate}
                                disabled={
                                  confirmingAdminChatCandidate || findingAdminChat || loading
                                }
                                className="mt-3 w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                              >
                                {confirmingAdminChatCandidate
                                  ? t('developer.salons.confirmingAdminChatCandidate')
                                  : t('developer.salons.useAdminChatCandidate')}
                              </button>
                            </div>
                          )}
                        {adminChatCandidateError && (
                          <p className="text-sm text-red-400">{adminChatCandidateError}</p>
                        )}
                        {adminChatCandidateSuccess && !adminChatCandidate?.found && (
                          <p className="text-sm text-green-400">{adminChatCandidateSuccess}</p>
                        )}
                      </div>

                      <label className="mb-1.5 block text-sm font-medium text-gray-300">
                        {t('developer.salons.adminChatId')}
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={adminChatIdInput}
                        onChange={(e) => setAdminChatIdInput(e.target.value)}
                        placeholder={t('developer.salons.adminChatIdNotSet')}
                        className={inputClassName}
                      />
                      {detail.telegram.adminChatId == null && adminChatIdInput.trim() === '' && (
                        <p className="mt-1.5 text-xs text-gray-500">
                          {t('developer.salons.adminChatIdNotSet')}
                        </p>
                      )}
                      {adminChatValidationError && (
                        <p className="mt-2 text-sm text-red-400">{adminChatValidationError}</p>
                      )}
                      {adminChatSaveError && (
                        <p className="mt-2 text-sm text-red-400">{adminChatSaveError}</p>
                      )}
                      {adminChatSuccessMessage && (
                        <p className="mt-2 text-sm text-green-400">{adminChatSuccessMessage}</p>
                      )}
                      {adminChatTestError && (
                        <p className="mt-2 text-sm text-red-400">{adminChatTestError}</p>
                      )}
                      {adminChatTestSuccess && (
                        <p className="mt-2 text-sm text-green-400">{adminChatTestSuccess}</p>
                      )}
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <button
                          type="button"
                          onClick={handleSaveAdminChat}
                          disabled={savingAdminChat || loading}
                          className="w-full rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        >
                          {savingAdminChat
                            ? t('developer.salons.savingAdminChatId')
                            : t('developer.salons.saveAdminChatId')}
                        </button>
                        <button
                          type="button"
                          onClick={handleTestAdminNotification}
                          disabled={
                            testingAdminNotification ||
                            loading ||
                            detail.telegram.adminChatId == null
                          }
                          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        >
                          {testingAdminNotification
                            ? t('developer.salons.testingAdminNotification')
                            : t('developer.salons.testAdminNotification')}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <h4 className="mb-2 text-sm font-semibold text-white">
                  {t('developer.integrations.instagram.title')}
                </h4>
                <p className="mb-3 text-xs text-gray-400">
                  {t('developer.integrations.instagram.salonDetailHint')}
                </p>
                {instagramError ? (
                  <p className="text-sm text-red-400">
                    {t('developer.integrations.instagram.genericError')}
                  </p>
                ) : instagram ? (
                  <>
                    <p className="text-sm text-gray-200">
                      {instagram.integrationAdded === false
                        ? t('developer.integrations.instagram.notAdded')
                        : instagram.connected
                          ? t('developer.integrations.status.connected')
                          : instagram.connection?.status === 'error'
                            ? t('developer.integrations.instagram.reconnectRequired')
                            : t('developer.integrations.status.notConnected')}
                    </p>
                    {instagram.integrationAdded !== false ? (
                      <p className="mt-2 text-xs text-gray-400">
                        {t('developer.integrations.instagram.outbound')}:{' '}
                        {instagram.outboundEnabled
                          ? t('developer.integrations.instagram.outboundEnabled')
                          : t('developer.integrations.instagram.outboundDisabled')}
                      </p>
                    ) : null}
                    <Link
                      to={`/developer/integrations?tab=instagram`}
                      className="mt-3 inline-flex rounded-lg bg-rose-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-rose-600"
                    >
                      {instagram.integrationAdded === false
                        ? t('developer.integrations.instagram.addInIntegrations')
                        : t('developer.integrations.instagram.manageInIntegrations')}
                    </Link>
                  </>
                ) : (
                  <p className="text-sm text-gray-400">{t('developer.integrations.loading')}</p>
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

        <div className="flex flex-col gap-2 border-t border-slate-700 px-6 py-4">
          {detail && !loadError ? (
            <div className="mb-1 rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-3">
              {detail.id === PILOT_SALON_ID || detail.slug === DEFAULT_SALON_SLUG ? (
                <p className="text-sm text-amber-300">{t('developer.salons.protectedSalonHint')}</p>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteOpen(true)}
                  disabled={saving || loading}
                  className="w-full rounded-lg border border-red-800 bg-red-950/40 px-4 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-950/70 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                >
                  {t('developer.salons.deleteSalon')}
                </button>
              )}
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
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

      <DeleteSalonModal
        open={deleteOpen}
        salonId={salonId}
        onClose={() => setDeleteOpen(false)}
        onDeleted={(result) => {
          setDeleteOpen(false);
          onDeleted?.(result);
          onClose();
        }}
      />
    </div>
  );
}
