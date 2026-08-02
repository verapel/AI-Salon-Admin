import { FormEvent, useCallback, useEffect, useState } from 'react';
import { CalendarDays, MessageCircle, ShieldCheck } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Modal from '@/components/ui/Modal';
import { useLanguage } from '@/context/LanguageContext';
import type { TranslationKey } from '@/i18n/translations';
import { ApiError, api } from '@/lib/api';
import type {
  CalendarConnectionPublic,
  WhatsAppBusinessConnectionPublic,
  WhatsAppConnectRequest,
} from '@/types';

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isCredentialsStoredState(connection: CalendarConnectionPublic | null): boolean {
  if (!connection?.isCredentialStored) return false;
  if (connection.status === 'disconnected') return false;
  return true;
}

function mapWhatsAppErrorCode(
  code: string | undefined,
  t: (key: TranslationKey) => string
): string {
  switch (code) {
    case 'WHATSAPP_ENCRYPTION_KEY_MISSING':
    case 'WHATSAPP_NOT_CONFIGURED':
      return t('integrations.whatsapp.encryptionNotConfigured');
    case 'WHATSAPP_INVALID_CREDENTIALS':
      return t('integrations.whatsapp.invalidCredentials');
    case 'WHATSAPP_META_API_ERROR':
      return t('integrations.whatsapp.providerUnavailable');
    case 'WHATSAPP_PHONE_NUMBER_NOT_FOUND':
      return t('integrations.whatsapp.phoneNumberNotFound');
    case 'WHATSAPP_WABA_MISMATCH':
      return t('integrations.whatsapp.wabaMismatch');
    case 'WHATSAPP_PHONE_NUMBER_IN_USE':
      return t('integrations.whatsapp.phoneNumberInUse');
    default:
      return t('integrations.whatsapp.genericError');
  }
}

const EMPTY_WA_FORM: WhatsAppConnectRequest = {
  accessToken: '',
  appSecret: '',
  verifyToken: '',
  businessAccountId: '',
  phoneNumberId: '',
};

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

  const [waConnected, setWaConnected] = useState(false);
  const [waConnection, setWaConnection] = useState<WhatsAppBusinessConnectionPublic | null>(null);
  const [waForm, setWaForm] = useState<WhatsAppConnectRequest>(EMPTY_WA_FORM);
  const [waShowForm, setWaShowForm] = useState(false);
  const [waConnectError, setWaConnectError] = useState<string | null>(null);
  const [waConnectSubmitting, setWaConnectSubmitting] = useState(false);
  const [waDisconnectOpen, setWaDisconnectOpen] = useState(false);
  const [waDisconnectError, setWaDisconnectError] = useState<string | null>(null);
  const [waDisconnectSubmitting, setWaDisconnectSubmitting] = useState(false);

  const clearPassword = () => setAppSpecificPassword('');
  const clearWaSecrets = () =>
    setWaForm((prev) => ({
      ...prev,
      accessToken: '',
      appSecret: '',
      verifyToken: '',
    }));

  const refreshAll = useCallback(async () => {
    const [apple, whatsapp] = await Promise.all([
      api.calendar.getConnections(),
      api.whatsapp.getWhatsAppIntegration(),
    ]);
    setConnection(apple.connection);
    setWaConnected(whatsapp.connected);
    setWaConnection(whatsapp.connection);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    refreshAll()
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
  }, [refreshAll, t]);

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

  const handleWaConnect = async (event: FormEvent) => {
    event.preventDefault();
    if (waConnectSubmitting) return;

    setWaConnectError(null);
    const accessToken = waForm.accessToken.trim();
    const appSecret = waForm.appSecret.trim();
    const verifyToken = waForm.verifyToken.trim();
    const businessAccountId = waForm.businessAccountId.trim();
    const phoneNumberId = waForm.phoneNumberId.trim();

    if (!accessToken || !appSecret || !verifyToken || !businessAccountId || !phoneNumberId) {
      setWaConnectError(t('integrations.whatsapp.invalidCredentials'));
      return;
    }

    setWaConnectSubmitting(true);
    try {
      const result = await api.whatsapp.connectWhatsApp({
        accessToken,
        appSecret,
        verifyToken,
        businessAccountId,
        phoneNumberId,
      });
      setWaForm(EMPTY_WA_FORM);
      setWaShowForm(false);
      setWaConnected(result.connected);
      setWaConnection(result.connection);
    } catch (err: unknown) {
      clearWaSecrets();
      if (err instanceof ApiError) {
        setWaConnectError(mapWhatsAppErrorCode(err.code, t));
      } else {
        setWaConnectError(t('integrations.whatsapp.genericError'));
      }
    } finally {
      setWaConnectSubmitting(false);
    }
  };

  const handleWaDisconnect = async () => {
    if (waDisconnectSubmitting) return;
    setWaDisconnectSubmitting(true);
    setWaDisconnectError(null);
    try {
      const result = await api.whatsapp.disconnectWhatsApp();
      setWaConnected(result.connected);
      setWaConnection(result.connection);
      setWaForm(EMPTY_WA_FORM);
      setWaShowForm(false);
      setWaDisconnectOpen(false);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setWaDisconnectError(mapWhatsAppErrorCode(err.code, t));
      } else {
        setWaDisconnectError(t('integrations.whatsapp.genericError'));
      }
    } finally {
      setWaDisconnectSubmitting(false);
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
            refreshAll()
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
  const showWaForm = !waConnected || waShowForm;

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

      <div className="card min-w-0 max-w-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/50">
            <MessageCircle className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('integrations.whatsapp.title')}
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t('integrations.whatsapp.description')}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {waConnected ? (
                <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                  {t('integrations.whatsapp.connected')}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {t('integrations.whatsapp.disconnected')}
                </span>
              )}
            </div>

            {waConnected && !waShowForm ? (
              <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
                <div className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p>{t('integrations.whatsapp.connected')}</p>
                </div>

                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('integrations.whatsapp.verifiedName')}
                    </dt>
                    <dd className="font-medium text-gray-900 dark:text-white">
                      {waConnection?.verifiedName || t('integrations.apple.valueUnknown')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('integrations.whatsapp.displayPhoneNumber')}
                    </dt>
                    <dd className="font-medium text-gray-900 dark:text-white">
                      {waConnection?.displayPhoneNumber || t('integrations.apple.valueUnknown')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('integrations.whatsapp.businessAccountId')}
                    </dt>
                    <dd className="break-all font-medium text-gray-900 dark:text-white">
                      {waConnection?.businessAccountId || t('integrations.apple.valueUnknown')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('integrations.whatsapp.phoneNumberId')}
                    </dt>
                    <dd className="break-all font-medium text-gray-900 dark:text-white">
                      {waConnection?.phoneNumberId || t('integrations.apple.valueUnknown')}
                    </dd>
                  </div>
                </dl>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={waConnectSubmitting || waDisconnectSubmitting}
                    onClick={() => {
                      setWaForm(EMPTY_WA_FORM);
                      setWaConnectError(null);
                      setWaShowForm(true);
                    }}
                  >
                    {t('integrations.whatsapp.reconnect')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={waDisconnectSubmitting}
                    onClick={() => {
                      setWaDisconnectError(null);
                      setWaDisconnectOpen(true);
                    }}
                  >
                    {t('integrations.whatsapp.disconnect')}
                  </button>
                </div>
              </div>
            ) : null}

            {showWaForm ? (
              <form onSubmit={handleWaConnect} className="space-y-4" autoComplete="off">
                <div>
                  <label htmlFor="wa-access-token" className="mb-1.5 block text-sm font-medium">
                    {t('integrations.whatsapp.accessToken')}
                  </label>
                  <input
                    id="wa-access-token"
                    type="password"
                    required
                    className="input-field"
                    value={waForm.accessToken}
                    onChange={(e) => setWaForm((prev) => ({ ...prev, accessToken: e.target.value }))}
                    autoComplete="new-password"
                    disabled={waConnectSubmitting}
                  />
                </div>
                <div>
                  <label htmlFor="wa-app-secret" className="mb-1.5 block text-sm font-medium">
                    {t('integrations.whatsapp.appSecret')}
                  </label>
                  <input
                    id="wa-app-secret"
                    type="password"
                    required
                    className="input-field"
                    value={waForm.appSecret}
                    onChange={(e) => setWaForm((prev) => ({ ...prev, appSecret: e.target.value }))}
                    autoComplete="new-password"
                    disabled={waConnectSubmitting}
                  />
                </div>
                <div>
                  <label htmlFor="wa-verify-token" className="mb-1.5 block text-sm font-medium">
                    {t('integrations.whatsapp.verifyToken')}
                  </label>
                  <input
                    id="wa-verify-token"
                    type="password"
                    required
                    className="input-field"
                    value={waForm.verifyToken}
                    onChange={(e) => setWaForm((prev) => ({ ...prev, verifyToken: e.target.value }))}
                    autoComplete="new-password"
                    disabled={waConnectSubmitting}
                  />
                </div>
                <div>
                  <label htmlFor="wa-waba-id" className="mb-1.5 block text-sm font-medium">
                    {t('integrations.whatsapp.businessAccountId')}
                  </label>
                  <input
                    id="wa-waba-id"
                    type="text"
                    required
                    className="input-field"
                    value={waForm.businessAccountId}
                    onChange={(e) =>
                      setWaForm((prev) => ({ ...prev, businessAccountId: e.target.value }))
                    }
                    autoComplete="off"
                    disabled={waConnectSubmitting}
                  />
                </div>
                <div>
                  <label htmlFor="wa-phone-number-id" className="mb-1.5 block text-sm font-medium">
                    {t('integrations.whatsapp.phoneNumberId')}
                  </label>
                  <input
                    id="wa-phone-number-id"
                    type="text"
                    required
                    className="input-field"
                    value={waForm.phoneNumberId}
                    onChange={(e) =>
                      setWaForm((prev) => ({ ...prev, phoneNumberId: e.target.value }))
                    }
                    autoComplete="off"
                    disabled={waConnectSubmitting}
                  />
                </div>
                {waConnectError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{waConnectError}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className="btn-primary" disabled={waConnectSubmitting}>
                    {waConnectSubmitting
                      ? t('integrations.whatsapp.connecting')
                      : waConnected
                        ? t('integrations.whatsapp.reconnect')
                        : t('integrations.whatsapp.connect')}
                  </button>
                  {waConnected ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={waConnectSubmitting}
                      onClick={() => {
                        setWaForm(EMPTY_WA_FORM);
                        setWaConnectError(null);
                        setWaShowForm(false);
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                  ) : null}
                </div>
              </form>
            ) : null}
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

      <Modal
        open={waDisconnectOpen}
        onClose={() => {
          if (waDisconnectSubmitting) return;
          setWaDisconnectOpen(false);
        }}
        title={t('integrations.whatsapp.disconnect')}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('integrations.whatsapp.disconnectConfirm')}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('integrations.whatsapp.credentialsRemoved')}
          </p>
          {waDisconnectError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{waDisconnectError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={waDisconnectSubmitting}
              onClick={() => setWaDisconnectOpen(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={waDisconnectSubmitting}
              onClick={handleWaDisconnect}
            >
              {t('integrations.whatsapp.disconnect')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
