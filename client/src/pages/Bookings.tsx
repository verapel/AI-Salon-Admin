import { useEffect, useState } from 'react';
import { Plus, Check, X as XIcon, Clock, User, Scissors, CalendarDays, BadgeCheck } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { api } from '@/lib/api';
import { formatDate, formatTime, formatCurrency, getStatusColor } from '@/lib/utils';
import type { Appointment, Client, Service, Staff as StaffType } from '@/types';

/** "14:00" из "14:00:00" или "14:00" */
const formatTime24 = (time: string) => time.slice(0, 5);

export default function Bookings() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<StaffType[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [form, setForm] = useState({
    clientId: '',
    staffId: '',
    serviceId: '',
    date: new Date().toISOString().split('T')[0],
    startTime: '09:00',
    notes: '',
  });

  const loadData = () => {
    Promise.all([
      api.appointments.getAll(),
      api.clients.getAll(),
      api.services.getAll(),
      api.staff.getAll(),
    ])
      .then(([apts, cls, svcs, stf]) => {
        setAppointments(apts.sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime)));
        setClients(cls);
        setServices(svcs.filter((s) => s.active));
        setStaff(stf.filter((s) => s.active));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const filtered = statusFilter === 'all'
    ? appointments
    : appointments.filter((a) => a.status === statusFilter);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.appointments.create(form);
      setModalOpen(false);
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const updateStatus = async (id: string, status: Appointment['status']) => {
    await api.appointments.update(id, { status });
    loadData();
  };

  const cancelAppointment = async (id: string) => {
    if (!confirm('Cancel this appointment?')) return;
    await api.appointments.delete(id);
    loadData();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {['all', 'scheduled', 'confirmed', 'completed', 'cancelled'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                statusFilter === status
                  ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {status}
            </button>
          ))}
        </div>
        {/* На mobile — полная ширина, на desktop — автоширина (оригинал) */}
        <button onClick={() => setModalOpen(true)} className="btn-primary w-full sm:w-auto">
          <Plus className="h-4 w-4" /> New Booking
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Plus className="h-8 w-8 text-gray-400" />}
          title="No bookings found"
          description="Create a new booking to get started."
          action={<button onClick={() => setModalOpen(true)} className="btn-primary"><Plus className="h-4 w-4" /> New Booking</button>}
        />
      ) : (
        <>
          {/* ── MOBILE: карточки (ниже sm) ── */}
          <div className="space-y-3 sm:hidden">
            {filtered.map((apt) => (
              <div key={apt.id} className="card w-full min-w-0 max-w-full p-4 space-y-3">
                {/* Шапка карточки: имя + статус */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <User className="h-4 w-4 shrink-0 text-gray-400" />
                    <p className="truncate text-base font-semibold text-gray-900 dark:text-white">
                      {apt.clientName}
                    </p>
                  </div>
                  <span className={`badge shrink-0 text-xs ${getStatusColor(apt.status)}`}>
                    {apt.status}
                  </span>
                </div>

                {/* Детали: min-w-0 на span обеспечивает truncate в flex */}
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
                    <span>{formatDate(apt.date)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span>{formatTime24(apt.startTime)}</span>
                    {apt.servicePrice != null && apt.servicePrice > 0 && (
                      <span className="ml-auto font-medium text-gray-900 dark:text-white">
                        {formatCurrency(apt.servicePrice)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Кнопки действий — min-h-[36px] гарантирует touch target ≥ 36px */}
                {(apt.status === 'scheduled' || apt.status === 'confirmed') && (
                  <div className="flex gap-2 border-t pt-3 dark:border-gray-700">
                    {apt.status === 'scheduled' && (
                      <button
                        onClick={() => updateStatus(apt.id, 'confirmed')}
                        className="btn-secondary flex-1 min-h-[36px] py-1.5 text-xs text-green-600 dark:text-green-400"
                      >
                        <Check className="h-3.5 w-3.5" /> Confirm
                      </button>
                    )}
                    <button
                      onClick={() => updateStatus(apt.id, 'completed')}
                      className="btn-secondary flex-1 min-h-[36px] py-1.5 text-xs text-blue-600 dark:text-blue-400"
                    >
                      <Check className="h-3.5 w-3.5" /> Complete
                    </button>
                    <button
                      onClick={() => cancelAppointment(apt.id)}
                      className="btn-secondary flex-1 min-h-[36px] py-1.5 text-xs text-red-500 dark:text-red-400"
                    >
                      <XIcon className="h-3.5 w-3.5" /> Cancel
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ── DESKTOP: таблица (sm+) — враппер видимости отдельно от card ── */}
          <div className="hidden sm:block">
          <div className="card overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 dark:bg-gray-800/50">
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Client</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Service</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Staff</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Date & Time</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Price</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((apt) => (
                    <tr key={apt.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{apt.clientName}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{apt.serviceName}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{apt.staffName}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {formatDate(apt.date)} at {formatTime(apt.startTime)}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                        {formatCurrency(apt.servicePrice ?? 0)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`badge ${getStatusColor(apt.status)}`}>{apt.status}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {apt.status === 'scheduled' && (
                            <button onClick={() => updateStatus(apt.id, 'confirmed')} className="btn-ghost p-1.5 text-green-600" title="Confirm">
                              <Check className="h-4 w-4" />
                            </button>
                          )}
                          {(apt.status === 'scheduled' || apt.status === 'confirmed') && (
                            <>
                              <button onClick={() => updateStatus(apt.id, 'completed')} className="btn-ghost p-1.5 text-blue-600" title="Complete">
                                <Check className="h-4 w-4" />
                              </button>
                              <button onClick={() => cancelAppointment(apt.id)} className="btn-ghost p-1.5 text-red-500" title="Cancel">
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
          </div>{/* /hidden sm:block */}
        </>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Booking" size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Grid: 1 колонка на mobile, 2 на sm+ */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Client</label>
              <select className="input-field" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required>
                <option value="">Select client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Service</label>
              <select className="input-field" value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })} required>
                <option value="">Select service</option>
                {services.map((s) => <option key={s.id} value={s.id}>{s.name} - {formatCurrency(s.price)}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Staff Member</label>
              <select className="input-field" value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })} required>
                <option value="">Select staff</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Date</label>
              <input className="input-field" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Start Time</label>
              <input className="input-field" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Notes</label>
            <textarea className="input-field" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {/* Кнопки: на mobile в столбик (полная ширина), на sm+ — в ряд справа */}
          <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary w-full sm:w-auto">Cancel</button>
            <button type="submit" className="btn-primary w-full sm:w-auto">Create Booking</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
