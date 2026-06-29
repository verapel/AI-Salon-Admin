import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Scissors, Clock } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { Service } from '@/types';

const CATEGORIES = ['Hair', 'Color', 'Nails', 'Skincare', 'Beauty', 'General'] as const;

const emptyForm = () => ({
  name: '',
  description: '',
  duration: 60,
  price: 0,
  category: 'Hair' as string,
});

function categoryLabel(category: string, t: (key: TranslationKey) => string) {
  const key = `services.category.${category}` as TranslationKey;
  return t(key);
}

function formatDurationLocalized(
  minutes: number,
  t: (key: TranslationKey) => string
) {
  if (minutes < 60) return `${minutes} ${t('services.durationMin')}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hour = t('services.durationHour');
  return m > 0 ? `${h}${hour} ${m}${t('services.durationMin')}` : `${h}${hour}`;
}

export default function Services() {
  const { t } = useLanguage();
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('all');

  const loadServices = () => {
    api.services
      .getAll()
      .then(setServices)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadServices();
  }, []);

  const activeServices = services.filter((s) => s.active);

  const categoryFiltered =
    filter === 'all'
      ? activeServices
      : activeServices.filter((s) => s.category === filter);

  const query = search.trim().toLowerCase();
  const filtered = query
    ? categoryFiltered.filter(
        (service) =>
          service.name.toLowerCase().includes(query) ||
          service.description.toLowerCase().includes(query) ||
          service.category.toLowerCase().includes(query) ||
          String(service.price).includes(query)
      )
    : categoryFiltered;

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setModalOpen(true);
  };

  const openEdit = (service: Service) => {
    setEditing(service);
    setForm({
      name: service.name,
      description: service.description,
      duration: service.duration,
      price: service.price,
      category: service.category,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (editing) {
        await api.services.update(editing.id, form);
      } else {
        await api.services.create(form);
      }
      setModalOpen(false);
      setEditing(null);
      loadServices();
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('services.deactivateConfirm'))) return;
    if (actionBusy) return;
    setActionBusy(id);
    try {
      await api.services.delete(id);
      loadServices();
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const emptyTitle =
    activeServices.length === 0 ? t('services.noServices') : t('services.noResults');

  const emptyDescription =
    activeServices.length === 0
      ? t('services.noServicesDesc')
      : t('services.noResultsDesc');

  if (loading) return <LoadingSpinner />;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full min-w-0 max-w-full sm:max-w-xs">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('services.searchPlaceholder')}
            />
          </div>
          <button onClick={openCreate} className="btn-primary w-full sm:w-auto">
            <Plus className="h-4 w-4" /> {t('services.addService')}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === 'all'
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {t('services.filterAll')}
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === cat
                  ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {categoryLabel(cat, t)}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Scissors className="h-8 w-8 text-gray-400" />}
          title={emptyTitle}
          description={emptyDescription}
          action={
            activeServices.length === 0 ? (
              <button onClick={openCreate} className="btn-primary">
                <Plus className="h-4 w-4" /> {t('services.addService')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((service) => (
            <div
              key={service.id}
              className="card group w-full min-w-0 max-w-full p-4 hover:shadow-card-hover sm:p-6"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/50">
                  <Scissors className="h-5 w-5 text-brand-600 dark:text-brand-400" />
                </div>
                <div className="flex shrink-0 gap-1.5 transition-opacity sm:gap-1 sm:opacity-0 sm:group-hover:opacity-100">
                  <button
                    onClick={() => openEdit(service)}
                    disabled={actionBusy === service.id}
                    className="btn-ghost min-h-[44px] min-w-[44px] p-2 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                    aria-label={t('services.editAria')}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(service.id)}
                    disabled={actionBusy === service.id}
                    className="btn-ghost min-h-[44px] min-w-[44px] p-2 text-red-500 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                    aria-label={t('services.deleteAria')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <h4 className="mt-3 truncate font-semibold text-gray-900 dark:text-white">
                {service.name}
              </h4>

              {service.description && (
                <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
                  {service.description}
                </p>
              )}

              <div className="mt-4 flex items-center justify-between gap-2">
                <span className="text-lg font-bold text-brand-600 dark:text-brand-400">
                  {formatCurrency(service.price)}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                  <Clock className="h-3.5 w-3.5" />
                  {formatDurationLocalized(service.duration, t)}
                </span>
              </div>

              <span className="mt-2 inline-block max-w-full truncate rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {categoryLabel(service.category, t)}
              </span>
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
        title={editing ? t('services.editTitle') : t('services.createTitle')}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('services.fieldName')}</label>
            <input
              className="input-field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('services.fieldDescription')}</label>
            <textarea
              className="input-field"
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('services.fieldDuration')}</label>
              <input
                className="input-field"
                type="number"
                min={1}
                value={form.duration}
                onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('services.fieldPrice')}</label>
              <input
                className="input-field"
                type="number"
                min={0}
                step={0.01}
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
                required
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('services.fieldCategory')}</label>
            <select
              className="input-field"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {categoryLabel(cat, t)}
                </option>
              ))}
            </select>
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
              {editing ? t('services.saveChanges') : t('services.createSubmit')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
