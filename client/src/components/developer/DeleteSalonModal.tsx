import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import { ApiError, api } from '@/lib/api';
import type { SalonDeletePreview, SalonPermanentDeleteResponse } from '@/types';

interface DeleteSalonModalProps {
  open: boolean;
  salonId: string | null;
  onClose: () => void;
  onDeleted: (result: SalonPermanentDeleteResponse) => void;
}

export default function DeleteSalonModal({
  open,
  salonId,
  onClose,
  onDeleted,
}: DeleteSalonModalProps) {
  const { t } = useLanguage();
  const [preview, setPreview] = useState<SalonDeletePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedSlug, setTypedSlug] = useState('');

  useEffect(() => {
    if (!open || !salonId) {
      setPreview(null);
      setError(null);
      setLoading(false);
      setSubmitting(false);
      setAcknowledged(false);
      setTypedSlug('');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    setAcknowledged(false);
    setTypedSlug('');

    api.developer
      .getSalonDeletePreview(salonId)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'SALON_NOT_FOUND') {
          setError(t('developer.salons.deleteFailed'));
        } else {
          setError(err instanceof Error ? err.message : t('developer.salons.deleteFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, salonId, t]);

  const slugMatches =
    !!preview && typedSlug.trim() === preview.slug;

  const canDelete =
    !!preview &&
    preview.canPermanentlyDelete &&
    acknowledged &&
    slugMatches &&
    !loading &&
    !submitting;

  async function handleDelete() {
    if (!salonId || !preview || !canDelete) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.developer.deleteSalonPermanent(salonId, { confirm: true });
      onDeleted(result);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'SALON_PROTECTED') {
          setError(t('developer.salons.protectedSalon'));
        } else if (err.code === 'SALON_NOT_FOUND') {
          setError(t('developer.salons.deleteFailed'));
        } else {
          setError(err.message || t('developer.salons.deleteFailed'));
        }
      } else {
        setError(err instanceof Error ? err.message : t('developer.salons.deleteFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (submitting) return;
        onClose();
      }}
      title={t('developer.salons.deleteSalonTitle')}
      size="md"
    >
      {loading ? (
        <div className="flex min-h-[180px] flex-col items-center justify-center gap-3">
          <LoadingSpinner />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('developer.salons.loading')}
          </p>
        </div>
      ) : error && !preview ? (
        <div className="space-y-4">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <div className="flex justify-end">
            <button type="button" className="btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : preview ? (
        <div className="space-y-4">
          {!preview.canPermanentlyDelete ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
              <p className="font-medium">{t('developer.salons.protectedSalon')}</p>
              <p className="mt-1">{t('developer.salons.protectedSalonHint')}</p>
            </div>
          ) : null}

          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('developer.salons.salonName')}
              </dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">{preview.name}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">{t('developer.salons.slug')}</dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">{preview.slug}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('developer.salons.clientsCount')}
              </dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">
                {preview.counts.clients}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('developer.salons.appointmentsCount')}
              </dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">
                {preview.counts.appointments}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('developer.salons.activeAppointmentsCount')}
              </dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">
                {preview.counts.activeAppointments}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('developer.salons.staffCount')}
              </dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">
                {preview.counts.staff}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('developer.salons.servicesCount')}
              </dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">
                {preview.counts.services}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('developer.salons.integrationsCount')}
              </dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">
                {preview.counts.integrations}
              </dd>
            </div>
          </dl>

          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            <p className="font-medium">{t('developer.salons.deleteSalonWarning')}</p>
            <p className="mt-1">{t('developer.salons.deleteSalonPermanentWarning')}</p>
          </div>

          {preview.canPermanentlyDelete ? (
            <>
              <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged}
                  disabled={submitting}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>{t('developer.salons.confirmPermanentDelete')}</span>
              </label>

              <div>
                <label
                  htmlFor="delete-salon-slug-confirm"
                  className="mb-1.5 block text-sm font-medium"
                >
                  {t('developer.salons.typeSlugToConfirm')}
                </label>
                <input
                  id="delete-salon-slug-confirm"
                  type="text"
                  className="input-field font-mono"
                  value={typedSlug}
                  autoComplete="off"
                  disabled={submitting}
                  placeholder={preview.slug}
                  onChange={(e) => setTypedSlug(e.target.value)}
                />
              </div>
            </>
          ) : null}

          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={submitting}
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
            {preview.canPermanentlyDelete ? (
              <button
                type="button"
                className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canDelete}
                onClick={handleDelete}
              >
                {submitting ? t('developer.salons.deleting') : t('developer.salons.deleteSalon')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
