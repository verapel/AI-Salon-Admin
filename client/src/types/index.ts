export interface Client {
  id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  totalVisits: number;
  lastVisit: string | null;
  createdAt: string;
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
  timezone: string;
  country: string;
  currency: string;
  language: string;
  active: boolean;
  createdAt: string;
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
}

export const DEFAULT_SALON_SLUG = 'default';
