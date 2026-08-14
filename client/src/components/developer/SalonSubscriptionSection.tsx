/**
 * SUB-1C: Developer salon subscription management section.
 * Displays subscription state + derived AI entitlement; PATCH via developer API.
 * Does not enforce messengers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { TranslationKey } from '@/i18n/translations';
import type {
  DeveloperSalonSubscription,
  SalonEntitlementDenyReason,
  SalonSubscriptionStatus,
  UpdateDeveloperSalonSubscriptionRequest,
} from '@/types';

interface SalonSubscriptionSectionProps {
  salonId: string;
  isOpen: boolean;
}

const STATUS_OPTIONS: SalonSubscriptionStatus[] = [
  'trial',
  'active',
  'past_due',
  'expired',
  'cancelled',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Convert stored ISO/timestamptz to datetime-local value in the browser local zone. */
function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Convert datetime-local input to UTC ISO for the API.
 * Empty → null. Invalid → throws (caller shows validation error).
 */
function datetimeLocalToIso(local: string): string | null {
  const trimmed = local.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error('invalid_datetime');
  }
  return d.toISOString();
}

function statusBadgeClass(status: SalonSubscriptionStatus): string {
  switch (status) {
    case 'active':
      return 'bg-green-900/60 text-green-300';
    case 'trial':
      return 'bg-blue-900/60 text-blue-300';
    case 'past_due':
      return 'bg-yellow-900/60 text-yellow-300';
    case 'expired':
    case 'cancelled':
      return 'bg-red-900/60 text-red-300';
    default:
      return 'bg-slate-700 text-gray-300';
  }
}

function denyReasonKey(reason: SalonEntitlementDenyReason): TranslationKey {
  return `developer.salons.subscription.deny.${reason}` as TranslationKey;
}

export default function SalonSubscriptionSection({
  salonId,
  isOpen,
}: SalonSubscriptionSectionProps) {
  const { t } = useLanguage();
  const activeSalonIdRef = useRef(salonId);
  activeSalonIdRef.current = salonId;
  const [subscription, setSubscription] = useState<DeveloperSalonSubscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [validationError, setValidationError] = useState('');

  const [plan, setPlan] = useState<'standard'>('standard');
  const [status, setStatus] = useState<SalonSubscriptionStatus>('active');
  const [trialEndsLocal, setTrialEndsLocal] = useState('');
  const [periodStartLocal, setPeriodStartLocal] = useState('');
  const [periodEndLocal, setPeriodEndLocal] = useState('');
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [developerSuspended, setDeveloperSuspended] = useState(false);

  const populate = useCallback((data: DeveloperSalonSubscription) => {
    setSubscription(data);
    setPlan(data.plan === 'standard' ? 'standard' : 'standard');
    setStatus(data.status);
    setTrialEndsLocal(isoToDatetimeLocal(data.trialEndsAt));
    setPeriodStartLocal(isoToDatetimeLocal(data.currentPeriodStart));
    setPeriodEndLocal(isoToDatetimeLocal(data.currentPeriodEnd));
    setCancelAtPeriodEnd(data.cancelAtPeriodEnd);
    setDeveloperSuspended(data.developerSuspended);
  }, []);

  useEffect(() => {
    if (!isOpen || !salonId) {
      setSubscription(null);
      setLoadError('');
      setSaveError('');
      setSuccessMessage('');
      setValidationError('');
      return;
    }
    let cancelled = false;
    setSaveError('');
    setSuccessMessage('');
    setValidationError('');
    setLoading(true);
    setLoadError('');

    void api.developer
      .getSalonSubscription(salonId)
      .then((data) => {
        if (cancelled) return;
        populate(data);
        setLoadError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSubscription(null);
        setLoadError(
          err instanceof Error ? err.message : t('developer.salons.subscription.loadError')
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, salonId, populate, t]);

  async function handleSave() {
    if (!salonId || saving) return;
    const requestSalonId = salonId;
    setValidationError('');
    setSaveError('');
    setSuccessMessage('');

    let trialEndsAt: string | null;
    let currentPeriodStart: string | null;
    let currentPeriodEnd: string | null;
    try {
      trialEndsAt = datetimeLocalToIso(trialEndsLocal);
      currentPeriodStart = datetimeLocalToIso(periodStartLocal);
      currentPeriodEnd = datetimeLocalToIso(periodEndLocal);
    } catch {
      setValidationError(t('developer.salons.subscription.invalidTimestamp'));
      return;
    }

    const body: UpdateDeveloperSalonSubscriptionRequest = {
      plan,
      status,
      trialEndsAt,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      developerSuspended,
    };

    setSaving(true);
    try {
      const result = await api.developer.updateSalonSubscription(requestSalonId, body);
      // Ignore stale response if modal switched to another salon.
      if (activeSalonIdRef.current !== requestSalonId) return;
      if (!result.success || !result.subscription) {
        setSaveError(result.error || t('developer.salons.subscription.updateError'));
        return;
      }
      populate(result.subscription);
      setSuccessMessage(t('developer.salons.subscription.updated'));
    } catch (err) {
      if (activeSalonIdRef.current !== requestSalonId) return;
      setSaveError(
        err instanceof Error ? err.message : t('developer.salons.subscription.updateError')
      );
    } finally {
      if (activeSalonIdRef.current === requestSalonId) {
        setSaving(false);
      }
    }
  }

  const inputClassName =
    'w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20';

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-white">
          {t('developer.salons.subscription.title')}
        </h4>
        {subscription && (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(subscription.status)}`}
            >
              {t(`developer.salons.subscription.status.${subscription.status}` as TranslationKey)}
            </span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                subscription.aiAutomationAllowed
                  ? 'bg-green-900/60 text-green-300'
                  : 'bg-amber-900/60 text-amber-300'
              }`}
            >
              {subscription.aiAutomationAllowed
                ? t('developer.salons.subscription.aiAllowed')
                : t('developer.salons.subscription.aiSuspended')}
            </span>
          </div>
        )}
      </div>

      <p className="mb-4 text-xs leading-relaxed text-gray-400">
        {t('developer.salons.subscription.explanation')}
      </p>

      {loading && (
        <p className="text-sm text-gray-400">{t('developer.salons.subscription.loading')}</p>
      )}

      {loadError && !loading && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-400">
          {loadError}
        </div>
      )}

      {!loading && !loadError && subscription && (
        <div className="space-y-4">
          {subscription.denyReason && (
            <div className="rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
              <span className="font-medium">
                {t('developer.salons.subscription.denyReasonLabel')}:{' '}
              </span>
              {t(denyReasonKey(subscription.denyReason))}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">
                {t('developer.salons.subscription.plan')}
              </label>
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value as 'standard')}
                className={inputClassName}
              >
                <option value="standard">
                  {t('developer.salons.subscription.plan.standard')}
                </option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">
                {t('developer.salons.subscription.status')}
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as SalonSubscriptionStatus)}
                className={inputClassName}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {t(`developer.salons.subscription.status.${s}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">
                {t('developer.salons.subscription.trialEnds')}
              </label>
              <input
                type="datetime-local"
                value={trialEndsLocal}
                onChange={(e) => setTrialEndsLocal(e.target.value)}
                className={inputClassName}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">
                {t('developer.salons.subscription.periodStarts')}
              </label>
              <input
                type="datetime-local"
                value={periodStartLocal}
                onChange={(e) => setPeriodStartLocal(e.target.value)}
                className={inputClassName}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">
                {t('developer.salons.subscription.periodEnds')}
              </label>
              <input
                type="datetime-local"
                value={periodEndLocal}
                onChange={(e) => setPeriodEndLocal(e.target.value)}
                className={inputClassName}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-300">
                {t('developer.salons.subscription.cancelAtPeriodEnd')}
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={cancelAtPeriodEnd}
                onChange={(e) => setCancelAtPeriodEnd(e.target.checked)}
                className="peer sr-only"
              />
              <span className="h-6 w-11 rounded-full bg-slate-600 transition-colors peer-checked:bg-purple-600 peer-focus:ring-2 peer-focus:ring-purple-500/30" />
              <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-300">
                {t('developer.salons.subscription.manualAiSuspension')}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {t('developer.salons.subscription.manualAiSuspensionHint')}
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={developerSuspended}
                onChange={(e) => setDeveloperSuspended(e.target.checked)}
                className="peer sr-only"
              />
              <span className="h-6 w-11 rounded-full bg-slate-600 transition-colors peer-checked:bg-amber-600 peer-focus:ring-2 peer-focus:ring-amber-500/30" />
              <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
            </label>
          </div>

          {validationError && (
            <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-400">
              {validationError}
            </div>
          )}
          {saveError && (
            <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-400">
              {saveError}
            </div>
          )}
          {successMessage && (
            <div className="rounded-lg border border-green-800 bg-green-950/50 px-3 py-2 text-sm text-green-400">
              {successMessage}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="w-full rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {saving
              ? t('developer.salons.subscription.saving')
              : t('developer.salons.subscription.save')}
          </button>
        </div>
      )}
    </div>
  );
}
