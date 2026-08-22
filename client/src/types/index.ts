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

export type ProductStockStatus = 'in_stock' | 'low' | 'out';

export interface Product {
  id: string;
  name: string;
  brand: string;
  line: string;
  codeShade: string;
  category: string;
  quantity: number;
  minQuantity: number;
  unit: string;
  price: number;
  supplier: string;
  markedForPurchase: boolean;
  stockStatus: ProductStockStatus;
  createdAt: string;
  updatedAt: string;
}

export type ProductDraft = {
  name: string;
  brand: string;
  line: string;
  codeShade: string;
  category: string;
  quantity: number;
  minQuantity: number;
  unit: string;
  price: number;
  supplier: string;
  markedForPurchase: boolean;
};

export type ProductImportResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: { name: string; message: string }[];
};

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
export type AppointmentSource =
  | 'telegram'
  | 'owner'
  | 'apple'
  | 'whatsapp'
  | 'instagram'
  | 'google';

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

export interface InAppNotification extends Reminder {
  read: boolean;
}

export interface NotificationFeed {
  items: InAppNotification[];
  unreadCount: number;
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

/** SUB-1C: Subscription lifecycle statuses (matches server). */
export type SalonSubscriptionStatus =
  | 'trial'
  | 'active'
  | 'past_due'
  | 'expired'
  | 'cancelled';

export type SalonEntitlementDenyReason =
  | 'salon_inactive'
  | 'developer_suspended'
  | 'trial_expired'
  | 'subscription_past_due'
  | 'subscription_expired'
  | 'subscription_cancelled';

/** Browser-safe developer subscription + entitlement (no provider linkage ids). */
export interface DeveloperSalonSubscription {
  salonId: string;
  plan: string;
  status: SalonSubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  developerSuspended: boolean;
  aiAutomationAllowed: boolean;
  denyReason: SalonEntitlementDenyReason | null;
  usedMissingSubscriptionFallback: boolean;
  usedSubscriptionReadFailureFallback: boolean;
  usedSalonReadFailureFallback: boolean;
  updatedAt: string | null;
}

export interface UpdateDeveloperSalonSubscriptionRequest {
  plan?: 'standard';
  status?: SalonSubscriptionStatus;
  trialEndsAt?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  developerSuspended?: boolean;
}

export interface UpdateDeveloperSalonSubscriptionResponse {
  success: boolean;
  subscription: DeveloperSalonSubscription;
  error?: string;
  code?: string;
}

/** SUB-1C2: Batch list row for developer subscriptions page. */
export interface DeveloperSalonSubscriptionListItem {
  salonId: string;
  salonName: string;
  salonActive: boolean;
  subscription: DeveloperSalonSubscription | null;
  loadError: boolean;
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
  /**
   * Legacy Apple-only field for existing Integrations UI.
   * Prefer `connections` for multi-provider reads (GOOGLE-CAL-A2).
   */
  connection: CalendarConnectionPublic | null;
  /** Safe metadata for all providers present for this salon (apple, google, …). */
  connections: CalendarConnectionPublic[];
}

export interface AppleCalendarConnectResponse {
  connection: CalendarConnectionPublic;
  verificationPending: boolean;
  message: string;
}

/** Safe Google calendarList entry (no tokens). */
export interface GoogleCalendarListItem {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string | null;
  timeZone: string | null;
}

/** Normalized Google event start/end for FAST-2 preview. */
export interface GoogleEventTimePreview {
  dateTime: string | null;
  date: string | null;
  timeZone: string | null;
  allDay: boolean;
}

/** GOOGLE-CAL-FAST-3B deterministic parse preview (no import). */
export type CalendarParseImportability = 'ready' | 'review' | 'not_importable';

export interface CalendarParsedPhone {
  value: string | null;
  normalized: string | null;
  confidence: 'exact' | 'possible' | 'none';
}

export interface CalendarParsedPrice {
  value: number | null;
  raw: string | null;
  confidence: 'likely' | 'possible' | 'none';
}

export interface CalendarEventParsedPreview {
  classification: string[];
  importability: CalendarParseImportability;
  localDate: string | null;
  localStartTime: string | null;
  localEndTime: string | null;
  durationMinutes: number | null;
  clientNameCandidate: string | null;
  phone: CalendarParsedPhone;
  serviceCandidate: string | null;
  priceCandidate: CalendarParsedPrice;
  staffCandidate: null;
  reasons: string[];
}

/** GOOGLE-CAL-FAST-4: salon-scoped read-only matching preview (no import). */
export type CalendarMatchingStatus = 'matched' | 'partial' | 'review';

export type CalendarClientMatchStatus =
  | 'matched'
  | 'possible'
  | 'ambiguous'
  | 'not_found'
  | 'not_attempted';

export type CalendarClientMatchConfidence =
  | 'exact_phone'
  | 'exact_name'
  | 'possible_name'
  | 'none';

export type CalendarServiceMatchStatus =
  | 'matched'
  | 'ambiguous'
  | 'not_found'
  | 'not_attempted';

export type CalendarServiceMatchConfidence =
  | 'exact_name'
  | 'contained_name'
  | 'none';

export interface CalendarEventClientMatch {
  status: CalendarClientMatchStatus;
  confidence: CalendarClientMatchConfidence;
  clientId: string | null;
  displayName: string | null;
  matchedPhone: string | null;
}

export interface CalendarEventServiceMatch {
  status: CalendarServiceMatchStatus;
  confidence: CalendarServiceMatchConfidence;
  serviceId: string | null;
  displayName: string | null;
}

export interface CalendarEventMatchingPreview {
  client: CalendarEventClientMatch;
  service: CalendarEventServiceMatch;
  recognizedClientText: string | null;
  serviceSearchText: string | null;
  serviceResidualText: string | null;
  staff: null;
  reasons: string[];
  matchingStatus: CalendarMatchingStatus;
}

/** GOOGLE-CAL-FAST manual import readiness (separate from parsed.importability). */
export type GoogleImportReadinessStatus =
  | 'importable'
  | 'needs_client_review'
  | 'needs_service_review'
  | 'needs_staff_review'
  | 'already_imported'
  | 'not_importable';

export interface GoogleImportReadiness {
  status: GoogleImportReadinessStatus;
  reasons: string[];
  occurrenceKey: string;
  externalUid: string;
  recurrenceId: string;
  suggestedNewClientName: string | null;
  canCreateNewClient: boolean;
}

export interface GoogleImportStaffOption {
  id: string;
  name: string;
}

/** Safe Google events.list preview DTO (no credentials). */
export interface GoogleEventPreviewItem {
  id: string;
  iCalUID: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  status: string | null;
  start: GoogleEventTimePreview;
  end: GoogleEventTimePreview;
  recurringEventId: string | null;
  originalStartTime: GoogleEventTimePreview | null;
  created: string | null;
  updated: string | null;
  etag: string | null;
  htmlLink: string | null;
  calendarId: string;
  calendarName: string | null;
  /** Present after FAST-3B; optional for older responses. */
  parsed?: CalendarEventParsedPreview;
  /** Present after FAST-4; optional for older responses. */
  matching?: CalendarEventMatchingPreview;
  matchingStatus?: CalendarMatchingStatus;
  /** Present after manual-import foundation. */
  importReadiness?: GoogleImportReadiness;
  /** Present when automatic import is enabled. */
  autoImport?: {
    status: 'would_import' | 'skip' | 'already_imported';
    reason: string | null;
  };
}

export interface GoogleEventsPreviewResponse {
  events: GoogleEventPreviewItem[];
  count: number;
  truncated: boolean;
  windowStart: string;
  windowEnd: string;
  calendarId: string;
  calendarName: string | null;
  salonTimeZone?: string;
  staffOptions?: GoogleImportStaffOption[];
  autoImportEnabled?: boolean;
}

export interface GoogleEventImportRequest {
  eventId: string;
  recurrenceId?: string;
  staffId: string;
  serviceId: string;
  client: {
    mode: 'existing' | 'new';
    clientId?: string;
    name?: string;
    phone?: string;
  };
  expectedEtag?: string;
  expectedUpdated?: string;
}

export interface GoogleEventImportResponse {
  appointmentId: string;
  clientId: string;
  clientCreated: boolean;
  alreadyImported?: boolean;
}

/** FAST-7B: unresolved Google event shown on the salon calendar overlay. */
export interface GoogleReviewCalendarItem {
  id: string;
  kind: 'google_review';
  source: 'google';
  reviewStatus: 'needs_review';
  eventId: string;
  recurrenceId: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number | null;
  staffId: string;
  staffName: string;
  reasonCode: string;
  clientCandidate: string | null;
  phoneCandidate: string | null;
  serviceCandidate: string | null;
  clientId?: string | null;
}

export interface GoogleBackfillProgress {
  processed: number;
  total: number | null;
  percent: number;
  status: 'idle' | 'listing' | 'processing' | 'done' | 'error';
  pagesProcessed?: number;
  result?: GoogleBackfillLast30DaysResult | null;
}

/** Compact FAST-7D coverage summary (no appointment/client rows). */
export interface GoogleBackfillLast30DaysResult {
  scanned: number;
  represented: number;
  imported: number;
  appointments: number;
  reviewEvents: number;
  clientsCreated: number;
  clientsReused: number;
  alreadyImported: number;
  skipped: number;
  excluded: number;
  failed: number;
  truncated: boolean;
  newEvents?: number;
  updatedEvents?: number;
  unchangedEvents?: number;
  appointmentsCreated?: number;
  appointmentsUpdated?: number;
  reviewEventsCreated?: number;
  reviewEventsUpdated?: number;
  conflicts?: number;
  reasons: {
    noPhone: number;
    unsafeClientName: number;
    clientAmbiguous: number;
    serviceUnmatched: number;
    serviceAmbiguous: number;
    conflict: number;
    cancelled: number;
    allDay: number;
    invalidTime: number;
    other: number;
  };
}

/** Meta WhatsApp Cloud API architecture marker. */
export type WhatsAppCloudProvider = 'meta_cloud';

/**
 * Safe WhatsApp Business connection metadata from developer WhatsApp APIs.
 * Never includes ciphertext, iv, authTag, or plaintext secrets.
 * webhookKey is a public routing identifier (not a credential).
 */
export interface WhatsAppBusinessConnectionPublic {
  id: string;
  salonId: string;
  /** Null when connection shell is detached from registry after remove. */
  integrationId: string | null;
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
  /** Opaque public routing UUID for Meta webhook URL (not a secret). */
  webhookKey?: string | null;
  /** Absolute callback URL from server APP_URL + webhookKey. */
  webhookCallbackUrl?: string | null;
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
  /**
   * True when WhatsApp is visible:
   * registry row OR meaningful connection (orphan-safe).
   */
  integrationAdded?: boolean;
  connected: boolean;
  connection: WhatsAppBusinessConnectionPublic | null;
  /** True when remove would clear stored credentials (needs explicit confirm). */
  requiresRemoveConfirmation?: boolean;
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
   * registry row OR meaningful connection (orphan-safe).
   */
  integrationAdded?: boolean;
  connected: boolean;
  connection: InstagramBusinessConnectionPublic | null;
  /** True when remove would clear stored credentials (needs explicit confirm). */
  requiresRemoveConfirmation?: boolean;
  /** Read-only: INSTAGRAM_OUTBOUND_ENABLED === "true". Not a client toggle. */
  outboundEnabled?: boolean;
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
