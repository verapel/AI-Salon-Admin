export type ProductSection = 'paint' | 'care';

export const PRODUCT_SECTION_CATEGORY: Record<ProductSection, string> = {
  paint: 'paint',
  care: 'care',
};

function normalizeCategory(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
}

function looksPaint(normalized: string): boolean {
  if (!normalized) return false;
  return [
    'paint',
    'color',
    'colour',
    'краск',
    'окраш',
    'dye',
    'toner',
    'bleach',
    'оксид',
    'окисл',
    'oxid',
    'developer',
  ].some((token) => normalized === token || normalized.includes(token));
}

function looksCare(normalized: string): boolean {
  if (!normalized) return false;
  return [
    'care',
    'уход',
    'шампун',
    'shampoo',
    'бальзам',
    'condition',
    'маска',
    'mask',
    'treatment',
    'oil',
    'масл',
    'cream',
    'крем',
    'serum',
    'сыворот',
  ].some((token) => normalized === token || normalized.includes(token));
}

/** Map free-text category (+ optional code/shade) onto paint vs care. */
export function resolveProductSection(category: string, codeShade = ''): ProductSection {
  const normalized = normalizeCategory(category);
  const paint = looksPaint(normalized);
  const care = looksCare(normalized);
  if (paint && !care) return 'paint';
  if (care && !paint) return 'care';
  if (String(codeShade ?? '').trim()) return 'paint';
  return 'care';
}

export function isProductInSection(
  product: { category: string; codeShade?: string },
  section: ProductSection
): boolean {
  return resolveProductSection(product.category, product.codeShade ?? '') === section;
}

export function categoryForProductSection(section: ProductSection, current = ''): string {
  const trimmed = String(current ?? '').trim();
  if (trimmed && resolveProductSection(trimmed) === section) return trimmed;
  return PRODUCT_SECTION_CATEGORY[section];
}
