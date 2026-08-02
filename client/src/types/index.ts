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
  isPrimary?: boolean;
  /** Assigned service IDs from staff_services (empty if none). */
  serviceIds?: string[];
}

/** Origin of an appointment. API falls back to 'owner' when DB value is null. */
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
  type: 'email' | 'sms' | 'telegram';
  scheduledFor: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
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

export interface SalonDeleteCounts {
  clients: number;
  staff: number;
  services: number;
  appointments: number;
  activeAppointments: number;
  reminders: number;
  salonMembers: number;
  integrations: number;
  scheduleExceptions: number;
  calendarConnections: number;
}

export type SalonDeleteProtectedReason = 'DEFAULT_SALON' | 'DELETION_PROTECTED' | null;

export type SalonDeleteTelegramStatus =
  | 'connected'
  | 'not_connected'
  | 'error'
  | 'disabled'
  | 'none';

/** Developer-cabinet permanent salon delete preview (no secrets). */
export interface SalonDeletePreview {
  salonId: string;
  name: string;
  slug: string;
  active: boolean;
  deletionProtected: boolean;
  protectedReason: SalonDeleteProtectedReason;
  canPermanentlyDelete: boolean;
  counts: SalonDeleteCounts;
  whatsappConnected: boolean;
  telegramStatus: SalonDeleteTelegramStatus;
}

export interface SalonPermanentDeleteResponse {
  salonId: string;
  deleted: boolean;
  counts: {
    clients: number;
    staff: number;
    services: number;
    appointments: number;
    reminders: number;
    salonMembers: number;
  };
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

export interface TelegramAdminChatCandidateResponse {
  found: boolean;
  expired?: boolean;
  candidateChatId?: number | null;
  detectedAt?: string | null;
  expiresAt?: string | null;
}

export interface ConfirmTelegramAdminChatCandidateResponse {
  success: boolean;
  integration?: DeveloperTelegramIntegration;
  error?: string;
}

export const DEFAULT_SALON_SLUG = 'default';

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

/** Safe Apple/calendar connection metadata from owner APIs (no credential material). */
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
  isCredentialStored: boolean;
  verificationPending: boolean;
}

/** Transient connect request only — never store or echo the password. */
export interface AppleCalendarConnectRequest {
  accountEmail: string;
  appSpecificPassword: string;
}

export interface CalendarConnectionsResponse {
  connection: CalendarConnectionPublic | null;
}

export interface AppleCalendarConnectResponse {
  connection: CalendarConnectionPublic;
  verificationPending: boolean;
  message: string;
}

/** Meta WhatsApp Cloud API architecture marker. */
export type WhatsAppCloudProvider = 'meta_cloud';

/**
 * Safe WhatsApp Business connection metadata from owner APIs.
 * Never includes ciphertext, iv, authTag, or plaintext secrets.
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
  isAccessTokenStored: boolean;
  isAppSecretStored: boolean;
  isVerifyTokenStored: boolean;
}

/** Transient connect request only — never store or echo secrets. */
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

/** Developer-cabinet per-salon WhatsApp status (no secrets). */
export interface DeveloperWhatsAppIntegration {
  salonId: string;
  salonName: string;
  slug: string;
  connected: boolean;
  connection: WhatsAppBusinessConnectionPublic | null;
}

export interface WeeklyHoursInput {
  weekday: number;
  isClosed: boolean;
  openTime?: string | null;
  closeTime?: string | null;
}

export interface CreateScheduleExceptionInput {
  scope: ScheduleExceptionScope;
  staffId?: string | null;
  kind: ScheduleExceptionKind;
  startDate: string;
  endDate: string;
  openTime?: string | null;
  closeTime?: string | null;
  note?: string | null;
}

/** Staff portal — matches GET /api/staff-portal/* (no salonId/staffId client params). */
export interface StaffPortalMe {
  userId: string;
  email: string;
  salonId: string;
  role: 'staff_readonly';
  staffId: string;
  staffName: string;
}

export interface StaffPortalAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: Appointment['status'];
  serviceName: string;
  clientName: string;
  clientPhone: string;
  notes: string;
}

export interface StaffPortalSchedule {
  salonWeekly: WeeklyHoursRow[];
  staffWeekly: WeeklyHoursRow[];
  exceptions: ScheduleException[];
}

/** Staff portal self-schedule write — identity from auth only (no salonId/staffId). */
export interface StaffPortalCreateExceptionInput {
  kind: Extract<ScheduleExceptionKind, 'closed' | 'vacation' | 'custom_hours'>;
  startDate: string;
  endDate: string;
  openTime?: string | null;
  closeTime?: string | null;
  note?: string | null;
}

export interface StaffPortalWeeklySaveResponse {
  staffWeekly: WeeklyHoursRow[];
}

export interface StaffPortalExceptionCreateResponse {
  exception: ScheduleException;
}

/** Owner Staff Access — portal membership status (no Auth UUIDs). */
export type StaffAccessStatus = 'none' | 'active' | 'disabled';

export interface StaffAccessDto {
  staffId: string;
  status: StaffAccessStatus;
  email: string | null;
  active: boolean;
  canInvite: boolean;
  canResend: boolean;
  canDisable: boolean;
  canEnable: boolean;
}

export interface StaffAccessInviteResponse {
  ok: true;
  invitationSent: boolean;
  existingUserLinked: boolean;
  access: StaffAccessDto;
}

export interface StaffAccessResendResponse {
  ok: true;
  invitationSent: boolean;
  access: StaffAccessDto;
}

export interface StaffAccessPatchResponse {
  ok: true;
  access: StaffAccessDto;
}

export type StaffDeleteProtectedReason =
  | 'PRIMARY_STAFF'
  | 'self_membership'
  | 'owner_or_admin_membership'
  | 'authenticated_user_email'
  | null;

export interface StaffDeletePreview {
  staff: {
    id: string;
    name: string;
    active: boolean;
    isPrimary: boolean;
  };
  totalAppointments: number;
  activeAppointments: number;
  hasPortalMembership: boolean;
  protected: boolean;
  protectedReason: StaffDeleteProtectedReason;
}

export interface StaffPermanentDeleteRequest {
  confirm: true;
  deleteAppointments: boolean;
}

export interface StaffPermanentDeleteResult {
  success: true;
  deletedStaffId: string;
  deletedAppointments: number;
  affectedMemberships: number;
  affectedMappingRules: number;
}

export type StaffApiErrorCode =
  | 'STAFF_NOT_FOUND'
  | 'STAFF_HAS_APPOINTMENTS'
  | 'PROTECTED_STAFF_MEMBER'
  | 'PRIMARY_STAFF_CANNOT_DELETE'
  | 'CONFIRM_REQUIRED'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR'
  | string;
