export type ProductStockStatus = 'in_stock' | 'low' | 'out';

export type ProductIdentityRow = {
  id: string;
  salon_id: string;
  name: string;
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

export function identityIsTracked(
  name: string,
  brand: string,
  line: string,
  codeShade: string
): boolean {
  return Boolean(name.trim() || brand.trim() || line.trim() || codeShade.trim());
}

/** Hide a stored shade that only exists to keep same-brand care rows unique. */
export function visibleCodeShade(storedCode: string, name: string): string {
  const code = normalizeIdentityPart(storedCode);
  const normalizedName = normalizeIdentityPart(name);
  if (code && normalizedName && code.toLowerCase() === normalizedName.toLowerCase()) return '';
  return code;
}

/**
 * Existing unique index is brand+line+code_shade only.
 * When shade is empty, persist the name so two care products can coexist.
 */
export function storedCodeShade(visibleCode: string, name: string): string {
  const code = normalizeIdentityPart(visibleCode);
  if (code) return code;
  return normalizeIdentityPart(name);
}

export function productIdentityKey(
  name: string,
  brand: string,
  line: string,
  codeShade: string
): string {
  return [name, brand, line, visibleCodeShade(codeShade, name)]
    .map((part) => part.trim().toLowerCase())
    .join('\0');
}

export function findIdentityConflict(
  rows: ProductIdentityRow[],
  opts: {
    salonId: string;
    name: string;
    brand: string;
    line: string;
    codeShade: string;
    excludeId?: string;
  }
): ProductIdentityRow | null {
  if (!identityIsTracked(opts.name, opts.brand, opts.line, opts.codeShade)) return null;
  const key = productIdentityKey(opts.name, opts.brand, opts.line, opts.codeShade);
  return (
    rows.find(
      (row) =>
        row.salon_id === opts.salonId &&
        row.id !== opts.excludeId &&
        identityIsTracked(row.name, row.brand, row.line, row.code_shade) &&
        productIdentityKey(row.name, row.brand, row.line, row.code_shade) === key
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

type ParsedCodeShade = {
  empty: boolean;
  group: 0 | 1;
  prefix: string;
  value: number | null;
  rest: string;
  raw: string;
};

function parseProductCodeShade(input: string): ParsedCodeShade {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return { empty: true, group: 1, prefix: '', value: null, rest: '', raw };
  }

  const numeric = raw.match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (numeric) {
    return {
      empty: false,
      group: 0,
      prefix: '',
      value: Number(numeric[1]),
      rest: numeric[2] ?? '',
      raw,
    };
  }

  const prefixed = raw.match(/^(.*?)(\d+(?:\.\d+)?)(.*)$/);
  if (prefixed?.[2]) {
    return {
      empty: false,
      group: 1,
      prefix: prefixed[1] ?? '',
      value: Number(prefixed[2]),
      rest: prefixed[3] ?? '',
      raw,
    };
  }

  return { empty: false, group: 1, prefix: raw, value: null, rest: '', raw };
}

/** Natural code/shade order: numeric codes, then prefixes like SL12.0, empty last. */
export function compareProductCodeShade(a: string, b: string): number {
  const left = parseProductCodeShade(a);
  const right = parseProductCodeShade(b);
  if (left.empty !== right.empty) return left.empty ? 1 : -1;
  if (left.group !== right.group) return left.group - right.group;

  const prefixCmp = left.prefix.localeCompare(right.prefix, 'en', { sensitivity: 'base' });
  if (prefixCmp !== 0) return prefixCmp;

  if (left.value !== right.value) {
    if (left.value == null) return 1;
    if (right.value == null) return -1;
    return left.value - right.value;
  }

  const restCmp = left.rest.localeCompare(right.rest, 'en', { numeric: true, sensitivity: 'base' });
  if (restCmp !== 0) return restCmp;
  return left.raw.localeCompare(right.raw, 'en', { sensitivity: 'base' });
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
