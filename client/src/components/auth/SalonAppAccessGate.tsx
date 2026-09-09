import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useBilling } from '@/context/BillingContext';
import { useLanguage } from '@/context/LanguageContext';

function isSubscriptionPath(pathname: string): boolean {
  return pathname === '/subscription' || pathname.startsWith('/subscription/');
}

/** Keeps login, subscription, and payment reachable when entitlement is off. */
export default function SalonAppAccessGate() {
  const { loading: authLoading, authInfo } = useAuth();
  const { snapshot, loading: billingLoading } = useBilling();
  const location = useLocation();
  const { t } = useLanguage();

  if (authLoading || (authInfo?.salonId && billingLoading && !snapshot)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      </div>
    );
  }

  const entitled = snapshot ? snapshot.entitled : true;
  if (entitled || isSubscriptionPath(location.pathname)) {
    return <Outlet />;
  }

  return <Navigate to="/subscription" replace />;
}
