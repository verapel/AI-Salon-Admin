export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type IntegrationProvider =
  | 'telegram'
  | 'whatsapp'
  | 'instagram'
  | 'facebook_messenger'
  | 'email'
  | 'push'
  | 'google_calendar'
  | 'stripe'
  | 'openai';

export type IntegrationStatus = 'connected' | 'not_connected' | 'error' | 'disabled';

export type IntegrationHealth = 'healthy' | 'error' | 'unknown';

export type SalonMemberRole = 'owner' | 'admin' | 'staff_readonly';

export type PlatformUserRole = 'developer';

/** Origin of an appointment row. NULL in DB = legacy/unknown. */
export type AppointmentSource = 'telegram' | 'owner' | 'apple';

export type CalendarProvider = 'apple' | 'google';

export type CalendarConnectionStatus =
  | 'disconnected'
  | 'connected'
  | 'error'
  | 'disabled';

export type CalendarImportIssueStatus = 'open' | 'resolved' | 'dismissed';

/** Meta WhatsApp Cloud API architecture marker. */
export type WhatsAppCloudProvider = 'meta_cloud';

/** Channel identity providers for client_channel_identities. */
export type ClientChannelProvider = 'telegram' | 'whatsapp';

/** Providers for channel_event_receipts / channel_conversations (WA-1: WhatsApp only). */
export type ChannelMessagingProvider = 'whatsapp';

export type ChannelEventProcessingStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'ignored';

export interface Database {
  public: {
    Tables: {
      salons: {
        Row: {
          id: string;
          name: string;
          slug: string;
          timezone: string;
          country: string;
          currency: string;
          language: string;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          timezone?: string;
          country?: string;
          currency?: string;
          language?: string;
          active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          timezone?: string;
          country?: string;
          currency?: string;
          language?: string;
          active?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      salon_integrations: {
        Row: {
          id: string;
          salon_id: string;
          provider: IntegrationProvider;
          status: IntegrationStatus;
          health: IntegrationHealth;
          bot_username: string | null;
          bot_display_name: string | null;
          connected_at: string | null;
          last_checked_at: string | null;
          last_error: string | null;
          token_ciphertext: string | null;
          admin_chat_id: number | null;
          admin_chat_candidate_id: number | null;
          admin_chat_candidate_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          provider: IntegrationProvider;
          status?: IntegrationStatus;
          health?: IntegrationHealth;
          bot_username?: string | null;
          bot_display_name?: string | null;
          connected_at?: string | null;
          last_checked_at?: string | null;
          last_error?: string | null;
          token_ciphertext?: string | null;
          admin_chat_id?: number | null;
          admin_chat_candidate_id?: number | null;
          admin_chat_candidate_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          provider?: IntegrationProvider;
          status?: IntegrationStatus;
          health?: IntegrationHealth;
          bot_username?: string | null;
          bot_display_name?: string | null;
          connected_at?: string | null;
          last_checked_at?: string | null;
          last_error?: string | null;
          token_ciphertext?: string | null;
          admin_chat_id?: number | null;
          admin_chat_candidate_id?: number | null;
          admin_chat_candidate_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      clients: {
        Row: {
          id: string;
          name: string;
          email: string;
          phone: string;
          notes: string;
          total_visits: number;
          last_visit: string | null;
          created_at: string;
          is_blocked: boolean;
          blocked_at: string | null;
          blocked_reason: string | null;
          birthday: string | null;
          telegram_chat_id: number | null;
          salon_id: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          email: string;
          phone?: string;
          notes?: string;
          total_visits?: number;
          last_visit?: string | null;
          created_at?: string;
          is_blocked?: boolean;
          blocked_at?: string | null;
          blocked_reason?: string | null;
          birthday?: string | null;
          telegram_chat_id?: number | null;
          salon_id?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          email?: string;
          phone?: string;
          notes?: string;
          total_visits?: number;
          last_visit?: string | null;
          created_at?: string;
          is_blocked?: boolean;
          blocked_at?: string | null;
          blocked_reason?: string | null;
          birthday?: string | null;
          telegram_chat_id?: number | null;
          salon_id?: string | null;
        };
        Relationships: [];
      };
      services: {
        Row: {
          id: string;
          name: string;
          description: string;
          duration: number;
          price: number;
          category: string;
          active: boolean;
          created_at: string;
          salon_id: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string;
          duration: number;
          price: number;
          category?: string;
          active?: boolean;
          created_at?: string;
          salon_id?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string;
          duration?: number;
          price?: number;
          category?: string;
          active?: boolean;
          created_at?: string;
          salon_id?: string | null;
        };
        Relationships: [];
      };
      staff: {
        Row: {
          id: string;
          name: string;
          email: string;
          phone: string;
          role: string;
          specialties: string[];
          avatar: string;
          active: boolean;
          is_primary: boolean;
          created_at: string;
          salon_id: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          email: string;
          phone?: string;
          role?: string;
          specialties?: string[];
          avatar?: string;
          active?: boolean;
          is_primary?: boolean;
          created_at?: string;
          salon_id?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          email?: string;
          phone?: string;
          role?: string;
          specialties?: string[];
          avatar?: string;
          active?: boolean;
          is_primary?: boolean;
          created_at?: string;
          salon_id?: string | null;
        };
        Relationships: [];
      };
      staff_services: {
        Row: {
          id: string;
          salon_id: string;
          staff_id: string;
          service_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          staff_id: string;
          service_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          staff_id?: string;
          service_id?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      appointments: {
        Row: {
          id: string;
          client_id: string;
          staff_id: string;
          service_id: string;
          date: string;
          start_time: string;
          end_time: string;
          status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no-show';
          notes: string;
          reminder_sent: boolean;
          created_at: string;
          salon_id: string | null;
          source: AppointmentSource | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          staff_id: string;
          service_id: string;
          date: string;
          start_time: string;
          end_time: string;
          status?: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no-show';
          notes?: string;
          reminder_sent?: boolean;
          created_at?: string;
          salon_id?: string | null;
          source?: AppointmentSource | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          staff_id?: string;
          service_id?: string;
          date?: string;
          start_time?: string;
          end_time?: string;
          status?: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no-show';
          notes?: string;
          reminder_sent?: boolean;
          created_at?: string;
          salon_id?: string | null;
          source?: AppointmentSource | null;
        };
        Relationships: [];
      };
      calendar_connections: {
        Row: {
          id: string;
          salon_id: string;
          provider: CalendarProvider;
          account_email: string | null;
          credential_ciphertext: string | null;
          credential_iv: string | null;
          credential_auth_tag: string | null;
          selected_calendar_id: string | null;
          selected_calendar_url: string | null;
          selected_calendar_name: string | null;
          provider_config: Json;
          status: CalendarConnectionStatus;
          import_enabled: boolean;
          last_sync_at: string | null;
          last_sync_started_at: string | null;
          sync_lock_token: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          provider: CalendarProvider;
          account_email?: string | null;
          credential_ciphertext?: string | null;
          credential_iv?: string | null;
          credential_auth_tag?: string | null;
          selected_calendar_id?: string | null;
          selected_calendar_url?: string | null;
          selected_calendar_name?: string | null;
          provider_config?: Json;
          status?: CalendarConnectionStatus;
          import_enabled?: boolean;
          last_sync_at?: string | null;
          last_sync_started_at?: string | null;
          sync_lock_token?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          provider?: CalendarProvider;
          account_email?: string | null;
          credential_ciphertext?: string | null;
          credential_iv?: string | null;
          credential_auth_tag?: string | null;
          selected_calendar_id?: string | null;
          selected_calendar_url?: string | null;
          selected_calendar_name?: string | null;
          provider_config?: Json;
          status?: CalendarConnectionStatus;
          import_enabled?: boolean;
          last_sync_at?: string | null;
          last_sync_started_at?: string | null;
          sync_lock_token?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      appointment_external_links: {
        Row: {
          id: string;
          salon_id: string;
          appointment_id: string;
          calendar_connection_id: string;
          provider: CalendarProvider;
          external_calendar_id: string | null;
          external_uid: string;
          recurrence_id: string;
          external_etag: string | null;
          external_sequence: number | null;
          external_last_modified: string | null;
          last_seen_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          appointment_id: string;
          calendar_connection_id: string;
          provider: CalendarProvider;
          external_calendar_id?: string | null;
          external_uid: string;
          recurrence_id?: string;
          external_etag?: string | null;
          external_sequence?: number | null;
          external_last_modified?: string | null;
          last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          appointment_id?: string;
          calendar_connection_id?: string;
          provider?: CalendarProvider;
          external_calendar_id?: string | null;
          external_uid?: string;
          recurrence_id?: string;
          external_etag?: string | null;
          external_sequence?: number | null;
          external_last_modified?: string | null;
          last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      calendar_mapping_rules: {
        Row: {
          id: string;
          salon_id: string;
          calendar_connection_id: string | null;
          keyword: string;
          normalized_keyword: string;
          staff_id: string | null;
          service_id: string | null;
          default_duration_minutes: number | null;
          active: boolean;
          priority: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          calendar_connection_id?: string | null;
          keyword: string;
          normalized_keyword: string;
          staff_id?: string | null;
          service_id?: string | null;
          default_duration_minutes?: number | null;
          active?: boolean;
          priority?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          calendar_connection_id?: string | null;
          keyword?: string;
          normalized_keyword?: string;
          staff_id?: string | null;
          service_id?: string | null;
          default_duration_minutes?: number | null;
          active?: boolean;
          priority?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      calendar_import_issues: {
        Row: {
          id: string;
          salon_id: string;
          calendar_connection_id: string;
          external_uid: string;
          recurrence_id: string;
          external_etag: string | null;
          raw_event: Json;
          parsed_event: Json;
          reason_code: string;
          reason_message: string | null;
          status: CalendarImportIssueStatus;
          resolved_appointment_id: string | null;
          resolved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          calendar_connection_id: string;
          external_uid: string;
          recurrence_id?: string;
          external_etag?: string | null;
          raw_event?: Json;
          parsed_event?: Json;
          reason_code: string;
          reason_message?: string | null;
          status?: CalendarImportIssueStatus;
          resolved_appointment_id?: string | null;
          resolved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          calendar_connection_id?: string;
          external_uid?: string;
          recurrence_id?: string;
          external_etag?: string | null;
          raw_event?: Json;
          parsed_event?: Json;
          reason_code?: string;
          reason_message?: string | null;
          status?: CalendarImportIssueStatus;
          resolved_appointment_id?: string | null;
          resolved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      reminders: {
        Row: {
          id: string;
          appointment_id: string;
          type: 'email' | 'sms' | 'telegram';
          scheduled_for: string;
          status: 'pending' | 'sent' | 'failed' | 'skipped';
          message: string;
          created_at: string;
          salon_id: string | null;
          sent_at: string | null;
          last_error: string | null;
          claimed_at: string | null;
          claim_token: string | null;
          attempt_count: number;
        };
        Insert: {
          id?: string;
          appointment_id: string;
          type?: 'email' | 'sms' | 'telegram';
          scheduled_for: string;
          status?: 'pending' | 'sent' | 'failed' | 'skipped';
          message?: string;
          created_at?: string;
          salon_id?: string | null;
          sent_at?: string | null;
          last_error?: string | null;
          claimed_at?: string | null;
          claim_token?: string | null;
          attempt_count?: number;
        };
        Update: {
          id?: string;
          appointment_id?: string;
          type?: 'email' | 'sms' | 'telegram';
          scheduled_for?: string;
          status?: 'pending' | 'sent' | 'failed' | 'skipped';
          message?: string;
          created_at?: string;
          salon_id?: string | null;
          sent_at?: string | null;
          last_error?: string | null;
          claimed_at?: string | null;
          claim_token?: string | null;
          attempt_count?: number;
        };
        Relationships: [];
      };
      salon_members: {
        Row: {
          id: string;
          user_id: string;
          salon_id: string;
          role: SalonMemberRole;
          active: boolean;
          created_at: string;
          staff_id: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          salon_id: string;
          role: SalonMemberRole;
          active?: boolean;
          created_at?: string;
          staff_id?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          salon_id?: string;
          role?: SalonMemberRole;
          active?: boolean;
          created_at?: string;
          staff_id?: string | null;
        };
        Relationships: [];
      };
      platform_users: {
        Row: {
          user_id: string;
          role: PlatformUserRole;
          active: boolean;
          created_at: string;
        };
        Insert: {
          user_id: string;
          role?: PlatformUserRole;
          active?: boolean;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          role?: PlatformUserRole;
          active?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      salon_weekly_hours: {
        Row: {
          id: string;
          salon_id: string;
          weekday: number;
          is_closed: boolean;
          open_time: string | null;
          close_time: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          weekday: number;
          is_closed?: boolean;
          open_time?: string | null;
          close_time?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          weekday?: number;
          is_closed?: boolean;
          open_time?: string | null;
          close_time?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      staff_weekly_hours: {
        Row: {
          id: string;
          salon_id: string;
          staff_id: string;
          weekday: number;
          is_closed: boolean;
          open_time: string | null;
          close_time: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          staff_id: string;
          weekday: number;
          is_closed?: boolean;
          open_time?: string | null;
          close_time?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          staff_id?: string;
          weekday?: number;
          is_closed?: boolean;
          open_time?: string | null;
          close_time?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      schedule_exceptions: {
        Row: {
          id: string;
          salon_id: string;
          scope: 'salon' | 'staff';
          staff_id: string | null;
          kind: 'closed' | 'vacation' | 'holiday' | 'custom_hours';
          start_date: string;
          end_date: string;
          open_time: string | null;
          close_time: string | null;
          note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          scope: 'salon' | 'staff';
          staff_id?: string | null;
          kind: 'closed' | 'vacation' | 'holiday' | 'custom_hours';
          start_date: string;
          end_date: string;
          open_time?: string | null;
          close_time?: string | null;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          scope?: 'salon' | 'staff';
          staff_id?: string | null;
          kind?: 'closed' | 'vacation' | 'holiday' | 'custom_hours';
          start_date?: string;
          end_date?: string;
          open_time?: string | null;
          close_time?: string | null;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      birthday_owner_notifications: {
        Row: {
          id: string;
          salon_id: string;
          client_id: string;
          occurrence_year: number;
          notify_offset_days: number;
          status: 'pending' | 'processing' | 'sent' | 'failed';
          sent_at: string | null;
          last_error: string | null;
          attempt_count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          client_id: string;
          occurrence_year: number;
          notify_offset_days?: number;
          status?: 'pending' | 'processing' | 'sent' | 'failed';
          sent_at?: string | null;
          last_error?: string | null;
          attempt_count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          client_id?: string;
          occurrence_year?: number;
          notify_offset_days?: number;
          status?: 'pending' | 'processing' | 'sent' | 'failed';
          sent_at?: string | null;
          last_error?: string | null;
          attempt_count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      whatsapp_business_connections: {
        Row: {
          id: string;
          salon_id: string;
          integration_id: string;
          provider: WhatsAppCloudProvider;
          business_account_id: string | null;
          phone_number_id: string | null;
          display_phone_number: string | null;
          verified_name: string | null;
          webhook_key: string;
          access_token_ciphertext: string | null;
          access_token_iv: string | null;
          access_token_auth_tag: string | null;
          app_secret_ciphertext: string | null;
          app_secret_iv: string | null;
          app_secret_auth_tag: string | null;
          verify_token_ciphertext: string | null;
          verify_token_iv: string | null;
          verify_token_auth_tag: string | null;
          token_expires_at: string | null;
          last_webhook_at: string | null;
          last_inbound_at: string | null;
          last_outbound_at: string | null;
          quality_rating: string | null;
          messaging_limit_tier: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          integration_id: string;
          provider?: WhatsAppCloudProvider;
          business_account_id?: string | null;
          phone_number_id?: string | null;
          display_phone_number?: string | null;
          verified_name?: string | null;
          webhook_key?: string;
          access_token_ciphertext?: string | null;
          access_token_iv?: string | null;
          access_token_auth_tag?: string | null;
          app_secret_ciphertext?: string | null;
          app_secret_iv?: string | null;
          app_secret_auth_tag?: string | null;
          verify_token_ciphertext?: string | null;
          verify_token_iv?: string | null;
          verify_token_auth_tag?: string | null;
          token_expires_at?: string | null;
          last_webhook_at?: string | null;
          last_inbound_at?: string | null;
          last_outbound_at?: string | null;
          quality_rating?: string | null;
          messaging_limit_tier?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          integration_id?: string;
          provider?: WhatsAppCloudProvider;
          business_account_id?: string | null;
          phone_number_id?: string | null;
          display_phone_number?: string | null;
          verified_name?: string | null;
          webhook_key?: string;
          access_token_ciphertext?: string | null;
          access_token_iv?: string | null;
          access_token_auth_tag?: string | null;
          app_secret_ciphertext?: string | null;
          app_secret_iv?: string | null;
          app_secret_auth_tag?: string | null;
          verify_token_ciphertext?: string | null;
          verify_token_iv?: string | null;
          verify_token_auth_tag?: string | null;
          token_expires_at?: string | null;
          last_webhook_at?: string | null;
          last_inbound_at?: string | null;
          last_outbound_at?: string | null;
          quality_rating?: string | null;
          messaging_limit_tier?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      client_channel_identities: {
        Row: {
          id: string;
          salon_id: string;
          client_id: string;
          provider: ClientChannelProvider;
          external_user_id: string;
          normalized_address: string | null;
          display_address: string | null;
          opt_in_at: string | null;
          opt_out_at: string | null;
          last_interaction_at: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          client_id: string;
          provider: ClientChannelProvider;
          external_user_id: string;
          normalized_address?: string | null;
          display_address?: string | null;
          opt_in_at?: string | null;
          opt_out_at?: string | null;
          last_interaction_at?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          client_id?: string;
          provider?: ClientChannelProvider;
          external_user_id?: string;
          normalized_address?: string | null;
          display_address?: string | null;
          opt_in_at?: string | null;
          opt_out_at?: string | null;
          last_interaction_at?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      channel_event_receipts: {
        Row: {
          id: string;
          salon_id: string;
          provider: ChannelMessagingProvider;
          external_event_id: string;
          external_message_id: string | null;
          event_type: string | null;
          payload_hash: string | null;
          processing_status: ChannelEventProcessingStatus;
          received_at: string;
          processed_at: string | null;
          last_error: string | null;
          attempt_count: number;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          provider: ChannelMessagingProvider;
          external_event_id: string;
          external_message_id?: string | null;
          event_type?: string | null;
          payload_hash?: string | null;
          processing_status?: ChannelEventProcessingStatus;
          received_at?: string;
          processed_at?: string | null;
          last_error?: string | null;
          attempt_count?: number;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          provider?: ChannelMessagingProvider;
          external_event_id?: string;
          external_message_id?: string | null;
          event_type?: string | null;
          payload_hash?: string | null;
          processing_status?: ChannelEventProcessingStatus;
          received_at?: string;
          processed_at?: string | null;
          last_error?: string | null;
          attempt_count?: number;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      channel_conversations: {
        Row: {
          id: string;
          salon_id: string;
          provider: ChannelMessagingProvider;
          external_user_id: string;
          client_id: string | null;
          current_flow: string | null;
          current_step: string | null;
          state: Json;
          last_inbound_message_id: string | null;
          last_inbound_at: string | null;
          last_outbound_message_id: string | null;
          last_interaction_at: string | null;
          expires_at: string | null;
          locked_at: string | null;
          lock_token: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          salon_id: string;
          provider: ChannelMessagingProvider;
          external_user_id: string;
          client_id?: string | null;
          current_flow?: string | null;
          current_step?: string | null;
          state?: Json;
          last_inbound_message_id?: string | null;
          last_inbound_at?: string | null;
          last_outbound_message_id?: string | null;
          last_interaction_at?: string | null;
          expires_at?: string | null;
          locked_at?: string | null;
          lock_token?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          salon_id?: string;
          provider?: ChannelMessagingProvider;
          external_user_id?: string;
          client_id?: string | null;
          current_flow?: string | null;
          current_step?: string | null;
          state?: Json;
          last_inbound_message_id?: string | null;
          last_inbound_at?: string | null;
          last_outbound_message_id?: string | null;
          last_interaction_at?: string | null;
          expires_at?: string | null;
          locked_at?: string | null;
          lock_token?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    // WA-4B1 owned RPCs are invoked via supabase.rpc(...); keep Functions loose so
    // incomplete Relationship metadata does not break existing join typings.
    Functions: Record<string, never>;
    Enums: {
      integration_provider: IntegrationProvider;
      integration_status: IntegrationStatus;
      integration_health: IntegrationHealth;
      salon_member_role: SalonMemberRole;
      platform_user_role: PlatformUserRole;
    };
  };
}
