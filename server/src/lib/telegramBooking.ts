import { supabase } from './supabase.js';
import { computeEndTime } from './mappers.js';

type ServiceRow = { id: string; name: string; duration: number; category: string };
export type StaffRow = { id: string; name: string; specialties: string[] };

export const STAFF_UNAVAILABLE_MESSAGE =
  'Для этой услуги пока не назначен мастер. Администратор свяжется с вами.';

export const BLOCKED_CLIENT_BOOKING_MESSAGE =
  'К сожалению, онлайн-запись для этого номера недоступна. Администратор свяжется с вами.';

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

function normalizeMatchText(value: string): string {
  return value.toLowerCase().trim();
}

function parseSpecializations(entries: string[] | null | undefined): string[] {
  return (entries ?? [])
    .flatMap((entry) => entry.split(','))
    .map((part) => normalizeMatchText(part))
    .filter(Boolean);
}

function serviceMatchesSpecialization(serviceName: string, specialization: string): boolean {
  const service = normalizeMatchText(serviceName);
  const spec = normalizeMatchText(specialization);
  if (!service || !spec) return false;
  return service.includes(spec) || spec.includes(service);
}

export function staffMatchesServiceSpecialization(
  member: StaffRow,
  serviceName: string
): boolean {
  const specs = parseSpecializations(member.specialties);
  return specs.some((spec) => serviceMatchesSpecialization(serviceName, spec));
}

async function fetchActiveStaff(): Promise<StaffRow[]> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, specialties')
    .eq('active', true)
    .order('name');

  if (error) {
    console.error('[telegram/staff] load error:', error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    specialties: row.specialties ?? [],
  }));
}

/** Active staff whose specialties match the selected Telegram service name. */
export async function findStaffForServiceSpecialization(
  serviceName: string
): Promise<StaffRow[]> {
  const trimmed = serviceName.trim();
  if (!trimmed || trimmed.toLowerCase() === 'manual') return [];

  const staffList = await fetchActiveStaff();
  return staffList.filter((member) => staffMatchesServiceSpecialization(member, trimmed));
}

export async function getActiveStaffById(staffId: string): Promise<StaffRow | null> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, specialties')
    .eq('id', staffId)
    .eq('active', true)
    .maybeSingle();

  if (error || !data) {
    console.error('[telegram/staff] lookup by id error:', error?.message);
    return null;
  }

  return {
    id: data.id,
    name: data.name,
    specialties: data.specialties ?? [],
  };
}

export function buildStaffSelectionKeyboard(
  staff: StaffRow[]
): { text: string; callback_data: string }[][] {
  const buttons = staff.map((member) => ({
    text: member.name,
    callback_data: `staff:${member.id}`,
  }));
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  return keyboard;
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
      { text: '💄 Макияж', callback_data: 'service:Макияж' },
      { text: '✍️ Другая услуга', callback_data: 'service:manual' },
    ],
  ];
}

/** Active appointments that occupy a time slot on a given date. */
export const ACTIVE_SLOT_STATUSES = ['scheduled', 'confirmed'] as const;
