export interface Client {
  id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  totalVisits: number;
  lastVisit: string | null;
  createdAt: string;
  isBlocked: boolean;
  blockedAt: string | null;
  blockedReason: string | null;
  birthday: string | null;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  duration: number;
  price: number;
  category: string;
  active: boolean;
}

export interface Staff {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  specialties: string[];
  avatar: string;
  active: boolean;
}

export interface Appointment {
  id: string;
  clientId: string;
  staffId: string;
  serviceId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no-show';
  notes: string;
  reminderSent: boolean;
  createdAt: string;
  clientName?: string;
  clientBirthday?: string | null;
  staffName?: string;
  serviceName?: string;
  servicePrice?: number;
  serviceDuration?: number;
}

export interface Reminder {
  id: string;
  appointmentId: string;
  type: 'email' | 'sms';
  scheduledFor: string;
  status: 'pending' | 'sent' | 'failed';
  message: string;
  clientName?: string;
  appointmentDate?: string;
  appointmentTime?: string;
}

export interface DashboardStats {
  totalClients: number;
  totalAppointments: number;
  todayAppointments: number;
  monthlyRevenue: number;
  completionRate: number;
  upcomingReminders: number;
}

export interface AnalyticsData {
  revenueByMonth: { month: string; revenue: number }[];
  appointmentsByStatus: { status: string; count: number }[];
  topServices: { name: string; count: number; revenue: number }[];
  staffPerformance: { name: string; appointments: number; revenue: number }[];
}

export interface DeveloperSalon {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  connectedAt: string | null;
  clientCount: number;
  appointmentCount: number;
  createdAt: string;
}

export interface CreateSalonResponse {
  success: true;
  salon: {
    id: string;
    name: string;
    slug: string;
    active: boolean;
    createdAt: string;
  };
  owner: {
    userId: string;
    email: string;
  };
  membership: {
    id: string;
    salonId: string;
    role: string;
    active: boolean;
  };
}

export interface DeveloperSalonCounts {
  clients: number;
  appointments: number;
  services: number;
  staff: number;
}

export interface DeveloperSalonOwner {
  membershipId: string;
  userId: string;
  email: string | null;
  fullName: string | null;
  role: string;
  membershipActive: boolean;
}

export interface DeveloperSalonTelegramSummary {
  status: IntegrationConnectionStatus;
  health: IntegrationHealthStatus;
  botUsername: string | null;
  botDisplayName: string | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  livePolling: boolean;
  adminChatId: number | null;
}

export interface DeveloperSalonDetail {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  timezone: string;
  country: string;
  currency: string;
  language: string;
  createdAt: string;
  counts: DeveloperSalonCounts;
  owner: DeveloperSalonOwner | null;
  telegram: DeveloperSalonTelegramSummary;
}

export interface UpdateDeveloperSalonRequest {
  name?: string;
  active?: boolean;
  timezone?: string;
  country?: string;
  currency?: string;
  language?: string;
}

export interface UpdateDeveloperSalonResponse {
  success: true;
  salon: {
    id: string;
    name: string;
    slug: string;
    active: boolean;
    timezone: string;
    country: string;
    currency: string;
    language: string;
    createdAt: string;
  };
}

export interface DeveloperHealth {
  api: { status: 'ok' };
  supabase: { status: 'connected' | 'disconnected' };
  telegram: {
    status: 'connected' | 'not_connected' | 'error';
    bot: string | null;
    error?: string | null;
  };
  version: string;
}

export type IntegrationConnectionStatus = 'connected' | 'not_connected' | 'error' | 'disabled';
export type IntegrationHealthStatus = 'healthy' | 'error' | 'unknown';

export interface DeveloperTelegramIntegration {
  salonId: string;
  salonName: string;
  slug: string;
  status: IntegrationConnectionStatus;
  health: IntegrationHealthStatus;
  botUsername: string | null;
  botDisplayName: string | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  adminChatId?: number | null;
}

export interface TestAdminNotificationResponse {
  success: boolean;
  error?: string;
}

export const DEFAULT_SALON_SLUG = 'default';
