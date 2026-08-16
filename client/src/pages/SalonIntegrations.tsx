import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Modal from '@/components/ui/Modal';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import type {
  CalendarConnectionPublic,
  CalendarEventParsedPreview,
  CalendarParseImportability,
  GoogleCalendarListItem,
  GoogleEventPreviewItem,
  GoogleEventTimePreview,
} from '@/types';

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isCredentialsStoredState(connection: CalendarConnectionPublic | null): boolean {
  if (!connection?.isCredentialStored) return false;
  if (connection.status === 'disconnected') return false;
  return true;
}

function formatEventInstant(time: GoogleEventTimePreview): string {
  if (time.allDay && time.date) return time.date;
  if (time.dateTime) return time.dateTime;
  if (time.date) return time.date;
  return '—';
}

function formatEventDuration(
  start: GoogleEventTimePreview,
  end: GoogleEventTimePreview,
  allDayLabel: string,
): string {
  if (start.allDay || end.allDay) return allDayLabel;
  if (!start.dateTime || !end.dateTime) return '—';
  const a = Date.parse(start.dateTime);
  const b = Date.parse(end.dateTime);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—';
  const mins = Math.round((b - a) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function importabilityLabel(
  t: (key: import('@/context/LanguageContext').TranslationKey) => string,
  value: CalendarParseImportability | undefined,
): string {
  if (value === 'ready') return t('integrations.google.parsedReady');
  if (value === 'not_importable') return t('integrations.google.parsedNotImportable');
  return t('integrations.google.parsedReview');
}

function importabilityClass(value: CalendarParseImportability | undefined): string {
  if (value === 'ready') {
    return 'text-emerald-800 dark:text-emerald-200';
  }
  if (value === 'not_importable') {
    return 'text-gray-600 dark:text-gray-400';
  }
  return 'text-amber-800 dark:text-amber-200';
}

function parsedReasonLabels(
  t: (key: import('@/context/LanguageContext').TranslationKey) => string,
  parsed: CalendarEventParsedPreview | undefined,
): string[] {
  if (!parsed) return [t('integrations.google.reasonStaffUnset')];
  const labels: string[] = [];
  const reasons = parsed.reasons ?? [];
  const pushUnique = (label: string) => {
    if (!labels.includes(label)) labels.push(label);
  };

  // Staff is always unresolved in FAST-3B.
  pushUnique(t('integrations.google.reasonStaffUnset'));

  if (reasons.includes('all_day_event') || parsed.classification.includes('all_day')) {
    pushUnique(t('integrations.google.reasonAllDay'));
  }
  if (reasons.includes('cancelled_event') || parsed.classification.includes('cancelled')) {
    pushUnique(t('integrations.google.reasonCancelled'));
  }
  if (
    reasons.includes('invalid_or_incomplete_time') ||
    reasons.includes('missing_start_datetime') ||
    reasons.includes('invalid_start_datetime') ||
    reasons.includes('missing_end_datetime') ||
    reasons.includes('end_before_or_equal_start')
  ) {
    pushUnique(t('integrations.google.reasonInvalidTime'));
  }
  if (reasons.includes('ambiguous_title_structure') || parsed.classification.includes('ambiguous')) {
    pushUnique(t('integrations.google.reasonAmbiguous'));
  }
  if (reasons.includes('needs_client_review') || !parsed.clientNameCandidate) {
    if (parsed.importability !== 'not_importable') {
      pushUnique(t('integrations.google.reasonNeedsClient'));
    }
  }
  if (reasons.includes('needs_service_review') || !parsed.serviceCandidate) {
    if (parsed.importability !== 'not_importable') {
      pushUnique(t('integrations.google.reasonNeedsService'));
    }
  }

  return labels;
}

function formatParsedLocalTime(parsed: CalendarEventParsedPreview | undefined): string {
  if (!parsed?.localStartTime) return '—';
  if (parsed.localEndTime) return `${parsed.localStartTime} – ${parsed.localEndTime}`;
  return parsed.localStartTime;
}

function formatParsedDuration(
  parsed: CalendarEventParsedPreview | undefined,
  minutesLabel: (n: number) => string,
): string {
  if (parsed?.durationMinutes == null) return '—';
  return minutesLabel(parsed.durationMinutes);
}

function formatParsedPhone(parsed: CalendarEventParsedPreview | undefined): string {
  if (!parsed?.phone || parsed.phone.confidence === 'none') return '—';
  const shown = parsed.phone.normalized || parsed.phone.value || '—';
  return `${shown} (${parsed.phone.confidence})`;
}

function formatParsedPrice(parsed: CalendarEventParsedPreview | undefined): string {
  if (!parsed?.priceCandidate || parsed.priceCandidate.confidence === 'none') return '—';
  const v =
    parsed.priceCandidate.value != null
      ? String(parsed.priceCandidate.value)
      : parsed.priceCandidate.raw || '—';
  return `${v} (${parsed.priceCandidate.confidence})`;
}

function ParsedField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}

export default function SalonIntegrations() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [appleConnection, setAppleConnection] = useState<CalendarConnectionPublic | null>(null);
  const [googleConnection, setGoogleConnection] = useState<CalendarConnectionPublic | null>(null);

  const [accountEmail, setAccountEmail] = useState('');
  const [appSpecificPassword, setAppSpecificPassword] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSubmitting, setConnectSubmitting] = useState(false);

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [disconnectSubmitting, setDisconnectSubmitting] = useState(false);

  const [googleConnectError, setGoogleConnectError] = useState<string | null>(null);
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [googleBanner, setGoogleBanner] = useState<string | null>(null);

  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendarListItem[]>([]);
  const [googleCalendarsLoading, setGoogleCalendarsLoading] = useState(false);
  const [googleCalendarsError, setGoogleCalendarsError] = useState<string | null>(null);
  const [googleSelecting, setGoogleSelecting] = useState(false);
  const [showCalendarPicker, setShowCalendarPicker] = useState(false);

  const [googleDisconnectOpen, setGoogleDisconnectOpen] = useState(false);
  const [googleDisconnectError, setGoogleDisconnectError] = useState<string | null>(null);
  const [googleDisconnectSubmitting, setGoogleDisconnectSubmitting] = useState(false);

  const [googlePreviewEvents, setGooglePreviewEvents] = useState<GoogleEventPreviewItem[]>([]);
  const [googlePreviewLoading, setGooglePreviewLoading] = useState(false);
  const [googlePreviewError, setGooglePreviewError] = useState<string | null>(null);
  const [googlePreviewTruncated, setGooglePreviewTruncated] = useState(false);
  const [googlePreviewLoaded, setGooglePreviewLoaded] = useState(false);

  const refreshConnections = useCallback(async () => {
    const data = await api.calendar.getConnections();
    setAppleConnection(data.connection);
    const google =
      data.connections?.find((c) => c.provider === 'google') ?? null;
    setGoogleConnection(google);
    return google;
  }, []);

  const loadGoogleCalendars = useCallback(async () => {
    setGoogleCalendarsLoading(true);
    setGoogleCalendarsError(null);
    try {
      const data = await api.calendar.getGoogleCalendars();
      setGoogleCalendars(data.calendars);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('integrations.google.calendarsError');
      setGoogleCalendarsError(message || t('integrations.google.calendarsError'));
      setGoogleCalendars([]);
    } finally {
      setGoogleCalendarsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api.calendar
      .getConnections()
      .then((data) => {
        if (cancelled) return;
        setAppleConnection(data.connection);
        const google =
          data.connections?.find((c) => c.provider === 'google') ?? null;
        setGoogleConnection(google);
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

  useEffect(() => {
    const google = searchParams.get('google');
    const reason = searchParams.get('reason');
    if (!google) return;
    if (google === 'connected') {
      setGoogleBanner(t('integrations.google.connectedBanner'));
      setShowCalendarPicker(true);
      void refreshConnections().then((conn) => {
        if (conn && isCredentialsStoredState(conn) && !conn.selectedCalendarId) {
          void loadGoogleCalendars();
        }
      });
    } else if (google === 'error') {
      setGoogleConnectError(
        reason
          ? t('integrations.google.errorWithReason').replace('{reason}', reason)
          : t('integrations.google.connectError'),
      );
    }
    const next = new URLSearchParams(searchParams);
    next.delete('google');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, t, refreshConnections, loadGoogleCalendars]);

  const clearPassword = () => setAppSpecificPassword('');

  const handleConnectApple = async (event: FormEvent) => {
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
      setAppleConnection(result.connection);
      setAccountEmail(result.connection.accountEmail ?? email);
    } catch (err: unknown) {
      clearPassword();
      const message = err instanceof Error ? err.message : t('integrations.apple.connectError');
      setConnectError(message || t('integrations.apple.connectError'));
    } finally {
      setConnectSubmitting(false);
    }
  };

  const handleDisconnectApple = async () => {
    if (disconnectSubmitting) return;
    setDisconnectSubmitting(true);
    setDisconnectError(null);
    try {
      const result = await api.calendar.disconnectApple();
      setAppleConnection(result.connection);
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

  const handleConnectGoogle = async () => {
    if (googleConnecting) return;
    setGoogleConnecting(true);
    setGoogleConnectError(null);
    try {
      const { authorizationUrl } = await api.calendar.getGoogleAuthUrl();
      window.location.assign(authorizationUrl);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('integrations.google.connectError');
      setGoogleConnectError(message || t('integrations.google.connectError'));
      setGoogleConnecting(false);
    }
  };

  const handleSelectGoogleCalendar = async (calendarId: string) => {
    if (googleSelecting) return;
    setGoogleSelecting(true);
    setGoogleCalendarsError(null);
    try {
      const result = await api.calendar.selectGoogleCalendar(calendarId);
      setGoogleConnection(result.connection);
      setShowCalendarPicker(false);
      setGoogleBanner(t('integrations.google.calendarSelectedBanner'));
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('integrations.google.selectError');
      setGoogleCalendarsError(message || t('integrations.google.selectError'));
    } finally {
      setGoogleSelecting(false);
    }
  };

  const handleDisconnectGoogle = async () => {
    if (googleDisconnectSubmitting) return;
    setGoogleDisconnectSubmitting(true);
    setGoogleDisconnectError(null);
    try {
      const result = await api.calendar.disconnectGoogle();
      setGoogleConnection(result.connection);
      setGoogleCalendars([]);
      setShowCalendarPicker(false);
      setGoogleDisconnectOpen(false);
      setGoogleBanner(null);
      setGooglePreviewEvents([]);
      setGooglePreviewLoaded(false);
      setGooglePreviewTruncated(false);
      setGooglePreviewError(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('integrations.google.disconnectError');
      setGoogleDisconnectError(message || t('integrations.google.disconnectError'));
    } finally {
      setGoogleDisconnectSubmitting(false);
    }
  };

  const handlePreviewGoogleEvents = async () => {
    if (googlePreviewLoading) return;
    setGooglePreviewLoading(true);
    setGooglePreviewError(null);
    try {
      const data = await api.calendar.getGoogleEventsPreview();
      setGooglePreviewEvents(data.events);
      setGooglePreviewTruncated(Boolean(data.truncated));
      setGooglePreviewLoaded(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('integrations.google.previewError');
      setGooglePreviewError(message || t('integrations.google.previewError'));
      setGooglePreviewEvents([]);
      setGooglePreviewLoaded(false);
      setGooglePreviewTruncated(false);
    } finally {
      setGooglePreviewLoading(false);
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
            refreshConnections()
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

  const appleStored = isCredentialsStoredState(appleConnection);
  const appleShowError = appleConnection?.status === 'error';
  const appleVerificationPending =
    appleStored && (appleConnection?.verificationPending ?? true);

  const googleStored = isCredentialsStoredState(googleConnection);
  const googleSelected = Boolean(googleConnection?.selectedCalendarId);
  const needsCalendarPick =
    googleStored && (!googleSelected || showCalendarPicker);

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-6 animate-fade-in">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('integrations.subtitle')}</p>

      {/* Google Calendar — primary for Tatev pilot */}
      <div className="card min-w-0 max-w-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/50">
            <CalendarDays className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('integrations.google.title')}
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t('integrations.google.description')}
              </p>
            </div>

            {googleBanner ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-300">{googleBanner}</p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {!googleStored ? (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {t('integrations.google.status.notConnected')}
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                    {t('integrations.google.status.connected')}
                  </span>
                  {googleSelected ? (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                      {t('integrations.google.status.calendarSelected')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                      {t('integrations.google.status.selectCalendar')}
                    </span>
                  )}
                </>
              )}
            </div>

            {!googleStored ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('integrations.google.connectHint')}
                </p>
                {googleConnectError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{googleConnectError}</p>
                ) : null}
                <button
                  type="button"
                  className="btn-primary"
                  disabled={googleConnecting}
                  onClick={handleConnectGoogle}
                >
                  {googleConnecting
                    ? t('integrations.google.connecting')
                    : t('integrations.google.connect')}
                </button>
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('integrations.google.accountEmail')}
                    </dt>
                    <dd className="font-medium text-gray-900 dark:text-white">
                      {googleConnection?.accountEmail ||
                        t('integrations.google.valueUnknown')}
                    </dd>
                  </div>
                  {googleConnection?.selectedCalendarName ? (
                    <div>
                      <dt className="text-gray-500 dark:text-gray-400">
                        {t('integrations.google.selectedCalendar')}
                      </dt>
                      <dd className="font-medium text-gray-900 dark:text-white">
                        {googleConnection.selectedCalendarName}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('integrations.google.noImportYet')}
                </p>

                {needsCalendarPick ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={googleCalendarsLoading}
                        onClick={() => {
                          setShowCalendarPicker(true);
                          void loadGoogleCalendars();
                        }}
                      >
                        {googleCalendarsLoading
                          ? t('integrations.google.loadingCalendars')
                          : t('integrations.google.loadCalendars')}
                      </button>
                    </div>
                    {googleCalendarsError ? (
                      <p className="text-sm text-red-600 dark:text-red-400">
                        {googleCalendarsError}
                      </p>
                    ) : null}
                    {googleCalendars.length > 0 ? (
                      <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
                        {googleCalendars.map((cal) => (
                          <li
                            key={cal.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                                {cal.summary}
                                {cal.primary
                                  ? ` (${t('integrations.google.primary')})`
                                  : ''}
                              </p>
                              <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                                {cal.timeZone || cal.id}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={googleSelecting}
                              onClick={() => handleSelectGoogleCalendar(cal.id)}
                            >
                              {googleSelecting
                                ? t('integrations.google.selecting')
                                : t('integrations.google.select')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2 pt-1">
                  {googleSelected ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={googlePreviewLoading}
                      onClick={() => {
                        void handlePreviewGoogleEvents();
                      }}
                    >
                      {googlePreviewLoading
                        ? t('integrations.google.previewLoading')
                        : t('integrations.google.previewEvents')}
                    </button>
                  ) : null}
                  {googleSelected ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={googleCalendarsLoading}
                      onClick={() => {
                        setShowCalendarPicker(true);
                        void loadGoogleCalendars();
                      }}
                    >
                      {t('integrations.google.changeCalendar')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setGoogleDisconnectError(null);
                      setGoogleDisconnectOpen(true);
                    }}
                  >
                    {t('integrations.google.disconnect')}
                  </button>
                </div>

                {googleSelected ? (
                  <div className="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      {t('integrations.google.previewBanner')}
                    </p>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {t('integrations.google.previewParseNote')}
                    </p>
                    {googlePreviewError ? (
                      <p className="text-sm text-red-600 dark:text-red-400">
                        {googlePreviewError}
                      </p>
                    ) : null}
                    {googlePreviewTruncated ? (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t('integrations.google.previewTruncated')}
                      </p>
                    ) : null}
                    {googlePreviewLoaded && googlePreviewEvents.length === 0 ? (
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('integrations.google.previewEmpty')}
                      </p>
                    ) : null}
                    {googlePreviewEvents.length > 0 ? (
                      <div className="max-h-[32rem] space-y-3 overflow-auto pr-1">
                        {googlePreviewEvents.map((ev) => {
                          const parsed = ev.parsed;
                          const minutesLabel = (n: number) =>
                            t('integrations.google.parsedMinutes').replace('{n}', String(n));
                          return (
                            <article
                              key={ev.id}
                              className="rounded-md border border-gray-200 p-3 dark:border-gray-700"
                            >
                              <div className="space-y-1">
                                <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                  {t('integrations.google.parsedOriginal')}
                                </p>
                                <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
                                  {ev.summary || '—'}
                                </h3>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                  {t('integrations.google.parsedGoogleTime')}:{' '}
                                  {formatEventInstant(ev.start)}
                                  {' → '}
                                  {formatEventInstant(ev.end)}
                                  {ev.start.allDay
                                    ? ` · ${t('integrations.google.previewAllDay')}`
                                    : ''}
                                  {ev.status ? ` · ${ev.status}` : ''}
                                  {' · '}
                                  {formatEventDuration(
                                    ev.start,
                                    ev.end,
                                    t('integrations.google.previewAllDay'),
                                  )}
                                </p>
                              </div>

                              <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
                                <div className="mb-2 flex flex-wrap items-center gap-2">
                                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                    {t('integrations.google.parsedSection')}
                                  </p>
                                  <span
                                    className={`text-xs font-semibold ${importabilityClass(parsed?.importability)}`}
                                  >
                                    {t('integrations.google.parsedImportability')}:{' '}
                                    {importabilityLabel(t, parsed?.importability)}
                                  </span>
                                </div>
                                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  <ParsedField
                                    label={t('integrations.google.parsedLocalDate')}
                                    value={parsed?.localDate || '—'}
                                  />
                                  <ParsedField
                                    label={t('integrations.google.parsedLocalTime')}
                                    value={formatParsedLocalTime(parsed)}
                                  />
                                  <ParsedField
                                    label={t('integrations.google.parsedDuration')}
                                    value={formatParsedDuration(parsed, minutesLabel)}
                                  />
                                  <ParsedField
                                    label={t('integrations.google.parsedClient')}
                                    value={parsed?.clientNameCandidate || '—'}
                                  />
                                  <ParsedField
                                    label={t('integrations.google.parsedPhone')}
                                    value={formatParsedPhone(parsed)}
                                  />
                                  <ParsedField
                                    label={t('integrations.google.parsedService')}
                                    value={parsed?.serviceCandidate || '—'}
                                  />
                                  <ParsedField
                                    label={t('integrations.google.parsedPrice')}
                                    value={formatParsedPrice(parsed)}
                                  />
                                  <ParsedField
                                    label={t('integrations.google.parsedStaff')}
                                    value={t('integrations.google.parsedStaffUnset')}
                                  />
                                </dl>
                                {(() => {
                                  const reasonLabels = parsedReasonLabels(t, parsed);
                                  if (reasonLabels.length === 0) return null;
                                  return (
                                    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-gray-500 dark:text-gray-400">
                                      {reasonLabels.map((label) => (
                                        <li key={label}>{label}</li>
                                      ))}
                                    </ul>
                                  );
                                })()}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Apple Calendar — kept for future / secondary */}
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
              {!appleStored ? (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {t('integrations.apple.status.notConnected')}
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                    {t('integrations.apple.status.credentialsStored')}
                  </span>
                  {appleVerificationPending ? (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                      {t('integrations.apple.status.verificationPending')}
                    </span>
                  ) : null}
                </>
              )}
              {appleShowError ? (
                <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/60 dark:text-red-300">
                  {t('integrations.apple.status.error')}
                </span>
              ) : null}
            </div>

            {appleStored ? (
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
                      {appleConnection?.accountEmail || t('integrations.apple.valueUnknown')}
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
              <form onSubmit={handleConnectApple} className="space-y-4" autoComplete="off">
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
              onClick={handleDisconnectApple}
            >
              {disconnectSubmitting
                ? t('integrations.apple.disconnecting')
                : t('integrations.apple.disconnectConfirmButton')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={googleDisconnectOpen}
        onClose={() => {
          if (googleDisconnectSubmitting) return;
          setGoogleDisconnectOpen(false);
        }}
        title={t('integrations.google.disconnectTitle')}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('integrations.google.disconnectConfirm')}
          </p>
          {googleDisconnectError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{googleDisconnectError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={googleDisconnectSubmitting}
              onClick={() => setGoogleDisconnectOpen(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={googleDisconnectSubmitting}
              onClick={handleDisconnectGoogle}
            >
              {googleDisconnectSubmitting
                ? t('integrations.google.disconnecting')
                : t('integrations.google.disconnectConfirmButton')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
