import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { useLanguage } from '@/context/LanguageContext';
import { ApiError, api } from '@/lib/api';
import type { StaffDeletePreview } from '@/types';

function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template
  );
}

export interface PermanentDeleteStaffModalProps {
  open: boolean;
  staffId: string | null;
  staffNameHint?: string;
  onClose: () => void;
  onDeleted: (result: {
    deletedStaffId: string;
    deletedAppointments: number;
  }) => void;
}

export default function PermanentDeleteStaffModal({
  open,
  staffId,
  staffNameHint,
  onClose,
  onDeleted,
}: PermanentDeleteStaffModalProps) {
  const { t } = useLanguage();
  const [preview, setPreview] = useState<StaffDeletePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !staffId) {
      setPreview(null);
      setError(null);
      setLoading(false);
      setSubmitting(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);

    api.staff
      .getDeletePreview(staffId)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'STAFF_NOT_FOUND') {
          setError(t('staff.deletionFailed'));
        } else {
          setError(err instanceof Error ? err.message : t('staff.deletionFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, staffId, t]);

  const close = () => {
    if (submitting) return;
    onClose();
  };

  const handleConfirm = async () => {
    if (!staffId || !preview || preview.protected || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.staff.permanentDelete(staffId, {
        confirm: true,
        deleteAppointments: preview.totalAppointments > 0,
      });
      onDeleted({
        deletedStaffId: result.deletedStaffId,
        deletedAppointments: result.deletedAppointments,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'PRIMARY_STAFF_CANNOT_DELETE' || err.code === 'PROTECTED_STAFF_MEMBER') {
          setError(
            err.code === 'PRIMARY_STAFF_CANNOT_DELETE'
              ? t('staff.primaryStaffCannotDelete')
              : t('staff.protectedStaffCannotDelete')
          );
        } else if (err.code === 'STAFF_HAS_APPOINTMENTS') {
          setError(t('staff.staffHasAppointments'));
        } else {
          setError(err.message || t('staff.deletionFailed'));
        }
      } else {
        setError(err instanceof Error ? err.message : t('staff.deletionFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const name = preview?.staff.name || staffNameHint || '—';
  const total = preview?.totalAppointments ?? 0;
  const active = preview?.activeAppointments ?? 0;
  const canConfirm = !!preview && !preview.protected && !loading && !submitting;

  const warningText =
    total > 0
      ? fillTemplate(t('staff.permanentDeleteWarning'), {
          count: total,
          activeCount: active,
        })
      : t('staff.irreversibleAction');

  const confirmLabel =
    total > 0 ? t('staff.deleteStaffAndAppointments') : t('staff.permanentDelete');

  return (
    <Modal open={open} onClose={close} title={t('staff.permanentDeleteTitle')} size="md">
      <div className="space-y-4">
        {loading ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('common.loading')}</p>
        ) : null}

        {!loading && preview ? (
          <>
            <div className="space-y-1">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                <span className="font-medium text-gray-900 dark:text-white">{name}</span>
                {preview.staff.isPrimary ? (
                  <span className="ml-2 inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                    {t('staff.primaryStaff')}
                  </span>
                ) : null}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {fillTemplate(t('staff.appointmentCount'), { count: total })}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {fillTemplate(t('staff.activeAppointmentCount'), { count: active })}
              </p>
            </div>

            {preview.protected && preview.protectedReason === 'PRIMARY_STAFF' ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                <p>{t('staff.primaryStaffCannotDelete')}</p>
                <p className="mt-1">{t('staff.assignAnotherPrimaryFirst')}</p>
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                <p className="whitespace-pre-line">{warningText}</p>
              </div>
            )}

            {preview.protected && preview.protectedReason !== 'PRIMARY_STAFF' ? (
              <p className="text-sm text-amber-800 dark:text-amber-200">
                {t('staff.protectedStaffCannotDelete')}
              </p>
            ) : null}
          </>
        ) : null}

        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="btn-secondary w-full sm:w-auto"
            onClick={close}
            disabled={submitting}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
          >
            {submitting ? t('common.loading') : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
