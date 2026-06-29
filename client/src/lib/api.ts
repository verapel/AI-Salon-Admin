const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  clients: {
    getAll: () => request<import('@/types').Client[]>('/clients'),
    get: (id: string) => request<import('@/types').Client>(`/clients/${id}`),
    create: (data: Partial<import('@/types').Client>) =>
      request<import('@/types').Client>('/clients', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<import('@/types').Client>) =>
      request<import('@/types').Client>(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
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
    getTelegramIntegrations: () =>
      request<import('@/types').DeveloperTelegramIntegration[]>('/developer/integrations/telegram'),
  },
};
