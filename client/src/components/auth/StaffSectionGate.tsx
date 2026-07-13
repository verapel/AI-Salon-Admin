import { Navigate, useLocation, Routes, Route } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import StaffAccessError from '@/pages/staff/StaffAccessError';
import StaffPortalShell from '@/pages/staff/StaffPortalShell';
import Layout from '@/components/layout/Layout';
import Staff from '@/pages/Staff';

/**
 * Role-split entry for /staff/*.
 * - staff_readonly (linked) → StaffPortalShell directly (descendant of /staff/*)
 * - staff_readonly (unlinked) → access error
 * - owner/admin → existing Staff management page inside salon Layout
 */
export default function StaffSectionGate() {
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
    if (!authInfo?.staffId) {
      return <StaffAccessError />;
    }
    // Direct shell: descendant Routes under /staff/* must see calendar|schedule.
    return <StaffPortalShell />;
  }

  if (role === 'owner' || role === 'admin') {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Staff />} />
          <Route path="*" element={<Navigate to="/staff" replace />} />
        </Route>
      </Routes>
    );
  }

  if (isDeveloper) {
    return <Navigate to="/developer" replace />;
  }

  return <Navigate to="/login" replace />;
}
