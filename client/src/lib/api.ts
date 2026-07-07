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
    delete: (id: string) => request<import('@/types').Staff>(`/staff/${id}`, { method: 'DELETE' }),
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
      body: { salonName?: string; botDisplayName?: string }
    ) =>
      request<{
        success: boolean;
        integration: import('@/types').DeveloperTelegramIntegration;
      }>(`/developer/integrations/telegram/${salonId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    getHealth: () => request<import('@/types').DeveloperHealth>('/developer/health'),
  },
};
