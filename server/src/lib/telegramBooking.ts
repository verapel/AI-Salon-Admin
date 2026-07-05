import { supabase } from './supabase.js';
import { computeEndTime } from './mappers.js';

type ServiceRow = { id: string; name: string; duration: number; category: string };
type StaffRow = { id: string; name: string };

const TATEV_NAME_ALIASES = ['татев', 'tatev'];
const MAYA_NAME_ALIASES = ['мая', 'maya'];

function normalizeStaffLookup(value: string): string {
  return value.toLowerCase().trim();
}

function staffNameMatches(memberName: string, aliases: string[]): boolean {
  const normalized = normalizeStaffLookup(memberName);
  return aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized));
}

function staffTargetForService(serviceName: string): 'maya' | 'tatev' {
  const normalized = normalizeStaffLookup(serviceName);
  if (normalized.includes('макияж') || normalized.includes('makeup')) {
    return 'maya';
  }
  return 'tatev';
}

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

/** Assign staff by Telegram service choice — no client prompt. */
export async function resolveStaffForTelegramBooking(serviceName: string): Promise<StaffRow | null> {
  const { data: staffList, error } = await supabase
    .from('staff')
    .select('id, name')
    .eq('active', true);

  if (error || !staffList?.length) {
    console.error('[telegram/staff] load error:', error?.message);
    return null;
  }

  const target = staffTargetForService(serviceName);
  const aliases = target === 'maya' ? MAYA_NAME_ALIASES : TATEV_NAME_ALIASES;
  const matched = staffList.find((member) => staffNameMatches(member.name, aliases));

  if (matched) return matched;

  console.warn(
    `[telegram/staff] no ${target} match for service "${serviceName}", using fallback staff`
  );
  return staffList[0];
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
