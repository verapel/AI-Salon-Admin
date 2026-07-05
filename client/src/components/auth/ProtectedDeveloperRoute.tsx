import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';

export default function ProtectedDeveloperRoute() {
  const { loading, session, isDeveloper, hasSalonAccess } = useAuth();
  const location = useLocation();
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-surface-dark">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  if (!isDeveloper) {
    if (hasSalonAccess) {
      return <Navigate to="/" replace />;
    }
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
