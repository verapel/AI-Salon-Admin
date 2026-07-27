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
  /** Assigned service IDs from staff_services (empty if none). */
  serviceIds?: string[];
}

/** Origin of an appointment. Mapper falls back to 'owner' when DB value is null. */
export type AppointmentSource = 'telegram' | 'owner' | 'apple';

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
  source: AppointmentSource;
}

export interface Reminder {
  id: string;
  appointmentId: string;
  type: 'email' | 'sms' | 'telegram';
  scheduledFor: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  message: string;
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

export type ScheduleExceptionScope = 'salon' | 'staff';
export type ScheduleExceptionKind = 'closed' | 'vacation' | 'holiday' | 'custom_hours';

export interface WeeklyHoursRow {
  id: string;
  salonId: string;
  staffId?: string;
  weekday: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleException {
  id: string;
  salonId: string;
  scope: ScheduleExceptionScope;
  staffId: string | null;
  kind: ScheduleExceptionKind;
  startDate: string;
  endDate: string;
  openTime: string | null;
  closeTime: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleWeeklyResponse {
  salon: WeeklyHoursRow[];
  staff: Record<string, WeeklyHoursRow[]>;
}

/** Safe calendar connection metadata for owner APIs (no credential material). */
export type CalendarConnectionStatus =
  | 'disconnected'
  | 'connected'
  | 'error'
  | 'disabled';

export type CalendarProvider = 'apple' | 'google';

export interface CalendarConnectionPublic {
  id: string;
  provider: CalendarProvider;
  accountEmail: string | null;
  selectedCalendarId: string | null;
  selectedCalendarName: string | null;
  selectedCalendarUrl: string | null;
  status: CalendarConnectionStatus;
  importEnabled: boolean;
  lastSyncAt: string | null;
  lastSyncStartedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when encrypted credential material is stored (not CalDAV-verified). */
  isCredentialStored: boolean;
  /**
   * True when credentials are stored but Apple/CalDAV has not been verified yet.
   * APPLE-A3B does not verify with Apple.
   */
  verificationPending: boolean;
}

export interface AppleCalendarConnectRequest {
  accountEmail: string;
  appSpecificPassword: string;
}

/** Meta WhatsApp Cloud API architecture marker for whatsapp_business_connections.provider. */
export type WhatsAppCloudProvider = 'meta_cloud';

/** Channel identity providers for client_channel_identities. */
export type ClientChannelProvider = 'telegram' | 'whatsapp';

/** Providers that may write channel_event_receipts / channel_conversations (WA-1: WhatsApp only). */
export type ChannelMessagingProvider = 'whatsapp';

export type ChannelEventProcessingStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'ignored';

/**
 * Safe WhatsApp Business connection metadata for future owner/developer APIs.
 * Never includes access_token / app_secret / verify_token ciphertext, iv, or auth_tag.
 */
export interface WhatsAppBusinessConnectionPublic {
  id: string;
  salonId: string;
  integrationId: string;
  provider: WhatsAppCloudProvider;
  businessAccountId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  tokenExpiresAt: string | null;
  lastWebhookAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when encrypted access-token material is stored (WA-2+). */
  isAccessTokenStored: boolean;
  /** True when encrypted app-secret material is stored (WA-2+). */
  isAppSecretStored: boolean;
  /** True when encrypted verify-token material is stored (WA-2+). */
  isVerifyTokenStored: boolean;
}

export interface ClientChannelIdentity {
  id: string;
  salonId: string;
  clientId: string;
  provider: ClientChannelProvider;
  externalUserId: string;
  normalizedAddress: string | null;
  displayAddress: string | null;
  optInAt: string | null;
  optOutAt: string | null;
  lastInteractionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelEventReceipt {
  id: string;
  salonId: string;
  provider: ChannelMessagingProvider;
  externalEventId: string;
  externalMessageId: string | null;
  eventType: string | null;
  payloadHash: string | null;
  processingStatus: ChannelEventProcessingStatus;
  receivedAt: string;
  processedAt: string | null;
  lastError: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelConversation {
  id: string;
  salonId: string;
  provider: ChannelMessagingProvider;
  externalUserId: string;
  clientId: string | null;
  currentFlow: string | null;
  currentStep: string | null;
  lastInboundMessageId: string | null;
  lastOutboundMessageId: string | null;
  lastInteractionAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
