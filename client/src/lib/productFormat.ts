export type ProductCurrency = 'AMD' | 'USD' | 'RUB' | 'EUR';

function asAmount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatMoneyAmount(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatProductPrice(product: {
  price?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  price_min?: number | null;
  price_max?: number | null;
  currency?: string | null;
}): string {
  const currency = product.currency || 'AMD';
  const price = asAmount(product.price);
  const priceMin = asAmount(product.priceMin ?? product.price_min);
  const priceMax = asAmount(product.priceMax ?? product.price_max);
  const hasRange = priceMin != null || priceMax != null;

  if (priceMin != null && priceMax != null) {
    if (priceMin !== priceMax) {
      return `${formatMoneyAmount(priceMin)}–${formatMoneyAmount(priceMax)} ${currency}`;
    }
    return `${formatMoneyAmount(priceMin)} ${currency}`;
  }
  if (hasRange) {
    return `${formatMoneyAmount((priceMin ?? priceMax) as number)} ${currency}`;
  }
  if (price != null && price > 0) {
    return `${formatMoneyAmount(price)} ${currency}`;
  }
  if (price != null && price === 0) return `0 ${currency}`;
  return '';
}
