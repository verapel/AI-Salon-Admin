export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
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
      };
    };
  };
}
