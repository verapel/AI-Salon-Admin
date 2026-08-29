import type {
  Client,
  Service,
  Staff,
  Appointment,
  Reminder,
  Product,
} from '../types.js';
import { parseOptionalMoney } from './productFields.js';
import { deriveProductStockStatus, visibleCodeShade } from './products.js';

function mapOptionalPrice(value: unknown): number | null {
  const n = parseOptionalMoney(value);
  return n == null || n === 0 ? null : n;
}

/** Normalize PostgreSQL TIME ("09:00:00") to API format ("09:00"). */
export function formatTimeValue(value: string): string {
  return value.slice(0, 5);
}

export function mapClient(row: {
  id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  total_visits: number;
  last_visit: string | null;
  created_at: string;
  is_blocked?: boolean;
  blocked_at?: string | null;
  blocked_reason?: string | null;
  birthday?: string | null;
}): Client {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? '',
    phone: row.phone,
    notes: row.notes,
    totalVisits: row.total_visits,
    lastVisit: row.last_visit,
    createdAt: row.created_at,
    isBlocked: row.is_blocked ?? false,
    blockedAt: row.blocked_at ?? null,
    blockedReason: row.blocked_reason ?? null,
    birthday: row.birthday ?? null,
  };
}

export function mapService(row: {
  id: string;
  name: string;
  description: string;
  duration: number;
  price: number;
  category: string;
  active: boolean;
}): Service {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    duration: row.duration,
    price: Number(row.price),
    category: row.category,
    active: row.active,
  };
}

export function mapProduct(row: {
  id: string;
  name: string;
  brand: string;
  line: string;
  code_shade: string;
  category: string;
  quantity: number;
  min_quantity: number;
  unit: string;
  price: number;
  volume?: string | null;
  percentage?: number | null;
  price_min?: number | string | null;
  price_max?: number | string | null;
  currency?: string | null;
  supplier: string;
  marked_for_purchase: boolean;
  created_at: string;
  updated_at: string;
}): Product {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand ?? '',
    line: row.line ?? '',
    codeShade: visibleCodeShade(row.code_shade ?? '', row.name),
    category: row.category ?? '',
    quantity: row.quantity,
    minQuantity: row.min_quantity,
    unit: row.unit ?? '',
    volume: row.volume ?? '',
    percentage: row.percentage == null ? null : Number(row.percentage),
    price: Number(row.price),
    priceMin: mapOptionalPrice(row.price_min),
    priceMax: mapOptionalPrice(row.price_max),
    currency: row.currency || 'AMD',
    supplier: row.supplier ?? '',
    markedForPurchase: Boolean(row.marked_for_purchase),
    stockStatus: deriveProductStockStatus(row.quantity, row.min_quantity),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStaff(
  row: {
    id: string;
    name: string;
    email: string;
    phone: string;
    role: string;
    specialties: string[];
    avatar: string;
    active: boolean;
    is_primary?: boolean | null;
    telegram_chat_id?: number | null;
  },
  serviceIds: string[] = []
): Staff {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    specialties: row.specialties ?? [],
    avatar: row.avatar,
    active: row.active,
    isPrimary: Boolean(row.is_primary),
    serviceIds,
    telegramChatId: row.telegram_chat_id ?? null,
  };
}

export function mapAppointment(row: {
  id: string;
  client_id: string;
  staff_id: string;
  service_id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: Appointment['status'];
  notes: string;
  reminder_sent: boolean;
  created_at: string;
  source?: Appointment['source'] | null;
}): Appointment {
  return {
    id: row.id,
    clientId: row.client_id,
    staffId: row.staff_id,
    serviceId: row.service_id,
    date: row.date,
    startTime: formatTimeValue(row.start_time),
    endTime: formatTimeValue(row.end_time),
    status: row.status,
    notes: row.notes,
    reminderSent: row.reminder_sent,
    createdAt: row.created_at,
    // Legacy/null rows and pre-migration responses fall back to owner.
    source: row.source ?? 'owner',
  };
}

type AppointmentJoinRow = {
  id: string;
  client_id: string;
  staff_id: string;
  service_id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: Appointment['status'];
  notes: string;
  reminder_sent: boolean;
  created_at: string;
  source?: Appointment['source'] | null;
  clients: { name: string; birthday: string | null } | null;
  staff: { name: string } | null;
  services: { name: string; price: number; duration: number } | null;
};

function googleBusyDisplayTitle(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const lines = notes.split('\n');
  if (!/^Google Calendar import/i.test(lines[0] || '')) return null;
  const title = lines.slice(1).join('\n').trim();
  return title || null;
}

export function mapEnrichedAppointment(row: AppointmentJoinRow) {
  const base = mapAppointment(row);
  const unresolvedGoogle = row.services?.name === 'Google • Требует проверки';
  return {
    ...base,
    clientName: row.clients?.name ?? 'Unknown',
    clientBirthday: row.clients?.birthday ?? null,
    staffName: row.staff?.name ?? 'Unknown',
    serviceName: unresolvedGoogle
      ? googleBusyDisplayTitle(row.notes) || row.services?.name || 'Unknown'
      : (row.services?.name ?? 'Unknown'),
    servicePrice: Number(row.services?.price ?? 0),
    serviceDuration: row.services?.duration ?? 0,
  };
}

export function mapReminder(row: {
  id: string;
  appointment_id: string;
  type: Reminder['type'];
  scheduled_for: string;
  status: Reminder['status'];
  message: string;
}): Reminder {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    type: row.type,
    scheduledFor: row.scheduled_for,
    status: row.status,
    message: row.message,
  };
}

type ReminderJoinRow = {
  id: string;
  appointment_id: string;
  type: Reminder['type'];
  scheduled_for: string;
  status: Reminder['status'];
  message: string;
  appointments: {
    date: string;
    start_time: string;
    clients: { name: string } | null;
  } | null;
};

export function mapEnrichedReminder(row: ReminderJoinRow) {
  const base = mapReminder(row);
  return {
    ...base,
    clientName: row.appointments?.clients?.name ?? 'Unknown',
    appointmentDate: row.appointments?.date,
    appointmentTime: row.appointments?.start_time
      ? formatTimeValue(row.appointments.start_time)
      : undefined,
  };
}

export function computeEndTime(startTime: string, durationMinutes: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const endMinutes = h * 60 + m + durationMinutes;
  return `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
}

export function initialsAvatar(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
