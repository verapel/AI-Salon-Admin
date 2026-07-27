import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, UserMinus, Mail, Phone, Users, Clock } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import StaffScheduleModal from '@/components/schedule/StaffScheduleModal';
import PermanentDeleteStaffModal from '@/components/staff/PermanentDeleteStaffModal';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { Service, Staff as StaffType } from '@/types';

const emptyForm = () => ({
  name: '',
  email: '',
  phone: '',
  role: 'Stylist',
  specialties: '',
});

export default function Staff() {
  const { t } = useLanguage();
  const [staff, setStaff] = useState<StaffType[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StaffType | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [formError, setFormError] = useState('');
  const [scheduleStaff, setScheduleStaff] = useState<StaffType | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<StaffType | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadStaff = () => {
    api.staff
      .getAll()
      .then(setStaff)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  const loadServices = () => {
    api.services
      .getAll()
      .then((list) => setServices(list.filter((s) => s.active).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(console.error);
  };

  useEffect(() => {
    loadStaff();
    loadServices();
  }, []);

  const activeStaff = staff.filter((s) => s.active);

  const query = search.trim().toLowerCase();
  const filtered = query
    ? activeStaff.filter(
        (member) =>
          member.name.toLowerCase().includes(query) ||
          member.role.toLowerCase().includes(query) ||
          member.email.toLowerCase().includes(query) ||
          member.phone.toLowerCase().includes(query) ||
          member.specialties.some((spec) => spec.toLowerCase().includes(query))
      )
    : activeStaff;

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setSelectedServiceIds([]);
    setFormError('');
    setModalOpen(true);
  };

  const openEdit = (member: StaffType) => {
    setEditing(member);
    setForm({
      name: member.name,
      email: member.email,
      phone: member.phone,
      role: member.role,
      specialties: member.specialties.join(', '),
    });
    setSelectedServiceIds(member.serviceIds ?? []);
    setFormError('');
    setModalOpen(true);
  };

  const toggleService = (serviceId: string) => {
    setSelectedServiceIds((prev) =>
      prev.includes(serviceId) ? prev.filter((id) => id !== serviceId) : [...prev, serviceId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError('');
    const data = {
      ...form,
      specialties: form.specialties
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      let staffId: string;
      if (editing) {
        await api.staff.update(editing.id, data);
        staffId = editing.id;
      } else {
        const created = await api.staff.create(data);
        staffId = created.id;
      }

      try {
        await api.staff.updateServices(staffId, selectedServiceIds);
      } catch (assignErr) {
        console.error(assignErr);
        setFormError(t('staff.servicesSaveError'));
        loadStaff();
        return;
      }

      setModalOpen(false);
      setEditing(null);
      loadStaff();
    } catch (err) {
      console.error(err);
      setFormError(err instanceof Error ? err.message : t('staff.servicesSaveError'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeactivate = async (id: string) => {
    if (!confirm(t('staff.deactivateConfirm'))) return;
    if (actionBusy) return;
    setActionBusy(id);
    try {
      await api.staff.delete(id);
      loadStaff();
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const emptyTitle =
    activeStaff.length === 0 ? t('staff.noStaff') : t('staff.noResults');

  const emptyDescription =
    activeStaff.length === 0 ? t('staff.noStaffDesc') : t('staff.noResultsDesc');

  if (loading) return <LoadingSpinner />;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
      {toast ? (
        <div
          className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full min-w-0 max-w-full sm:max-w-xs">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('staff.searchPlaceholder')}
          />
        </div>
        <button onClick={openCreate} className="btn-primary w-full sm:w-auto">
          <Plus className="h-4 w-4" /> {t('staff.addMember')}
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8 text-gray-400" />}
          title={emptyTitle}
          description={emptyDescription}
          action={
            activeStaff.length === 0 ? (
              <button onClick={openCreate} className="btn-primary">
                <Plus className="h-4 w-4" /> {t('staff.addMember')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((member) => (
            <div
              key={member.id}
              className="card group w-full min-w-0 max-w-full p-4 hover:shadow-card-hover sm:p-6"
            >
              <div className="flex items-start gap-3 sm:gap-4">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-lg font-bold text-white sm:h-14 sm:w-14"
                  aria-hidden
                >
                  {member.avatar}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="truncate font-semibold text-gray-900 dark:text-white">
                        {member.name}
                      </h4>
                      <p className="truncate text-sm text-brand-600 dark:text-brand-400">
                        {member.role}
                      </p>
                      {member.isPrimary ? (
                        <p className="mt-1">
                          <span className="inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                            {t('staff.primaryStaff')}
                          </span>
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1.5 transition-opacity sm:gap-1 sm:opacity-0 sm:group-hover:opacity-100">
                      <button
                        onClick={() => setScheduleStaff(member)}
                        disabled={actionBusy === member.id}
                        className="btn-ghost min-h-[44px] min-w-[44px] p-2 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                        aria-label={t('staff.scheduleAria')}
                        title={t('staff.schedule')}
                      >
                        <Clock className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => openEdit(member)}
                        disabled={actionBusy === member.id}
                        className="btn-ghost min-h-[44px] min-w-[44px] p-2 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                        aria-label={t('staff.editAria')}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDeactivate(member.id)}
                        disabled={actionBusy === member.id}
                        className="btn-ghost min-h-[44px] min-w-[44px] p-2 text-amber-600 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                        aria-label={t('staff.deactivateAria')}
                        title={t('staff.deactivateStaff')}
                      >
                        <UserMinus className="h-4 w-4" />
                      </button>
                      {!member.isPrimary ? (
                        <button
                          onClick={() => setPermanentDeleteTarget(member)}
                          disabled={actionBusy === member.id}
                          className="btn-ghost min-h-[44px] min-w-[44px] p-2 text-red-500 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                          aria-label={t('staff.permanentDeleteAria')}
                          title={t('staff.permanentDelete')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 space-y-1 text-sm text-gray-500 dark:text-gray-400">
                    <div className="flex min-w-0 items-center gap-2">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate">{member.email || '—'}</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <Phone className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-300 sm:font-normal sm:text-gray-500 dark:sm:text-gray-400">
                        {member.phone || '—'}
                      </span>
                    </div>
                  </div>

                  {(member.serviceIds?.length ?? 0) > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {(member.serviceIds ?? [])
                        .map((id) => services.find((s) => s.id === id)?.name)
                        .filter(Boolean)
                        .map((name) => (
                          <span
                            key={name as string}
                            className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                          >
                            {name}
                          </span>
                        ))}
                    </div>
                  )}

                  {member.specialties.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {member.specialties.map((spec) => (
                        <span
                          key={spec}
                          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        >
                          {spec}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <StaffScheduleModal
        open={!!scheduleStaff}
        staff={scheduleStaff}
        onClose={() => setScheduleStaff(null)}
      />

      <PermanentDeleteStaffModal
        open={!!permanentDeleteTarget}
        staffId={permanentDeleteTarget?.id ?? null}
        staffNameHint={permanentDeleteTarget?.name}
        onClose={() => setPermanentDeleteTarget(null)}
        onDeleted={() => {
          setToast(t('staff.deletionSuccess'));
          window.setTimeout(() => setToast(null), 3200);
          loadStaff();
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
          setFormError('');
        }}
        title={editing ? t('staff.editTitle') : t('staff.createTitle')}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('staff.fieldName')}</label>
            <input
              className="input-field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('staff.fieldEmail')}</label>
            <input
              className="input-field"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('staff.fieldPhone')}</label>
            <input
              className="input-field"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('staff.fieldRole')}</label>
            <input
              className="input-field"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('staff.masterServices')}</label>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              {t('staff.masterServicesHint')}
            </p>
            {services.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('staff.noActiveServices')}</p>
            ) : (
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                {services.map((service) => {
                  const checked = selectedServiceIds.includes(service.id);
                  return (
                    <label
                      key={service.id}
                      className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                        checked={checked}
                        onChange={() => toggleService(service.id)}
                      />
                      <span className="min-w-0 truncate">{service.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {selectedServiceIds.length === 0 && services.length > 0 && (
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                {t('staff.noServicesSelected')}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('staff.fieldSpecialties')}</label>
            <input
              className="input-field"
              value={form.specialties}
              onChange={(e) => setForm({ ...form, specialties: e.target.value })}
              placeholder={t('staff.specialtiesPlaceholder')}
            />
          </div>

          {formError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {formError}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                setEditing(null);
                setFormError('');
              }}
              className="btn-secondary w-full sm:w-auto"
              disabled={submitting}
            >
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary w-full sm:w-auto" disabled={submitting}>
              {editing ? t('staff.saveChanges') : t('staff.createSubmit')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
