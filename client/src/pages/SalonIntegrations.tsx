import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import Modal from '@/components/ui/Modal';
import { useLanguage } from '@/context/LanguageContext';
import { api, ApiError } from '@/lib/api';
import type {
  CalendarConnectionPublic,
  CalendarEventMatchingPreview,
  CalendarEventParsedPreview,
  CalendarMatchingStatus,
  CalendarParseImportability,
  GoogleCalendarListItem,
  GoogleBackfillLast30DaysResult,
  GoogleBackfillProgress,
  GoogleEventPreviewItem,
  GoogleEventTimePreview,
  GoogleImportStaffOption,
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

function matchingStatusLabel(
  t: (key: import('@/context/LanguageContext').TranslationKey) => string,
  value: CalendarMatchingStatus | undefined,
): string {
  if (value === 'matched') return t('integrations.google.matchingStatusMatched');
  if (value === 'partial') return t('integrations.google.matchingStatusPartial');
  return t('integrations.google.matchingStatusReview');
}

function matchingStatusClass(value: CalendarMatchingStatus | undefined): string {
  if (value === 'matched') return 'text-emerald-800 dark:text-emerald-200';
  if (value === 'partial') return 'text-amber-800 dark:text-amber-200';
  return 'text-amber-800 dark:text-amber-200';
}

function clientMatchDetail(
  t: (key: import('@/context/LanguageContext').TranslationKey) => string,
  matching: CalendarEventMatchingPreview | undefined,
): { title: string; detail: string } {
  const client = matching?.client;
  if (!client || client.status === 'not_attempted') {
    return {
      title: t('integrations.google.matchingDash'),
      detail: t('integrations.google.matchingClientNotAttempted'),
    };
  }
  if (client.status === 'ambiguous') {
    return {
      title: t('integrations.google.matchingDash'),
      detail: t('integrations.google.matchingClientAmbiguous'),
    };
  }
  if (client.status === 'not_found') {
    return {
      title: t('integrations.google.matchingDash'),
      detail: t('integrations.google.matchingClientNotFound'),
    };
  }
  if (client.status === 'matched' && client.confidence === 'exact_phone') {
    return {
      title: `✓ ${client.displayName || t('integrations.google.matchingDash')}`,
      detail: t('integrations.google.matchingClientExactPhone').replace(
        '{phone}',
        client.matchedPhone || '',
      ),
    };
  }
  if (client.status === 'matched') {
    return {
      title: `✓ ${client.displayName || t('integrations.google.matchingDash')}`,
      detail: t('integrations.google.matchingClientExactName'),
    };
  }
  return {
    title: t('integrations.google.matchingDash'),
    detail: t('integrations.google.matchingClientNotFound'),
  };
}

function serviceMatchDetail(
  t: (key: import('@/context/LanguageContext').TranslationKey) => string,
  matching: CalendarEventMatchingPreview | undefined,
): { title: string; detail: string } {
  const service = matching?.service;
  if (!service || service.status === 'not_attempted') {
    return {
      title: t('integrations.google.matchingDash'),
      detail: t('integrations.google.matchingServiceNotAttempted'),
    };
  }
  if (service.status === 'ambiguous') {
    return {
      title: t('integrations.google.matchingDash'),
      detail: t('integrations.google.matchingServiceAmbiguous'),
    };
  }
  if (service.status === 'not_found') {
    return {
      title: t('integrations.google.matchingDash'),
      detail: t('integrations.google.matchingServiceNotFound'),
    };
  }
  if (service.status === 'matched' && service.confidence === 'exact_name') {
    return {
      title: `✓ ${service.displayName || t('integrations.google.matchingDash')}`,
      detail: t('integrations.google.matchingServiceExact'),
    };
  }
  if (service.status === 'matched') {
    return {
      title: `✓ ${service.displayName || t('integrations.google.matchingDash')}`,
      detail: t('integrations.google.matchingServiceContained'),
    };
  }
  return {
    title: t('integrations.google.matchingDash'),
    detail: t('integrations.google.matchingServiceNotFound'),
  };
}

function autoImportReasonLabel(
  t: (key: import('@/context/LanguageContext').TranslationKey) => string,
  reason: string | null | undefined,
): string {
  switch (reason) {
    case 'already_imported':
      return t('integrations.google.autoSkipAlready');
    case 'before_auto_import':
    case 'created_unknown':
      return t('integrations.google.autoSkipBeforeEnable');
    case 'cancelled':
      return t('integrations.google.autoSkipCancelled');
    case 'all_day':
      return t('integrations.google.autoSkipAllDay');
    case 'invalid_time':
    case 'overnight':
      return t('integrations.google.autoSkipTime');
    case 'service_not_matched':
    case 'service_inactive_or_invalid':
    case 'service_invalid':
    case 'service_review_required':
      return t('integrations.google.autoSkipService');
    case 'client_ambiguous':
      return t('integrations.google.autoSkipClientAmbiguous');
    case 'no_exact_phone':
      return t('integrations.google.autoSkipPhone');
    case 'unsafe_client_name':
    case 'client_review_required':
      return t('integrations.google.autoSkipClient');
    case 'appointment_conflict':
      return t('integrations.google.autoSkipConflict');
    case 'staff_unresolved':
    case 'staff_invalid':
      return t('integrations.google.autoSkipStaff');
    default:
      return t('integrations.google.autoSkipOther');
  }
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

function GoogleEventImportPanel({
  event,
  staffOptions,
  onImported,
}: {
  event: GoogleEventPreviewItem;
  staffOptions: GoogleImportStaffOption[];
  onImported: (eventId: string) => void;
}) {
  const { t } = useLanguage();
  const readiness = event.importReadiness;
  const matching = event.matching;
  const parsed = event.parsed;

  const [staffId, setStaffId] = useState('');
  const [newClientName, setNewClientName] = useState(
    readiness?.suggestedNewClientName || '',
  );
  const [localImported, setLocalImported] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const isExistingClient =
    matching?.client.status === 'matched' && Boolean(matching.client.clientId);
  const canNewClient = Boolean(readiness?.canCreateNewClient);
  const serviceMatched =
    matching?.service.status === 'matched' && Boolean(matching.service.serviceId);
  const alreadyImported =
    readiness?.status === 'already_imported' || localImported;
  const notImportable = readiness?.status === 'not_importable';

  const clientMode: 'existing' | 'new' | null = isExistingClient
    ? 'existing'
    : canNewClient
      ? 'new'
      : null;

  const nameOk =
    clientMode === 'existing' ||
    (clientMode === 'new' && newClientName.trim().length > 0);
  const canSubmit =
    !alreadyImported &&
    !notImportable &&
    serviceMatched &&
    clientMode != null &&
    nameOk &&
    Boolean(staffId) &&
    !submitting;

  // Potentially importable = not hard-blocked (show controls).
  const showControls =
    !notImportable &&
    readiness?.status !== undefined &&
    (serviceMatched ||
      matching?.service.status === 'ambiguous' ||
      matching?.service.status === 'not_found' ||
      canNewClient ||
      isExistingClient);

  if (alreadyImported) {
    return (
      <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('integrations.google.importSection')}
        </p>
        <p className="mt-1 text-sm font-medium text-emerald-700 dark:text-emerald-300">
          {t('integrations.google.importAlready')}
        </p>
      </div>
    );
  }

  if (!showControls || !serviceMatched || clientMode == null) {
    return (
      <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('integrations.google.importSection')}
        </p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('integrations.google.importNotReady')}
        </p>
      </div>
    );
  }

  const phoneDisplay =
    parsed?.phone.confidence === 'exact' && parsed.phone.normalized
      ? parsed.phone.normalized
      : '—';
  const dateDisplay = parsed?.localDate || '—';
  const timeDisplay = formatParsedLocalTime(parsed);
  const durationDisplay =
    parsed?.durationMinutes != null
      ? t('integrations.google.parsedMinutes').replace('{n}', String(parsed.durationMinutes))
      : '—';
  const serviceName = matching?.service.displayName || '—';
  const clientLabel = isExistingClient
    ? matching?.client.displayName || t('integrations.google.importExistingClient')
    : t('integrations.google.importNewClient');
  const staffName = staffOptions.find((s) => s.id === staffId)?.name || '—';

  const handleConfirmImport = async () => {
    if (!canSubmit || !matching?.service.serviceId) return;
    setSubmitting(true);
    setImportError(null);
    try {
      await api.calendar.importGoogleEvent({
        eventId: event.id,
        recurrenceId: readiness?.recurrenceId || undefined,
        staffId,
        serviceId: matching.service.serviceId,
        client:
          clientMode === 'existing'
            ? { mode: 'existing', clientId: matching.client.clientId || undefined }
            : {
                mode: 'new',
                name: newClientName.trim(),
                phone: parsed?.phone.normalized || undefined,
              },
        expectedEtag: event.etag || undefined,
        expectedUpdated: event.updated || undefined,
      });
      setLocalImported(true);
      setConfirmOpen(false);
      onImported(event.id);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'google_event_already_imported') {
        setLocalImported(true);
        setConfirmOpen(false);
        onImported(event.id);
      } else {
        const message =
          err instanceof Error ? err.message : t('integrations.google.importError');
        setImportError(message || t('integrations.google.importError'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('integrations.google.importSection')}
      </p>
      {localImported ? (
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
          {t('integrations.google.importSuccess')}
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('integrations.google.importClient')}
            </p>
            <p className="text-sm text-gray-900 dark:text-gray-100">{clientLabel}</p>
          </div>
          {clientMode === 'new' ? (
            <>
              <label className="block">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {t('integrations.google.importName')}
                </span>
                <input
                  type="text"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                />
              </label>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('integrations.google.importPhone')}
                </p>
                <p className="text-sm text-gray-900 dark:text-gray-100">{phoneDisplay}</p>
              </div>
            </>
          ) : null}
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('integrations.google.importService')}
            </p>
            <p className="text-sm text-gray-900 dark:text-gray-100">{serviceName}</p>
          </div>
          <label className="block">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('integrations.google.importStaff')}
            </span>
            <select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
            >
              <option value="">{t('integrations.google.importStaffPlaceholder')}</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <ParsedField label={t('integrations.google.importDate')} value={dateDisplay} />
            <ParsedField label={t('integrations.google.importTime')} value={timeDisplay} />
            <ParsedField
              label={t('integrations.google.importDuration')}
              value={durationDisplay}
            />
          </dl>
          <p className="text-xs text-amber-800 dark:text-amber-200">
            {clientMode === 'new'
              ? t('integrations.google.importWarning')
              : t('integrations.google.importWarningExisting')}
          </p>
          {importError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{importError}</p>
          ) : null}
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => setConfirmOpen(true)}
            className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('integrations.google.importButton')}
          </button>
        </div>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!submitting) setConfirmOpen(false);
        }}
        title={t('integrations.google.importConfirmTitle')}
      >
        <div className="space-y-2 text-sm text-gray-800 dark:text-gray-200">
          {clientMode === 'new' ? (
            <>
              <p>{t('integrations.google.importNewClient')}:</p>
              <p className="font-medium">
                {newClientName.trim()}
                <br />
                {phoneDisplay}
              </p>
            </>
          ) : (
            <p>
              {t('integrations.google.importClient')}:{' '}
              <span className="font-medium">{clientLabel}</span>
            </p>
          )}
          <p>
            {t('integrations.google.importService')}:{' '}
            <span className="font-medium">{serviceName}</span>
          </p>
          <p>
            {t('integrations.google.importStaff')}:{' '}
            <span className="font-medium">{staffName}</span>
          </p>
          <p>
            {t('integrations.google.importDate')}/{t('integrations.google.importTime')}:{' '}
            <span className="font-medium">
              {dateDisplay}, {timeDisplay}
            </span>
          </p>
          {importError ? (
            <p className="text-red-600 dark:text-red-400">{importError}</p>
          ) : null}
          <div className="flex justify-end gap-2 pt-3">
            <button
              type="button"
              className="btn-secondary"
              disabled={submitting}
              onClick={() => setConfirmOpen(false)}
            >
              {t('integrations.google.importConfirmCancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={submitting || !canSubmit}
              onClick={() => void handleConfirmImport()}
            >
              {submitting
                ? t('integrations.google.importing')
                : t('integrations.google.importConfirmSubmit')}
            </button>
          </div>
        </div>
      </Modal>
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
  const [googleStaffOptions, setGoogleStaffOptions] = useState<GoogleImportStaffOption[]>([]);
  const [googleAutoImportToggling, setGoogleAutoImportToggling] = useState(false);
  const [googleAutoImportError, setGoogleAutoImportError] = useState<string | null>(null);
  const [googleBackfillConfirmOpen, setGoogleBackfillConfirmOpen] = useState(false);
  const [googleBackfillRunning, setGoogleBackfillRunning] = useState(false);
  const [googleBackfillError, setGoogleBackfillError] = useState<string | null>(null);
  const [googleBackfillResult, setGoogleBackfillResult] =
    useState<GoogleBackfillLast30DaysResult | null>(null);
  const [googleBackfillProgress, setGoogleBackfillProgress] =
    useState<GoogleBackfillProgress | null>(null);

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
      setGoogleStaffOptions([]);
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
      setGoogleStaffOptions(data.staffOptions ?? []);
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

  const handleToggleGoogleAutoImport = async (enabled: boolean) => {
    if (googleAutoImportToggling) return;
    setGoogleAutoImportToggling(true);
    setGoogleAutoImportError(null);
    try {
      const result = await api.calendar.setGoogleImportEnabled(enabled);
      if (result.connection) {
        setGoogleConnection(result.connection);
      } else {
        setGoogleConnection((prev) =>
          prev ? { ...prev, importEnabled: result.importEnabled } : prev,
        );
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('integrations.google.autoImportError');
      setGoogleAutoImportError(message || t('integrations.google.autoImportError'));
    } finally {
      setGoogleAutoImportToggling(false);
    }
  };

  const applyGoogleBackfillProgress = (next: GoogleBackfillProgress) => {
    setGoogleBackfillProgress((prev) => {
      if (!prev || next.status === 'done' || next.status === 'error' || next.status === 'idle') {
        return next;
      }
      return {
        ...next,
        processed: Math.max(prev.processed, next.processed),
        percent: Math.max(prev.percent, next.percent),
      };
    });
    if (next.status === 'done' && next.result) {
      setGoogleBackfillResult(next.result);
    }
  };

  const handleImportGoogleLast30Days = async () => {
    if (googleBackfillRunning) return;
    setGoogleBackfillRunning(true);
    setGoogleBackfillError(null);
    setGoogleBackfillProgress({
      processed: 0,
      total: null,
      percent: 0,
      status: 'listing',
    });

    const waitUntilSettled = async () => {
      for (;;) {
        const next = await api.calendar.getGoogleBackfillProgress();
        if (next.status !== 'idle') applyGoogleBackfillProgress(next);
        if (next.status === 'done') {
          if (next.result) setGoogleBackfillResult(next.result);
          return;
        }
        if (next.status === 'error') {
          throw new Error(t('integrations.google.backfillError'));
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    };

    const poll = window.setInterval(() => {
      void api.calendar
        .getGoogleBackfillProgress()
        .then((next) => {
          if (next.status !== 'idle') applyGoogleBackfillProgress(next);
        })
        .catch(() => undefined);
    }, 400);
    try {
      const started = await api.calendar.importGoogleLast30Days();
      if (started && 'scanned' in started && typeof started.scanned === 'number') {
        setGoogleBackfillResult(started);
        setGoogleBackfillProgress({
          processed: started.scanned,
          total: started.scanned,
          percent: 100,
          status: 'done',
        });
        return;
      }
      await waitUntilSettled();
    } catch (err: unknown) {
      const alreadyRunning =
        err instanceof ApiError && err.code === 'google_backfill_already_running';
      if (alreadyRunning) {
        try {
          await waitUntilSettled();
          return;
        } catch (attachErr: unknown) {
          const message =
            attachErr instanceof Error ? attachErr.message : t('integrations.google.backfillError');
          setGoogleBackfillError(message || t('integrations.google.backfillError'));
          return;
        }
      }
      try {
        const live = await api.calendar.getGoogleBackfillProgress();
        if (live.status === 'listing' || live.status === 'processing') {
          applyGoogleBackfillProgress(live);
          await waitUntilSettled();
          return;
        }
      } catch {
        // Fall through to the original POST error.
      }
      const message =
        err instanceof Error ? err.message : t('integrations.google.backfillError');
      setGoogleBackfillError(message || t('integrations.google.backfillError'));
    } finally {
      window.clearInterval(poll);
      setGoogleBackfillRunning(false);
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

                {googleSelected ? (
                  <div className="space-y-2 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/40">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {t('integrations.google.autoImportTitle')}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t('integrations.google.autoImportHelp')}
                    </p>
                    <p className="text-xs text-amber-800 dark:text-amber-200">
                      {t('integrations.google.autoImportPilotNote')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={
                          googleConnection?.importEnabled ? 'btn-secondary' : 'btn-primary'
                        }
                        disabled={googleAutoImportToggling || googleConnection?.importEnabled}
                        onClick={() => void handleToggleGoogleAutoImport(true)}
                      >
                        {googleAutoImportToggling && !googleConnection?.importEnabled
                          ? t('integrations.google.autoImportSaving')
                          : t('integrations.google.autoImportEnable')}
                      </button>
                      <button
                        type="button"
                        className={
                          googleConnection?.importEnabled ? 'btn-primary' : 'btn-secondary'
                        }
                        disabled={googleAutoImportToggling || !googleConnection?.importEnabled}
                        onClick={() => void handleToggleGoogleAutoImport(false)}
                      >
                        {googleAutoImportToggling && googleConnection?.importEnabled
                          ? t('integrations.google.autoImportSaving')
                          : t('integrations.google.autoImportDisable')}
                      </button>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      {googleConnection?.importEnabled
                        ? t('integrations.google.autoImportOn')
                        : t('integrations.google.autoImportOff')}
                    </p>
                    {googleAutoImportError ? (
                      <p className="text-sm text-red-600 dark:text-red-400">
                        {googleAutoImportError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {googleSelected ? (
                  <div className="space-y-2 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/40">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {t('integrations.google.backfillTitle')}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t('integrations.google.backfillHelp')}
                    </p>
                    <p className="text-xs text-amber-800 dark:text-amber-200">
                      {t('integrations.google.backfillPilotNote')}
                    </p>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={googleBackfillRunning}
                      onClick={() => {
                        setGoogleBackfillError(null);
                        setGoogleBackfillProgress(null);
                        setGoogleBackfillConfirmOpen(true);
                      }}
                    >
                      {googleBackfillRunning
                        ? t('integrations.google.backfillRunning')
                        : t('integrations.google.backfillButton')}
                    </button>
                    {googleBackfillResult ? (
                      <div className="space-y-1 text-sm text-gray-800 dark:text-gray-200">
                        <p className="font-medium">{t('integrations.google.backfillDone')}</p>
                        <p>
                          {t('integrations.google.backfillScanned')}: {googleBackfillResult.scanned}
                        </p>
                        <p>
                          {t('integrations.google.backfillNewEvents')}:{' '}
                          {googleBackfillResult.newEvents ?? googleBackfillResult.imported}
                        </p>
                        <p>
                          {t('integrations.google.backfillUpdatedEvents')}:{' '}
                          {googleBackfillResult.updatedEvents ?? 0}
                        </p>
                        <p>
                          {t('integrations.google.backfillUnchangedEvents')}:{' '}
                          {googleBackfillResult.unchangedEvents ??
                            googleBackfillResult.alreadyImported}
                        </p>
                        <p>
                          {t('integrations.google.backfillFailed')}: {googleBackfillResult.failed}
                        </p>
                        {googleBackfillResult.truncated ? (
                          <p className="text-amber-800 dark:text-amber-200">
                            {t('integrations.google.backfillTruncated')}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {googleBackfillError ? (
                      <p className="text-sm text-red-600 dark:text-red-400">
                        {googleBackfillError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

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
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {t('integrations.google.previewMatchNote')}
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

                              <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
                                {(() => {
                                  const matching = ev.matching;
                                  const status =
                                    matching?.matchingStatus ?? ev.matchingStatus;
                                  const clientInfo = clientMatchDetail(t, matching);
                                  const serviceInfo = serviceMatchDetail(t, matching);
                                  return (
                                    <>
                                      <div className="mb-2 flex flex-wrap items-center gap-2">
                                        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                          {t('integrations.google.matchingSection')}
                                        </p>
                                        <span
                                          className={`text-xs font-semibold ${matchingStatusClass(status)}`}
                                        >
                                          {t('integrations.google.matchingStatusLabel')}:{' '}
                                          {matchingStatusLabel(t, status)}
                                        </span>
                                      </div>
                                      <div className="space-y-2 text-sm text-gray-800 dark:text-gray-200">
                                        <div>
                                          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                            {t('integrations.google.matchingClient')}
                                          </p>
                                          <p>{clientInfo.title}</p>
                                          <p className="text-xs text-gray-500 dark:text-gray-400">
                                            {clientInfo.detail}
                                          </p>
                                        </div>
                                        <div>
                                          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                            {t('integrations.google.matchingService')}
                                          </p>
                                          <p>{serviceInfo.title}</p>
                                          <p className="text-xs text-gray-500 dark:text-gray-400">
                                            {serviceInfo.detail}
                                          </p>
                                        </div>
                                        {matching?.serviceResidualText ? (
                                          <div>
                                            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                              {t('integrations.google.matchingResidual')}
                                            </p>
                                            <p>{matching.serviceResidualText}</p>
                                          </div>
                                        ) : null}
                                        <div>
                                          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                            {t('integrations.google.matchingStaff')}
                                          </p>
                                          <p>{t('integrations.google.matchingStaffUnset')}</p>
                                        </div>
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>

                              <GoogleEventImportPanel
                                event={ev}
                                staffOptions={googleStaffOptions}
                                onImported={(eventId) => {
                                  setGooglePreviewEvents((prev) =>
                                    prev.map((item) =>
                                      item.id === eventId
                                        ? {
                                            ...item,
                                            importReadiness: item.importReadiness
                                              ? {
                                                  ...item.importReadiness,
                                                  status: 'already_imported',
                                                  reasons: ['already_imported'],
                                                }
                                              : item.importReadiness,
                                            autoImport: {
                                              status: 'already_imported',
                                              reason: 'already_imported',
                                            },
                                          }
                                        : item,
                                    ),
                                  );
                                }}
                              />
                              {ev.autoImport ? (
                                <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                                  <span className="font-medium">
                                    {t('integrations.google.autoImportStatus')}:{' '}
                                  </span>
                                  {ev.autoImport.status === 'would_import'
                                    ? t('integrations.google.autoWouldImport')
                                    : ev.autoImport.status === 'already_imported'
                                      ? t('integrations.google.autoSkipAlready')
                                      : autoImportReasonLabel(t, ev.autoImport.reason)}
                                </div>
                              ) : null}
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
        open={googleBackfillConfirmOpen}
        onClose={() => {
          if (googleBackfillRunning) return;
          setGoogleBackfillConfirmOpen(false);
        }}
        title={t('integrations.google.backfillConfirmTitle')}
        size="sm"
      >
        <div className="space-y-3 text-sm text-gray-800 dark:text-gray-200">
          {googleBackfillRunning || googleBackfillProgress?.status === 'done' ? (
            <div className="space-y-3">
              {googleBackfillProgress?.status === 'listing' &&
              (googleBackfillProgress.processed ?? 0) === 0 ? (
                <p className="font-medium">{t('integrations.google.backfillProgressListing')}</p>
              ) : (
                <p className="font-medium">
                  {googleBackfillProgress?.total != null
                    ? t('integrations.google.backfillProgressCount')
                        .replace('{processed}', String(googleBackfillProgress.processed))
                        .replace('{total}', String(googleBackfillProgress.total))
                    : t('integrations.google.backfillProgressProcessed').replace(
                        '{processed}',
                        String(googleBackfillProgress?.processed ?? 0),
                      )}
                </p>
              )}
              {googleBackfillProgress?.status !== 'done' ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t('integrations.google.backfillProgressContinue')}
                </p>
              ) : null}
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={googleBackfillProgress?.percent ?? 0}
              >
                <div
                  className="h-full rounded-full bg-brand-600 transition-[width] duration-200"
                  style={{ width: `${googleBackfillProgress?.percent ?? 0}%` }}
                />
              </div>
              {googleBackfillProgress?.total != null ||
              googleBackfillProgress?.status === 'done' ? (
                <p className="tabular-nums text-sm text-gray-600 dark:text-gray-300">
                  {googleBackfillProgress?.percent ?? 0}%
                </p>
              ) : null}
              {googleBackfillResult && googleBackfillProgress?.status === 'done' ? (
                <div className="space-y-1">
                  <p className="font-medium">{t('integrations.google.backfillDone')}</p>
                  <p>
                    {t('integrations.google.backfillScanned')}: {googleBackfillResult.scanned}
                  </p>
                  <p>
                    {t('integrations.google.backfillNewEvents')}:{' '}
                    {googleBackfillResult.newEvents ?? googleBackfillResult.imported}
                  </p>
                  <p>
                    {t('integrations.google.backfillUpdatedEvents')}:{' '}
                    {googleBackfillResult.updatedEvents ?? 0}
                  </p>
                  <p>
                    {t('integrations.google.backfillUnchangedEvents')}:{' '}
                    {googleBackfillResult.unchangedEvents ??
                      googleBackfillResult.alreadyImported}
                  </p>
                  <p>
                    {t('integrations.google.backfillFailed')}: {googleBackfillResult.failed}
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <p>{t('integrations.google.backfillConfirmGoogleUnchanged')}</p>
              <p>{t('integrations.google.backfillConfirmSkipImported')}</p>
              <p>{t('integrations.google.backfillConfirmSkipUnsafe')}</p>
              <p>{t('integrations.google.backfillConfirmTatev')}</p>
            </>
          )}
          {googleBackfillError ? (
            <p className="text-red-600 dark:text-red-400">{googleBackfillError}</p>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={googleBackfillRunning}
              onClick={() => setGoogleBackfillConfirmOpen(false)}
            >
              {t('integrations.google.importConfirmCancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={googleBackfillRunning}
              onClick={() => void handleImportGoogleLast30Days()}
            >
              {googleBackfillRunning
                ? t('integrations.google.backfillRunning')
                : t('integrations.google.importConfirmSubmit')}
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
