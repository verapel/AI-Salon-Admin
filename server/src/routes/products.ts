import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapProduct } from '../lib/mappers.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import type { Database } from '../types/database.js';
import {
  parsePercentage,
  persistProductPricing,
  parseVolume,
} from '../lib/productFields.js';
import {
  applyQuantityDelta,
  compareProductCodeShade,
  findIdentityConflict,
  isUniqueViolation,
  normalizeIdentityPart,
  parseNonNegativeInt,
  parseNonNegativeNumber,
  storedCodeShade,
  visibleCodeShade,
} from '../lib/products.js';
import {
  commitProductDrafts,
  parseSpreadsheetBuffer,
  type ImportProductRow,
} from '../lib/productImport.js';
import { extractProductDraftsFromImage, productPhotoVisionModel } from '../lib/productPhotoVision.js';

const router = Router();

const DUPLICATE_IDENTITY = 'A product with this brand, line, and code/shade already exists.';

type ProductRow = Database['public']['Tables']['products']['Row'];

async function loadSalonIdentityRows(salonId: string) {
  const { data, error } = await supabase
    .from('products')
    .select('id, salon_id, name, brand, line, code_shade')
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

  const { data: loadedRows, error: loadError } = await supabase
    .from('products')
    .select('*')
    .eq('salon_id', salonId);

  if (loadError) return res.status(500).json({ error: loadError.message });
  const currentRows = [...((loadedRows ?? []) as ImportProductRow[])];

  const { result } = await commitProductDrafts({
    salonId,
    incoming,
    loadRows: async () => currentRows,
    insertRow: async (row) => {
      const { data, error } = await supabase.from('products').insert(row).select('id').single();
      if (error || !data) return { error: error?.message || 'Create failed' };
      return { id: data.id };
    },
    updateRow: async (id, patch) => {
      const { data, error } = await supabase
        .from('products')
        .update(patch)
        .eq('id', id)
        .eq('salon_id', salonId)
        .select('id')
        .single();
      if (error || !data) return { error: error?.message || 'Update failed' };
      return { ok: true as const };
    },
  });

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
    if (findIdentityConflict(existing, { salonId, name, brand, line, codeShade })) {
      return duplicateResponse(res);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not validate product identity';
    return res.status(500).json({ error: message });
  }

  const pricing = persistProductPricing({
    price,
    priceMin: req.body?.priceMin ?? req.body?.price_min,
    priceMax: req.body?.priceMax ?? req.body?.price_max,
    priceRange: req.body?.priceRange ?? req.body?.price_range,
    currency: req.body?.currency,
  });
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('products')
    .insert({
      salon_id: salonId,
      name,
      brand,
      line,
      code_shade: storedCodeShade(codeShade, name),
      category: normalizeIdentityPart(req.body?.category),
      quantity,
      min_quantity: minQuantity,
      unit: normalizeIdentityPart(req.body?.unit),
      volume: parseVolume(req.body?.volume),
      percentage: parsePercentage(req.body?.percentage),
      price: pricing.price || price,
      price_min: pricing.price_min,
      price_max: pricing.price_max,
      currency: pricing.currency,
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
  if (req.body?.codeShade !== undefined) {
    updates.code_shade = storedCodeShade(
      normalizeIdentityPart(req.body.codeShade),
      normalizeIdentityPart(req.body?.name ?? updates.name)
    );
  }
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
  if (req.body?.volume !== undefined) updates.volume = parseVolume(req.body.volume);
  if (req.body?.percentage !== undefined) updates.percentage = parsePercentage(req.body.percentage);
  if (
    req.body?.priceMin !== undefined ||
    req.body?.price_min !== undefined ||
    req.body?.priceMax !== undefined ||
    req.body?.price_max !== undefined ||
    req.body?.priceRange !== undefined ||
    req.body?.price_range !== undefined ||
    req.body?.currency !== undefined
  ) {
    const minProvided =
      req.body?.priceMin !== undefined ||
      req.body?.price_min !== undefined ||
      req.body?.priceRange !== undefined ||
      req.body?.price_range !== undefined;
    const maxProvided =
      req.body?.priceMax !== undefined ||
      req.body?.price_max !== undefined ||
      req.body?.priceRange !== undefined ||
      req.body?.price_range !== undefined;
    const pricing = persistProductPricing({
      price: req.body?.price ?? updates.price,
      priceMin: req.body?.priceMin ?? req.body?.price_min,
      priceMax: req.body?.priceMax ?? req.body?.price_max,
      priceRange: req.body?.priceRange ?? req.body?.price_range,
      currency: req.body?.currency,
    });
    if (req.body?.price === undefined && pricing.price_min != null && pricing.price_max != null) {
      updates.price = 0;
    }
    if (minProvided) updates.price_min = pricing.price_min;
    if (maxProvided) updates.price_max = pricing.price_max;
    if (req.body?.currency !== undefined) updates.currency = pricing.currency;
  }

  const identityTouched =
    req.body?.name !== undefined ||
    req.body?.brand !== undefined ||
    req.body?.line !== undefined ||
    req.body?.codeShade !== undefined;

  if (identityTouched) {
    const { data: current, error: loadError } = await supabase
      .from('products')
      .select('id, salon_id, name, brand, line, code_shade')
      .eq('id', id)
      .eq('salon_id', salonId)
      .single();

    if (loadError || !current) return res.status(404).json({ error: 'Product not found' });
    if (req.body?.codeShade === undefined && updates.name && visibleCodeShade(current.code_shade, current.name) === '') {
      updates.code_shade = storedCodeShade('', updates.name);
    }

    try {
      const existing = await loadSalonIdentityRows(salonId);
      const conflict = findIdentityConflict(existing, {
        salonId,
        name: updates.name ?? current.name,
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
