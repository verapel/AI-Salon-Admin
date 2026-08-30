import { supabase } from './supabase.js';
import { parseStaffTelegramChatId } from './telegramBooking.js';

export function parseStaffTelegramChatIdBody(body: {
  telegramChatId?: unknown;
  telegram_chat_id?: unknown;
}):
  | { provided: false }
  | { provided: true; ok: true; value: number | null }
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
    const parsed = parseStaffTelegramChatId(raw);
    if (parsed == null && String(raw).trim() !== '') return { provided: true, ok: false };
    return { provided: true, ok: true, value: parsed };
  }
  return { provided: true, ok: false };
}

export function isMissingStaffTelegramChatIdColumn(error: unknown): boolean {
  const msg = String((error as { message?: string } | null)?.message || '');
  if (!/telegram_chat_id/i.test(msg)) return false;
  return /schema cache|column|does not exist|could not find/i.test(msg);
}

/** Write telegram_chat_id only. Never fail staff CRUD if the column is unavailable. */
export async function persistStaffTelegramChatIdIfSupported(params: {
  salonId: string;
  staffId: string;
  value: number | null;
}): Promise<void> {
  try {
    const { error } = await supabase
      .from('staff')
      .update({ telegram_chat_id: params.value })
      .eq('id', params.staffId)
      .eq('salon_id', params.salonId);
    if (error) {
      console.warn('[staff] telegram_chat_id persist skipped:', error.message);
    }
  } catch (err) {
    console.warn(
      '[staff] telegram_chat_id persist skipped:',
      err instanceof Error ? err.message : err
    );
  }
}
