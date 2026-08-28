export const SALON_CURRENCIES = ['AMD', 'RUB', 'USD'] as const;
export type SalonCurrency = (typeof SALON_CURRENCIES)[number];

export const DEFAULT_SALON_CURRENCY: SalonCurrency = 'AMD';

export function isSalonCurrency(value: unknown): value is SalonCurrency {
  return value === 'AMD' || value === 'RUB' || value === 'USD';
}

/** Salon display currency. Unknown/empty values fall back to AMD. No conversion. */
export function parseSalonCurrency(value: unknown): SalonCurrency {
  const text = value == null ? '' : String(value).trim().toUpperCase();
  if (text === 'AMD' || text === 'RUB' || text === 'USD') return text;
  return DEFAULT_SALON_CURRENCY;
}
