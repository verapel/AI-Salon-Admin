import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Mail, Phone, Users } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { Staff as StaffType } from '@/types';

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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StaffType | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const loadStaff = () => {
    api.staff
      .getAll()
      .then(setStaff)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadStaff();
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
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const data = {
      ...form,
      specialties: form.specialties
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      if (editing) {
        await api.staff.update(editing.id, data);
      } else {
        await api.staff.create(data);
      }
      setModalOpen(false);
      setEditing(null);
      loadStaff();
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
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
                    </div>
                    <div className="flex shrink-0 gap-1.5 transition-opacity sm:gap-1 sm:opacity-0 sm:group-hover:opacity-100">
                      <button
                        onClick={() => openEdit(member)}
                        disabled={actionBusy === member.id}
                        className="btn-ghost min-h-[44px] min-w-[44px] p-2 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                        aria-label={t('staff.editAria')}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(member.id)}
                        disabled={actionBusy === member.id}
                        className="btn-ghost min-h-[44px] min-w-[44px] p-2 text-red-500 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                        aria-label={t('staff.deleteAria')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
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

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
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
            <label className="mb-1.5 block text-sm font-medium">{t('staff.fieldSpecialties')}</label>
            <input
              className="input-field"
              value={form.specialties}
              onChange={(e) => setForm({ ...form, specialties: e.target.value })}
              placeholder={t('staff.specialtiesPlaceholder')}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                setEditing(null);
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
