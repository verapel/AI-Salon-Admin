import { useEffect, useState } from 'react';
import { Plus, Check, X as XIcon, Clock, User, Scissors, CalendarDays, BadgeCheck, Pencil } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import QuickBookingModal from '@/components/bookings/QuickBookingModal';
import { useLanguage, type LangCode, type TranslationKey } from '@/context/LanguageContext';
import { useCurrency } from '@/context/CurrencyContext';
import { api } from '@/lib/api';
import { isVisibleOnBookingsAll } from '@/lib/bookingsVisibility';
import { getStatusColor } from '@/lib/utils';
import type { Appointment, Client, Service, Staff as StaffType } from '@/types';

const LOCALE: Record<LangCode, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  hy: 'hy-AM',
};

const STATUS_FILTERS = ['all', 'scheduled', 'confirmed', 'completed', 'cancelled'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const toLocalDateStr = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatTime24 = (time: string) => time.slice(0, 5);

const emptyEditForm = () => ({
  clientId: '',
  staffId: '',
  serviceId: '',
  date: toLocalDateStr(new Date()),
  startTime: '09:00',
  notes: '',
});

function statusLabel(status: Appointment['status'], t: (key: TranslationKey) => string) {
  return t(`appointmentStatus.${status}` as TranslationKey);
}

function filterLabel(filter: StatusFilter, t: (key: TranslationKey) => string) {
  if (filter === 'all') return t('bookings.filterAll');
  return statusLabel(filter, t);
}

export default function Bookings() {
  const { language, t } = useLanguage();
  const { formatCurrency } = useCurrency();
  const locale = LOCALE[language];
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<StaffType[]>([]);
  const [loading, setLoading] = useState(true);
  const [quickModalOpen, setQuickModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [form, setForm] = useState(emptyEditForm);

  const formatDateLocalized = (dateStr: string) =>
    new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

  const loadData = () => {
    Promise.all([
      api.appointments.getAll(),
      api.clients.getAll(),
      api.services.getAll(),
      api.staff.getAll(),
    ])
      .then(([apts, cls, svcs, stf]) => {
        setAppointments(
          apts.sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime))
        );
        setClients(cls);
        setServices(svcs.filter((s) => s.active));
        setStaff(stf.filter((s) => s.active));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, []);

  const query = search.trim().toLowerCase();
  const statusFiltered =
    statusFilter === 'all'
      ? appointments.filter(isVisibleOnBookingsAll)
      : appointments.filter((a) => a.status === statusFilter);

  const filtered = query
    ? statusFiltered.filter(
        (a) =>
          (a.clientName?.toLowerCase().includes(query) ?? false) ||
          (a.serviceName?.toLowerCase().includes(query) ?? false) ||
          (a.staffName?.toLowerCase().includes(query) ?? false) ||
          a.date.includes(query) ||
          formatTime24(a.startTime).includes(query)
      )
    : statusFiltered;

  const visibleIds = filtered.map((a) => a.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  const toggleRowSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const canModify = (apt: Appointment) =>
    apt.status === 'scheduled' || apt.status === 'confirmed';

  const openCreate = () => setQuickModalOpen(true);

  const openEdit = (apt: Appointment) => {
    setEditing(apt);
    setForm({
      clientId: apt.clientId,
      staffId: apt.staffId,
      serviceId: apt.serviceId,
      date: apt.date,
      startTime: formatTime24(apt.startTime),
      notes: apt.notes || '',
    });
    setEditModalOpen(true);
  };

  const closeEditModal = () => {
    setEditModalOpen(false);
    setEditing(null);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || submitting) return;
    setSubmitting(true);
    try {
      await api.appointments.update(editing.id, form);
      closeEditModal();
      loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (id: string, status: Appointment['status']) => {
    if (actionBusy) return;
    setActionBusy(id);
    try {
      await api.appointments.update(id, { status });
      loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const cancelAppointment = async (id: string) => {
    if (!confirm(t('bookings.cancelConfirm'))) return;
    if (actionBusy) return;
    setActionBusy(id);
    try {
      await api.appointments.delete(id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const deleteSelected = async () => {
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0 || actionBusy) return;
    if (!confirm(t('bookings.deleteSelectedConfirm').replace('{count}', String(ids.length)))) {
      return;
    }
    setActionBusy('bulk');
    try {
      await api.appointments.bulkDelete(ids);
      setSelectedIds(new Set());
      loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const emptyTitle =
    appointments.length === 0
      ? t('bookings.noBookings')
      : t('bookings.noResults');

  const emptyDescription =
    appointments.length === 0
      ? t('bookings.noBookingsDesc')
      : t('bookings.noResultsDesc');

  if (loading) return <LoadingSpinner />;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full min-w-0 max-w-full sm:max-w-xs">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('bookings.searchPlaceholder')}
            />
          </div>
          <button onClick={openCreate} className="btn-primary w-full sm:w-auto">
            <Plus className="h-4 w-4" /> {t('bookings.newBooking')}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === status
                  ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {filterLabel(status, t)}
            </button>
          ))}
        </div>

        {filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                }}
                onChange={toggleSelectAllVisible}
                aria-label={t('bookings.selectAll')}
              />
              <span>{t('bookings.selectAll')}</span>
            </label>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={
                visibleIds.filter((id) => selectedIds.has(id)).length === 0 ||
                actionBusy === 'bulk'
              }
              className="btn-secondary text-red-600 disabled:opacity-50 dark:text-red-400"
            >
              {t('bookings.deleteSelected')}
            </button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Plus className="h-8 w-8 text-gray-400" />}
          title={emptyTitle}
          description={emptyDescription}
          action={
            appointments.length === 0 ? (
              <button onClick={openCreate} className="btn-primary">
                <Plus className="h-4 w-4" /> {t('bookings.newBooking')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* MOBILE: cards */}
          <div className="space-y-3 sm:hidden">
            {filtered.map((apt) => (
              <div key={apt.id} className="card w-full min-w-0 max-w-full space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                      checked={selectedIds.has(apt.id)}
                      onChange={() => toggleRowSelected(apt.id)}
                      aria-label={t('bookings.selectRow')}
                    />
                    <User className="h-4 w-4 shrink-0 text-gray-400" />
                    <p className="truncate text-base font-semibold text-gray-900 dark:text-white">
                      {apt.clientName}
                    </p>
                  </div>
                  <span className={`badge shrink-0 text-xs ${getStatusColor(apt.status)}`}>
                    {statusLabel(apt.status, t)}
                  </span>
                </div>

                <div className="space-y-1.5 text-sm text-gray-600 dark:text-gray-400">
                  <div className="flex items-center gap-2">
                    <Scissors className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="min-w-0 truncate">{apt.serviceName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="min-w-0 truncate">{apt.staffName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span>{formatDateLocalized(apt.date)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="tabular-nums">{formatTime24(apt.startTime)}</span>
                    {apt.servicePrice != null && apt.servicePrice > 0 && (
                      <span className="ml-auto font-medium text-gray-900 dark:text-white">
                        {formatCurrency(apt.servicePrice)}
                      </span>
                    )}
                  </div>
                </div>

                {canModify(apt) && (
                  <div className="flex flex-wrap gap-2 border-t pt-3 dark:border-gray-700">
                    <button
                      onClick={() => openEdit(apt)}
                      disabled={actionBusy === apt.id}
                      className="btn-secondary min-h-[36px] flex-1 py-1.5 text-xs"
                    >
                      <Pencil className="h-3.5 w-3.5" /> {t('bookings.actionEdit')}
                    </button>
                    {apt.status === 'scheduled' && (
                      <button
                        onClick={() => updateStatus(apt.id, 'confirmed')}
                        disabled={actionBusy === apt.id}
                        className="btn-secondary min-h-[36px] flex-1 py-1.5 text-xs text-green-600 dark:text-green-400"
                      >
                        <Check className="h-3.5 w-3.5" /> {t('bookings.actionConfirm')}
                      </button>
                    )}
                    <button
                      onClick={() => updateStatus(apt.id, 'completed')}
                      disabled={actionBusy === apt.id}
                      className="btn-secondary min-h-[36px] flex-1 py-1.5 text-xs text-blue-600 dark:text-blue-400"
                    >
                      <Check className="h-3.5 w-3.5" /> {t('bookings.actionComplete')}
                    </button>
                    <button
                      onClick={() => cancelAppointment(apt.id)}
                      disabled={actionBusy === apt.id}
                      className="btn-secondary min-h-[36px] flex-1 py-1.5 text-xs text-red-500 dark:text-red-400"
                    >
                      <XIcon className="h-3.5 w-3.5" /> {t('bookings.actionCancel')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* DESKTOP: table */}
          <div className="hidden sm:block">
            <div className="card overflow-hidden p-0">
              <div className="table-scroll">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50">
                      <th className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                          checked={allVisibleSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                          }}
                          onChange={toggleSelectAllVisible}
                          aria-label={t('bookings.selectAll')}
                        />
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('bookings.columnClient')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('bookings.columnService')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('bookings.columnStaff')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('bookings.columnDateTime')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('bookings.columnPrice')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('bookings.columnStatus')}
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        {t('bookings.columnActions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-gray-700">
                    {filtered.map((apt) => (
                      <tr key={apt.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                            checked={selectedIds.has(apt.id)}
                            onChange={() => toggleRowSelected(apt.id)}
                            aria-label={t('bookings.selectRow')}
                          />
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                          {apt.clientName}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{apt.serviceName}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{apt.staffName}</td>
                        <td className="px-4 py-3 tabular-nums text-gray-600 dark:text-gray-400">
                          {formatDateLocalized(apt.date)} {t('header.at')}{' '}
                          {formatTime24(apt.startTime)}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                          {formatCurrency(apt.servicePrice ?? 0)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`badge ${getStatusColor(apt.status)}`}>
                            {statusLabel(apt.status, t)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            {canModify(apt) && (
                              <>
                                <button
                                  onClick={() => openEdit(apt)}
                                  disabled={actionBusy === apt.id}
                                  className="btn-ghost p-1.5"
                                  title={t('bookings.actionEdit')}
                                  aria-label={t('bookings.editAria')}
                                >
                                  <Pencil className="h-4 w-4" />
                                </button>
                                {apt.status === 'scheduled' && (
                                  <button
                                    onClick={() => updateStatus(apt.id, 'confirmed')}
                                    disabled={actionBusy === apt.id}
                                    className="btn-ghost p-1.5 text-green-600 dark:text-green-400"
                                    title={t('bookings.actionConfirm')}
                                    aria-label={t('bookings.confirmAria')}
                                  >
                                    <Check className="h-4 w-4" />
                                  </button>
                                )}
                                <button
                                  onClick={() => updateStatus(apt.id, 'completed')}
                                  disabled={actionBusy === apt.id}
                                  className="btn-ghost p-1.5 text-blue-600 dark:text-blue-400"
                                  title={t('bookings.actionComplete')}
                                  aria-label={t('bookings.completeAria')}
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => cancelAppointment(apt.id)}
                                  disabled={actionBusy === apt.id}
                                  className="btn-ghost p-1.5 text-red-500 dark:text-red-400"
                                  title={t('bookings.actionCancel')}
                                  aria-label={t('bookings.cancelAria')}
                                >
                                  <XIcon className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      <QuickBookingModal
        open={quickModalOpen}
        onClose={() => setQuickModalOpen(false)}
        onSuccess={loadData}
      />

      <Modal open={editModalOpen} onClose={closeEditModal} title={t('bookings.editTitle')} size="lg">
        <form onSubmit={handleEditSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('bookings.fieldClient')}</label>
              <select
                className="input-field w-full min-w-0"
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                required
              >
                <option value="">{t('bookings.selectClient')}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('bookings.fieldService')}</label>
              <select
                className="input-field w-full min-w-0"
                value={form.serviceId}
                onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
                required
              >
                <option value="">{t('bookings.selectService')}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} - {formatCurrency(s.price)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('bookings.fieldStaff')}</label>
              <select
                className="input-field w-full min-w-0"
                value={form.staffId}
                onChange={(e) => setForm({ ...form, staffId: e.target.value })}
                required
              >
                <option value="">{t('bookings.selectStaff')}</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('bookings.fieldDate')}</label>
              <input
                className="input-field w-full min-w-0"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('bookings.fieldTime')}</label>
              <input
                className="input-field w-full min-w-0"
                type="time"
                value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                required
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('bookings.fieldNotes')}</label>
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
              onClick={closeEditModal}
              className="btn-secondary w-full sm:w-auto"
              disabled={submitting}
            >
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary w-full sm:w-auto" disabled={submitting}>
              {t('bookings.saveChanges')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
