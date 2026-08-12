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
  /** Salon primary master; at most one per salon. */
  isPrimary: boolean;
  /** Assigned service IDs from staff_services (empty if none). */
  serviceIds?: string[];
}

/** Origin of an appointment. Mapper falls back to 'owner' when DB value is null. */
export type AppointmentSource = 'telegram' | 'owner' | 'apple' | 'whatsapp' | 'instagram';

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
export type ClientChannelProvider = 'telegram' | 'whatsapp' | 'instagram';

/**
 * Providers for channel_event_receipts / channel_conversations.
 * Receipts: whatsapp + instagram (IG-3). Conversations: whatsapp + instagram (IG-4).
 */
export type ChannelMessagingProvider = 'whatsapp' | 'instagram';

export type ChannelEventProcessingStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'ignored';

/**
 * Safe WhatsApp Business connection metadata for developer WhatsApp APIs.
 * Never includes access_token / app_secret / verify_token ciphertext, iv, or auth_tag.
 * webhookKey is a public routing identifier (not a credential) — developer cabinet only.
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
  /** Opaque public routing UUID for Meta webhook URL (not a secret). */
  webhookKey?: string | null;
  /** Absolute callback URL built from APP_URL + webhookKey, or null if APP_URL unset. */
  webhookCallbackUrl?: string | null;
}

/** Transient connect request only — never persist or echo plaintext secrets. */
export interface WhatsAppConnectRequest {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  businessAccountId: string;
  phoneNumberId: string;
}

export interface WhatsAppIntegrationResponse {
  connected: boolean;
  connection: WhatsAppBusinessConnectionPublic | null;
}

/** IG-1 Instagram connection status (connection table). */
export type InstagramConnectionStatus =
  | 'not_connected'
  | 'connected'
  | 'error'
  | 'disabled';

/**
 * Safe Instagram Business connection metadata for developer Instagram APIs.
 * Never includes access_token ciphertext, iv, or auth_tag.
 */
export interface InstagramBusinessConnectionPublic {
  id: string;
  salonId: string;
  status: InstagramConnectionStatus;
  /** Instagram Professional Account ID (routing identity). */
  instagramUserId: string | null;
  instagramUsername: string | null;
  connectedAt: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
  tokenExpiresAt?: string | null;
  isAccessTokenStored: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Developer-cabinet per-salon Instagram status (no secrets). */
export interface DeveloperInstagramIntegration {
  salonId: string;
  salonName: string;
  slug: string;
  /**
   * True when Instagram is visible:
   * registry row OR meaningful connection (orphan-safe, non-mutating).
   */
  integrationAdded: boolean;
  connected: boolean;
  connection: InstagramBusinessConnectionPublic | null;
  /** True when remove would clear stored credentials (needs explicit confirm). */
  requiresRemoveConfirmation: boolean;
  /** Read-only mirror of INSTAGRAM_OUTBOUND_ENABLED === "true". */
  outboundEnabled: boolean;
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
