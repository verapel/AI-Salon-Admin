import type { ProductSection } from './productSection';

const VOLUME_UNIT_TOKEN_RE = /^(ml|мл|l|л|liter|litre|литры?|литр(?:а|ов)?)(?:\.|)$/i;
const VOLUME_IN_TEXT_RE = /(\d+(?:[.,]\d+)?)\s*(ml|мл|l|л|liter|litre|литр(?:а|ов)?)\b/i;

/** Volume tokens must never appear as the inventory quantity unit. */
export function isVolumeLikeUnit(unit: string | null | undefined): boolean {
  const text = String(unit ?? '').trim();
  if (!text) return false;
  return VOLUME_UNIT_TOKEN_RE.test(text) || VOLUME_IN_TEXT_RE.test(text);
}

/**
 * Stock quantity is always pieces. Oxide always shows шт./pcs.
 * Paint/Care keep a non-volume unit; volume-like units fall back to pieces.
 */
export function stockQuantityDisplayUnit(
  unit: string | null | undefined,
  section: ProductSection,
  pieceLabel: string
): string {
  if (section === 'oxide' || isVolumeLikeUnit(unit)) return pieceLabel;
  return String(unit ?? '').trim();
}
