export const SALON_CURRENCIES = ['AMD', 'RUB', 'USD'] as const;
export type SalonCurrency = (typeof SALON_CURRENCIES)[number];

export const DEFAULT_SALON_CURRENCY: SalonCurrency = 'AMD';

export const CURRENCY_META: Record<
  SalonCurrency,
  { code: SalonCurrency; symbol: string }
> = {
  AMD: { code: 'AMD', symbol: '֏' },
  RUB: { code: 'RUB', symbol: '₽' },
  USD: { code: 'USD', symbol: '$' },
};

export function isSalonCurrency(value: unknown): value is SalonCurrency {
  return value === 'AMD' || value === 'RUB' || value === 'USD';
}

/** Display/selection only — never converts amounts. Unknown values fall back to AMD. */
export function parseSalonCurrency(value: unknown): SalonCurrency {
  const text = value == null ? '' : String(value).trim().toUpperCase();
  if (text === 'AMD' || text === 'RUB' || text === 'USD') return text;
  return DEFAULT_SALON_CURRENCY;
}

export function formatMoneyAmount(amount: number): string {
  const n = Number.isFinite(amount) ? Math.round(amount) : 0;
  const abs = Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return n < 0 ? `-${abs}` : abs;
}

/** Shared salon money formatter. Does not convert values between currencies. */
export function formatCurrency(
  amount: number,
  currency: string = DEFAULT_SALON_CURRENCY
): string {
  return `${formatMoneyAmount(amount)} ${parseSalonCurrency(currency)}`;
}

/** Compact axis tick without the currency suffix. */
export function formatCurrencyAxis(amount: number, _currency?: string): string {
  return formatMoneyAmount(amount);
}

export function currencySymbol(currency: string = DEFAULT_SALON_CURRENCY): string {
  return CURRENCY_META[parseSalonCurrency(currency)].symbol;
}
