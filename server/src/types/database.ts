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
        };
        Relationships: [];
      };
      reminders: {
        Row: {
          id: string;
          appointment_id: string;
          type: 'email' | 'sms';
          scheduled_for: string;
          status: 'pending' | 'sent' | 'failed';
          message: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          appointment_id: string;
          type?: 'email' | 'sms';
          scheduled_for: string;
          status?: 'pending' | 'sent' | 'failed';
          message?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          appointment_id?: string;
          type?: 'email' | 'sms';
          scheduled_for?: string;
          status?: 'pending' | 'sent' | 'failed';
          message?: string;
          created_at?: string;
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
    };
  };
}
