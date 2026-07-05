import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Users, Mail, Phone, Ban, ShieldCheck } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import type { Client } from '@/types';
import type { TranslationKey } from '@/i18n/translations';

type ClientFilter = 'all' | 'active' | 'blacklist';

const FILTER_KEYS: Record<ClientFilter, TranslationKey> = {
  all: 'clients.filterAll',
  active: 'clients.filterActive',
  blacklist: 'clients.filterBlacklist',
};

const FILTERS: ClientFilter[] = ['all', 'active', 'blacklist'];

export default function Clients() {
  const { t } = useLanguage();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ClientFilter>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });

  const loadClients = () => {
    api.clients
      .getAll()
      .then(setClients)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadClients();
  }, []);

  const query = search.trim().toLowerCase();
  const filtered = clients.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(query) ||
      c.email.toLowerCase().includes(query) ||
      c.phone.toLowerCase().includes(query);
    if (!matchesSearch) return false;
    if (filter === 'active') return !c.isBlocked;
    if (filter === 'blacklist') return c.isBlocked;
    return true;
  });

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
    if (!confirm(t('clients.deleteConfirm'))) return;
    try {
      await api.clients.delete(id);
      loadClients();
    } catch (err) {
      console.error(err);
    }
  };

  const handleBlock = async (client: Client) => {
    if (!confirm(t('clients.blockConfirm'))) return;
    try {
      await api.clients.block(client.id);
      loadClients();
    } catch (err) {
      console.error(err);
    }
  };

  const handleUnblock = async (client: Client) => {
    try {
      await api.clients.unblock(client.id);
      loadClients();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <LoadingSpinner />;

  const emptyTitle =
    filter === 'blacklist'
      ? t('clients.noBlacklist')
      : clients.length === 0
        ? t('clients.noClients')
        : t('clients.noResults');

  const emptyDescription =
    filter === 'blacklist'
      ? t('clients.noBlacklistDesc')
      : clients.length === 0
        ? t('clients.noClientsDesc')
        : t('clients.noResultsDesc');

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
      <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full min-w-0 max-w-full sm:max-w-xs">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('clients.searchPlaceholder')}
          />
        </div>
        <button onClick={openCreate} className="btn-primary w-full sm:w-auto">
          <Plus className="h-4 w-4" /> {t('common.addClient')}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === status
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {t(FILTER_KEYS[status])}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8 text-gray-400" />}
          title={emptyTitle}
          description={emptyDescription}
          action={
            filter !== 'blacklist' && clients.length === 0 ? (
              <button onClick={openCreate} className="btn-primary">
                <Plus className="h-4 w-4" /> {t('common.addClient')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((client) => (
            <div
              key={client.id}
              className={`card group w-full min-w-0 max-w-full p-4 hover:shadow-card-hover sm:p-6 ${
                client.isBlocked ? 'border-red-200 dark:border-red-900/50' : ''
              }`}
            >
              <div className="flex min-w-0 items-center justify-between gap-1 sm:items-start">
                <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold sm:h-11 sm:w-11 sm:text-sm ${
                      client.isBlocked
                        ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                        : 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                    }`}
                  >
                    {client.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h4 className="truncate font-semibold text-gray-900 dark:text-white">
                        {client.name}
                      </h4>
                      {client.isBlocked && (
                        <span className="badge shrink-0 bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300">
                          {t('clients.blocked')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {client.totalVisits} {t('clients.visits')}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 gap-1.5 transition-opacity sm:gap-1 sm:opacity-0 sm:group-hover:opacity-100">
                  {client.isBlocked ? (
                    <button
                      onClick={() => handleUnblock(client)}
                      className="btn-ghost min-h-[44px] min-w-[44px] p-2 text-green-600 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                      aria-label={t('clients.unblockAria')}
                      title={t('clients.unblock')}
                    >
                      <ShieldCheck className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleBlock(client)}
                      className="btn-ghost min-h-[44px] min-w-[44px] p-2 text-red-500 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                      aria-label={t('clients.blockAria')}
                      title={t('clients.block')}
                    >
                      <Ban className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={() => openEdit(client)}
                    className="btn-ghost min-h-[44px] min-w-[44px] p-2 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                    aria-label={t('clients.editAria')}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(client.id)}
                    className="btn-ghost min-h-[44px] min-w-[44px] p-2 text-red-500 sm:min-h-0 sm:min-w-0 sm:p-1.5"
                    aria-label={t('clients.deleteAria')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="mt-3 min-w-0 space-y-1.5 overflow-hidden text-sm sm:mt-4">
                <div className="flex min-w-0 items-center gap-2">
                  <Mail className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="min-w-0 truncate text-gray-500 dark:text-gray-400">
                    {client.email || '—'}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <Phone className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-300 sm:font-normal sm:text-gray-500 dark:sm:text-gray-400">
                    {client.phone || t('clients.phoneNA')}
                  </span>
                </div>
                {client.isBlocked && client.blockedReason && (
                  <p className="truncate text-xs text-red-600 dark:text-red-400">
                    {client.blockedReason}
                  </p>
                )}
                {client.lastVisit && (
                  <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {t('clients.lastVisit')}: {formatDate(client.lastVisit)}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? t('clients.editTitle') : t('clients.addTitle')}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('clients.fieldName')}</label>
            <input
              className="input-field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('clients.fieldEmail')}</label>
            <input
              className="input-field"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('clients.fieldPhone')}</label>
            <input
              className="input-field"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('clients.fieldNotes')}</label>
            <textarea
              className="input-field"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary w-full sm:w-auto">
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary w-full sm:w-auto">
              {editing ? t('clients.saveChanges') : t('common.addClient')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
