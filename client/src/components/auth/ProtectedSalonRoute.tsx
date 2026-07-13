import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';

/** Owner/admin salon cabinet only — staff_readonly is redirected to /staff. */
export default function ProtectedSalonRoute() {
  const { loading, session, authInfo, isDeveloper } = useAuth();
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

  const role = authInfo?.role;

  if (role === 'staff_readonly') {
    return <Navigate to="/staff" replace />;
  }

  if (role === 'owner' || role === 'admin') {
    return <Outlet />;
  }

  if (isDeveloper) {
    return <Navigate to="/developer" replace />;
  }

  return <Navigate to="/login" replace />;
}
