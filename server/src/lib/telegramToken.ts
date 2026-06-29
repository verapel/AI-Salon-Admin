import { supabase } from './supabase.js';

export const DEFAULT_SALON_SLUG = 'default';
const TELEGRAM_PROVIDER = 'telegram' as const;

async function getDefaultSalonId(): Promise<string | null> {
  const { data } = await supabase.from('salons').select('id').eq('slug', DEFAULT_SALON_SLUG).maybeSingle();
  return data?.id ?? null;
}

/** Pilot: token stored in DB so owner connect survives server restart (single salon). */
export async function loadTelegramTokenFromDb(): Promise<string | null> {
  const salonId = await getDefaultSalonId();
  if (!salonId) return null;

  const { data } = await supabase
    .from('salon_integrations')
    .select('token_ciphertext')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  const token = data?.token_ciphertext?.trim();
  return token || null;
}

export async function saveTelegramTokenToDb(
  token: string,
  botUsername: string,
  botDisplayName: string
): Promise<boolean> {
  const salonId = await getDefaultSalonId();
  if (!salonId) return false;

  const now = new Date().toISOString();
  const { data: existing } = await supabase
    .from('salon_integrations')
    .select('connected_at')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  const { error } = await supabase.from('salon_integrations').upsert(
    {
      salon_id: salonId,
      provider: TELEGRAM_PROVIDER,
      status: 'connected',
      health: 'healthy',
      bot_username: botUsername,
      bot_display_name: botDisplayName,
      connected_at: existing?.connected_at ?? now,
      last_checked_at: now,
      last_error: null,
      token_ciphertext: token,
      updated_at: now,
    },
    { onConflict: 'salon_id,provider' }
  );

  if (error) {
    console.error('[telegram/token] save error:', error.message);
    return false;
  }

  return true;
}
