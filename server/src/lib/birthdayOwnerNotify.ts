/**
 * Daily owner birthday notifications (1 day before).
 *
 * Leap-day rule (MVP):
 * In a non-leap year, clients with birthday February 29 are notified when
 * "tomorrow" is February 28 (same day as Feb 28 birthdays).
 *
 * Does not use TELEGRAM_CHAT_ID fallback — salon bot + admin_chat_id only.
 */

import { dateStrInTimezone, resolveTimezone } from './scheduleSlots.js';
import { supabase } from './supabase.js';

const NOTIFY_OFFSET_DAYS = 1;
const TELEGRAM_PROVIDER = 'telegram' as const;
const LOG_PREFIX = '[birthday-owner-notify]';

export interface BirthdayOwnerNotifyOptions {
  /** When true: match only — no Telegram sends and no DB writes. */
  dryRun?: boolean;
}

export interface BirthdayOwnerNotifyResult {
  salonsChecked: number;
  clientsMatched: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
}

type TrackingStatus = 'pending' | 'processing' | 'sent' | 'failed';

interface SalonRow {
  id: string;
  timezone: string | null;
  active: boolean;
}

interface ClientRow {
  id: string;
  name: string;
  phone: string | null;
  birthday: string;
  salon_id: string | null;
}

interface TrackingRow {
  id: string;
  salon_id: string;
  client_id: string;
  occurrence_year: number;
  notify_offset_days: number;
  status: TrackingStatus;
  attempt_count: number;
  last_error: string | null;
}

interface SalonTelegramDelivery {
  botToken: string;
  adminChatId: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function monthDay(ymd: string): string {
  return ymd.slice(5, 10);
}

/**
 * Whether a client's birthday (YYYY-MM-DD) should notify for target "tomorrow" date.
 * Includes Feb 29 → Feb 28 in non-leap occurrence years.
 */
export function birthdayMatchesNotifyTarget(
  birthdayYmd: string,
  targetYmd: string,
  occurrenceYear: number
): boolean {
  const bMd = monthDay(birthdayYmd);
  const tMd = monthDay(targetYmd);
  if (bMd === tMd) return true;
  if (!isLeapYear(occurrenceYear) && tMd === '02-28' && bMd === '02-29') return true;
  return false;
}

function buildOwnerMessage(name: string, phone: string | null | undefined): string {
  const phoneLine = phone?.trim() ? phone.trim() : 'не указан';
  return [
    '🎂 Завтра день рождения клиента!',
    '',
    `👤 Клиент: ${name}`,
    `📞 Телефон: ${phoneLine}`,
    '🎁 Можно подготовить поздравление или бонус.',
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

async function loadActiveSalons(): Promise<SalonRow[]> {
  const { data, error } = await supabase
    .from('salons')
    .select('id, timezone, active')
    .eq('active', true);

  if (error) {
    throw new Error(`load active salons: ${error.message}`);
  }
  return (data ?? []) as SalonRow[];
}

async function loadSalonTelegramDelivery(salonId: string): Promise<
  | { ok: true; delivery: SalonTelegramDelivery }
  | { ok: false; reason: string }
> {
  const { data, error } = await supabase
    .from('salon_integrations')
    .select('token_ciphertext, admin_chat_id, status')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: `integration query failed: ${error.message}` };
  }
  if (!data) {
    return { ok: false, reason: 'no telegram integration' };
  }
  if (data.status !== 'connected') {
    return { ok: false, reason: `telegram status=${data.status}` };
  }

  const botToken = data.token_ciphertext?.trim() ?? '';
  if (!botToken) {
    return { ok: false, reason: 'missing bot token' };
  }

  if (data.admin_chat_id == null) {
    return { ok: false, reason: 'missing admin_chat_id' };
  }
  const adminChatId = Number(data.admin_chat_id);
  if (!Number.isFinite(adminChatId)) {
    return { ok: false, reason: 'invalid admin_chat_id' };
  }

  return { ok: true, delivery: { botToken, adminChatId } };
}

async function loadSalonClientsWithBirthday(salonId: string): Promise<ClientRow[]> {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, phone, birthday, salon_id')
    .eq('salon_id', salonId)
    .not('birthday', 'is', null);

  if (error) {
    throw new Error(`load clients salon=${salonId}: ${error.message}`);
  }

  return ((data ?? []) as Array<{
    id: string;
    name: string;
    phone: string | null;
    birthday: string | null;
    salon_id: string | null;
  }>)
    .filter((c): c is ClientRow => typeof c.birthday === 'string' && c.birthday.length >= 10)
    .map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      birthday: c.birthday.slice(0, 10),
      salon_id: c.salon_id,
    }));
}

async function findTrackingRow(
  salonId: string,
  clientId: string,
  occurrenceYear: number
): Promise<TrackingRow | null> {
  const { data, error } = await supabase
    .from('birthday_owner_notifications')
    .select('id, salon_id, client_id, occurrence_year, notify_offset_days, status, attempt_count, last_error')
    .eq('salon_id', salonId)
    .eq('client_id', clientId)
    .eq('occurrence_year', occurrenceYear)
    .eq('notify_offset_days', NOTIFY_OFFSET_DAYS)
    .maybeSingle();

  if (error) {
    throw new Error(`find tracking: ${error.message}`);
  }
  return (data as TrackingRow | null) ?? null;
}

async function insertPendingTracking(
  salonId: string,
  clientId: string,
  occurrenceYear: number
): Promise<TrackingRow> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('birthday_owner_notifications')
    .insert({
      salon_id: salonId,
      client_id: clientId,
      occurrence_year: occurrenceYear,
      notify_offset_days: NOTIFY_OFFSET_DAYS,
      status: 'pending',
      attempt_count: 0,
      created_at: now,
      updated_at: now,
    })
    .select('id, salon_id, client_id, occurrence_year, notify_offset_days, status, attempt_count, last_error')
    .single();

  if (error) {
    // Race: another worker inserted — re-read
    if (error.code === '23505') {
      const existing = await findTrackingRow(salonId, clientId, occurrenceYear);
      if (existing) return existing;
    }
    throw new Error(`insert tracking: ${error.message}`);
  }
  return data as TrackingRow;
}

async function claimForProcessing(row: TrackingRow): Promise<TrackingRow | null> {
  const now = new Date().toISOString();
  const nextAttempts = row.attempt_count + 1;

  const { data, error } = await supabase
    .from('birthday_owner_notifications')
    .update({
      status: 'processing',
      attempt_count: nextAttempts,
      last_error: null,
      updated_at: now,
    })
    .eq('id', row.id)
    .in('status', ['pending', 'failed'])
    .select('id, salon_id, client_id, occurrence_year, notify_offset_days, status, attempt_count, last_error')
    .maybeSingle();

  if (error) {
    throw new Error(`claim processing: ${error.message}`);
  }
  return (data as TrackingRow | null) ?? null;
}

async function markSent(rowId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('birthday_owner_notifications')
    .update({
      status: 'sent',
      sent_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq('id', rowId);

  if (error) {
    throw new Error(`mark sent: ${error.message}`);
  }
}

async function markFailed(rowId: string, lastError: string): Promise<void> {
  const now = new Date().toISOString();
  const safe = lastError.slice(0, 500);
  const { error } = await supabase
    .from('birthday_owner_notifications')
    .update({
      status: 'failed',
      last_error: safe,
      updated_at: now,
    })
    .eq('id', rowId);

  if (error) {
    throw new Error(`mark failed: ${error.message}`);
  }
}

async function processClient(params: {
  salonId: string;
  client: ClientRow;
  occurrenceYear: number;
  delivery: SalonTelegramDelivery;
  dryRun: boolean;
  result: BirthdayOwnerNotifyResult;
}): Promise<void> {
  const { salonId, client, occurrenceYear, delivery, dryRun, result } = params;

  // Explicit cross-salon guard (do not trust FKs alone)
  if (client.salon_id !== salonId) {
    result.skipped += 1;
    const msg = `cross-salon guard: client=${client.id} salon_id mismatch`;
    result.errors.push(msg);
    console.warn(`${LOG_PREFIX} ${msg}`);
    return;
  }

  if (dryRun) {
    result.skipped += 1;
    console.log(
      `${LOG_PREFIX} dryRun match salon=${salonId} client=${client.id} year=${occurrenceYear}`
    );
    return;
  }

  let row = await findTrackingRow(salonId, client.id, occurrenceYear);
  if (!row) {
    row = await insertPendingTracking(salonId, client.id, occurrenceYear);
  }

  if (row.status === 'sent') {
    result.skipped += 1;
    return;
  }

  if (row.status === 'processing') {
    // Another run may be in-flight; skip to avoid double-send (MVP).
    result.skipped += 1;
    console.warn(`${LOG_PREFIX} skip in-flight processing id=${row.id}`);
    return;
  }

  if (row.status !== 'pending' && row.status !== 'failed') {
    result.skipped += 1;
    return;
  }

  const claimed = await claimForProcessing(row);
  if (!claimed) {
    result.skipped += 1;
    return;
  }

  const message = buildOwnerMessage(client.name, client.phone);
  const sendResult = await sendTelegramText(delivery.adminChatId, message, delivery.botToken);

  if (sendResult.ok) {
    await markSent(claimed.id);
    result.sent += 1;
    console.log(`${LOG_PREFIX} sent salon=${salonId} client=${client.id} year=${occurrenceYear}`);
    return;
  }

  await markFailed(claimed.id, sendResult.error);
  result.failed += 1;
  const errMsg = `send failed salon=${salonId} client=${client.id}: ${sendResult.error}`;
  result.errors.push(errMsg);
  console.warn(`${LOG_PREFIX} ${errMsg}`);
}

/**
 * Run daily owner birthday notifications for all active salons.
 * One client/salon failure does not abort the rest.
 */
export async function runBirthdayOwnerNotifications(
  options: BirthdayOwnerNotifyOptions = {}
): Promise<BirthdayOwnerNotifyResult> {
  const dryRun = options.dryRun === true;
  const result: BirthdayOwnerNotifyResult = {
    salonsChecked: 0,
    clientsMatched: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const salons = await loadActiveSalons();
  result.salonsChecked = salons.length;

  for (const salon of salons) {
    try {
      const timeZone = resolveTimezone(salon.timezone);
      const tomorrowYmd = dateStrInTimezone(timeZone, 1);
      const occurrenceYear = Number(tomorrowYmd.slice(0, 4));

      const deliveryResult = await loadSalonTelegramDelivery(salon.id);
      if (!deliveryResult.ok) {
        console.warn(
          `${LOG_PREFIX} skip salon=${salon.id} reason=${deliveryResult.reason}`
        );
        // Still count matching clients as skipped for visibility in dry-run/live
        const clients = await loadSalonClientsWithBirthday(salon.id);
        const matched = clients.filter((c) =>
          birthdayMatchesNotifyTarget(c.birthday, tomorrowYmd, occurrenceYear)
        );
        result.clientsMatched += matched.length;
        result.skipped += matched.length;
        if (matched.length > 0) {
          result.errors.push(
            `salon=${salon.id} skipped ${matched.length} client(s): ${deliveryResult.reason}`
          );
        }
        continue;
      }

      const clients = await loadSalonClientsWithBirthday(salon.id);
      const matched = clients.filter((c) =>
        birthdayMatchesNotifyTarget(c.birthday, tomorrowYmd, occurrenceYear)
      );
      result.clientsMatched += matched.length;

      for (const client of matched) {
        try {
          await processClient({
            salonId: salon.id,
            client,
            occurrenceYear,
            delivery: deliveryResult.delivery,
            dryRun,
            result,
          });
        } catch (err) {
          result.failed += 1;
          const msg = err instanceof Error ? err.message : 'unknown client error';
          result.errors.push(`salon=${salon.id} client=${client.id}: ${msg}`);
          console.warn(`${LOG_PREFIX} client error salon=${salon.id} client=${client.id}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown salon error';
      result.errors.push(`salon=${salon.id}: ${msg}`);
      console.warn(`${LOG_PREFIX} salon error salon=${salon.id}: ${msg}`);
    }
  }

  return result;
}
