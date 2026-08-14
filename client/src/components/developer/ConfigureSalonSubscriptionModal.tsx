/**
 * SUB-1C2: Modal wrapping the shared SalonSubscriptionSection editor.
 */

import SalonSubscriptionSection from '@/components/developer/SalonSubscriptionSection';
import { useLanguage } from '@/context/LanguageContext';
import type { DeveloperSalonSubscription } from '@/types';

interface ConfigureSalonSubscriptionModalProps {
  salonId: string | null;
  salonName: string;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: (subscription: DeveloperSalonSubscription) => void;
}

export default function ConfigureSalonSubscriptionModal({
  salonId,
  salonName,
  isOpen,
  onClose,
  onUpdated,
}: ConfigureSalonSubscriptionModalProps) {
  const { t } = useLanguage();

  if (!isOpen || !salonId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      >
        <div className="border-b border-slate-700 px-6 py-5">
          <h3 className="text-lg font-semibold text-white">
            {t('developer.subscriptions.configureTitle')}
          </h3>
          <p className="mt-1 truncate text-sm text-gray-400">{salonName}</p>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <SalonSubscriptionSection
            salonId={salonId}
            isOpen={isOpen}
            embedded
            onUpdated={onUpdated}
          />
        </div>
        <div className="border-t border-slate-700 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 sm:w-auto"
          >
            {t('developer.salons.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
