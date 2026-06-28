import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Users, Mail, Phone } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import type { Client } from '@/types';

export default function Clients() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });

  const loadClients = () => {
    api.clients.getAll()
      .then(setClients)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadClients(); }, []);

  const filtered = clients.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.email.toLowerCase().includes(search.toLowerCase())
  );

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', email: '', phone: '', notes: '' });
    setModalOpen(true);
  };

  const openEdit = (client: Client) => {
    setEditing(client);
    setForm({ name: client.name, email: client.email, phone: client.phone, notes: client.notes });
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing) {
        await api.clients.update(editing.id, form);
      } else {
        await api.clients.create(form);
      }
      setModalOpen(false);
      loadClients();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this client?')) return;
    await api.clients.delete(id);
    loadClients();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="w-full max-w-full min-w-0 overflow-x-clip space-y-4 animate-fade-in">
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full min-w-0 max-w-full sm:max-w-xs">
          <SearchInput value={search} onChange={setSearch} placeholder="Search clients..." />
        </div>
        <button onClick={openCreate} className="btn-primary w-full sm:w-auto">
          <Plus className="h-4 w-4" /> Add Client
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8 text-gray-400" />}
          title="No clients found"
          description="Get started by adding your first client."
          action={<button onClick={openCreate} className="btn-primary"><Plus className="h-4 w-4" /> Add Client</button>}
        />
      ) : (
        <div className="w-full min-w-0 max-w-full grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((client) => (
            <div key={client.id} className="card group w-full min-w-0 max-w-full p-4 sm:p-6 hover:shadow-card-hover">
              <div className="flex min-w-0 items-center sm:items-start justify-between gap-1">
                {/* Аватар + имя + визиты */}
                <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
                  <div className="flex h-9 w-9 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs sm:text-sm font-semibold text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
                    {client.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate font-semibold text-gray-900 dark:text-white">
                      {client.name}
                    </h4>
                    <p className="text-xs text-gray-500">{client.totalVisits} visits</p>
                  </div>
                </div>

                {/* Кнопки: на mobile всегда видимы, на desktop — по hover */}
                <div className="flex shrink-0 gap-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                  <button
                    onClick={() => openEdit(client)}
                    className="btn-ghost p-2 sm:p-1.5"
                    aria-label="Edit client"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(client.id)}
                    className="btn-ghost p-2 sm:p-1.5 text-red-500"
                    aria-label="Delete client"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Контактные данные — email первый (как в оригинале) */}
              <div className="mt-3 sm:mt-4 min-w-0 space-y-1.5 overflow-hidden text-sm text-gray-500 dark:text-gray-400">
                <div className="flex min-w-0 items-center gap-2">
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{client.email || '—'}</span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{client.phone || 'N/A'}</span>
                </div>
                {client.lastVisit && (
                  <p className="truncate text-xs">Last visit: {formatDate(client.lastVisit)}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Client' : 'Add Client'}>
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
            <label className="mb-1.5 block text-sm font-medium">Notes</label>
            <textarea className="input-field" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">{editing ? 'Save Changes' : 'Add Client'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
