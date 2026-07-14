import { supabase } from './supabase.js';
import { getSalonTimezone, resolveTimezone } from './scheduleSlots.js';

const HHMM_RE = /^\d{2}:\d{2}$/;

export type AppointmentReminderStatus = 'pending' | 'skipped';

export interface AppointmentReminderFields {
  type: 'telegram';
  scheduledFor: string;
  status: AppointmentReminderStatus;
  message: string;
}

/** Normalize TIME / HH:MM(:SS) to HH:MM. */
export function normalizeStartHhMm(startTime: string): string | null {
  const raw = startTime.trim();
  const slice = raw.length >= 5 ? raw.slice(0, 5) : raw;
  if (!HHMM_RE.test(slice)) return null;
  const [h, m] = slice.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return slice;
}

/**
 * Convert salon-local calendar date + HH:MM to a UTC Date.
 * Reuses IANA timezone resolution from scheduleSlots.
 */
export function zonedLocalDateTimeToUtc(
  dateYmd: string,
  startHhMm: string,
  timeZoneRaw: string
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return null;
  const hhmm = normalizeStartHhMm(startHhMm);
  if (!hhmm) return null;

  const timeZone = resolveTimezone(timeZoneRaw);
  const [y, mo, d] = dateYmd.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  const desiredAsUtcMs = Date.UTC(y, mo - 1, d, hh, mi, 0);

  // Iteratively correct UTC guess so wall clock in `timeZone` matches desired local time.
  let guess = desiredAsUtcMs;
  for (let i = 0; i < 4; i++) {
    const wallMs = wallTimeAsUtcMs(new Date(guess), timeZone);
    if (wallMs === null) return null;
    const delta = desiredAsUtcMs - wallMs;
    guess += delta;
    if (delta === 0) break;
  }

  return new Date(guess);
}

function wallTimeAsUtcMs(instant: Date, timeZone: string): number | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  if (!map.year || !map.month || !map.day || !map.hour || !map.minute) return null;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  return Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second ?? '0')
  );
}

/**
 * Build telegram reminder fields: scheduled_for = appointment local time − 24h (UTC ISO).
 * If that instant is already past (appointment within 24h), status = skipped.
 */
export async function buildAppointmentReminderFields(params: {
  salonId: string;
  appointmentDate: string;
  startTime: string;
}): Promise<AppointmentReminderFields | null> {
  const hhmm = normalizeStartHhMm(params.startTime);
  if (!hhmm) return null;

  const timeZone = await getSalonTimezone(params.salonId);
  const appointmentUtc = zonedLocalDateTimeToUtc(params.appointmentDate, hhmm, timeZone);
  if (!appointmentUtc || Number.isNaN(appointmentUtc.getTime())) return null;

  const scheduledForDate = new Date(appointmentUtc.getTime() - 24 * 60 * 60 * 1000);
  const scheduledFor = scheduledForDate.toISOString();
  const now = Date.now();
  const status: AppointmentReminderStatus =
    scheduledForDate.getTime() > now ? 'pending' : 'skipped';

  return {
    type: 'telegram',
    scheduledFor,
    status,
    message: `Reminder: Your appointment on ${params.appointmentDate} at ${hhmm}`,
  };
}

/** Insert or update the single pending telegram reminder for an appointment. */
export async function syncAppointmentReminder(params: {
  salonId: string;
  appointmentId: string;
  appointmentDate: string;
  startTime: string;
}): Promise<void> {
  const fields = await buildAppointmentReminderFields(params);
  if (!fields) {
    console.error('[appointmentReminders] invalid schedule inputs', {
      appointmentId: params.appointmentId,
      date: params.appointmentDate,
    });
    return;
  }

  const row = {
    type: fields.type,
    scheduled_for: fields.scheduledFor,
    status: fields.status,
    message: fields.message,
    salon_id: params.salonId,
    // Clear any stale claim when rescheduling.
    claimed_at: null as string | null,
    claim_token: null as string | null,
    last_error: fields.status === 'skipped' ? 'skipped: less than 24 hours before appointment' : null,
  };

  const { data: updatedPending, error: updatePendingError } = await (supabase as any)
    .from('reminders')
    .update(row)
    .eq('appointment_id', params.appointmentId)
    .eq('salon_id', params.salonId)
    .eq('status', 'pending')
    .select('id');

  if (updatePendingError) {
    console.error('[appointmentReminders] update pending error:', updatePendingError.message);
    return;
  }
  if (Array.isArray(updatedPending) && updatedPending.length > 0) {
    return;
  }

  // No pending row: insert (new booking, or re-schedule after previous skip/fail).
  const { error: insertError } = await (supabase as any).from('reminders').insert({
    appointment_id: params.appointmentId,
    ...row,
  });

  if (insertError) {
    console.error('[appointmentReminders] insert error:', insertError.message);
  }
}

/** Mark pending reminders skipped when appointment is cancelled. */
export async function skipPendingRemindersForAppointment(params: {
  salonId: string;
  appointmentId: string;
}): Promise<void> {
  const { error } = await (supabase as any)
    .from('reminders')
    .update({
      status: 'skipped',
      last_error: 'skipped: appointment cancelled',
      claimed_at: null,
      claim_token: null,
    })
    .eq('appointment_id', params.appointmentId)
    .eq('salon_id', params.salonId)
    .eq('status', 'pending');

  if (error) {
    console.error('[appointmentReminders] skip on cancel error:', error.message);
  }
}

/** Persist durable Telegram chat id; never writes null. */
export async function persistClientTelegramChatId(params: {
  salonId: string;
  clientId: string;
  chatId: number;
}): Promise<void> {
  if (!Number.isFinite(params.chatId)) return;

  const { error } = await (supabase as any)
    .from('clients')
    .update({ telegram_chat_id: params.chatId })
    .eq('id', params.clientId)
    .eq('salon_id', params.salonId);

  if (error) {
    console.error('[appointmentReminders] telegram_chat_id persist error:', error.message);
  }
}
