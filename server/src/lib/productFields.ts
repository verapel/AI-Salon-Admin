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

/** Inventory stock is always pieces, never bottle volume. */
export const STOCK_PIECE_UNIT = 'шт.';

const VOLUME_UNIT_TOKEN_RE = /^(ml|мл|l|л|liter|litre|литры?|литр(?:а|ов)?)(?:\.|)$/i;
const VOLUME_IN_TEXT_RE = /(\d+(?:[.,]\d+)?)\s*(ml|мл|l|л|liter|litre|литр(?:а|ов)?)\b/i;
const PIECE_UNIT_RE = /^(pcs?|pieces?|шт\.?|штук[аи]?|հատ|bottle|bottles)$/i;

export function isVolumeUnitToken(value: unknown): boolean {
  const text = asTrimmed(value);
  if (!text) return false;
  return VOLUME_UNIT_TOKEN_RE.test(text) || Boolean(extractVolumeFromText(text));
}

export function extractVolumeFromText(value: unknown): string {
  const text = asTrimmed(value);
  if (!text || !VOLUME_IN_TEXT_RE.test(text)) return '';
  return parseVolume(text);
}

function parsePieceCount(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
  }
  const text = String(value).trim();
  if (extractVolumeFromText(text)) return fallback;
  const match = text.match(/^(\d+)/);
  if (!match) return fallback;
  return Number(match[1]);
}

/**
 * Quantity is bottle/tube count (шт.). Volume (ml/L) never becomes the stock unit.
 * If the model stuffed "1 L" into quantity or unit, recover it as volume.
 */
export function resolveStockQuantityFields(input: {
  quantity?: unknown;
  unit?: unknown;
  volume?: unknown;
}): { quantity: number; unit: string; volume: string } {
  let volume = parseVolume(input.volume);
  const volumeFromQuantity = extractVolumeFromText(input.quantity);
  if (volumeFromQuantity) {
    if (!volume) volume = volumeFromQuantity;
    return { quantity: 1, unit: STOCK_PIECE_UNIT, volume };
  }

  const volumeFromUnit = extractVolumeFromText(input.unit);
  if (volumeFromUnit) {
    if (!volume) volume = volumeFromUnit;
    return { quantity: parsePieceCount(input.quantity, 1), unit: STOCK_PIECE_UNIT, volume };
  }

  const unitText = asTrimmed(input.unit) ?? '';
  const quantity = parsePieceCount(input.quantity, 1);
  if (VOLUME_UNIT_TOKEN_RE.test(unitText)) {
    const isLiter = /^(l|л|liter|litre|литр)/i.test(unitText);
    const isMl = /^(ml|мл)(?:\.|)?$/i.test(unitText);
    if (!volume && (isLiter || (isMl && quantity >= 50))) {
      volume = parseVolume(`${quantity} ${unitText}`);
      return { quantity: 1, unit: STOCK_PIECE_UNIT, volume };
    }
    return { quantity, unit: STOCK_PIECE_UNIT, volume };
  }

  const unit = !unitText || PIECE_UNIT_RE.test(unitText) ? STOCK_PIECE_UNIT : unitText;
  return { quantity, unit, volume };
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

export type PersistedProductPricing = {
  price: number;
  price_min: number | null;
  price_max: number | null;
  currency: ProductCurrency;
};

/**
 * Columns to write on CREATE/UPDATE. Incoming positive range wins;
 * null/0/empty never clobbers a range already stored on the row.
 */
export function persistProductPricing(
  incoming: {
    price?: unknown;
    priceMin?: unknown;
    priceMax?: unknown;
    price_min?: unknown;
    price_max?: unknown;
    priceRange?: unknown;
    price_range?: unknown;
    currency?: unknown;
  },
  existing?: {
    price?: unknown;
    price_min?: unknown;
    price_max?: unknown;
    currency?: unknown;
  } | null
): PersistedProductPricing {
  const parsed = parseProductPricing({
    price: incoming.price,
    priceMin: incoming.priceMin ?? incoming.price_min,
    priceMax: incoming.priceMax ?? incoming.price_max,
    priceRange: incoming.priceRange ?? incoming.price_range,
    currency: incoming.currency,
  });
  const keepMin = asDisplayAmount(existing?.price_min);
  const keepMax = asDisplayAmount(existing?.price_max);
  const keepPrice = asDisplayAmount(existing?.price);
  const incomingCurrency =
    incoming.currency != null && String(incoming.currency).trim() !== '';

  return {
    price: asDisplayAmount(parsed.price) ?? keepPrice ?? 0,
    price_min: asDisplayAmount(parsed.priceMin) ?? keepMin,
    price_max: asDisplayAmount(parsed.priceMax) ?? keepMax,
    currency: incomingCurrency
      ? parseCurrency(incoming.currency)
      : parseCurrency(existing?.currency),
  };
}

export function formatMoneyAmount(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
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
