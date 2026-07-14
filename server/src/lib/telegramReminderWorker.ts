/**
 * Telegram appointment reminder delivery worker (R1D).
 *
 * Claims due pending telegram reminders, validates context, sends one plain
 * text message via the salon bot, and updates reminder / appointment status.
 * No keyboards, no second poller, no global TELEGRAM_BOT_TOKEN fallback.
 */

import { randomUUID } from 'node:crypto';
import { zonedLocalDateTimeToUtc } from './appointmentReminders.js';
import { resolveTimezone } from './scheduleSlots.js';
import { supabase } from './supabase.js';

const LOG_PREFIX = '[telegram-reminders]';
const TELEGRAM_PROVIDER = 'telegram' as const;
const BATCH_LIMIT = 50;
const STALE_CLAIM_MS = 15 * 60 * 1000;
const DELIVERY_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SEND_DELAY_MS = 75;
const ERROR_MAX_LEN = 500;

export interface TelegramReminderWorkerOptions {
  /** When true: select + validate only — no claims, sends, or DB writes. */
  dryRun?: boolean;
}

export interface TelegramReminderWorkerResult {
  scanned: number;
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
  errors: string[];
}

type ReminderRow = {
  id: string;
  appointment_id: string;
  salon_id: string | null;
  scheduled_for: string;
  attempt_count: number;
  claim_token: string | null;
  claimed_at: string | null;
};

type AppointmentRow = {
  id: string;
  client_id: string;
  staff_id: string;
  service_id: string;
  date: string;
  start_time: string;
  status: string;
  salon_id: string | null;
};

type SalonRow = {
  id: string;
  name: string;
  language: string | null;
  timezone: string | null;
  active: boolean;
};

type GateOutcome =
  | { kind: 'send'; chatId: number; botToken: string; text: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string; permanent: boolean };

function truncateError(msg: string): string {
  return msg.length > ERROR_MAX_LEN ? msg.slice(0, ERROR_MAX_LEN) : msg;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayName(value: string | null | undefined, fallback: string): string {
  const t = value?.trim();
  return t || fallback;
}

function normalizeLang(raw: string | null | undefined): 'ru' | 'en' | 'hy' {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'en' || v.startsWith('en')) return 'en';
  if (v === 'hy' || v.startsWith('hy') || v === 'arm') return 'hy';
  return 'ru';
}

function formatLocalDate(ymd: string, lang: 'ru' | 'en' | 'hy'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const locale = lang === 'en' ? 'en-US' : lang === 'hy' ? 'hy-AM' : 'ru-RU';
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(utcNoon);
  } catch {
    return ymd;
  }
}

function formatLocalTime(startTime: string): string {
  const raw = startTime.trim();
  return raw.length >= 5 ? raw.slice(0, 5) : raw;
}

function buildReminderMessage(params: {
  language: string | null | undefined;
  salonName: string;
  staffName: string;
  serviceName: string;
  clientName: string;
  appointmentDate: string;
  startTime: string;
}): string {
  const lang = normalizeLang(params.language);
  const salon = displayName(params.salonName, lang === 'en' ? 'Salon' : lang === 'hy' ? 'Սրահ' : 'Салон');
  const staff = displayName(params.staffName, '—');
  const service = displayName(params.serviceName, '—');
  const client = displayName(params.clientName, lang === 'en' ? 'client' : lang === 'hy' ? 'հաճախորդ' : 'клиент');
  const date = formatLocalDate(params.appointmentDate, lang);
  const time = formatLocalTime(params.startTime);

  if (lang === 'en') {
    return [
      'Appointment reminder',
      '',
      `Salon: ${salon}`,
      `Master: ${staff}`,
      `Service: ${service}`,
      `Date: ${date}`,
      `Time: ${time}`,
      '',
      `See you soon, ${client}!`,
    ].join('\n');
  }

  if (lang === 'hy') {
    return [
      'Գրանցման հիշեցում',
      '',
      `Սրահ: ${salon}`,
      `Մասնագետ: ${staff}`,
      `Ծառայություն: ${service}`,
      `Ամսաթիվ: ${date}`,
      `Ժամ: ${time}`,
      '',
      `Սպասում ենք ձեզ, ${client}!`,
    ].join('\n');
  }

  return [
    'Напоминание о записи',
    '',
    `Салон: ${salon}`,
    `Мастер: ${staff}`,
    `Услуга: ${service}`,
    `Дата: ${date}`,
    `Время: ${time}`,
    '',
    `Ждём вас, ${client}!`,
  ].join('\n');
}

async function sendTelegramText(
  chatId: number,
  text: string,
  botToken: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = botToken.trim();
  if (!token) return { ok: false, error: 'empty bot token' };

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'network error';
    return { ok: false, error: msg };
  }

  let data: { ok?: boolean; description?: string } = {};
  try {
    data = (await response.json()) as { ok?: boolean; description?: string };
  } catch {
    return { ok: false, error: `telegram HTTP ${response.status}` };
  }

  if (!response.ok || !data.ok) {
    return { ok: false, error: data.description || `telegram HTTP ${response.status}` };
  }
  return { ok: true };
}

function claimOrFilter(staleCutoffIso: string): string {
  // Quote the ISO timestamp — unquoted values break on ':' in PostgREST filters.
  return `claim_token.is.null,claimed_at.lt."${staleCutoffIso}"`;
}

async function selectDueCandidates(nowIso: string, windowStartIso: string, staleCutoffIso: string): Promise<ReminderRow[]> {
  const { data, error } = await (supabase as any)
    .from('reminders')
    .select('id, appointment_id, salon_id, scheduled_for, attempt_count, claim_token, claimed_at')
    .eq('type', 'telegram')
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso)
    .gte('scheduled_for', windowStartIso)
    .or(claimOrFilter(staleCutoffIso))
    .order('scheduled_for', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new Error(`select due reminders: ${error.message}`);
  }
  return (data ?? []) as ReminderRow[];
}

async function selectTooLateCandidates(windowStartIso: string): Promise<ReminderRow[]> {
  const { data, error } = await (supabase as any)
    .from('reminders')
    .select('id, appointment_id, salon_id, scheduled_for, attempt_count, claim_token, claimed_at')
    .eq('type', 'telegram')
    .eq('status', 'pending')
    .lt('scheduled_for', windowStartIso)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new Error(`select too-late reminders: ${error.message}`);
  }
  return (data ?? []) as ReminderRow[];
}

async function claimReminder(row: ReminderRow, staleCutoffIso: string): Promise<(ReminderRow & { claim_token: string }) | null> {
  const claimToken = randomUUID();
  const nowIso = new Date().toISOString();
  const nextAttempts = (row.attempt_count ?? 0) + 1;

  const { data, error } = await (supabase as any)
    .from('reminders')
    .update({
      claim_token: claimToken,
      claimed_at: nowIso,
      attempt_count: nextAttempts,
    })
    .eq('id', row.id)
    .eq('status', 'pending')
    .eq('type', 'telegram')
    .or(claimOrFilter(staleCutoffIso))
    .select('id, appointment_id, salon_id, scheduled_for, attempt_count, claim_token, claimed_at')
    .maybeSingle();

  if (error) {
    throw new Error(`claim reminder ${row.id}: ${error.message}`);
  }
  if (!data || !data.claim_token) return null;
  return data as ReminderRow & { claim_token: string };
}

async function markSkipped(
  id: string,
  claimToken: string | null,
  reason: string,
  requireClaim: boolean
): Promise<void> {
  let q = (supabase as any)
    .from('reminders')
    .update({
      status: 'skipped',
      last_error: truncateError(reason),
      claim_token: null,
      claimed_at: null,
    })
    .eq('id', id)
    .eq('status', 'pending');

  if (requireClaim && claimToken) {
    q = q.eq('claim_token', claimToken);
  }

  const { error } = await q;
  if (error) {
    throw new Error(`mark skipped ${id}: ${error.message}`);
  }
}

async function markFailed(id: string, claimToken: string, reason: string): Promise<void> {
  const { error } = await (supabase as any)
    .from('reminders')
    .update({
      status: 'failed',
      last_error: truncateError(reason),
      claim_token: null,
      claimed_at: null,
    })
    .eq('id', id)
    .eq('claim_token', claimToken)
    .eq('status', 'pending');

  if (error) {
    throw new Error(`mark failed ${id}: ${error.message}`);
  }
}

async function markRetryPending(id: string, claimToken: string, reason: string): Promise<void> {
  const { error } = await (supabase as any)
    .from('reminders')
    .update({
      status: 'pending',
      last_error: truncateError(reason),
      claim_token: null,
      claimed_at: null,
    })
    .eq('id', id)
    .eq('claim_token', claimToken)
    .eq('status', 'pending');

  if (error) {
    throw new Error(`clear claim for retry ${id}: ${error.message}`);
  }
}

/**
 * Prove exactly one pending row owned by claimToken transitioned to sent.
 * Zero rows (claim lost / superseded) returns false — not treated as success.
 */
async function markSent(id: string, claimToken: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data, error } = await (supabase as any)
    .from('reminders')
    .update({
      status: 'sent',
      sent_at: nowIso,
      last_error: null,
      claim_token: null,
      claimed_at: null,
    })
    .eq('id', id)
    .eq('type', 'telegram')
    .eq('claim_token', claimToken)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`mark sent ${id}: ${error.message}`);
  }
  return Boolean(data?.id);
}

/** Skip a too-late row only if unclaimed or stale-claimed. Fresh claims are left alone. */
async function skipTooLateIfUnowned(id: string, staleCutoffIso: string): Promise<boolean> {
  const { data, error } = await (supabase as any)
    .from('reminders')
    .update({
      status: 'skipped',
      last_error: truncateError('too late to send reminder'),
      claim_token: null,
      claimed_at: null,
    })
    .eq('id', id)
    .eq('type', 'telegram')
    .eq('status', 'pending')
    .or(claimOrFilter(staleCutoffIso))
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`too-late skip ${id}: ${error.message}`);
  }
  return Boolean(data?.id);
}

async function markAppointmentReminderSent(appointmentId: string, salonId: string): Promise<void> {
  const { error } = await supabase
    .from('appointments')
    .update({ reminder_sent: true })
    .eq('id', appointmentId)
    .eq('salon_id', salonId);

  if (error) {
    console.warn(
      `${LOG_PREFIX} reminder_sent update failed appointment=${appointmentId}: ${error.message}`
    );
  }
}

async function evaluateReminder(row: ReminderRow): Promise<GateOutcome> {
  if (!row.salon_id) {
    return { kind: 'skip', reason: 'missing salon_id on reminder' };
  }
  if (!row.appointment_id) {
    return { kind: 'skip', reason: 'missing appointment_id on reminder' };
  }

  const salonId = row.salon_id;
  const appointmentId = row.appointment_id;

  const { data: appointment, error: apptErr } = await supabase
    .from('appointments')
    .select('id, client_id, staff_id, service_id, date, start_time, status, salon_id')
    .eq('id', appointmentId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (apptErr) {
    return { kind: 'fail', reason: `appointment query failed: ${apptErr.message}`, permanent: true };
  }
  if (!appointment) {
    return { kind: 'skip', reason: 'appointment missing' };
  }

  const appt = appointment as AppointmentRow;
  if (appt.status !== 'scheduled') {
    return { kind: 'skip', reason: `appointment status=${appt.status}` };
  }

  const { data: salon, error: salonErr } = await supabase
    .from('salons')
    .select('id, name, language, timezone, active')
    .eq('id', salonId)
    .maybeSingle();

  if (salonErr) {
    return { kind: 'fail', reason: `salon query failed: ${salonErr.message}`, permanent: true };
  }
  if (!salon) {
    return { kind: 'skip', reason: 'salon missing' };
  }

  const salonRow = salon as SalonRow;
  if (!salonRow.active) {
    return { kind: 'skip', reason: 'salon inactive' };
  }

  const timeZone = resolveTimezone(salonRow.timezone);
  const appointmentUtc = zonedLocalDateTimeToUtc(appt.date, appt.start_time, timeZone);
  if (!appointmentUtc || Number.isNaN(appointmentUtc.getTime())) {
    return { kind: 'fail', reason: 'invalid appointment local datetime', permanent: true };
  }
  if (appointmentUtc.getTime() <= Date.now()) {
    return { kind: 'skip', reason: 'appointment already past' };
  }

  const { data: client, error: clientErr } = await (supabase as any)
    .from('clients')
    .select('id, name, telegram_chat_id')
    .eq('id', appt.client_id)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (clientErr) {
    return { kind: 'fail', reason: `client query failed: ${clientErr.message}`, permanent: true };
  }
  if (!client) {
    return { kind: 'fail', reason: 'client missing', permanent: true };
  }

  if (client.telegram_chat_id == null) {
    return { kind: 'skip', reason: 'no telegram_chat_id' };
  }
  const chatId = Number(client.telegram_chat_id);
  if (!Number.isFinite(chatId)) {
    return { kind: 'skip', reason: 'invalid telegram_chat_id' };
  }

  const { data: staff, error: staffErr } = await supabase
    .from('staff')
    .select('id, name')
    .eq('id', appt.staff_id)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (staffErr) {
    return { kind: 'fail', reason: `staff query failed: ${staffErr.message}`, permanent: true };
  }
  if (!staff) {
    return { kind: 'fail', reason: 'staff missing', permanent: true };
  }

  const { data: service, error: serviceErr } = await supabase
    .from('services')
    .select('id, name')
    .eq('id', appt.service_id)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (serviceErr) {
    return { kind: 'fail', reason: `service query failed: ${serviceErr.message}`, permanent: true };
  }
  if (!service) {
    return { kind: 'fail', reason: 'service missing', permanent: true };
  }

  const { data: integration, error: integErr } = await supabase
    .from('salon_integrations')
    .select('token_ciphertext, status')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  if (integErr) {
    return { kind: 'fail', reason: `integration query failed: ${integErr.message}`, permanent: true };
  }
  if (!integration) {
    return { kind: 'fail', reason: 'no telegram integration', permanent: true };
  }
  if (integration.status !== 'connected') {
    return { kind: 'fail', reason: `telegram status=${integration.status}`, permanent: true };
  }

  const botToken = integration.token_ciphertext?.trim() ?? '';
  if (!botToken) {
    return { kind: 'fail', reason: 'missing bot token', permanent: true };
  }

  const text = buildReminderMessage({
    language: salonRow.language,
    salonName: salonRow.name,
    staffName: staff.name,
    serviceName: service.name,
    clientName: client.name,
    appointmentDate: appt.date,
    startTime: appt.start_time,
  });

  return { kind: 'send', chatId, botToken, text };
}

async function processTooLate(
  dryRun: boolean,
  result: TelegramReminderWorkerResult,
  windowStartIso: string,
  staleCutoffIso: string
): Promise<void> {
  const late = await selectTooLateCandidates(windowStartIso);
  result.scanned += late.length;

  for (const row of late) {
    if (dryRun) {
      result.skipped += 1;
      continue;
    }
    try {
      const skipped = await skipTooLateIfUnowned(row.id, staleCutoffIso);
      if (!skipped) {
        // Fresh claim owns this row — leave it for the claim holder.
        continue;
      }
      result.skipped += 1;
      console.log(`${LOG_PREFIX} skipped too-late id=${row.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'too-late update failed';
      result.failed += 1;
      result.errors.push(`too-late id=${row.id}: ${msg}`);
      console.warn(`${LOG_PREFIX} ${msg}`);
    }
  }
}

async function processDueCandidate(
  row: ReminderRow,
  dryRun: boolean,
  staleCutoffIso: string,
  result: TelegramReminderWorkerResult
): Promise<void> {
  if (dryRun) {
    const gate = await evaluateReminder(row);
    if (gate.kind === 'send') result.sent += 1;
    else if (gate.kind === 'skip') result.skipped += 1;
    else {
      result.failed += 1;
      result.errors.push(`dryRun id=${row.id}: ${gate.reason}`);
    }
    return;
  }

  const claimed = await claimReminder(row, staleCutoffIso);
  if (!claimed) {
    return;
  }
  result.claimed += 1;

  // Authoritative checks only after a successful claim.
  const afterClaim = await evaluateReminder(claimed);

  if (afterClaim.kind === 'skip') {
    await markSkipped(claimed.id, claimed.claim_token, afterClaim.reason, true);
    result.skipped += 1;
    console.log(`${LOG_PREFIX} skipped id=${claimed.id} reason=${afterClaim.reason}`);
    return;
  }

  if (afterClaim.kind === 'fail') {
    await markFailed(claimed.id, claimed.claim_token, afterClaim.reason);
    result.failed += 1;
    result.errors.push(`id=${claimed.id}: ${afterClaim.reason}`);
    console.warn(`${LOG_PREFIX} failed id=${claimed.id}: ${afterClaim.reason}`);
    return;
  }

  const sendResult = await sendTelegramText(afterClaim.chatId, afterClaim.text, afterClaim.botToken);
  if (sendResult.ok) {
    const marked = await markSent(claimed.id, claimed.claim_token);
    if (!marked) {
      const ownershipLost = `telegram delivered but claim lost before markSent id=${claimed.id}`;
      result.failed += 1;
      result.errors.push(ownershipLost);
      console.warn(`${LOG_PREFIX} ${ownershipLost}`);
      return;
    }
    result.sent += 1;
    if (claimed.salon_id) {
      await markAppointmentReminderSent(claimed.appointment_id, claimed.salon_id);
    }
    console.log(`${LOG_PREFIX} sent id=${claimed.id} appointment=${claimed.appointment_id}`);
    await sleep(SEND_DELAY_MS);
    return;
  }

  const errText = sendResult.error;
  if (claimed.attempt_count >= MAX_ATTEMPTS) {
    await markFailed(claimed.id, claimed.claim_token, errText);
    result.failed += 1;
    result.errors.push(`id=${claimed.id}: ${errText}`);
    console.warn(`${LOG_PREFIX} failed after max attempts id=${claimed.id}: ${errText}`);
    return;
  }

  await markRetryPending(claimed.id, claimed.claim_token, errText);
  result.retried += 1;
  result.errors.push(`id=${claimed.id} retry: ${errText}`);
  console.warn(`${LOG_PREFIX} transient id=${claimed.id}: ${errText}`);
}

/**
 * Process due (and too-late) telegram appointment reminders.
 */
export async function runTelegramReminderWorker(
  options: TelegramReminderWorkerOptions = {}
): Promise<TelegramReminderWorkerResult> {
  const dryRun = options.dryRun === true;
  const result: TelegramReminderWorkerResult = {
    scanned: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    errors: [],
  };

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const windowStartIso = new Date(nowMs - DELIVERY_WINDOW_MS).toISOString();
  const staleCutoffIso = new Date(nowMs - STALE_CLAIM_MS).toISOString();

  await processTooLate(dryRun, result, windowStartIso, staleCutoffIso);

  const candidates = await selectDueCandidates(nowIso, windowStartIso, staleCutoffIso);
  result.scanned += candidates.length;

  for (const row of candidates) {
    try {
      await processDueCandidate(row, dryRun, staleCutoffIso, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown reminder error';
      result.failed += 1;
      result.errors.push(`id=${row.id}: ${msg}`);
      console.warn(`${LOG_PREFIX} error id=${row.id}: ${msg}`);
    }
  }

  return result;
}
