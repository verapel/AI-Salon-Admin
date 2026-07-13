import { useLanguage } from '@/context/LanguageContext';

/**
 * Legacy AI Assistant page (not mounted in App routes).
 * Telegram connect is developer-only after Security-2a.
 */
export default function AIAssistant() {
  const { t } = useLanguage();

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in sm:p-6">
      <h1 className="text-2xl font-bold">{t('pages.aiAssistant.title')}</h1>

      <p className="mb-6 text-gray-400">{t('ai.subtitle')}</p>

      <div className="w-full min-w-0 max-w-full grid gap-4 md:grid-cols-3">
        <div className="w-full min-w-0 max-w-full rounded-xl bg-slate-800 p-4">
          <h2 className="text-xl font-semibold">{t('ai.telegram')}</h2>
          <p className="mt-2 text-sm text-amber-400/90">{t('integrations.managedByDeveloper')}</p>
        </div>

        <div className="w-full min-w-0 max-w-full rounded-xl bg-slate-800 p-4">
          <h2 className="text-xl font-semibold">{t('ai.whatsapp')}</h2>
          <p className="mt-2 text-gray-400 text-sm">
            {t('ai.statusLabel')} {t('common.notConnected')}
          </p>
        </div>

        <div className="w-full min-w-0 max-w-full rounded-xl bg-slate-800 p-4">
          <h2 className="text-xl font-semibold">{t('ai.instagram')}</h2>
          <p className="mt-2 text-gray-400 text-sm">
            {t('ai.statusLabel')} {t('common.notConnected')}
          </p>
        </div>
      </div>
    </div>
  );
}
