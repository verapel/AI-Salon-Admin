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

/** Exact name match; creates a placeholder service when missing (Telegram booking). */
export async function resolveServiceByName(serviceName: string): Promise<ServiceRow | null> {
  const trimmed = serviceName.trim();
  if (!trimmed || trimmed.toLowerCase() === 'manual') return null;

  const { data: existing, error: lookupError } = await supabase
    .from('services')
    .select('id, name, duration, category')
    .ilike('name', trimmed)
    .maybeSingle();

  if (lookupError) {
    console.error('[telegram/services] lookup error:', lookupError.message);
    return null;
  }
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from('services')
    .insert({
      name: trimmed,
      description: '',
      duration: 60,
      price: 0,
      category: 'Other',
      active: true,
    })
    .select('id, name, duration, category')
    .single();

  if (insertError || !created) {
    console.error('[telegram/services] create error:', insertError?.message);
    return null;
  }

  return created;
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
