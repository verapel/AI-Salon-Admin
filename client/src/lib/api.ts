const API_BASE = '/api';

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
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
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
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
    delete: (id: string) => request<import('@/types').Staff>(`/staff/${id}`, { method: 'DELETE' }),
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
    getTelegramIntegrations: () =>
      request<import('@/types').DeveloperTelegramIntegration[]>('/developer/integrations/telegram'),
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
