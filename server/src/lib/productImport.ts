import * as XLSX from 'xlsx';
import {
  findIdentityConflict,
  identityIsTracked,
  normalizeIdentityPart,
  parseNonNegativeInt,
  parseNonNegativeNumber,
  type ProductIdentityRow,
} from './products.js';

export type ProductDraft = {
  name: string;
  brand: string;
  line: string;
  codeShade: string;
  category: string;
  quantity: number;
  minQuantity: number;
  unit: string;
  price: number;
  supplier: string;
  markedForPurchase: boolean;
};

export type ImportExisting = ProductIdentityRow & {
  name: string;
  quantity: number;
};

export type ImportPlanAction =
  | { kind: 'create'; draft: ProductDraft }
  | { kind: 'update'; id: string; quantityDelta: number; draft: ProductDraft }
  | { kind: 'skip'; reason: 'empty' | 'invalid'; draft: ProductDraft };

const HEADER_ALIASES: Record<keyof ProductDraft, string[]> = {
  name: ['name', 'product', 'product name', 'название', 'наименование', 'товар', 'продукт', 'անվանում', 'ապրանք'],
  brand: ['brand', 'бренд', 'марка', 'бренд марка', 'ապրանքանիշ', 'բրենդ'],
  line: ['line', 'series', 'collection', 'линия', 'серия', 'коллекция', 'գիծ', 'շարք'],
  codeShade: [
    'code',
    'shade',
    'code shade',
    'code/shade',
    'код',
    'оттенок',
    'тон',
    'код оттенок',
    'код/оттенок',
    'կոդ',
    'երանգ',
    'tone',
    'ref',
  ],
  category: ['category', 'категория', 'կատեգորիա'],
  quantity: ['quantity', 'qty', 'count', 'количество', 'кол во', 'кол-во', 'քանակ'],
  minQuantity: ['min', 'min quantity', 'minquantity', 'минимум', 'мин количество', 'նվազագույն'],
  unit: ['unit', 'ед', 'единица', 'ед изм', 'միավոր'],
  price: ['price', 'цена', 'գին', 'cost'],
  supplier: ['supplier', 'vendor', 'поставщик', 'մատակարար'],
  markedForPurchase: ['to order', 'purchase', 'for purchase', 'к закупке', 'закупка', 'գնման'],
};

export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_./\\|]+/g, ' ')
    .replace(/[()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldForHeader(header: string): keyof ProductDraft | null {
  const normalized = normalizeHeader(header);
  if (!normalized) return null;
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof ProductDraft, string[]][]) {
    if (aliases.includes(normalized)) return field;
  }
  return null;
}

function parseMarked(value: unknown): boolean {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'yes', 'y', 'да', 'oui', 'к закупке', 'закупка'].includes(raw);
}

function coerceMarked(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return parseMarked(value);
}

export function emptyDraft(): ProductDraft {
  return {
    name: '',
    brand: '',
    line: '',
    codeShade: '',
    category: '',
    quantity: 1,
    minQuantity: 0,
    unit: '',
    price: 0,
    supplier: '',
    markedForPurchase: false,
  };
}

export function sanitizeDraft(input: Partial<ProductDraft> | Record<string, unknown>): ProductDraft {
  const quantity = parseNonNegativeInt(input.quantity, 1);
  const minQuantity = parseNonNegativeInt(input.minQuantity, 0);
  const price = parseNonNegativeNumber(input.price, 0);
  const brand = normalizeIdentityPart(input.brand);
  const line = normalizeIdentityPart(input.line);
  const codeShade = normalizeIdentityPart(
    (input as { codeShade?: unknown; code_shade?: unknown }).codeShade ??
      (input as { code_shade?: unknown }).code_shade
  );
  const name =
    normalizeIdentityPart(input.name) ||
    [brand, line, codeShade].filter(Boolean).join(' ');
  return {
    name,
    brand,
    line,
    codeShade,
    category: normalizeIdentityPart(input.category),
    quantity: quantity ?? 1,
    minQuantity: minQuantity ?? 0,
    unit: normalizeIdentityPart(input.unit),
    price: price ?? 0,
    supplier: normalizeIdentityPart(input.supplier),
    markedForPurchase: coerceMarked((input as { markedForPurchase?: unknown }).markedForPurchase),
  };
}

export function draftIsEmpty(draft: ProductDraft): boolean {
  return !draft.name && !identityIsTracked(draft.brand, draft.line, draft.codeShade);
}

export function mapSpreadsheetObject(row: Record<string, unknown>): ProductDraft {
  const mapped: Partial<ProductDraft> = {};
  for (const [key, value] of Object.entries(row)) {
    const field = fieldForHeader(key);
    if (!field) continue;
    if (field === 'markedForPurchase') mapped.markedForPurchase = parseMarked(value);
    else (mapped as Record<string, unknown>)[field] = value;
  }
  return sanitizeDraft(mapped);
}

export function parseSpreadsheetBuffer(buffer: Buffer): ProductDraft[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }) as Record<string, unknown>[];
  return rows.map(mapSpreadsheetObject).filter((row) => !draftIsEmpty(row));
}

export function draftsFromPhotoPayload(payload: unknown): ProductDraft[] {
  const list = extractDraftList(payload);
  return list.map((item) => sanitizeDraft(item as Record<string, unknown>)).filter((row) => !draftIsEmpty(row));
}

function extractDraftList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.products)) return record.products;
  if (Array.isArray(record.rows)) return record.rows;
  if (Array.isArray(record.items)) return record.items;
  return [];
}

export function parseJsonFromModelText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.search(/[\[{]/);
  if (start < 0) return [];
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return [];
  }
}

export function planImportRows(
  existing: ImportExisting[],
  salonId: string,
  drafts: ProductDraft[]
): ImportPlanAction[] {
  const working = existing.map((row) => ({ ...row }));
  const actions: ImportPlanAction[] = [];

  for (const raw of drafts) {
    const draft = sanitizeDraft(raw);
    if (draftIsEmpty(draft) || !draft.name) {
      actions.push({ kind: 'skip', reason: draftIsEmpty(draft) ? 'empty' : 'invalid', draft });
      continue;
    }

    const match = findIdentityConflict(working, {
      salonId,
      brand: draft.brand,
      line: draft.line,
      codeShade: draft.codeShade,
    });

    if (match) {
      const current = working.find((row) => row.id === match.id);
      if (current) current.quantity += draft.quantity;
      actions.push({ kind: 'update', id: match.id, quantityDelta: draft.quantity, draft });
      continue;
    }

    const createdId = `new:${working.length}`;
    working.push({
      id: createdId,
      salon_id: salonId,
      brand: draft.brand,
      line: draft.line,
      code_shade: draft.codeShade,
      name: draft.name,
      quantity: draft.quantity,
    });
    actions.push({ kind: 'create', draft });
  }

  return actions;
}
