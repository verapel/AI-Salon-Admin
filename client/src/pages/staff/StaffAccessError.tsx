import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';

export default function StaffAccessError() {
  const { signOut } = useAuth();
  const { t } = useLanguage();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 dark:bg-surface-dark">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('staffPortal.accessError.title')}
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t('staffPortal.accessError.body')}
        </p>
        <button type="button" onClick={() => void signOut()} className="btn-primary mt-6 w-full">
          {t('staffPortal.nav.logout')}
        </button>
      </div>
    </div>
  );
}
