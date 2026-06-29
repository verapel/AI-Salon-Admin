import { supabase } from './supabase.js';
import { computeEndTime } from './mappers.js';

type ServiceRow = { id: string; name: string; duration: number; category: string };
type StaffRow = { id: string; specialties: string[] | null };

export function localDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function fetchActiveServices(): Promise<ServiceRow[]> {
  const { data, error } = await supabase
    .from('services')
    .select('id, name, duration, category')
    .eq('active', true)
    .order('name');

  if (error) {
    console.error('[telegram/services] load error:', error.message);
    return [];
  }

  return data ?? [];
}

export async function resolveServiceByName(serviceName: string): Promise<ServiceRow | null> {
  const services = await fetchActiveServices();
  if (services.length === 0) return null;

  const normalized = serviceName.toLowerCase().trim();
  if (!normalized || normalized === 'manual') return services[0];

  const exact = services.find((s) => s.name.toLowerCase() === normalized);
  if (exact) return exact;

  const partial = services.find(
    (s) =>
      s.name.toLowerCase().includes(normalized) || normalized.includes(s.name.toLowerCase())
  );
  if (partial) return partial;

  const byCategory = services.find((s) => s.category.toLowerCase().includes(normalized));
  return byCategory ?? services[0];
}

export async function resolveStaffForService(service: ServiceRow): Promise<StaffRow | null> {
  const { data: staffList, error } = await supabase
    .from('staff')
    .select('id, specialties')
    .eq('active', true);

  if (error || !staffList?.length) {
    console.error('[telegram/staff] load error:', error?.message);
    return null;
  }

  const serviceLower = service.name.toLowerCase();
  const categoryLower = service.category.toLowerCase();

  const matched = staffList.find((member) =>
    (member.specialties ?? []).some((spec) => {
      const specLower = spec.toLowerCase();
      return (
        serviceLower.includes(specLower) ||
        specLower.includes(serviceLower) ||
        categoryLower.includes(specLower) ||
        specLower.includes(categoryLower)
      );
    })
  );

  return matched ?? staffList[0];
}

export function computeAppointmentEndTime(startTime: string, durationMinutes: number): string {
  return `${computeEndTime(startTime, durationMinutes)}:00`;
}

export async function buildServiceKeyboard(): Promise<{ text: string; callback_data: string }[][]> {
  const services = await fetchActiveServices();
  const buttons: { text: string; callback_data: string }[] = services
    .slice(0, 8)
    .map((s) => ({ text: s.name, callback_data: `service:${s.name}` }));

  buttons.push({ text: '✍️ Другая услуга', callback_data: 'service:manual' });

  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }

  return keyboard;
}

/** Active appointments that occupy a time slot on a given date. */
export const ACTIVE_SLOT_STATUSES = ['scheduled', 'confirmed'] as const;
