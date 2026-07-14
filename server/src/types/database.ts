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
    };
    Views: Record<string, never>;
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
