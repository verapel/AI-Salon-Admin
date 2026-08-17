export type ProductStockStatus = 'in_stock' | 'low' | 'out';

export type ProductIdentityRow = {
  id: string;
  salon_id: string;
  brand: string;
  line: string;
  code_shade: string;
};

export function deriveProductStockStatus(
  quantity: number,
  minQuantity: number
): ProductStockStatus {
  if (quantity <= 0) return 'out';
  if (quantity <= minQuantity) return 'low';
  return 'in_stock';
}

export function normalizeIdentityPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function identityIsTracked(brand: string, line: string, codeShade: string): boolean {
  return Boolean(brand.trim() || line.trim() || codeShade.trim());
}

export function productIdentityKey(brand: string, line: string, codeShade: string): string {
  return [brand, line, codeShade].map((part) => part.trim().toLowerCase()).join('\0');
}

export function findIdentityConflict(
  rows: ProductIdentityRow[],
  opts: {
    salonId: string;
    brand: string;
    line: string;
    codeShade: string;
    excludeId?: string;
  }
): ProductIdentityRow | null {
  if (!identityIsTracked(opts.brand, opts.line, opts.codeShade)) return null;
  const key = productIdentityKey(opts.brand, opts.line, opts.codeShade);
  return (
    rows.find(
      (row) =>
        row.salon_id === opts.salonId &&
        row.id !== opts.excludeId &&
        identityIsTracked(row.brand, row.line, row.code_shade) &&
        productIdentityKey(row.brand, row.line, row.code_shade) === key
    ) ?? null
  );
}

export function applyQuantityDelta(quantity: number, delta: number): number | null {
  if (!Number.isInteger(delta) || delta === 0 || !Number.isFinite(quantity)) return null;
  const next = quantity + delta;
  if (!Number.isFinite(next)) return null;
  return Math.max(0, Math.trunc(next));
}

export function parseNonNegativeInt(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

export function parseNonNegativeNumber(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '23505') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('duplicate key') || msg.includes('products_salon_identity_unique');
}

export function findProductInSalon<T extends { id: string; salon_id: string }>(
  rows: T[],
  id: string,
  salonId: string
): T | null {
  return rows.find((row) => row.id === id && row.salon_id === salonId) ?? null;
}
