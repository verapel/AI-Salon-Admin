import * as XLSX from 'xlsx';
import {
  DEFAULT_PRODUCT_CURRENCY,
  parseCurrency,
  parsePercentage,
  parseProductPricing,
  persistProductPricing,
  parseVolume,
  resolveStockQuantityFields,
  type ProductCurrency,
} from './productFields.js';
import {
  findIdentityConflict,
  identityIsTracked,
  normalizeIdentityPart,
  storedCodeShade,
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
  volume: string;
  percentage: number | null;
  price: number;
  priceMin: number | null;
  priceMax: number | null;
  currency: ProductCurrency;
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

export type ImportProductRow = {
  id: string;
  salon_id: string;
  name: string;
  brand: string;
  line: string;
  code_shade: string;
  category: string;
  quantity: number;
  min_quantity: number;
  unit: string;
  volume: string | null;
  percentage: number | null;
  price: number;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  supplier: string;
  marked_for_purchase: boolean;
  created_at: string;
  updated_at: string;
};

export type ImportCommitResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: { name: string; message: string }[];
};

export function buildImportInsertRow(
  salonId: string,
  draft: ProductDraft,
  now: string
): Omit<ImportProductRow, 'id'> {
  const pricing = persistProductPricing(draft);
  return {
    salon_id: salonId,
    name: draft.name,
    brand: draft.brand,
    line: draft.line,
    code_shade: storedCodeShade(draft.codeShade, draft.name),
    category: draft.category,
    quantity: draft.quantity,
    min_quantity: draft.minQuantity,
    unit: draft.unit,
    volume: draft.volume,
    percentage: draft.percentage,
    price: pricing.price,
    price_min: pricing.price_min,
    price_max: pricing.price_max,
    currency: pricing.currency,
    supplier: draft.supplier,
    marked_for_purchase: draft.markedForPurchase,
    created_at: now,
    updated_at: now,
  };
}

export function buildImportUpdatePatch(
  draft: ProductDraft,
  current: ImportProductRow,
  now: string
): Partial<ImportProductRow> {
  const pricing = persistProductPricing(draft, current);
  return {
    quantity: current.quantity + draft.quantity,
    marked_for_purchase: current.marked_for_purchase || draft.markedForPurchase,
    price: pricing.price,
    price_min: pricing.price_min,
    price_max: pricing.price_max,
    currency: pricing.currency,
    updated_at: now,
  };
}

export async function commitProductDrafts(opts: {
  salonId: string;
  incoming: unknown[];
  now?: string;
  loadRows: () => Promise<ImportProductRow[]>;
  insertRow: (
    row: Omit<ImportProductRow, 'id'>
  ) => Promise<{ id: string } | { error: string }>;
  updateRow: (
    id: string,
    patch: Partial<ImportProductRow>
  ) => Promise<{ ok: true } | { error: string }>;
}): Promise<{ result: ImportCommitResult; rows: ImportProductRow[] }> {
  const currentRows = await opts.loadRows();
  const existing: ImportExisting[] = currentRows.map((row) => ({
    id: row.id,
    salon_id: row.salon_id,
    brand: row.brand,
    line: row.line,
    code_shade: row.code_shade,
    name: row.name,
    quantity: row.quantity,
  }));
  const now = opts.now ?? new Date().toISOString();
  const result: ImportCommitResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (const raw of opts.incoming) {
    const draft = sanitizeDraft((raw ?? {}) as Record<string, unknown>);
    if (draftIsEmpty(draft) || !draft.name) {
      result.skipped += 1;
      continue;
    }

    const match = findIdentityConflict(existing, {
      salonId: opts.salonId,
      name: draft.name,
      brand: draft.brand,
      line: draft.line,
      codeShade: draft.codeShade,
    });

    if (match) {
      const current = currentRows.find((row) => row.id === match.id);
      if (!current) {
        result.errors.push({ name: draft.name, message: 'Product not found' });
        continue;
      }
      const patch = buildImportUpdatePatch(draft, current, now);
      const updated = await opts.updateRow(match.id, patch);
      if ('error' in updated) {
        result.errors.push({ name: draft.name, message: updated.error });
        continue;
      }
      Object.assign(current, patch);
      const working = existing.find((row) => row.id === match.id);
      if (working) working.quantity = current.quantity;
      result.updated += 1;
      continue;
    }

    const row = buildImportInsertRow(opts.salonId, draft, now);
    const inserted = await opts.insertRow(row);
    if ('error' in inserted) {
      result.errors.push({ name: draft.name, message: inserted.error });
      continue;
    }
    currentRows.push({ ...row, id: inserted.id });
    existing.push({
      id: inserted.id,
      salon_id: opts.salonId,
      brand: draft.brand,
      line: draft.line,
      code_shade: storedCodeShade(draft.codeShade, draft.name),
      name: draft.name,
      quantity: draft.quantity,
    });
    result.created += 1;
  }

  return { result, rows: currentRows };
}

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
  volume: ['volume', 'объём', 'объем', 'объем мл', 'ծավալ'],
  percentage: ['percentage', 'percent', 'процент', '%', 'տոկոս'],
  price: ['price', 'цена', 'գին', 'cost'],
  priceMin: ['price min', 'price_min', 'мин цена', 'цена от', 'min price'],
  priceMax: ['price max', 'price_max', 'макс цена', 'цена до', 'max price'],
  currency: ['currency', 'валюта', 'արժույթ'],
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
    volume: '',
    percentage: null,
    price: 0,
    priceMin: null,
    priceMax: null,
    currency: DEFAULT_PRODUCT_CURRENCY,
    supplier: '',
    markedForPurchase: false,
  };
}

export function sanitizeDraft(input: Partial<ProductDraft> | Record<string, unknown>): ProductDraft {
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
  const raw = input as Record<string, unknown>;
  const pricing = parseProductPricing({
    price: raw.price ?? price,
    priceMin: raw.priceMin ?? raw.price_min,
    priceMax: raw.priceMax ?? raw.price_max,
    priceRange: raw.priceRange ?? raw.price_range,
    currency: raw.currency,
  });
  const stock = resolveStockQuantityFields({
    quantity: raw.quantity,
    unit: raw.unit,
    volume: raw.volume ?? raw.size ?? raw.ml,
  });
  return {
    name,
    brand,
    line,
    codeShade,
    category: normalizeIdentityPart(input.category),
    quantity: stock.quantity,
    minQuantity: minQuantity ?? 0,
    unit: stock.unit,
    volume: stock.volume,
    percentage: parsePercentage(raw.percentage ?? raw.percent ?? raw.vol),
    price: pricing.price || (price ?? 0),
    priceMin: pricing.priceMin,
    priceMax: pricing.priceMax,
    currency: parseCurrency(raw.currency),
    supplier: normalizeIdentityPart(input.supplier),
    markedForPurchase: coerceMarked((input as { markedForPurchase?: unknown }).markedForPurchase),
  };
}

export function draftIsEmpty(draft: ProductDraft): boolean {
  return !identityIsTracked(draft.name, draft.brand, draft.line, draft.codeShade);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeProduct(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = [
    'name',
    'brand',
    'line',
    'code',
    'code_shade',
    'codeShade',
    'shade',
    'volume',
    'percentage',
    'price',
    'category',
  ];
  return keys.some((key) => value[key] != null && String(value[key]).trim() !== '');
}

/**
 * Collect every distinct product node. Do not collapse products[] to [0]
 * (that dropped the second care item when a photo had two bottles).
 */
export function collectPhotoProductNodes(payload: unknown): Record<string, unknown>[] {
  if (payload == null) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectPhotoProductNodes(item));
  }
  if (!isPlainObject(payload)) return [];

  const listKeys = ['products', 'items', 'rows', 'result', 'results', 'data'];
  for (const key of listKeys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.flatMap((item) => collectPhotoProductNodes(item));
    }
    if (looksLikeProduct(value)) return [value];
  }

  if (looksLikeProduct(payload.product) && !Array.isArray(payload.products)) {
    return [payload.product as Record<string, unknown>];
  }
  if (looksLikeProduct(payload)) return [payload];
  return [];
}

export function draftsFromPhotoPayload(payload: unknown): ProductDraft[] {
  const list = collectPhotoProductNodes(payload);
  return list.map((item) => sanitizeDraft(item)).filter((row) => !draftIsEmpty(row));
}

function extractBalancedJson(source: string): string | null {
  const open = source[0];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(0, i + 1);
    }
  }
  return null;
}

function extractAllCompleteJsonValues(source: string): unknown[] {
  const values: unknown[] = [];
  let rest = source.trim();
  while (rest) {
    const start = rest.search(/[\[{]/);
    if (start < 0) break;
    const extracted = extractBalancedJson(rest.slice(start));
    if (!extracted) return [];
    try {
      values.push(JSON.parse(extracted));
    } catch {
      return [];
    }
    rest = rest.slice(start + extracted.length).trim();
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
  }
  return values;
}

export function parseJsonFromModelText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.search(/[\[{]/);
  if (start < 0) return [];
  const slice = raw.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    const values = extractAllCompleteJsonValues(slice);
    if (values.length === 0) return [];
    if (values.length === 1) return values[0];
    return values;
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
      name: draft.name,
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
      code_shade: storedCodeShade(draft.codeShade, draft.name),
      name: draft.name,
      quantity: draft.quantity,
    });
    actions.push({ kind: 'create', draft });
  }

  return actions;
}
