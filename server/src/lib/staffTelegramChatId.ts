export const STAFF_TELEGRAM_CHAT_ID_UNAVAILABLE =
  'telegram_chat_id is not available on staff. Apply migration 20260829000001_staff_telegram_chat_id.';

/** Keep the full decimal Telegram chat id (BIGINT-safe). Do not parseInt/32-bit coerce. */
export function parseStaffTelegramChatIdDigits(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const digits = String(raw).trim();
  if (!digits) return null;
  if (!/^-?\d+$/.test(digits)) return null;
  const unsigned = digits.startsWith('-') ? digits.slice(1) : digits;
  if (unsigned.length === 0 || unsigned.length > 19) return null;
  return digits;
}

export function parseStaffTelegramChatIdBody(body: {
  telegramChatId?: unknown;
  telegram_chat_id?: unknown;
}):
  | { provided: false }
  | { provided: true; ok: true; value: string | null }
  | { provided: true; ok: false } {
  const hasCamel = Object.prototype.hasOwnProperty.call(body, 'telegramChatId');
  const hasSnake = Object.prototype.hasOwnProperty.call(body, 'telegram_chat_id');
  if (!hasCamel && !hasSnake) return { provided: false };

  const raw = hasCamel ? body.telegramChatId : body.telegram_chat_id;
  if (raw === undefined || raw === null || raw === '') {
    return { provided: true, ok: true, value: null };
  }
  if (typeof raw === 'number' || typeof raw === 'string') {
    const trimmed = typeof raw === 'string' ? raw.trim() : raw;
    if (trimmed === '') return { provided: true, ok: true, value: null };
    const parsed = parseStaffTelegramChatIdDigits(raw);
    if (parsed == null) return { provided: true, ok: false };
    return { provided: true, ok: true, value: parsed };
  }
  return { provided: true, ok: false };
}

export function isMissingStaffTelegramChatIdColumn(error: unknown): boolean {
  const msg = String((error as { message?: string } | null)?.message || '');
  if (!/telegram_chat_id/i.test(msg)) return false;
  return /schema cache|column|does not exist|could not find/i.test(msg);
}

export function mapStaffTelegramChatId(raw: unknown): string | null {
  return parseStaffTelegramChatIdDigits(raw);
}

export async function persistStaffTelegramChatId(params: {
  db: any;
  salonId: string;
  staffId: string;
  value: string | null;
}): Promise<
  | { ok: true; telegramChatId: string | null }
  | { ok: false; missingColumn: boolean; message: string }
> {
  const { data, error } = await params.db
    .from('staff')
    .update({ telegram_chat_id: params.value })
    .eq('id', params.staffId)
    .eq('salon_id', params.salonId)
    .select('telegram_chat_id')
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      missingColumn: isMissingStaffTelegramChatIdColumn(error),
      message: isMissingStaffTelegramChatIdColumn(error)
        ? STAFF_TELEGRAM_CHAT_ID_UNAVAILABLE
        : String((error as { message?: string }).message || error),
    };
  }
  return { ok: true, telegramChatId: mapStaffTelegramChatId(data?.telegram_chat_id ?? params.value) };
}
