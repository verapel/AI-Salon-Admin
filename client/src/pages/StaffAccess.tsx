import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, ShieldOff, Trash2, UserMinus, UserPlus, Users } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Modal from '@/components/ui/Modal';
import SearchInput from '@/components/ui/SearchInput';
import PermanentDeleteStaffModal from '@/components/staff/PermanentDeleteStaffModal';
import { useAuth } from '@/context/AuthContext';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import {
  inviteStaff,
  listStaffAccess,
  looksLikeEmail,
  resendStaffInvite,
  setStaffAccessActive,
  type StaffAccessItem,
  type StaffAccessStatus,
} from '@/lib/staffAccess';

const STATUS_LABEL: Record<StaffAccessStatus, TranslationKey> = {
  none: 'staffAccess.status.none',
  active: 'staffAccess.status.active',
  disabled: 'staffAccess.status.disabled',
};

const STATUS_BADGE: Record<StaffAccessStatus, string> = {
  none: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  active: 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300',
  disabled: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
};

function applyAccessUpdate(items: StaffAccessItem[], next: StaffAccessItem['staffId'], patch: Partial<StaffAccessItem>) {
  return items.map((row) => (row.staffId === next ? { ...row, ...patch } : row));
}

export default function StaffAccess() {
  const { t } = useLanguage();
  const { authInfo } = useAuth();
  const canManageEmployment = authInfo?.role === 'owner' || authInfo?.role === 'admin';

  const [items, setItems] = useState<StaffAccessItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [inviteTarget, setInviteTarget] = useState<StaffAccessItem | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<StaffAccessItem | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setActionError(null);
    try {
      setItems(await listStaffAccess());
    } catch {
      setItems([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openInvite = (row: StaffAccessItem) => {
    setInviteTarget(row);
    setInviteEmail(looksLikeEmail(row.staffEmail) ? row.staffEmail.trim().toLowerCase() : '');
    setInviteError('');
  };

  const closeInvite = () => {
    if (inviteSubmitting) return;
    setInviteTarget(null);
    setInviteEmail('');
    setInviteError('');
  };

  const handleInviteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteTarget) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      setInviteError(t('staffAccess.invite.invalidEmail'));
      return;
    }

    setInviteSubmitting(true);
    setInviteError('');
    setActionError(null);
    try {
      const result = await inviteStaff(inviteTarget.staffId, email);
      setItems((prev) =>
        applyAccessUpdate(prev, inviteTarget.staffId, {
          status: result.access.status,
          email: result.access.email,
          active: result.access.active,
          canInvite: result.access.canInvite,
          canResend: result.access.canResend,
          canDisable: result.access.canDisable,
          canEnable: result.access.canEnable,
        })
      );
      setInviteTarget(null);
      showToast(
        result.invitationSent
          ? t('staffAccess.toast.inviteSent')
          : t('staffAccess.toast.existingLinked')
      );
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : t('staffAccess.error.action'));
    } finally {
      setInviteSubmitting(false);
    }
  };

  const runMutation = async (
    staffId: string,
    action: () => Promise<{ access: import('@/types').StaffAccessDto }>,
    successKey: TranslationKey
  ) => {
    setBusyId(staffId);
    setActionError(null);
    try {
      const result = await action();
      setItems((prev) =>
        applyAccessUpdate(prev, staffId, {
          status: result.access.status,
          email: result.access.email,
          active: result.access.active,
          canInvite: result.access.canInvite,
          canResend: result.access.canResend,
          canDisable: result.access.canDisable,
          canEnable: result.access.canEnable,
        })
      );
      showToast(t(successKey));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('staffAccess.error.action'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeactivateEmployment = async (row: StaffAccessItem) => {
    if (!confirm(t('staff.deactivateConfirm'))) return;
    setBusyId(row.staffId);
    setActionError(null);
    try {
      await api.staff.delete(row.staffId);
      setItems((prev) =>
        applyAccessUpdate(prev, row.staffId, {
          staffActive: false,
          canInvite: false,
        })
      );
      showToast(t('staffAccess.toast.deactivate'));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('staffAccess.error.action'));
    } finally {
      setBusyId(null);
    }
  };

  const visibleItems = useMemo(() => {
    const base = showInactive ? items : items.filter((row) => row.staffActive);
    const query = search.trim().toLowerCase();
    if (!query) return base;
    return base.filter(
      (row) =>
        row.name.toLowerCase().includes(query) ||
        row.specialty.toLowerCase().includes(query) ||
        row.staffEmail.toLowerCase().includes(query) ||
        (row.email || '').toLowerCase().includes(query) ||
        row.specialties.some((s) => s.toLowerCase().includes(query))
    );
  }, [items, search, showInactive]);

  const activeCount = items.filter((row) => row.staffActive).length;

  if (loading) return <LoadingSpinner />;

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
        <p className="text-sm text-red-700 dark:text-red-300">{t('staffAccess.error.load')}</p>
        <button type="button" className="btn-primary mt-3" onClick={() => void load()}>
          {t('staffAccess.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip animate-fade-in">
      {toast ? (
        <div
          className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {actionError}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full min-w-0 max-w-full sm:max-w-xs">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('staffAccess.searchPlaceholder')}
          />
        </div>
        <button
          type="button"
          className="btn-secondary w-full text-sm sm:w-auto"
          onClick={() => setShowInactive((prev) => !prev)}
        >
          {showInactive ? t('staff.hideInactiveStaff') : t('staff.showInactiveStaff')}
        </button>
      </div>

      {visibleItems.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8 text-gray-400" />}
          title={
            activeCount === 0 && !showInactive
              ? t('staffAccess.empty')
              : items.length === 0
                ? t('staffAccess.empty')
                : t('staffAccess.noResults')
          }
          description={
            activeCount === 0 && !showInactive
              ? t('staffAccess.emptyDesc')
              : items.length === 0
                ? t('staffAccess.emptyDesc')
                : t('staffAccess.noResultsDesc')
          }
        />
      ) : (
        <div className="grid w-full min-w-0 max-w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleItems.map((row) => {
            const busy = busyId === row.staffId;
            return (
              <div
                key={row.staffId}
                className="card group w-full min-w-0 max-w-full p-4 hover:shadow-card-hover sm:p-6"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  <div
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-lg font-bold text-white sm:h-14 sm:w-14"
                    aria-hidden
                  >
                    {row.avatar}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="truncate font-semibold text-gray-900 dark:text-white">
                          {row.name}
                        </h4>
                        <p className="truncate text-sm text-brand-600 dark:text-brand-400">
                          {row.specialty || '—'}
                        </p>
                        {row.isPrimary ? (
                          <p className="mt-1">
                            <span className="inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                              {t('staff.primaryStaff')}
                            </span>
                          </p>
                        ) : null}
                        {row.email ? (
                          <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                            {row.email}
                          </p>
                        ) : null}
                        {!row.staffActive ? (
                          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                            {t('staffAccess.staffInactive')}
                          </p>
                        ) : null}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[row.status]}`}
                      >
                        {t(STATUS_LABEL[row.status])}
                      </span>
                    </div>

                    <div className="mt-4 space-y-3">
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          {t('staffAccess.section.portal')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {row.canInvite ? (
                            <button
                              type="button"
                              className="btn-primary text-xs"
                              disabled={busy}
                              onClick={() => openInvite(row)}
                            >
                              <UserPlus className="h-3.5 w-3.5" />
                              {t('staffAccess.action.invite')}
                            </button>
                          ) : null}

                          {row.canResend ? (
                            <button
                              type="button"
                              className="btn-secondary text-xs"
                              disabled={busy}
                              onClick={() =>
                                void runMutation(
                                  row.staffId,
                                  () => resendStaffInvite(row.staffId),
                                  'staffAccess.toast.resend'
                                )
                              }
                            >
                              {t('staffAccess.action.resend')}
                            </button>
                          ) : null}

                          {row.canDisable ? (
                            <button
                              type="button"
                              className="btn-secondary text-xs text-red-600 dark:text-red-400"
                              disabled={busy}
                              onClick={() =>
                                void runMutation(
                                  row.staffId,
                                  () => setStaffAccessActive(row.staffId, false),
                                  'staffAccess.toast.disable'
                                )
                              }
                            >
                              <ShieldOff className="h-3.5 w-3.5" />
                              {t('staffAccess.action.disable')}
                            </button>
                          ) : null}

                          {row.canEnable ? (
                            <button
                              type="button"
                              className="btn-primary text-xs"
                              disabled={busy}
                              onClick={() =>
                                void runMutation(
                                  row.staffId,
                                  () => setStaffAccessActive(row.staffId, true),
                                  'staffAccess.toast.enable'
                                )
                              }
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                              {t('staffAccess.action.enable')}
                            </button>
                          ) : null}

                          {!row.canInvite &&
                          !row.canResend &&
                          !row.canDisable &&
                          !row.canEnable ? (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {t(STATUS_LABEL[row.status])}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      {canManageEmployment ? (
                        <div>
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                            {t('staffAccess.section.employment')}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {row.staffActive ? (
                              <button
                                type="button"
                                className="btn-secondary text-xs"
                                disabled={busy}
                                onClick={() => void handleDeactivateEmployment(row)}
                              >
                                <UserMinus className="h-3.5 w-3.5" />
                                {t('staff.deactivateStaff')}
                              </button>
                            ) : null}
                            {row.isPrimary ? (
                              <p className="text-xs text-amber-800 dark:text-amber-200">
                                {t('staff.assignAnotherPrimaryFirst')}
                              </p>
                            ) : (
                              <button
                                type="button"
                                className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
                                disabled={busy}
                                onClick={() => setPermanentDeleteTarget(row)}
                              >
                                <Trash2 className="mr-1 inline h-3.5 w-3.5" />
                                {t('staff.permanentDelete')}
                              </button>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!inviteTarget}
        onClose={closeInvite}
        title={t('staffAccess.invite.title')}
        size="sm"
      >
        {inviteTarget ? (
          <form onSubmit={handleInviteSubmit} className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('staffAccess.invite.for')}{' '}
              <span className="font-medium text-gray-900 dark:text-white">{inviteTarget.name}</span>
            </p>
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                {t('staffAccess.invite.email')}
              </label>
              <input
                type="email"
                required
                className="input-field"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            {inviteError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{inviteError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={inviteSubmitting}
                onClick={closeInvite}
              >
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn-primary" disabled={inviteSubmitting}>
                {inviteSubmitting
                  ? t('staffAccess.invite.sending')
                  : t('staffAccess.invite.send')}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>

      <PermanentDeleteStaffModal
        open={!!permanentDeleteTarget}
        staffId={permanentDeleteTarget?.staffId ?? null}
        staffNameHint={permanentDeleteTarget?.name}
        onClose={() => setPermanentDeleteTarget(null)}
        onDeleted={({ deletedStaffId }) => {
          setItems((prev) => prev.filter((row) => row.staffId !== deletedStaffId));
          showToast(t('staff.deletionSuccess'));
        }}
      />
    </div>
  );
}
