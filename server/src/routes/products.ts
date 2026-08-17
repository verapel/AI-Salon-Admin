import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapProduct } from '../lib/mappers.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import type { Database } from '../types/database.js';
import {
  applyQuantityDelta,
  findIdentityConflict,
  isUniqueViolation,
  normalizeIdentityPart,
  parseNonNegativeInt,
  parseNonNegativeNumber,
} from '../lib/products.js';

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
    .eq('salon_id', salonId)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map((row) => mapProduct(row)));
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
