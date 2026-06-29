import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { cn } from '@/lib/utils';

export type IntegrationTabId = 'telegram' | 'whatsapp' | 'instagram' | 'tiktok';

export type IntegrationChannelId = IntegrationTabId;

export const INTEGRATION_TABS: {
  id: IntegrationTabId;
  labelKey: TranslationKey;
  available: boolean;
}[] = [
  { id: 'telegram', labelKey: 'developer.integrations.tabs.telegram', available: true },
  { id: 'whatsapp', labelKey: 'developer.integrations.tabs.whatsapp', available: false },
  { id: 'instagram', labelKey: 'developer.integrations.tabs.instagram', available: false },
  { id: 'tiktok', labelKey: 'developer.integrations.tabs.tiktok', available: false },
];

export const INTEGRATION_CHANNELS: {
  id: IntegrationChannelId;
  labelKey: TranslationKey;
}[] = INTEGRATION_TABS.map(({ id, labelKey }) => ({ id, labelKey }));

interface IntegrationTabsProps {
  activeTab: IntegrationTabId;
  onTabChange: (tab: IntegrationTabId) => void;
}

export default function IntegrationTabs({ activeTab, onTabChange }: IntegrationTabsProps) {
  const { t } = useLanguage();

  return (
    <div className="w-full min-w-0">
      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label={t('developer.integrations.title')}
      >
        {INTEGRATION_TABS.map(({ id, labelKey, available }) => {
          const isActive = activeTab === id;

          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabChange(id)}
              className={cn(
                'inline-flex min-h-[40px] max-w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
              )}
            >
              <span className="truncate">{t(labelKey)}</span>
              {!available && (
                <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  {t('developer.integrations.comingSoon')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
