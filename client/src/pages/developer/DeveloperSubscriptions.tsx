/**
 * SUB-1C2: Developer subscriptions list page — primary subscription management surface.
 * Reuses GET /developer/subscriptions + existing SalonSubscriptionSection editor.
 * No messenger enforcement.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, CreditCard, Search } from 'lucide-react';
import ConfigureSalonSubscriptionModal from '@/components/developer/ConfigureSalonSubscriptionModal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import type { TranslationKey } from '@/i18n/translations';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  DeveloperSalonSubscription,
  DeveloperSalonSubscriptionListItem,
  SalonEntitlementDenyReason,
  SalonSubscriptionStatus,
} from '@/types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatPeriodEnd(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusLabelKey(status: SalonSubscriptionStatus): TranslationKey {
  return `developer.salons.subscription.status.${status}` as TranslationKey;
}

function denyReasonKey(reason: SalonEntitlementDenyReason): TranslationKey {
  return `developer.salons.subscription.deny.${reason}` as TranslationKey;
}

function subStatusClass(status: SalonSubscriptionStatus): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
    case 'trial':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'past_due':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300';
    case 'expired':
    case 'cancelled':
    case 'unpaid':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

export default function DeveloperSubscriptions() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<DeveloperSalonSubscriptionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SalonSubscriptionStatus>('all');
  const [aiFilter, setAiFilter] = useState<'all' | 'allow' | 'deny'>('all');
  const [configureSalonId, setConfigureSalonId] = useState<string | null>(null);
  const [deepLinkNote, setDeepLinkNote] = useState('');

  const loadRows = useCallback(() => {
    setLoading(true);
    setError(false);
    return api.developer
      .getSalonSubscriptions()
      .then(setRows)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void api.developer
      .getSalonSubscriptions()
      .then((data) => {
        if (cancelled) return;
        setRows(data);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep-link: ?salonId=<uuid> opens configure for that exact salon.
  useEffect(() => {
    if (loading || error) return;
    const raw = searchParams.get('salonId')?.trim() ?? '';
    if (!raw) {
      setDeepLinkNote('');
      return;
    }
    if (!UUID_RE.test(raw)) {
      setDeepLinkNote(t('developer.subscriptions.invalidSalonId'));
      return;
    }
    const match = rows.find((r) => r.salonId === raw);
    if (!match) {
      setDeepLinkNote(t('developer.subscriptions.salonNotInList'));
      return;
    }
    setDeepLinkNote('');
    setConfigureSalonId(raw);
  }, [loading, error, rows, searchParams, t]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (q && !row.salonName.toLowerCase().includes(q)) return false;
        if (statusFilter !== 'all') {
          if (!row.subscription || row.subscription.status !== statusFilter) return false;
        }
        if (aiFilter === 'allow') {
          if (!row.subscription || !row.subscription.aiAutomationAllowed) return false;
        }
        if (aiFilter === 'deny') {
          if (!row.subscription || row.subscription.aiAutomationAllowed) return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => a.salonName.localeCompare(b.salonName));
  }, [rows, search, statusFilter, aiFilter]);

  const configureSalonName =
    rows.find((r) => r.salonId === configureSalonId)?.salonName ?? '';

  function openConfigure(salonId: string) {
    setConfigureSalonId(salonId);
    setSearchParams({ salonId }, { replace: true });
  }

  function closeConfigure() {
    setConfigureSalonId(null);
    if (searchParams.has('salonId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('salonId');
      setSearchParams(next, { replace: true });
    }
  }

  function handleUpdated(subscription: DeveloperSalonSubscription) {
    setRows((prev) =>
      prev.map((row) =>
        row.salonId === subscription.salonId
          ? { ...row, subscription, loadError: false }
          : row
      )
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-5 overflow-x-clip">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('developer.subscriptions.subtitle')}
        </p>
        <button
          type="button"
          onClick={() => void loadRows()}
          disabled={loading}
          className="btn-secondary self-start text-sm disabled:opacity-50"
        >
          {t('developer.subscriptions.retry')}
        </button>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('developer.subscriptions.search')}
            className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as 'all' | SalonSubscriptionStatus)
          }
          className="min-w-0 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white lg:w-auto"
        >
          <option value="all">{t('developer.subscriptions.filterStatusAll')}</option>
          {(
            ['trial', 'active', 'past_due', 'expired', 'cancelled', 'unpaid'] as SalonSubscriptionStatus[]
          ).map((s) => (
            <option key={s} value={s}>
              {t(statusLabelKey(s))}
            </option>
          ))}
        </select>
        <select
          value={aiFilter}
          onChange={(e) => setAiFilter(e.target.value as 'all' | 'allow' | 'deny')}
          className="min-w-0 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white lg:w-auto"
        >
          <option value="all">{t('developer.subscriptions.filterAiAll')}</option>
          <option value="allow">{t('developer.salons.subscription.aiAllowed')}</option>
          <option value="deny">{t('developer.salons.subscription.aiSuspended')}</option>
        </select>
      </div>

      {deepLinkNote && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {deepLinkNote}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-3">
          <LoadingSpinner />
          <p className="text-sm text-gray-500">{t('developer.subscriptions.loading')}</p>
        </div>
      ) : error ? (
        <div className="card flex flex-col items-start gap-3 p-5">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertCircle className="h-5 w-5" />
            <p className="text-sm font-medium">{t('developer.subscriptions.loadError')}</p>
          </div>
          <button type="button" onClick={() => void loadRows()} className="btn-secondary text-sm">
            {t('developer.subscriptions.retry')}
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('developer.subscriptions.empty')}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="table-scroll card hidden md:block">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('developer.subscriptions.colSalon')}</th>
                  <th className="px-4 py-3 font-medium">
                    {t('developer.subscriptions.colSalonStatus')}
                  </th>
                  <th className="px-4 py-3 font-medium">{t('developer.subscriptions.colPlan')}</th>
                  <th className="px-4 py-3 font-medium">
                    {t('developer.subscriptions.colSubscription')}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t('developer.subscriptions.colPeriodEnd')}
                  </th>
                  <th className="px-4 py-3 font-medium">{t('developer.subscriptions.colAi')}</th>
                  <th className="px-4 py-3 font-medium">{t('developer.subscriptions.colAction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {filtered.map((row) => (
                  <tr key={row.salonId} className="align-top">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <CreditCard className="h-4 w-4 shrink-0 text-violet-500" />
                        <span className="font-medium text-gray-900 dark:text-white">
                          {row.salonName}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                          row.salonActive
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        )}
                      >
                        {row.salonActive
                          ? t('developer.salons.active')
                          : t('developer.salons.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                      {row.loadError
                        ? '—'
                        : row.subscription?.plan === 'standard'
                          ? t('developer.salons.subscription.plan.standard')
                          : row.subscription?.plan ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {row.loadError ? (
                        <span className="text-xs text-red-500">
                          {t('developer.subscriptions.rowLoadError')}
                        </span>
                      ) : row.subscription ? (
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                            subStatusClass(row.subscription.status)
                          )}
                        >
                          {t(statusLabelKey(row.subscription.status))}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                      {row.subscription
                        ? formatPeriodEnd(row.subscription.currentPeriodEnd)
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {row.subscription ? (
                        <div className="space-y-1">
                          <span
                            className={cn(
                              'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                              row.subscription.aiAutomationAllowed
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                            )}
                          >
                            {row.subscription.aiAutomationAllowed
                              ? t('developer.salons.subscription.aiAllowed')
                              : t('developer.salons.subscription.aiSuspended')}
                          </span>
                          {row.subscription.denyReason && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {t(denyReasonKey(row.subscription.denyReason))}
                            </p>
                          )}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => openConfigure(row.salonId)}
                        className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
                      >
                        {t('developer.subscriptions.configure')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Narrow cards */}
          <div className="grid gap-3 md:hidden">
            {filtered.map((row) => (
              <div key={row.salonId} className="card space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-gray-900 dark:text-white">{row.salonName}</h3>
                  <span
                    className={cn(
                      'inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
                      row.salonActive
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    )}
                  >
                    {row.salonActive
                      ? t('developer.salons.active')
                      : t('developer.salons.inactive')}
                  </span>
                </div>
                {row.loadError ? (
                  <p className="text-xs text-red-500">{t('developer.subscriptions.rowLoadError')}</p>
                ) : row.subscription ? (
                  <dl className="grid gap-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-gray-500">{t('developer.subscriptions.colPlan')}</dt>
                      <dd>{t('developer.salons.subscription.plan.standard')}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-gray-500">
                        {t('developer.subscriptions.colSubscription')}
                      </dt>
                      <dd>{t(statusLabelKey(row.subscription.status))}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-gray-500">
                        {t('developer.subscriptions.colPeriodEnd')}
                      </dt>
                      <dd>{formatPeriodEnd(row.subscription.currentPeriodEnd)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-gray-500">{t('developer.subscriptions.colAi')}</dt>
                      <dd>
                        {row.subscription.aiAutomationAllowed
                          ? t('developer.salons.subscription.aiAllowed')
                          : t('developer.salons.subscription.aiSuspended')}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                <button
                  type="button"
                  onClick={() => openConfigure(row.salonId)}
                  className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
                >
                  {t('developer.subscriptions.configure')}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <ConfigureSalonSubscriptionModal
        salonId={configureSalonId}
        salonName={configureSalonName}
        isOpen={configureSalonId != null}
        onClose={closeConfigure}
        onUpdated={handleUpdated}
      />
    </div>
  );
}
