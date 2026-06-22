import type {
  Client,
  Service,
  Staff,
  Appointment,
  Reminder,
} from '../types.js';

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
}): Client {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    totalVisits: row.total_visits,
    lastVisit: row.last_visit,
    createdAt: row.created_at,
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

export function mapStaff(row: {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  specialties: string[];
  avatar: string;
  active: boolean;
}): Staff {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    specialties: row.specialties ?? [],
    avatar: row.avatar,
    active: row.active,
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
  clients: { name: string } | null;
  staff: { name: string } | null;
  services: { name: string; price: number; duration: number } | null;
};

export function mapEnrichedAppointment(row: AppointmentJoinRow) {
  const base = mapAppointment(row);
  return {
    ...base,
    clientName: row.clients?.name ?? 'Unknown',
    staffName: row.staff?.name ?? 'Unknown',
    serviceName: row.services?.name ?? 'Unknown',
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
