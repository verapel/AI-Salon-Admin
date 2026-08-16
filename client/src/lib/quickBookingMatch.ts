export const QUICK_BOOKING_SUGGESTION_LIMIT = 10;

export type QuickBookingClientMatch = {
  id: string;
  name: string;
  phone: string;
  salonId?: string;
  lastVisit?: string | null;
  totalVisits?: number;
};

export function matchExistingClients(
  query: string,
  clients: QuickBookingClientMatch[],
  currentSalonId?: string
): QuickBookingClientMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return clients
    .filter((client) => (currentSalonId ? client.salonId === currentSalonId : true))
    .filter((client) => client.name.toLowerCase().includes(q))
    .slice(0, QUICK_BOOKING_SUGGESTION_LIMIT);
}

export function formatClientSuggestion(client: QuickBookingClientMatch): string {
  const phone = client.phone.trim();
  return phone ? `${client.name} + ${phone}` : client.name;
}

export function applyExistingClientSelection<T extends { clientName: string; phone: string; clientId: string | null }>(
  form: T,
  client: QuickBookingClientMatch
): T {
  return {
    ...form,
    clientId: client.id,
    clientName: client.name,
    phone: client.phone,
  };
}

export function applyClientNameQuery<T extends { clientName: string; clientId: string | null }>(
  form: T,
  clientName: string
): T {
  const next = { ...form, clientName };
  if (form.clientId && clientName !== form.clientName) {
    next.clientId = null;
  }
  return next;
}

export const normalizePhone = (phone: string) => phone.replace(/\D/g, '');

export type QuickBookingClientStore = {
  list: () => Promise<QuickBookingClientMatch[]>;
  create: (data: { name: string; phone: string; email: string; notes: string }) => Promise<{ id: string }>;
};

export function quickClientEmail(phone: string, now = Date.now()) {
  const digits = normalizePhone(phone);
  return `quick-client-${digits || now}@no-email.local`;
}

export async function resolveClientId(
  name: string,
  phone: string,
  existingClientId: string | null | undefined,
  store: QuickBookingClientStore
): Promise<string> {
  const clients = await store.list();

  if (existingClientId) {
    const selected = clients.find((c) => c.id === existingClientId);
    if (selected) return selected.id;
  }

  const trimmedName = name.trim();
  const trimmedPhone = phone.trim();
  const normalized = normalizePhone(trimmedPhone);
  const existing = clients.find((c) => normalizePhone(c.phone) === normalized);
  if (existing) return existing.id;

  const created = await store.create({
    name: trimmedName,
    phone: trimmedPhone,
    email: quickClientEmail(trimmedPhone),
    notes: '',
  });
  return created.id;
}
