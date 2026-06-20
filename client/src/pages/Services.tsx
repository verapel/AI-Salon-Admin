import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Scissors, Clock } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import { formatCurrency, formatDuration } from '@/lib/utils';
import type { Service } from '@/types';

const categories = ['Hair', 'Color', 'Nails', 'Skincare', 'Beauty', 'General'];

export default function Services() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [form, setForm] = useState({ name: '', description: '', duration: 60, price: 0, category: 'Hair' });
  const [filter, setFilter] = useState('all');

  const loadServices = () => {
    api.services.getAll()
      .then(setServices)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadServices(); }, []);

  const filtered = filter === 'all' ? services : services.filter((s) => s.category === filter);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', description: '', duration: 60, price: 0, category: 'Hair' });
    setModalOpen(true);
  };

  const openEdit = (service: Service) => {
    setEditing(service);
    setForm({ name: service.name, description: service.description, duration: service.duration, price: service.price, category: service.category });
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing) {
        await api.services.update(editing.id, form);
      } else {
        await api.services.create(form);
      }
      setModalOpen(false);
      loadServices();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Deactivate this service?')) return;
    await api.services.delete(id);
    loadServices();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${filter === 'all' ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${filter === cat ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
            >
              {cat}
            </button>
          ))}
        </div>
        <button onClick={openCreate} className="btn-primary">
          <Plus className="h-4 w-4" /> Add Service
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.filter((s) => s.active).map((service) => (
          <div key={service.id} className="card group hover:shadow-card-hover">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/50">
                <Scissors className="h-5 w-5 text-brand-600 dark:text-brand-400" />
              </div>
              <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button onClick={() => openEdit(service)} className="btn-ghost p-1.5">
                  <Pencil className="h-4 w-4" />
                </button>
                <button onClick={() => handleDelete(service.id)} className="btn-ghost p-1.5 text-red-500">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <h4 className="mt-3 font-semibold text-gray-900 dark:text-white">{service.name}</h4>
            <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">{service.description}</p>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-lg font-bold text-brand-600 dark:text-brand-400">{formatCurrency(service.price)}</span>
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <Clock className="h-3.5 w-3.5" /> {formatDuration(service.duration)}
              </span>
            </div>
            <span className="mt-2 inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              {service.category}
            </span>
          </div>
        ))}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Service' : 'Add Service'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Name</label>
            <input className="input-field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Description</label>
            <textarea className="input-field" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Duration (min)</label>
              <input className="input-field" type="number" value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })} required />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Price ($)</label>
              <input className="input-field" type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} required />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Category</label>
            <select className="input-field" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">{editing ? 'Save Changes' : 'Add Service'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
