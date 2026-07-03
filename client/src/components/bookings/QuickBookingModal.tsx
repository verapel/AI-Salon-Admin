import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { createQuickBooking, emptyQuickBookingForm } from '@/lib/quickBooking';
import type { Staff } from '@/types';

interface QuickBookingModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function QuickBookingModal({ open, onClose, onSuccess }: QuickBookingModalProps) {
  const { t } = useLanguage();
  const [form, setForm] = useState(emptyQuickBookingForm);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(emptyQuickBookingForm());
    setError(null);
    setLoadingStaff(true);
    api.staff
      .getAll()
      .then((list) => setStaff(list.filter((s) => s.active)))
      .catch(() => setError(t('quickBooking.submitError')))
      .finally(() => setLoadingStaff(false));
  }, [open, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createQuickBooking(form);
      onClose();
      onSuccess?.();
    } catch (err) {
      console.error(err);
      setError(t('quickBooking.submitError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('quickBooking.title')} size="lg">
      {loadingStaff ? (
        <div className="flex min-h-[200px] items-center justify-center">
          <LoadingSpinner />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </p>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldClientName')}</label>
            <input
              className="input-field w-full min-w-0"
              value={form.clientName}
              onChange={(e) => setForm({ ...form, clientName: e.target.value })}
              placeholder={t('quickBooking.placeholderClientName')}
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldPhone')}</label>
            <input
              className="input-field w-full min-w-0"
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder={t('quickBooking.placeholderPhone')}
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldServiceName')}</label>
            <input
              className="input-field w-full min-w-0"
              value={form.serviceName}
              onChange={(e) => setForm({ ...form, serviceName: e.target.value })}
              placeholder={t('quickBooking.placeholderServiceName')}
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldStaff')}</label>
            <select
              className="input-field w-full min-w-0"
              value={form.staffId}
              onChange={(e) => setForm({ ...form, staffId: e.target.value })}
              required
            >
              <option value="">{t('quickBooking.selectStaff')}</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldDate')}</label>
            <input
              className="input-field w-full min-w-0"
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldTime')}</label>
            <input
              className="input-field w-full min-w-0"
              type="time"
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldNotes')}</label>
            <textarea
              className="input-field w-full min-w-0"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary w-full min-h-[44px] sm:w-auto"
              disabled={submitting}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn-primary w-full min-h-[44px] sm:w-auto"
              disabled={submitting}
            >
              {submitting ? t('quickBooking.submitting') : t('quickBooking.submit')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
