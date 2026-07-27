import { FormEvent, useCallback, useEffect, useState } from 'react';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Modal from '@/components/ui/Modal';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type { CalendarConnectionPublic } from '@/types';

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isCredentialsStoredState(connection: CalendarConnectionPublic | null): boolean {
  if (!connection?.isCredentialStored) return false;
  if (connection.status === 'disconnected') return false;
  return true;
}

export default function SalonIntegrations() {
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState<CalendarConnectionPublic | null>(null);

  const [accountEmail, setAccountEmail] = useState('');
  const [appSpecificPassword, setAppSpecificPassword] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSubmitting, setConnectSubmitting] = useState(false);

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [disconnectSubmitting, setDisconnectSubmitting] = useState(false);

  const refreshConnection = useCallback(async () => {
    const data = await api.calendar.getConnections();
    setConnection(data.connection);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api.calendar
      .getConnections()
      .then((data) => {
        if (cancelled) return;
        setConnection(data.connection);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : t('integrations.apple.loadError');
        setLoadError(message || t('integrations.apple.loadError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const clearPassword = () => setAppSpecificPassword('');

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    if (connectSubmitting) return;

    const email = accountEmail.trim();
    const password = appSpecificPassword.trim();
    setConnectError(null);

    if (!email) {
      setConnectError(t('integrations.apple.emailRequired'));
      return;
    }
    if (!BASIC_EMAIL_RE.test(email)) {
      setConnectError(t('integrations.apple.emailInvalid'));
      return;
    }
    if (!password) {
      setConnectError(t('integrations.apple.passwordRequired'));
      return;
    }

    setConnectSubmitting(true);
    try {
      const result = await api.calendar.connectApple({
        accountEmail: email,
        appSpecificPassword: password,
      });
      clearPassword();
      setConnection(result.connection);
      setAccountEmail(result.connection.accountEmail ?? email);
    } catch (err: unknown) {
      clearPassword();
      const message = err instanceof Error ? err.message : t('integrations.apple.connectError');
      setConnectError(message || t('integrations.apple.connectError'));
    } finally {
      setConnectSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    if (disconnectSubmitting) return;
    setDisconnectSubmitting(true);
    setDisconnectError(null);
    try {
      const result = await api.calendar.disconnectApple();
      setConnection(result.connection);
      setAccountEmail('');
      clearPassword();
      setDisconnectOpen(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('integrations.apple.disconnectError');
      setDisconnectError(message || t('integrations.apple.disconnectError'));
    } finally {
      setDisconnectSubmitting(false);
    }
  };

  if (loading) {
    return <LoadingSpinner />;
  }

  if (loadError) {
    return (
      <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setLoading(true);
            setLoadError(null);
            refreshConnection()
              .catch((err: unknown) => {
                const message =
                  err instanceof Error ? err.message : t('integrations.apple.loadError');
                setLoadError(message || t('integrations.apple.loadError'));
              })
              .finally(() => setLoading(false));
          }}
        >
          {t('integrations.apple.retry')}
        </button>
      </div>
    );
  }

  const stored = isCredentialsStoredState(connection);
  const showErrorStatus = connection?.status === 'error';
  const verificationPending = stored && (connection?.verificationPending ?? true);

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-6 animate-fade-in">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('integrations.subtitle')}</p>

      <div className="card min-w-0 max-w-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/50">
            <CalendarDays className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('integrations.apple.title')}
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t('integrations.apple.description')}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {!stored ? (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {t('integrations.apple.status.notConnected')}
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                    {t('integrations.apple.status.credentialsStored')}
                  </span>
                  {verificationPending ? (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                      {t('integrations.apple.status.verificationPending')}
                    </span>
                  ) : null}
                </>
              )}
              {showErrorStatus ? (
                <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/60 dark:text-red-300">
                  {t('integrations.apple.status.error')}
                </span>
              ) : null}
            </div>

            {stored ? (
              <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
                <div className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="space-y-1">
                    <p>{t('integrations.apple.storedSecurely')}</p>
                    <p>{t('integrations.apple.verificationNextStage')}</p>
                    <p>{t('integrations.apple.noImportYet')}</p>
                  </div>
                </div>

                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('integrations.apple.accountEmail')}
                    </dt>
                    <dd className="font-medium text-gray-900 dark:text-white">
                      {connection?.accountEmail || t('integrations.apple.valueUnknown')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('integrations.apple.credentialStored')}
                    </dt>
                    <dd className="font-medium text-gray-900 dark:text-white">
                      {t('integrations.apple.yes')}
                    </dd>
                  </div>
                  {connection?.selectedCalendarName ? (
                    <div>
                      <dt className="text-gray-500 dark:text-gray-400">
                        {t('integrations.apple.selectedCalendar')}
                      </dt>
                      <dd className="font-medium text-gray-900 dark:text-white">
                        {connection.selectedCalendarName}
                      </dd>
                    </div>
                  ) : null}
                  {connection?.lastSyncAt ? (
                    <div>
                      <dt className="text-gray-500 dark:text-gray-400">
                        {t('integrations.apple.lastSync')}
                      </dt>
                      <dd className="font-medium text-gray-900 dark:text-white">
                        {connection.lastSyncAt}
                      </dd>
                    </div>
                  ) : null}
                  {showErrorStatus && connection?.lastError ? (
                    <div className="sm:col-span-2">
                      <dt className="text-gray-500 dark:text-gray-400">
                        {t('integrations.apple.lastError')}
                      </dt>
                      <dd className="font-medium text-red-600 dark:text-red-400">
                        {connection.lastError}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                <div className="pt-1">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={disconnectSubmitting}
                    onClick={() => {
                      setDisconnectError(null);
                      setDisconnectOpen(true);
                    }}
                  >
                    {t('integrations.apple.disconnect')}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleConnect} className="space-y-4" autoComplete="off">
                <div>
                  <label htmlFor="apple-account-email" className="mb-1.5 block text-sm font-medium">
                    {t('integrations.apple.accountEmail')}
                  </label>
                  <input
                    id="apple-account-email"
                    type="email"
                    required
                    className="input-field"
                    value={accountEmail}
                    onChange={(e) => setAccountEmail(e.target.value)}
                    autoComplete="username"
                    disabled={connectSubmitting}
                  />
                </div>
                <div>
                  <label
                    htmlFor="apple-app-specific-password"
                    className="mb-1.5 block text-sm font-medium"
                  >
                    {t('integrations.apple.appSpecificPassword')}
                  </label>
                  <input
                    id="apple-app-specific-password"
                    type="password"
                    required
                    className="input-field"
                    value={appSpecificPassword}
                    onChange={(e) => setAppSpecificPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={connectSubmitting}
                  />
                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {t('integrations.apple.passwordHelp')}
                  </p>
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    {t('integrations.apple.noNormalPassword')}
                  </p>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('integrations.apple.verificationNotActive')}
                </p>
                {connectError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{connectError}</p>
                ) : null}
                <button type="submit" className="btn-primary" disabled={connectSubmitting}>
                  {connectSubmitting
                    ? t('integrations.apple.connecting')
                    : t('integrations.apple.connect')}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      <p className="max-w-2xl text-xs text-gray-500 dark:text-gray-400">
        {t('integrations.managedByDeveloper')}
      </p>

      <Modal
        open={disconnectOpen}
        onClose={() => {
          if (disconnectSubmitting) return;
          setDisconnectOpen(false);
        }}
        title={t('integrations.apple.disconnectTitle')}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('integrations.apple.disconnectConfirm')}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-400">
            <li>{t('integrations.apple.disconnectBulletCredentials')}</li>
            <li>{t('integrations.apple.disconnectBulletCalendar')}</li>
            <li>{t('integrations.apple.disconnectBulletAppointments')}</li>
            <li>{t('integrations.apple.disconnectBulletNoImport')}</li>
          </ul>
          {disconnectError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{disconnectError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={disconnectSubmitting}
              onClick={() => setDisconnectOpen(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={disconnectSubmitting}
              onClick={handleDisconnect}
            >
              {disconnectSubmitting
                ? t('integrations.apple.disconnecting')
                : t('integrations.apple.disconnectConfirmButton')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
