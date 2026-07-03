import { supabase } from './supabase.js';
import { computeEndTime } from './mappers.js';

type ServiceRow = { id: string; name: string; duration: number; category: string };
type StaffRow = { id: string; specialties: string[] | null };

const MAIN_CATEGORY_KEYWORDS: Record<string, string[]> = {
  стрижка: ['hair', 'haircut', 'cut', 'стрижка', 'blowout', 'style'],
  окрашивание: ['color', 'colour', 'balayage', 'окрашивание', 'highlight'],
  маникюр: ['nail', 'manicure', 'маникюр', 'pedicure'],
};

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

function matchMainCategory(normalized: string, services: ServiceRow[]): ServiceRow | null {
  const keywords = MAIN_CATEGORY_KEYWORDS[normalized];
  if (!keywords) return null;

  return (
    services.find((s) => {
      const nameLower = s.name.toLowerCase();
      const catLower = s.category.toLowerCase();
      return keywords.some((k) => nameLower.includes(k) || catLower.includes(k));
    }) ?? null
  );
}

export async function resolveServiceByName(serviceName: string): Promise<ServiceRow | null> {
  const services = await fetchActiveServices();
  if (services.length === 0) return null;

  const normalized = serviceName.toLowerCase().trim();
  if (!normalized || normalized === 'manual') return services[0];

  const mainCategory = matchMainCategory(normalized, services);
  if (mainCategory) return mainCategory;

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
  return [
    [
      { text: '✂️ Стрижка', callback_data: 'service:Стрижка' },
      { text: '🎨 Окрашивание', callback_data: 'service:Окрашивание' },
    ],
    [
      { text: '💅 Маникюр', callback_data: 'service:Маникюр' },
      { text: '✍️ Другая услуга', callback_data: 'service:manual' },
    ],
  ];
}

/** Active appointments that occupy a time slot on a given date. */
export const ACTIVE_SLOT_STATUSES = ['scheduled', 'confirmed'] as const;
