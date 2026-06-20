import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Mail, Phone } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import type { Staff as StaffType } from '@/types';

export default function Staff() {
  const [staff, setStaff] = useState<StaffType[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StaffType | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: 'Stylist', specialties: '' });

  const loadStaff = () => {
    api.staff.getAll()
      .then(setStaff)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadStaff(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', email: '', phone: '', role: 'Stylist', specialties: '' });
    setModalOpen(true);
  };

  const openEdit = (member: StaffType) => {
    setEditing(member);
    setForm({ name: member.name, email: member.email, phone: member.phone, role: member.role, specialties: member.specialties.join(', ') });
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = { ...form, specialties: form.specialties.split(',').map((s) => s.trim()).filter(Boolean) };
    try {
      if (editing) {
        await api.staff.update(editing.id, data);
      } else {
        await api.staff.create(data);
      }
      setModalOpen(false);
      loadStaff();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Deactivate this staff member?')) return;
    await api.staff.delete(id);
    loadStaff();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex justify-end">
        <button onClick={openCreate} className="btn-primary">
          <Plus className="h-4 w-4" /> Add Staff Member
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {staff.filter((s) => s.active).map((member) => (
          <div key={member.id} className="card group hover:shadow-card-hover">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-lg font-bold text-white">
                {member.avatar}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-semibold text-gray-900 dark:text-white">{member.name}</h4>
                    <p className="text-sm text-brand-600 dark:text-brand-400">{member.role}</p>
                  </div>
                  <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={() => openEdit(member)} className="btn-ghost p-1.5">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(member.id)} className="btn-ghost p-1.5 text-red-500">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-3 space-y-1 text-sm text-gray-500 dark:text-gray-400">
                  <p className="flex items-center gap-2"><Mail className="h-3.5 w-3.5" /> {member.email}</p>
                  <p className="flex items-center gap-2"><Phone className="h-3.5 w-3.5" /> {member.phone}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {member.specialties.map((spec) => (
                    <span key={spec} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                      {spec}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Staff Member' : 'Add Staff Member'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Name</label>
            <input className="input-field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Email</label>
            <input className="input-field" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Phone</label>
            <input className="input-field" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Role</label>
            <input className="input-field" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Specialties (comma-separated)</label>
            <input className="input-field" value={form.specialties} onChange={(e) => setForm({ ...form, specialties: e.target.value })} placeholder="Hair, Color, Nails" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">{editing ? 'Save Changes' : 'Add Staff'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
