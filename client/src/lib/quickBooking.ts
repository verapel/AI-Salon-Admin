import { api } from '@/lib/api';
import {
  resolveClientId as resolveClientIdWithStore,
  type QuickBookingClientStore,
} from '@/lib/quickBookingMatch';

export {
  applyClientNameQuery,
  applyExistingClientSelection,
  formatClientSuggestion,
  matchExistingClients,
  normalizePhone,
  quickClientEmail,
  QUICK_BOOKING_SUGGESTION_LIMIT,
  resolveClientId as resolveClientIdWithStore,
} from '@/lib/quickBookingMatch';
export type { QuickBookingClientMatch, QuickBookingClientStore } from '@/lib/quickBookingMatch';

const toLocalDateStr = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export function emptyQuickBookingForm() {
  return {
    clientId: null as string | null,
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

const defaultClientStore: QuickBookingClientStore = {
  list: () => api.clients.getAll(),
  create: (data) => api.clients.create(data),
};

export async function resolveClientId(
  name: string,
  phone: string,
  existingClientId?: string | null,
  store: QuickBookingClientStore = defaultClientStore
): Promise<string> {
  return resolveClientIdWithStore(name, phone, existingClientId, store);
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
  const clientId = await resolveClientId(form.clientName, form.phone, form.clientId);
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
