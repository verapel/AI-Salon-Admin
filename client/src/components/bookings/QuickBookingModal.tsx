import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import {
  applyClientNameQuery,
  applyExistingClientSelection,
  createQuickBooking,
  emptyQuickBookingForm,
  formatClientSuggestion,
  matchExistingClients,
} from '@/lib/quickBooking';
import type { Client, Staff } from '@/types';

interface QuickBookingModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function QuickBookingModal({ open, onClose, onSuccess }: QuickBookingModalProps) {
  const { t } = useLanguage();
  const [form, setForm] = useState(emptyQuickBookingForm);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(emptyQuickBookingForm());
    setError(null);
    setShowSuggestions(false);
    setLoadingStaff(true);
    Promise.all([api.staff.getAll(), api.clients.getAll()])
      .then(([staffList, clientList]) => {
        setStaff(staffList.filter((s) => s.active));
        setClients(clientList);
      })
      .catch(() => setError(t('quickBooking.submitError')))
      .finally(() => setLoadingStaff(false));
  }, [open, t]);

  const suggestions =
    form.clientId || !showSuggestions ? [] : matchExistingClients(form.clientName, clients);

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

          <div className="relative">
            <label className="mb-1.5 block text-sm font-medium">{t('quickBooking.fieldClientName')}</label>
            <input
              className="input-field w-full min-w-0"
              value={form.clientName}
              onChange={(e) => {
                setForm(applyClientNameQuery(form, e.target.value));
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              placeholder={t('quickBooking.placeholderClientName')}
              autoComplete="off"
              required
            />
            {suggestions.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                {suggestions.map((client) => (
                  <li key={client.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setForm(applyExistingClientSelection(form, client));
                        setShowSuggestions(false);
                      }}
                    >
                      {formatClientSuggestion(client)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
