import { useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';

interface CreateSalonModalProps {
  open: boolean;
  onClose: () => void;
  creating: boolean;
  createError: string;
  onCreate: (params: {
    name: string;
    ownerEmail: string;
    ownerPassword: string;
    ownerName?: string;
  }) => Promise<boolean>;
  onClearError: () => void;
  onSuccess: () => void;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function CreateSalonModal({
  open,
  onClose,
  creating,
  createError,
  onCreate,
  onClearError,
  onSuccess,
}: CreateSalonModalProps) {
  const { t } = useLanguage();
  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setOwnerEmail('');
    setOwnerPassword('');
    setOwnerName('');
    setValidationError('');
    onClearError();
  }, [open, onClearError]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError('');

    const trimmedName = name.trim();
    const trimmedEmail = ownerEmail.trim().toLowerCase();
    const trimmedOwnerName = ownerName.trim();

    if (trimmedName.length < 2) {
      setValidationError(t('developer.salons.validationName'));
      return;
    }
    if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
      setValidationError(t('developer.salons.validationEmail'));
      return;
    }
    if (ownerPassword.length < 6) {
      setValidationError(t('developer.salons.validationPassword'));
      return;
    }

    const success = await onCreate({
      name: trimmedName,
      ownerEmail: trimmedEmail,
      ownerPassword,
      ownerName: trimmedOwnerName || undefined,
    });
    if (success) {
      onSuccess();
      onClose();
    }
  }

  const displayError = validationError || createError;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
      >
        <h3 className="mb-5 text-lg font-semibold text-white">{t('developer.salons.createSalon')}</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.salons.salonName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('developer.integrations.modal.salonNamePlaceholder')}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.salons.ownerEmail')}
            </label>
            <input
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              autoComplete="off"
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.salons.ownerPassword')}
            </label>
            <input
              type="password"
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              {t('developer.salons.ownerName')}
            </label>
            <input
              type="text"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </div>

          {displayError && (
            <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-400">
              {displayError}
            </div>
          )}

          <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-slate-700 sm:w-auto"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={creating || !name.trim() || !ownerEmail.trim() || ownerPassword.length < 6}
              className="w-full min-h-[40px] rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {creating ? t('developer.salons.creating') : t('developer.salons.createSalon')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
