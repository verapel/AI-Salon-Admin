import { useLanguage } from '@/context/LanguageContext';

export default function DeveloperIntegrations() {
  const { t } = useLanguage();

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 animate-fade-in">
      <div className="card w-full min-w-0 max-w-full">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('developer.integrations.title')}</h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('developer.integrations.placeholder')}</p>
      </div>
    </div>
  );
}
