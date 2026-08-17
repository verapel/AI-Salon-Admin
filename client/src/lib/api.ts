const API_BASE = '/api';

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(options?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: 'Request failed' }))) as Record<
      string,
      unknown
    >;
    const message =
      (typeof body.error === 'string' && body.error) ||
      (typeof body.message === 'string' && body.message) ||
      'Request failed';
    const code = typeof body.code === 'string' ? body.code : undefined;
    throw new ApiError(message, res.status, code, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  auth: {
    getMe: () =>
      request<{
        userId: string;
        email: string;
        isDeveloper: boolean;
        platformRole: 'developer' | null;
        salonId: string | null;
        role: 'owner' | 'admin' | 'staff_readonly' | null;
        staffId: string | null;
      }>('/auth/me'),
  },
  clients: {
    getAll: () => request<import('@/types').Client[]>('/clients'),
    get: (id: string) => request<import('@/types').Client>(`/clients/${id}`),
    create: (data: Partial<import('@/types').Client>) =>
      request<import('@/types').Client>('/clients', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<import('@/types').Client>) =>
      request<import('@/types').Client>(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    block: (id: string, blockedReason?: string) =>
      request<import('@/types').Client>(`/clients/${id}/block`, {
        method: 'POST',
        body: JSON.stringify(blockedReason ? { blockedReason } : {}),
      }),
    unblock: (id: string) =>
      request<import('@/types').Client>(`/clients/${id}/unblock`, { method: 'POST' }),
    delete: (id: string) => request<void>(`/clients/${id}`, { method: 'DELETE' }),
  },
  services: {
    getAll: () => request<import('@/types').Service[]>('/services'),
    create: (data: Partial<import('@/types').Service>) =>
      request<import('@/types').Service>('/services', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<import('@/types').Service>) =>
      request<import('@/types').Service>(`/services/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<import('@/types').Service>(`/services/${id}`, { method: 'DELETE' }),
  },
  products: {
    getAll: () => request<import('@/types').Product[]>('/products'),
    create: (data: Partial<import('@/types').Product>) =>
      request<import('@/types').Product>('/products', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<import('@/types').Product>) =>
      request<import('@/types').Product>(`/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    adjustQuantity: (id: string, delta: number) =>
      request<import('@/types').Product>(`/products/${id}/quantity`, {
        method: 'POST',
        body: JSON.stringify({ delta }),
      }),
    delete: (id: string) =>
      request<void>(`/products/${id}`, { method: 'DELETE' }),
  },
  staff: {
    getAll: () => request<import('@/types').Staff[]>('/staff'),
    create: (data: Partial<import('@/types').Staff>) =>
      request<import('@/types').Staff>('/staff', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<import('@/types').Staff>) =>
      request<import('@/types').Staff>(`/staff/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateServices: (id: string, serviceIds: string[]) =>
      request<{ staffId: string; serviceIds: string[] }>(`/staff/${id}/services`, {
        method: 'PUT',
        body: JSON.stringify({ serviceIds }),
      }),
    /** Soft-deactivate (active=false). */
    delete: (id: string) => request<import('@/types').Staff>(`/staff/${id}`, { method: 'DELETE' }),
    getDeletePreview: (id: string) =>
      request<import('@/types').StaffDeletePreview>(`/staff/${id}/delete-preview`),
    permanentDelete: (
      id: string,
      body: import('@/types').StaffPermanentDeleteRequest
    ) =>
      request<import('@/types').StaffPermanentDeleteResult>(`/staff/${id}/permanent`, {
        method: 'DELETE',
        body: JSON.stringify(body),
      }),
  },
  staffAccess: {
    list: () =>
      request<{ items: import('@/types').StaffAccessDto[] }>('/staff/access'),
    invite: (staffId: string, email: string) =>
      request<import('@/types').StaffAccessInviteResponse>(`/staff/${staffId}/access/invite`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    resend: (staffId: string) =>
      request<import('@/types').StaffAccessResendResponse>(`/staff/${staffId}/access/resend`, {
        method: 'POST',
      }),
    setActive: (staffId: string, active: boolean) =>
      request<import('@/types').StaffAccessPatchResponse>(`/staff/${staffId}/access`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      }),
  },
  appointments: {
    getAll: (params?: Record<string, string>) => {
      const query = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<import('@/types').Appointment[]>(`/appointments${query}`);
    },
    create: (data: Partial<import('@/types').Appointment>) =>
      request<import('@/types').Appointment>('/appointments', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<import('@/types').Appointment>) =>
      request<import('@/types').Appointment>(`/appointments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<import('@/types').Appointment>(`/appointments/${id}`, { method: 'DELETE' }),
  },
  stats: {
    getDashboard: () => request<import('@/types').DashboardStats>('/stats/dashboard'),
    getAnalytics: () => request<import('@/types').AnalyticsData>('/stats/analytics'),
    getReminders: () => request<import('@/types').Reminder[]>('/stats/reminders'),
  },
  schedule: {
    getWeekly: () =>
      request<import('@/types').ScheduleWeeklyResponse>('/schedule/weekly'),
    putSalonWeekly: (hours: import('@/types').WeeklyHoursInput[]) =>
      request<import('@/types').WeeklyHoursRow[]>('/schedule/salon-weekly', {
        method: 'PUT',
        body: JSON.stringify({ hours }),
      }),
    putStaffWeekly: (staffId: string, hours: import('@/types').WeeklyHoursInput[]) =>
      request<import('@/types').WeeklyHoursRow[]>(`/schedule/staff/${staffId}/weekly`, {
        method: 'PUT',
        body: JSON.stringify({ hours }),
      }),
    getExceptions: (params?: { staffId?: string; from?: string; to?: string }) => {
      const query = params
        ? '?' +
          new URLSearchParams(
            Object.entries(params)
              .filter(([, v]) => typeof v === 'string' && v.length > 0)
              .map(([k, v]) => [k, v as string])
          ).toString()
        : '';
      return request<import('@/types').ScheduleException[]>(`/schedule/exceptions${query}`);
    },
    createException: (data: import('@/types').CreateScheduleExceptionInput) =>
      request<import('@/types').ScheduleException>('/schedule/exceptions', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deleteException: (id: string) =>
      request<void>(`/schedule/exceptions/${id}`, { method: 'DELETE' }),
  },
  calendar: {
    getConnections: () =>
      request<import('@/types').CalendarConnectionsResponse>('/calendar/connections'),
    connectApple: (body: import('@/types').AppleCalendarConnectRequest) =>
      request<import('@/types').AppleCalendarConnectResponse>('/calendar/apple/connect', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    disconnectApple: () =>
      request<{ connection: import('@/types').CalendarConnectionPublic | null }>(
        '/calendar/apple',
        { method: 'DELETE' }
      ),
    getGoogleAuthUrl: () =>
      request<{ authorizationUrl: string; expiresInSeconds: number }>(
        '/calendar/google/auth-url',
      ),
    getGoogleCalendars: () =>
      request<{ calendars: import('@/types').GoogleCalendarListItem[] }>(
        '/calendar/google/calendars',
      ),
    selectGoogleCalendar: (calendarId: string) =>
      request<{ connection: import('@/types').CalendarConnectionPublic | null }>(
        '/calendar/google/calendar',
        {
          method: 'PUT',
          body: JSON.stringify({ calendarId }),
        },
      ),
    getGoogleEventsPreview: () =>
      request<import('@/types').GoogleEventsPreviewResponse>(
        '/calendar/google/events/preview',
      ),
    getGoogleReviewEvents: () =>
      request<{ events: import('@/types').GoogleReviewCalendarItem[] }>(
        '/calendar/google/review-events',
      ),
    importGoogleEvent: (body: import('@/types').GoogleEventImportRequest) =>
      request<import('@/types').GoogleEventImportResponse>(
        '/calendar/google/events/import',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),
    importGoogleLast30Days: () =>
      request<import('@/types').GoogleBackfillLast30DaysResult>(
        '/calendar/google/events/import-last-30-days',
        { method: 'POST' },
      ),
    setGoogleImportEnabled: (enabled: boolean) =>
      request<{
        connection: import('@/types').CalendarConnectionPublic | null;
        importEnabled: boolean;
        autoImportStaffName: string | null;
      }>('/calendar/google/import-enabled', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    disconnectGoogle: () =>
      request<{ connection: import('@/types').CalendarConnectionPublic | null }>(
        '/calendar/google',
        { method: 'DELETE' },
      ),
  },
  developer: {
    getSalons: () => request<import('@/types').DeveloperSalon[]>('/developer/salons'),
    createSalon: (body: {
      name: string;
      ownerEmail: string;
      ownerPassword: string;
      ownerName?: string;
    }) =>
      request<import('@/types').CreateSalonResponse>('/developer/salons', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getSalon: (id: string) =>
      request<import('@/types').DeveloperSalonDetail>(`/developer/salons/${id}`),
    updateSalon: (id: string, body: import('@/types').UpdateDeveloperSalonRequest) =>
      request<import('@/types').UpdateDeveloperSalonResponse>(`/developer/salons/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    getSalonSubscription: (salonId: string) =>
      request<import('@/types').DeveloperSalonSubscription>(
        `/developer/salons/${salonId}/subscription`
      ),
    getSalonSubscriptions: () =>
      request<import('@/types').DeveloperSalonSubscriptionListItem[]>(
        '/developer/subscriptions'
      ),
    updateSalonSubscription: (
      salonId: string,
      body: import('@/types').UpdateDeveloperSalonSubscriptionRequest
    ) =>
      request<import('@/types').UpdateDeveloperSalonSubscriptionResponse>(
        `/developer/salons/${salonId}/subscription`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        }
      ),
    getSalonDeletePreview: (salonId: string) =>
      request<import('@/types').SalonDeletePreview>(
        `/developer/salons/${salonId}/delete-preview`
      ),
    deleteSalonPermanent: (salonId: string, body: { confirm: true }) =>
      request<import('@/types').SalonPermanentDeleteResponse>(
        `/developer/salons/${salonId}/permanent`,
        {
          method: 'DELETE',
          body: JSON.stringify(body),
        }
      ),
    getTelegramIntegrations: () =>
      request<import('@/types').DeveloperTelegramIntegration[]>('/developer/integrations/telegram'),
    getWhatsAppIntegrations: () =>
      request<import('@/types').DeveloperWhatsAppIntegration[]>(
        '/developer/integrations/whatsapp'
      ),
    getWhatsAppIntegration: (salonId: string) =>
      request<import('@/types').DeveloperWhatsAppIntegration>(
        `/developer/integrations/whatsapp/${salonId}`
      ),
    connectWhatsApp: (salonId: string, body: import('@/types').WhatsAppConnectRequest) =>
      request<import('@/types').DeveloperWhatsAppIntegration>(
        `/developer/integrations/whatsapp/${salonId}/connect`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      ),
    prepareWhatsApp: (salonId: string) =>
      request<import('@/types').DeveloperWhatsAppIntegration>(
        `/developer/integrations/whatsapp/${salonId}/prepare`,
        { method: 'POST' }
      ),
    disconnectWhatsApp: (salonId: string) =>
      request<import('@/types').DeveloperWhatsAppIntegration>(
        `/developer/integrations/whatsapp/${salonId}/disconnect`,
        { method: 'DELETE' }
      ),
    removeWhatsApp: (salonId: string, opts?: { confirmConnected?: boolean }) =>
      request<
        import('@/types').DeveloperWhatsAppIntegration & {
          removed?: boolean;
          atomic?: boolean;
        }
      >(`/developer/integrations/whatsapp/${salonId}/remove`, {
        method: 'DELETE',
        body: JSON.stringify({
          confirmConnected: opts?.confirmConnected === true,
        }),
      }),
    getInstagramIntegrations: () =>
      request<import('@/types').DeveloperInstagramIntegration[]>(
        '/developer/integrations/instagram'
      ),
    getInstagramIntegration: (salonId: string) =>
      request<import('@/types').DeveloperInstagramIntegration>(
        `/developer/integrations/instagram/${salonId}`
      ),
    prepareInstagram: (salonId: string) =>
      request<import('@/types').DeveloperInstagramIntegration>(
        `/developer/integrations/instagram/${salonId}/prepare`,
        { method: 'POST', body: JSON.stringify({}) }
      ),
    startInstagramConnect: (salonId: string) =>
      request<{ salonId: string; authorizationUrl: string }>(
        `/developer/integrations/instagram/${salonId}/connect/start`,
        { method: 'POST', body: JSON.stringify({}) }
      ),
    disconnectInstagram: (salonId: string) =>
      request<import('@/types').DeveloperInstagramIntegration>(
        `/developer/integrations/instagram/${salonId}/disconnect`,
        { method: 'DELETE' }
      ),
    removeInstagram: (salonId: string, opts?: { confirmConnected?: boolean }) =>
      request<import('@/types').DeveloperInstagramIntegration & { removed?: boolean }>(
        `/developer/integrations/instagram/${salonId}/remove`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            confirmConnected: opts?.confirmConnected === true,
          }),
        }
      ),
    connectTelegram: (body: {
      salonName?: string;
      salonId?: string;
      token: string;
      botDisplayName?: string;
    }) =>
      request<{
        success: boolean;
        salonId: string;
        username: string;
        name: string;
        integration: import('@/types').DeveloperTelegramIntegration;
      }>('/developer/integrations/telegram/connect', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateTelegramIntegration: (
      salonId: string,
      body: { salonName?: string; botDisplayName?: string; adminChatId?: number | null }
    ) =>
      request<{
        success: boolean;
        integration: import('@/types').DeveloperTelegramIntegration;
      }>(`/developer/integrations/telegram/${salonId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    testAdminNotification: (salonId: string) =>
      request<import('@/types').TestAdminNotificationResponse>(
        `/developer/integrations/telegram/${salonId}/test-admin-notification`,
        { method: 'POST' }
      ),
    getTelegramAdminChatCandidate: (salonId: string) =>
      request<import('@/types').TelegramAdminChatCandidateResponse>(
        `/developer/integrations/telegram/${salonId}/admin-chat-candidate`
      ),
    confirmTelegramAdminChatCandidate: (salonId: string, candidateChatId: number) =>
      request<import('@/types').ConfirmTelegramAdminChatCandidateResponse>(
        `/developer/integrations/telegram/${salonId}/admin-chat-candidate/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({ candidateChatId }),
        }
      ),
    getHealth: () => request<import('@/types').DeveloperHealth>('/developer/health'),
  },
  staffPortal: {
    getMe: () => request<import('@/types').StaffPortalMe>('/staff-portal/me'),
    getAppointments: (params?: { from?: string; to?: string; status?: string }) => {
      const q = new URLSearchParams();
      if (params?.from) q.set('from', params.from);
      if (params?.to) q.set('to', params.to);
      if (params?.status) q.set('status', params.status);
      const qs = q.toString();
      return request<import('@/types').StaffPortalAppointment[]>(
        `/staff-portal/appointments${qs ? `?${qs}` : ''}`
      );
    },
    getSchedule: (params?: { from?: string; to?: string }) => {
      const q = new URLSearchParams();
      if (params?.from) q.set('from', params.from);
      if (params?.to) q.set('to', params.to);
      const qs = q.toString();
      return request<import('@/types').StaffPortalSchedule>(
        `/staff-portal/schedule${qs ? `?${qs}` : ''}`
      );
    },
    putWeekly: (hours: import('@/types').WeeklyHoursInput[]) =>
      request<import('@/types').StaffPortalWeeklySaveResponse>('/staff-portal/schedule/weekly', {
        method: 'PUT',
        body: JSON.stringify({ hours }),
      }),
    createException: (data: import('@/types').StaffPortalCreateExceptionInput) =>
      request<import('@/types').StaffPortalExceptionCreateResponse>(
        '/staff-portal/schedule/exceptions',
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      ),
    deleteException: (id: string) =>
      request<{ ok: true }>(`/staff-portal/schedule/exceptions/${id}`, {
        method: 'DELETE',
      }),
  },
};
