import { supabase } from './supabase.js';
import { computeEndTime } from './mappers.js';

type ServiceRow = { id: string; name: string; duration: number; category: string };
export type StaffRow = { id: string; name: string; specialties: string[] };

export const STAFF_UNAVAILABLE_MESSAGE =
  'Для этой услуги пока не назначен мастер. Администратор свяжется с вами.';

export const BLOCKED_CLIENT_BOOKING_MESSAGE =
  'К сожалению, онлайн-запись для этого номера недоступна. Администратор свяжется с вами.';

export const BIRTHDAY_PROMPT_MESSAGE =
  'Хотите указать день рождения, чтобы мы могли подготовить для вас приятный бонус? Напишите дату в формате ДД.ММ.ГГГГ или нажмите Пропустить.';

export const BIRTHDAY_INVALID_MESSAGE =
  'Не удалось распознать дату. Введите в формате ДД.ММ.ГГГГ или нажмите Пропустить.';

export const BIRTHDAY_SAVED_MESSAGE = 'Спасибо! Сохранили ваш день рождения 🎂';

export const BIRTHDAY_SKIPPED_MESSAGE = 'Хорошо! Будем ждать вас!';

/** Parse DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY into YYYY-MM-DD. */
export function parseBirthdayDate(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > new Date().getFullYear()) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getBirthdaySkipKeyboard(): { text: string; callback_data: string }[][] {
  return [[{ text: 'Пропустить', callback_data: 'birthday:skip' }]];
}

export function localDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function fetchActiveServices(salonId: string): Promise<ServiceRow[]> {
  const { data, error } = await supabase
    .from('services')
    .select('id, name, duration, category')
    .eq('salon_id', salonId)
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

async function fetchActiveStaff(salonId: string): Promise<StaffRow[]> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, specialties')
    .eq('salon_id', salonId)
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

/** Active staff for a service: prefer staff_services assignments, else specialties text match. */
export async function findStaffForServiceSpecialization(
  salonId: string,
  serviceName: string
): Promise<StaffRow[]> {
  const trimmed = serviceName.trim();
  if (!trimmed || trimmed.toLowerCase() === 'manual') return [];

  // Prefer stable join-table assignments when the service exists in this salon.
  const { data: service, error: serviceError } = await supabase
    .from('services')
    .select('id')
    .eq('salon_id', salonId)
    .ilike('name', trimmed)
    .maybeSingle();

  if (serviceError) {
    console.error('[telegram/staff] service resolve for assignments error:', serviceError.message);
  } else if (service?.id) {
    const { data: assignmentRows, error: assignmentError } = await (supabase as any)
      .from('staff_services')
      .select('staff_id')
      .eq('salon_id', salonId)
      .eq('service_id', service.id);

    if (assignmentError) {
      console.error('[telegram/staff] staff_services load error:', assignmentError.message);
    } else if (assignmentRows && assignmentRows.length > 0) {
      const assignedIds = [
        ...new Set(
          (assignmentRows as Array<{ staff_id: string }>).map((row) => row.staff_id)
        ),
      ] as string[];
      const { data: assignedStaff, error: staffError } = await supabase
        .from('staff')
        .select('id, name, specialties')
        .eq('salon_id', salonId)
        .eq('active', true)
        .in('id', assignedIds)
        .order('name');

      if (staffError) {
        console.error('[telegram/staff] assigned staff load error:', staffError.message);
      } else if (assignedStaff && assignedStaff.length > 0) {
        return assignedStaff.map((row) => ({
          id: row.id,
          name: row.name,
          specialties: row.specialties ?? [],
        }));
      }
      // Assignments exist but no active staff — do not fall back to specialties
      // (explicit empty assignment should win over fuzzy text match).
      return [];
    }
  }

  // Fallback: legacy specialties text matching (protects Tatev until assignments exist).
  const staffList = await fetchActiveStaff(salonId);
  return staffList.filter((member) => staffMatchesServiceSpecialization(member, trimmed));
}

export async function getActiveStaffById(salonId: string, staffId: string): Promise<StaffRow | null> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, specialties')
    .eq('id', staffId)
    .eq('salon_id', salonId)
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
export async function resolveServiceByName(salonId: string, serviceName: string): Promise<ServiceRow | null> {
  const trimmed = serviceName.trim();
  if (!trimmed || trimmed.toLowerCase() === 'manual') return null;

  const { data: existing, error: lookupError } = await supabase
    .from('services')
    .select('id, name, duration, category')
    .eq('salon_id', salonId)
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
      salon_id: salonId,
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

/** Resolve active/inactive service by id within salon (no cross-salon). */
export async function resolveServiceById(
  salonId: string,
  serviceId: string
): Promise<ServiceRow | null> {
  const trimmed = serviceId.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase
    .from('services')
    .select('id, name, duration, category')
    .eq('salon_id', salonId)
    .eq('id', trimmed)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error('[telegram/services] lookup by id error:', error.message);
    return null;
  }
  return data ?? null;
}

export function computeAppointmentEndTime(startTime: string, durationMinutes: number): string {
  return `${computeEndTime(startTime, durationMinutes)}:00`;
}

/** Legacy hardcoded keyboard — Tatev / zero-catalog / load-error fallback. */
export function buildLegacyServiceKeyboard(): { text: string; callback_data: string }[][] {
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

const TELEGRAM_BUTTON_TEXT_MAX = 60;

function truncateTelegramButtonText(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= TELEGRAM_BUTTON_TEXT_MAX) return trimmed;
  return `${trimmed.slice(0, TELEGRAM_BUTTON_TEXT_MAX - 1)}…`;
}

/**
 * Salon-specific service keyboard from active catalog.
 * Uses service_id:<uuid> (safe under Telegram 64-byte callback_data limit).
 * Falls back to legacy hardcoded keyboard when catalog empty or load fails.
 * Ordering: fetchActiveServices already orders by name ascending.
 */
export async function buildServiceKeyboard(
  salonId: string
): Promise<{ text: string; callback_data: string }[][]> {
  try {
    const services = await fetchActiveServices(salonId);
    if (services.length === 0) {
      return buildLegacyServiceKeyboard();
    }

    const buttons = services.map((service) => ({
      text: truncateTelegramButtonText(service.name),
      callback_data: `service_id:${service.id}`,
    }));

    const keyboard: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2));
    }
    keyboard.push([{ text: '✍️ Другая услуга', callback_data: 'service:manual' }]);
    return keyboard;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown error';
    console.error('[telegram/services] buildServiceKeyboard failed:', errMsg);
    return buildLegacyServiceKeyboard();
  }
}

/** Active appointments that occupy a time slot on a given date. */
export const ACTIVE_SLOT_STATUSES = ['scheduled', 'confirmed'] as const;
