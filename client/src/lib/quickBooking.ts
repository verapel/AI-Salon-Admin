import { api } from '@/lib/api';

export const normalizePhone = (phone: string) => phone.replace(/\D/g, '');

export const quickClientEmail = (phone: string) => {
  const digits = normalizePhone(phone);
  return `quick-client-${digits || Date.now()}@no-email.local`;
};

const toLocalDateStr = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export function emptyQuickBookingForm() {
  return {
    clientName: '',
    phone: '',
    serviceName: '',
    staffId: '',
    date: toLocalDateStr(),
    startTime: '09:00',
    notes: '',
  };
}

export type QuickBookingForm = ReturnType<typeof emptyQuickBookingForm>;

export async function resolveClientId(name: string, phone: string): Promise<string> {
  const trimmedName = name.trim();
  const trimmedPhone = phone.trim();
  const clients = await api.clients.getAll();
  const normalized = normalizePhone(trimmedPhone);
  const existing = clients.find((c) => normalizePhone(c.phone) === normalized);
  if (existing) return existing.id;

  const created = await api.clients.create({
    name: trimmedName,
    phone: trimmedPhone,
    email: quickClientEmail(trimmedPhone),
    notes: '',
  });
  return created.id;
}

export async function resolveServiceId(serviceName: string): Promise<string> {
  const trimmed = serviceName.trim();
  const services = await api.services.getAll();
  const existing = services.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing.id;

  const created = await api.services.create({
    name: trimmed,
    description: '',
    duration: 60,
    price: 0,
    category: 'Other',
  });
  return created.id;
}

export async function createQuickBooking(form: QuickBookingForm) {
  const clientId = await resolveClientId(form.clientName, form.phone);
  const serviceId = await resolveServiceId(form.serviceName);
  return api.appointments.create({
    clientId,
    serviceId,
    staffId: form.staffId,
    date: form.date,
    startTime: form.startTime,
    notes: form.notes,
  });
}
