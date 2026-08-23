export type ProductCurrency = 'AMD' | 'USD' | 'RUB' | 'EUR';

/** Positive money only. Accepts number or string, including spaced thousands ("2 000"). */
export function asAmount(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const text = String(value).trim();
  if (!text || text === '-' || text === '—') return null;
  const normalized = text.replace(/\s+/g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatMoneyAmount(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function storedCurrency(value: unknown): string {
  const text = value == null ? '' : String(value).trim();
  return text || 'AMD';
}

export function formatProductPrice(product: {
  price?: number | string | null;
  priceMin?: number | string | null;
  priceMax?: number | string | null;
  price_min?: number | string | null;
  price_max?: number | string | null;
  currency?: string | null;
}): string {
  const currency = storedCurrency(product.currency);
  const min = asAmount(product.priceMin ?? product.price_min);
  const max = asAmount(product.priceMax ?? product.price_max);
  const exact = asAmount(product.price);

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

export function formatProductExactPrice(product: {
  price?: number | string | null;
  currency?: string | null;
}): string {
  const exact = asAmount(product.price);
  if (exact == null) return '—';
  return `${formatMoneyAmount(exact)} ${storedCurrency(product.currency)}`;
}

export function formatProductPriceRange(product: {
  priceMin?: number | string | null;
  priceMax?: number | string | null;
  price_min?: number | string | null;
  price_max?: number | string | null;
  currency?: string | null;
}): string {
  const currency = storedCurrency(product.currency);
  const min = asAmount(product.priceMin ?? product.price_min);
  const max = asAmount(product.priceMax ?? product.price_max);
  if (min != null && max != null) {
    return `${formatMoneyAmount(min)} – ${formatMoneyAmount(max)} ${currency}`;
  }
  if (min != null) return `от ${formatMoneyAmount(min)} ${currency}`;
  if (max != null) return `до ${formatMoneyAmount(max)} ${currency}`;
  return '—';
}
