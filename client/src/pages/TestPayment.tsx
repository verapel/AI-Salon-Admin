import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useBilling } from '@/context/BillingContext';
import { useLanguage } from '@/context/LanguageContext';
import { api, ApiError } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { BillingCheckoutView } from '@/types';

export default function TestPayment() {
  const { checkoutId } = useParams<{ checkoutId: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { refresh } = useBilling();
  const [checkout, setCheckout] = useState<BillingCheckoutView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!checkoutId) {
      setLoading(false);
      setError(t('subscription.checkoutNotFound'));
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.billing
      .getCheckout(checkoutId)
      .then((data) => {
        if (!cancelled) setCheckout(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('subscription.checkoutNotFound'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [checkoutId, t]);

  async function complete(result: 'success' | 'failure') {
    if (!checkoutId) return;
    setBusy(true);
    setError(null);
    try {
      await api.billing.completeTestCheckout(checkoutId, result);
      await refresh();
      navigate('/subscription', { replace: true });
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : t('subscription.loadError');
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
        <LoadingSpinner />
        <p className="text-sm text-gray-500">{t('common.loading')}</p>
      </div>
    );
  }

  if (!checkout) {
    return (
      <div className="card mx-auto max-w-lg">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {error ?? t('subscription.checkoutNotFound')}
        </p>
        <Link to="/subscription" className="btn-secondary mt-4 inline-flex">
          {t('subscription.back')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">{t('subscription.testBannerTitle')}</p>
            <p className="mt-1">{t('subscription.testBannerBody')}</p>
          </div>
        </div>
      </div>

      <section className="card space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('subscription.testPaymentTitle')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('subscription.testHint')}</p>
        <div className="rounded-lg bg-gray-50 px-4 py-3 dark:bg-gray-800/60">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('subscription.planName')}</p>
          <p className="text-xl font-semibold text-gray-900 dark:text-white">
            {formatCurrency(checkout.amount, checkout.currency)}
          </p>
        </div>
        {error ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={busy || checkout.status !== 'pending'}
            onClick={() => void complete('success')}
          >
            {t('subscription.payTest')}
          </button>
          <button
            type="button"
            className="btn-secondary flex-1"
            disabled={busy || checkout.status !== 'pending'}
            onClick={() => void complete('failure')}
          >
            {t('subscription.failTest')}
          </button>
        </div>
        <Link to="/subscription" className="inline-flex text-sm font-medium text-brand-700 dark:text-brand-300">
          {t('subscription.back')}
        </Link>
      </section>
    </div>
  );
}
