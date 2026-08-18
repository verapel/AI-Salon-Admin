import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapProduct } from '../lib/mappers.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import type { Database } from '../types/database.js';
import {
  applyQuantityDelta,
  compareProductCodeShade,
  findIdentityConflict,
  isUniqueViolation,
  normalizeIdentityPart,
  parseNonNegativeInt,
  parseNonNegativeNumber,
} from '../lib/products.js';
import {
  draftIsEmpty,
  parseSpreadsheetBuffer,
  sanitizeDraft,
  type ImportExisting,
  type ProductDraft,
} from '../lib/productImport.js';
import { extractProductDraftsFromImage, productPhotoVisionModel } from '../lib/productPhotoVision.js';

const router = Router();

const DUPLICATE_IDENTITY = 'A product with this brand, line, and code/shade already exists.';

type ProductRow = Database['public']['Tables']['products']['Row'];

async function loadSalonIdentityRows(salonId: string) {
  const { data, error } = await supabase
    .from('products')
    .select('id, salon_id, brand, line, code_shade')
    .eq('salon_id', salonId);

  if (error) throw error;
  return data ?? [];
}

function duplicateResponse(res: { status: (code: number) => { json: (body: unknown) => void } }) {
  return res.status(409).json({ error: DUPLICATE_IDENTITY, code: 'PRODUCT_IDENTITY_EXISTS' });
}

router.get('/', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('salon_id', salonId);

  if (error) return res.status(500).json({ error: error.message });
  const products = (data ?? []).map((row) => mapProduct(row));
  products.sort(
    (a, b) => compareProductCodeShade(a.codeShade, b.codeShade) || a.name.localeCompare(b.name, 'en')
  );
  res.json(products);
});

const MAX_IMPORT_BYTES = 6 * 1024 * 1024;

function decodeBase64File(body: { filename?: string; mimeType?: string; contentBase64?: string }) {
  const contentBase64 = String(body.contentBase64 ?? '').replace(/^data:[^;]+;base64,/, '');
  if (!contentBase64) return { error: 'File content is required' as const };
  if (contentBase64.length > MAX_IMPORT_BYTES * 2) return { error: 'File is too large' as const };
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) return { error: 'File content is required' as const };
  if (buffer.length > MAX_IMPORT_BYTES) return { error: 'File is too large' as const };
  return {
    buffer,
    filename: String(body.filename ?? ''),
    mimeType: String(body.mimeType ?? ''),
  };
}

router.post('/import/parse', requireSalonWriteAccess, async (req, res) => {
  getSalonId(req);
  const decoded = decodeBase64File(req.body ?? {});
  if ('error' in decoded) return res.status(400).json({ error: decoded.error });
  const name = decoded.filename.toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
    return res.status(400).json({ error: 'Upload an .xlsx, .xls, or .csv file' });
  }
  try {
    const rows = parseSpreadsheetBuffer(decoded.buffer);
    res.json({ source: 'excel', rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not parse spreadsheet';
    return res.status(400).json({ error: message });
  }
});

router.post('/import/photo', requireSalonWriteAccess, async (req, res) => {
  getSalonId(req);
  const decoded = decodeBase64File(req.body ?? {});
  if ('error' in decoded) return res.status(400).json({ error: decoded.error });
  const mime = decoded.mimeType || 'image/jpeg';
  if (!mime.startsWith('image/')) {
    return res.status(400).json({ error: 'Upload an image from camera or gallery' });
  }
  try {
    const rows = await extractProductDraftsFromImage({
      mimeType: mime,
      contentBase64: decoded.buffer.toString('base64'),
    });
    res.json({ source: 'photo', model: productPhotoVisionModel(), rows });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'AI_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Photo import is not configured', code });
    }
    const message = err instanceof Error ? err.message : 'Photo analysis failed';
    return res.status(502).json({ error: message });
  }
});

router.post('/import/commit', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const incoming = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const drafts: ProductDraft[] = incoming.map((row: Partial<ProductDraft>) => sanitizeDraft(row));

  const { data: currentRows, error: loadError } = await supabase
    .from('products')
    .select('*')
    .eq('salon_id', salonId);

  if (loadError) return res.status(500).json({ error: loadError.message });

  const existing: ImportExisting[] = (currentRows ?? []).map((row) => ({
    id: row.id,
    salon_id: row.salon_id,
    brand: row.brand,
    line: row.line,
    code_shade: row.code_shade,
    name: row.name,
    quantity: row.quantity,
  }));

  const now = new Date().toISOString();
  const result = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [] as { name: string; message: string }[],
  };

  for (const raw of drafts) {
    const draft = sanitizeDraft(raw);
    if (draftIsEmpty(draft) || !draft.name) {
      result.skipped += 1;
      continue;
    }

    const match = findIdentityConflict(existing, {
      salonId,
      brand: draft.brand,
      line: draft.line,
      codeShade: draft.codeShade,
    });

    if (match) {
      const current = (currentRows ?? []).find((row) => row.id === match.id);
      if (!current) {
        result.errors.push({ name: draft.name, message: 'Product not found' });
        continue;
      }
      const nextQuantity = current.quantity + draft.quantity;
      const { data, error } = await supabase
        .from('products')
        .update({
          quantity: nextQuantity,
          marked_for_purchase: current.marked_for_purchase || draft.markedForPurchase,
          updated_at: now,
        })
        .eq('id', match.id)
        .eq('salon_id', salonId)
        .select('id')
        .single();
      if (error || !data) {
        result.errors.push({ name: draft.name, message: error?.message || 'Update failed' });
        continue;
      }
      current.quantity = nextQuantity;
      const working = existing.find((row) => row.id === match.id);
      if (working) working.quantity = nextQuantity;
      result.updated += 1;
      continue;
    }

    const { data, error } = await supabase
      .from('products')
      .insert({
        salon_id: salonId,
        name: draft.name,
        brand: draft.brand,
        line: draft.line,
        code_shade: draft.codeShade,
        category: draft.category,
        quantity: draft.quantity,
        min_quantity: draft.minQuantity,
        unit: draft.unit,
        price: draft.price,
        supplier: draft.supplier,
        marked_for_purchase: draft.markedForPurchase,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !data) {
      result.errors.push({ name: draft.name, message: error?.message || 'Create failed' });
      continue;
    }

    existing.push({
      id: data.id,
      salon_id: salonId,
      brand: draft.brand,
      line: draft.line,
      code_shade: draft.codeShade,
      name: draft.name,
      quantity: draft.quantity,
    });
    (currentRows ?? []).push({
      id: data.id,
      salon_id: salonId,
      name: draft.name,
      brand: draft.brand,
      line: draft.line,
      code_shade: draft.codeShade,
      category: draft.category,
      quantity: draft.quantity,
      min_quantity: draft.minQuantity,
      unit: draft.unit,
      price: draft.price,
      supplier: draft.supplier,
      marked_for_purchase: draft.markedForPurchase,
      created_at: now,
      updated_at: now,
    } as ProductRow);
    result.created += 1;
  }

  res.json(result);
});

router.post('/', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const name = normalizeIdentityPart(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const brand = normalizeIdentityPart(req.body?.brand);
  const line = normalizeIdentityPart(req.body?.line);
  const codeShade = normalizeIdentityPart(req.body?.codeShade);
  const quantity = parseNonNegativeInt(req.body?.quantity, 0);
  const minQuantity = parseNonNegativeInt(req.body?.minQuantity, 0);
  const price = parseNonNegativeNumber(req.body?.price, 0);
  if (quantity === null || minQuantity === null || price === null) {
    return res.status(400).json({ error: 'Quantity, min quantity, and price must be 0 or greater' });
  }

  try {
    const existing = await loadSalonIdentityRows(salonId);
    if (findIdentityConflict(existing, { salonId, brand, line, codeShade })) {
      return duplicateResponse(res);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not validate product identity';
    return res.status(500).json({ error: message });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('products')
    .insert({
      salon_id: salonId,
      name,
      brand,
      line,
      code_shade: codeShade,
      category: normalizeIdentityPart(req.body?.category),
      quantity,
      min_quantity: minQuantity,
      unit: normalizeIdentityPart(req.body?.unit),
      price,
      supplier: normalizeIdentityPart(req.body?.supplier),
      marked_for_purchase: Boolean(req.body?.markedForPurchase),
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();

  if (error) {
    if (isUniqueViolation(error)) return duplicateResponse(res);
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(mapProduct(data as ProductRow));
});

router.post('/:id/quantity', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const delta = Number(req.body?.delta);
  if (!Number.isInteger(delta) || delta === 0) {
    return res.status(400).json({ error: 'Integer delta is required' });
  }

  const { data: current, error: loadError } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .eq('salon_id', salonId)
    .single();

  if (loadError || !current) return res.status(404).json({ error: 'Product not found' });

  const nextQuantity = applyQuantityDelta(current.quantity, delta);
  if (nextQuantity === null) return res.status(400).json({ error: 'Invalid quantity delta' });

  const { data, error } = await supabase
    .from('products')
    .update({ quantity: nextQuantity, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Product not found' });
  res.json(mapProduct(data as ProductRow));
});

router.get('/:id', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', req.params.id)
    .eq('salon_id', salonId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Product not found' });
  res.json(mapProduct(data as ProductRow));
});

router.put('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const updates: Database['public']['Tables']['products']['Update'] = {
    updated_at: new Date().toISOString(),
  };

  if (req.body?.name !== undefined) {
    const name = normalizeIdentityPart(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    updates.name = name;
  }
  if (req.body?.brand !== undefined) updates.brand = normalizeIdentityPart(req.body.brand);
  if (req.body?.line !== undefined) updates.line = normalizeIdentityPart(req.body.line);
  if (req.body?.codeShade !== undefined) updates.code_shade = normalizeIdentityPart(req.body.codeShade);
  if (req.body?.category !== undefined) updates.category = normalizeIdentityPart(req.body.category);
  if (req.body?.unit !== undefined) updates.unit = normalizeIdentityPart(req.body.unit);
  if (req.body?.supplier !== undefined) updates.supplier = normalizeIdentityPart(req.body.supplier);
  if (req.body?.markedForPurchase !== undefined) {
    updates.marked_for_purchase = Boolean(req.body.markedForPurchase);
  }
  if (req.body?.quantity !== undefined) {
    const quantity = parseNonNegativeInt(req.body.quantity, 0);
    if (quantity === null) return res.status(400).json({ error: 'Quantity must be 0 or greater' });
    updates.quantity = quantity;
  }
  if (req.body?.minQuantity !== undefined) {
    const minQuantity = parseNonNegativeInt(req.body.minQuantity, 0);
    if (minQuantity === null) return res.status(400).json({ error: 'Min quantity must be 0 or greater' });
    updates.min_quantity = minQuantity;
  }
  if (req.body?.price !== undefined) {
    const price = parseNonNegativeNumber(req.body.price, 0);
    if (price === null) return res.status(400).json({ error: 'Price must be 0 or greater' });
    updates.price = price;
  }

  const identityTouched =
    req.body?.brand !== undefined || req.body?.line !== undefined || req.body?.codeShade !== undefined;

  if (identityTouched) {
    const { data: current, error: loadError } = await supabase
      .from('products')
      .select('id, salon_id, brand, line, code_shade')
      .eq('id', id)
      .eq('salon_id', salonId)
      .single();

    if (loadError || !current) return res.status(404).json({ error: 'Product not found' });

    try {
      const existing = await loadSalonIdentityRows(salonId);
      const conflict = findIdentityConflict(existing, {
        salonId,
        brand: updates.brand ?? current.brand,
        line: updates.line ?? current.line,
        codeShade: updates.code_shade ?? current.code_shade,
        excludeId: id,
      });
      if (conflict) return duplicateResponse(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not validate product identity';
      return res.status(500).json({ error: message });
    }
  }

  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error) {
    if (isUniqueViolation(error)) return duplicateResponse(res);
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Product not found' });
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: 'Product not found' });
  res.json(mapProduct(data as ProductRow));
});

router.delete('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { data, error } = await supabase
    .from('products')
    .delete()
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('id')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Product not found' });
  res.status(204).send();
});

export default router;
