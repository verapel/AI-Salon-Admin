import { PILOT_SALON_ID } from './pilotSalon.js';
import { DEFAULT_SALON_SLUG } from './telegramToken.js';

/** Salon scope for Telegram booking runtime (botToken set by multi-bot manager when enabled). */
export interface TelegramSalonContext {
  salonId: string;
  salonSlug: string;
  botToken?: string;
  botUsername?: string | null;
}

/** Default / Tatev pilot salon — sole active Telegram bot in I3b-0. */
export const defaultTelegramSalonContext: TelegramSalonContext = {
  salonId: PILOT_SALON_ID,
  salonSlug: DEFAULT_SALON_SLUG,
};

/** Composite key for in-memory Telegram FSM state (salon + chat isolation). */
export function getTelegramStateKey(salonId: string, chatId: number): string {
  return `${salonId}:${chatId}`;
}
