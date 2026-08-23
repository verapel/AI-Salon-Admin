export type ProductCurrency = 'AMD' | 'USD' | 'RUB' | 'EUR';

export function formatMoneyAmount(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatProductPrice(product: {
  price: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  currency?: string | null;
}): string {
  const currency = product.currency || 'AMD';
  if (
    product.priceMin != null &&
    product.priceMax != null &&
    product.priceMin !== product.priceMax
  ) {
    return `${formatMoneyAmount(product.priceMin)}–${formatMoneyAmount(product.priceMax)} ${currency}`;
  }
  if (product.price != null) {
    return `${formatMoneyAmount(product.price)} ${currency}`;
  }
  if (product.priceMin != null) {
    return `${formatMoneyAmount(product.priceMin)} ${currency}`;
  }
  return '';
}
