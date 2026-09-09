import { FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, Sparkles } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useBilling } from '@/context/BillingContext';
import { useLanguage, type LangCode } from '@/context/LanguageContext';
import type { TranslationKey } from '@/i18n/translations';
import { api, ApiError } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { BillingPayment, OwnerSubscription } from '@/types';

function localeFor(language: LangCode): string {
  if (language === 'ru') return 'ru-RU';
  if (language === 'hy') return 'hy-AM';
  return 'en-US';
}

function formatLongDate(iso: string | null, language: LangCode): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(localeFor(language), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function paymentStatusClass(status: BillingPayment['status']): string {
  if (status === 'succeeded') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
  }
  if (status === 'failed') {
    return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
  }
  return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300';
}

export default function Subscription() {
  const navigate = useNavigate();
  const { language, t } = useLanguage();
  const { snapshot, loading, refresh } = useBilling();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const data = snapshot;
  const showPaidDetails = Boolean(data?.hasManagedPaidPeriod);

  const canceledMessage = useMemo(() => {
    if (!data?.cancelAtPeriodEnd || !data.currentPeriodEnd) return null;
    return t('subscription.canceledUntil').replace(
      '{date}',
      formatLongDate(data.currentPeriodEnd, language),
    );
  }, [data, language, t]);

  async function handleSubscribe() {
    setError(null);
    setBusy(true);
    try {
      const checkout = await api.billing.createCheckout('standard');
      navigate(checkout.hostedPaymentPath);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_SUBSCRIBED') {
        await refresh();
        setError(t('subscription.alreadyActive'));
      } else {
        setError(err instanceof Error ? err.message : t('subscription.loadError'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelConfirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.billing.cancelSubscription();
      await refresh();
      setCancelOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('subscription.loadError'));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
        <LoadingSpinner />
        <p className="text-sm text-gray-500">{t('common.loading')}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card max-w-xl">
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('subscription.loadError')}</p>
        <button type="button" className="btn-secondary mt-4" onClick={() => void refresh()}>
          {t('subscription.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <section className="card overflow-hidden p-0">
        <div className="bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-6 text-white sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-white/80">
                {t('subscription.productName')}
              </p>
              <h3 className="mt-1 text-xl font-semibold">{t('subscription.planName')}</h3>
              <p className="mt-2 text-sm text-white/90">{t('subscription.planDescription')}</p>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('subscription.monthly')}</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-white">
                {formatCurrency(data.plan.amount, data.plan.currency)}
              </p>
            </div>
            {showPaidDetails || (data.entitled && data.isComplimentary) ? (
              <span className="badge bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                {t('subscription.statusActive')}
              </span>
            ) : (
              <span className="badge bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {t('subscription.statusUnpaid')}
              </span>
            )}
          </div>

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          ) : null}

          {canceledMessage ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {canceledMessage}
            </p>
          ) : null}

          {showPaidDetails ? (
            <PaidDetails
              data={data}
              language={language}
              t={t}
              onCancel={() => setCancelOpen(true)}
              busy={busy}
            />
          ) : (
            <div className="space-y-4">
              {data.entitled && data.isComplimentary ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('subscription.complimentaryNote')}
                </p>
              ) : null}
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('subscription.noAutoChargePreview')}
              </p>
              <button
                type="button"
                className="btn-primary w-full sm:w-auto"
                disabled={busy}
                onClick={() => void handleSubscribe()}
              >
                <CreditCard className="h-4 w-4" />
                {t('subscription.subscribe')}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white">
          {t('subscription.paymentHistory')}
        </h3>
        {data.payments.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('subscription.noPayments')}</p>
        ) : (
          <ul className="mt-4 divide-y dark:divide-gray-800">
            {data.payments.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 dark:text-white">
                    {formatCurrency(payment.amount, payment.currency)}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatLongDate(payment.paidAt ?? payment.createdAt, language)}
                  </p>
                </div>
                <span className={`badge ${paymentStatusClass(payment.status)}`}>
                  {payment.status === 'succeeded'
                    ? t('subscription.paymentSucceeded')
                    : payment.status === 'failed'
                      ? t('subscription.paymentFailed')
                      : t('subscription.paymentPending')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={cancelOpen}
        onClose={() => !busy && setCancelOpen(false)}
        title={t('subscription.cancelConfirmTitle')}
        size="sm"
      >
        <form onSubmit={handleCancelConfirm} className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('subscription.cancelConfirmBody').replace(
              '{date}',
              formatLongDate(data.currentPeriodEnd, language),
            )}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => setCancelOpen(false)}
            >
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('subscription.cancelConfirmAction')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function PaidDetails({
  data,
  language,
  t,
  onCancel,
  busy,
}: {
  data: OwnerSubscription;
  language: LangCode;
  t: (key: TranslationKey) => string;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">{t('subscription.startDate')}</dt>
          <dd className="text-sm font-medium text-gray-900 dark:text-white">
            {formatLongDate(data.currentPeriodStart, language)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">{t('subscription.periodEnd')}</dt>
          <dd className="text-sm font-medium text-gray-900 dark:text-white">
            {formatLongDate(data.currentPeriodEnd, language)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">{t('subscription.provider')}</dt>
          <dd className="text-sm font-medium text-gray-900 dark:text-white">
            {data.provider.id === 'test' ? t('subscription.providerTest') : data.provider.displayName}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">{t('subscription.method')}</dt>
          <dd className="text-sm font-medium text-gray-900 dark:text-white">
            {t('subscription.methodTest')}
          </dd>
        </div>
      </dl>

      {!data.provider.supportsAutomaticRecurring ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('subscription.noAutoCharge').replace(
            '{date}',
            formatLongDate(data.currentPeriodEnd, language),
          )}
        </p>
      ) : null}

      {!data.cancelAtPeriodEnd ? (
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('subscription.cancel')}
        </button>
      ) : null}
    </div>
  );
}
