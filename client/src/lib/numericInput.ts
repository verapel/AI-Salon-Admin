/** Sanitize typed numeric fields so a leading 0 cannot stick as "05" / "012". */

export function sanitizeIntegerInput(raw: string): string {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits === '') return '';
  return String(Number(digits));
}

export function sanitizeDecimalInput(raw: string): string {
  let text = String(raw ?? '').replace(',', '.').replace(/[^\d.]/g, '');
  const firstDot = text.indexOf('.');
  if (firstDot !== -1) {
    text = `${text.slice(0, firstDot + 1)}${text.slice(firstDot + 1).replace(/\./g, '')}`;
  }
  if (text === '') return '';
  if (text === '.') return '0.';

  const [intPart, frac] = text.split('.');
  const normalizedInt = intPart === '' ? '0' : String(Number(intPart));
  if (frac !== undefined) return `${normalizedInt}.${frac}`;
  return normalizedInt;
}

export function parseIntegerInput(raw: string, fallback = 0): number {
  if (String(raw ?? '').trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function parseDecimalInput(raw: string): number | null {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '.') return null;
  const n = Number(text.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function numericDisplayValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '';
  return String(value);
}
