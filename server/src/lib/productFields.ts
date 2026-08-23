export const PRODUCT_CURRENCIES = ['AMD', 'USD', 'RUB', 'EUR'] as const;
export type ProductCurrency = (typeof PRODUCT_CURRENCIES)[number];

export const DEFAULT_PRODUCT_CURRENCY: ProductCurrency = 'AMD';

function asTrimmed(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

function parseLooseNumber(raw: string): number | null {
  const normalized = raw
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.-]/g, '');
  if (!normalized || normalized === '-' || normalized === '.') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Store volume as a short display string: "100 ml", "250 ml", "1 L". */
export function parseVolume(value: unknown): string {
  const text = asTrimmed(value);
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  const match = compact.match(
    /^(\d+(?:[.,]\d+)?)\s*(ml|мл|l|л|liter|litre|литр(?:а|ов)?)(?:\.|$)?$/i
  );
  if (match) {
    const amount = match[1].replace(',', '.');
    const unitRaw = match[2].toLowerCase();
    const isLiter = /^(l|л|liter|litre|литр)/.test(unitRaw);
    if (isLiter) {
      const n = Number(amount);
      if (n > 0 && n < 1) return `${Math.round(n * 1000)} ml`;
      return `${amount.replace(/\.0+$/, '')} L`;
    }
    return `${amount.replace(/\.0+$/, '')} ml`;
  }
  return compact;
}

/** Optional oxidant/developer strength. Stored as 1.5, 3, 6, 9, 12. */
export function parsePercentage(value: unknown): number | null {
  const text = asTrimmed(value);
  if (!text) return null;
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*%?/);
  if (!match) return null;
  const n = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
}

export function parseOptionalMoney(value: unknown): number | null {
  const text = asTrimmed(value);
  if (!text) return null;
  const n = parseLooseNumber(text);
  if (n == null || n < 0) return null;
  return Math.round(n * 100) / 100;
}

export function parseCurrency(value: unknown, fallback: ProductCurrency = DEFAULT_PRODUCT_CURRENCY): ProductCurrency {
  const text = asTrimmed(value);
  if (!text) return fallback;
  const upper = text.replace(/[^A-Za-zА-Яа-я$€₽]/g, '').toUpperCase();
  if (upper === 'AMD' || upper === 'ДРАМ') return 'AMD';
  if (upper === 'USD' || upper === '$' || upper === 'DOLLAR' || upper === 'ДОЛЛАР') return 'USD';
  if (upper === 'RUB' || upper === 'RUR' || upper === '₽' || upper === 'РУБ') return 'RUB';
  if (upper === 'EUR' || upper === '€' || upper === 'EURO' || upper === 'ЕВРО') return 'EUR';
  if ((PRODUCT_CURRENCIES as readonly string[]).includes(text.toUpperCase())) {
    return text.toUpperCase() as ProductCurrency;
  }
  return fallback;
}

export function parsePriceRange(value: unknown): { priceMin: number | null; priceMax: number | null } {
  const text = asTrimmed(value);
  if (!text) return { priceMin: null, priceMax: null };
  const parts = text.split(/\s*(?:–|—|-|…|to|до)\s*/i).filter(Boolean);
  if (parts.length >= 2) {
    const min = parseOptionalMoney(parts[0]);
    const max = parseOptionalMoney(parts[1]);
    if (min != null && max != null && min > max) return { priceMin: max, priceMax: min };
    return { priceMin: min, priceMax: max };
  }
  const single = parseOptionalMoney(text);
  return { priceMin: single, priceMax: single };
}

export function parseProductPricing(input: {
  price?: unknown;
  priceMin?: unknown;
  priceMax?: unknown;
  priceRange?: unknown;
  currency?: unknown;
}): {
  price: number;
  priceMin: number | null;
  priceMax: number | null;
  currency: ProductCurrency;
} {
  let price = input.price !== undefined ? parseOptionalMoney(input.price) : null;
  let priceMin = input.priceMin !== undefined ? parseOptionalMoney(input.priceMin) : null;
  let priceMax = input.priceMax !== undefined ? parseOptionalMoney(input.priceMax) : null;

  if ((priceMin == null || priceMax == null) && input.priceRange != null) {
    const range = parsePriceRange(input.priceRange);
    priceMin = priceMin ?? range.priceMin;
    priceMax = priceMax ?? range.priceMax;
  }

  if (priceMin != null && priceMax != null && priceMin === priceMax) {
    if (price == null) price = priceMin;
    priceMin = null;
    priceMax = null;
  }

  if (priceMin != null && priceMax != null && priceMin !== priceMax) {
    if (price == null) price = 0;
  }

  return {
    price: price ?? 0,
    priceMin,
    priceMax,
    currency: parseCurrency(input.currency),
  };
}

export function formatMoneyAmount(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Positive money only. Accepts number or string, including spaced thousands ("2 000"). */
export function asDisplayAmount(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const text = String(value).trim();
  if (!text || text === '-' || text === '—') return null;
  const n = parseLooseNumber(text);
  return n != null && n > 0 ? n : null;
}

export function formatProductPrice(fields: {
  price?: number | string | null;
  priceMin?: number | string | null;
  priceMax?: number | string | null;
  price_min?: number | string | null;
  price_max?: number | string | null;
  currency?: string | null;
}): string {
  const currency = parseCurrency(fields.currency);
  const min = asDisplayAmount(fields.priceMin ?? fields.price_min);
  const max = asDisplayAmount(fields.priceMax ?? fields.price_max);
  const exact = asDisplayAmount(fields.price);

  if (min != null && max != null) {
    return min === max
      ? `${formatMoneyAmount(min)} ${currency}`
      : `${formatMoneyAmount(min)}–${formatMoneyAmount(max)} ${currency}`;
  }
  if (min != null) return `от ${formatMoneyAmount(min)} ${currency}`;
  if (max != null) return `до ${formatMoneyAmount(max)} ${currency}`;
  if (exact != null) return `${formatMoneyAmount(exact)} ${currency}`;
  return '—';
}
