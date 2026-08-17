/**
 * PRODUCTS-1: salon-scoped products foundation.
 * Does not execute SQL. Does not call live Supabase.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyQuantityDelta,
  deriveProductStockStatus,
  findIdentityConflict,
  findProductInSalon,
  isUniqueViolation,
  type ProductIdentityRow,
} from './products.js';
import { mapProduct } from './mappers.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const SALON_A = 'salon-a';
const SALON_B = 'salon-b';

function row(
  id: string,
  salonId: string,
  brand: string,
  line: string,
  code: string
): ProductIdentityRow {
  return { id, salon_id: salonId, brand, line, code_shade: code };
}

describe('PRODUCTS-1 products foundation', () => {
  it('derives stock status from quantity and min_quantity', () => {
    assert.equal(deriveProductStockStatus(0, 2), 'out');
    assert.equal(deriveProductStockStatus(1, 2), 'low');
    assert.equal(deriveProductStockStatus(2, 2), 'low');
    assert.equal(deriveProductStockStatus(3, 2), 'in_stock');
    assert.equal(deriveProductStockStatus(1, 0), 'in_stock');
  });

  it('clamps quantity delta at zero and rejects invalid deltas', () => {
    assert.equal(applyQuantityDelta(2, 1), 3);
    assert.equal(applyQuantityDelta(2, -1), 1);
    assert.equal(applyQuantityDelta(0, -1), 0);
    assert.equal(applyQuantityDelta(1, 0), null);
    assert.equal(applyQuantityDelta(1, 1.5), null);
  });

  it('blocks duplicate brand+line+code in the same salon, not across salons', () => {
    const rows = [
      row('p1', SALON_A, 'Loreal', 'Majirel', '6.1'),
      row('p2', SALON_B, 'Loreal', 'Majirel', '6.1'),
    ];

    assert.ok(
      findIdentityConflict(rows, {
        salonId: SALON_A,
        brand: 'loreal',
        line: 'majirel',
        codeShade: '6.1',
      })
    );
    assert.equal(
      findIdentityConflict(rows, {
        salonId: SALON_A,
        brand: 'loreal',
        line: 'majirel',
        codeShade: '6.1',
        excludeId: 'p1',
      }),
      null
    );
    assert.equal(
      findIdentityConflict(rows, {
        salonId: SALON_B,
        brand: 'Loreal',
        line: 'Majirel',
        codeShade: '6.1',
        excludeId: 'p2',
      }),
      null
    );
    assert.equal(
      findIdentityConflict(
        [row('p1', SALON_A, 'Loreal', 'Majirel', '6.1')],
        { salonId: SALON_B, brand: 'Loreal', line: 'Majirel', codeShade: '6.1' }
      ),
      null
    );
    assert.equal(
      findIdentityConflict(rows, {
        salonId: SALON_A,
        brand: '',
        line: '',
        codeShade: '',
      }),
      null
    );
  });

  it('cannot mutate a product that belongs to another salon', () => {
    const rows = [{ id: 'p-other', salon_id: SALON_B, quantity: 4 }];
    assert.equal(findProductInSalon(rows, 'p-other', SALON_A), null);
    assert.equal(findProductInSalon(rows, 'p-other', SALON_B)?.quantity, 4);
  });

  it('maps derived stockStatus and never reads a stored status column', () => {
    const mapped = mapProduct({
      id: 'p1',
      name: 'Color 6.1',
      brand: 'Loreal',
      line: 'Majirel',
      code_shade: '6.1',
      category: 'Color',
      quantity: 1,
      min_quantity: 2,
      unit: 'pcs',
      price: 12.5,
      supplier: 'Profi',
      marked_for_purchase: true,
      created_at: '2026-08-17T00:00:00.000Z',
      updated_at: '2026-08-17T00:00:00.000Z',
    });
    assert.equal(mapped.stockStatus, 'low');
    assert.equal(mapped.markedForPurchase, true);
    assert.equal(mapped.codeShade, '6.1');
    const mapper = read('server/src/lib/mappers.ts');
    const fn = mapper.slice(mapper.indexOf('export function mapProduct'), mapper.indexOf('export function mapStaff'));
    assert.match(fn, /deriveProductStockStatus/);
    assert.doesNotMatch(fn, /row\.status/);
  });

  it('migration has no status column and unique identity is salon-scoped', () => {
    const sql = read('supabase/migrations/20260817000001_products_foundation.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.products/);
    assert.match(sql, /salon_id\s+UUID NOT NULL REFERENCES public\.salons\(id\)/);
    assert.match(sql, /products_salon_identity_unique/);
    assert.match(sql, /marked_for_purchase/);
    assert.doesNotMatch(sql, /^\s*status\s+/m);
  });

  it('routes always scope by salon_id and never take salon from the body', () => {
    const route = read('server/src/routes/products.ts');
    const index = read('server/src/index.ts');
    assert.match(index, /app\.use\('\/api\/products',\s*salonAuth,\s*requireSalonCabinetAccess,\s*productsRouter\)/);

    for (const marker of [
      "router.get('/',",
      "router.post('/',",
      "router.post('/:id/quantity'",
      "router.get('/:id'",
      "router.put('/:id'",
      "router.delete('/:id'",
    ]) {
      assert.ok(route.includes(marker), `missing ${marker}`);
    }

    assert.match(route, /getSalonId\(req\)/);
    assert.match(route, /\.eq\('salon_id',\s*salonId\)/);
    assert.doesNotMatch(route, /req\.body\?\.salonId|req\.body\.salon_id|req\.body\.salonId/);
    assert.match(route, /requireSalonWriteAccess/);
    assert.match(route, /marked_for_purchase/);
    assert.doesNotMatch(route, /req\.body\?\.status|updates\.status|stock_status/);
  });

  it('quantity and delete handlers keep salon isolation', () => {
    const route = read('server/src/routes/products.ts');
    const qty = route.slice(route.indexOf("router.post('/:id/quantity'"), route.indexOf("router.get('/:id'"));
    const del = route.slice(route.indexOf("router.delete('/:id'"));
    assert.match(qty, /\.eq\('id',\s*id\)/);
    assert.match(qty, /\.eq\('salon_id',\s*salonId\)/);
    assert.match(qty, /applyQuantityDelta/);
    assert.match(del, /\.delete\(\)/);
    assert.match(del, /\.eq\('salon_id',\s*salonId\)/);
  });

  it('detects unique-violation codes for identity conflicts', () => {
    assert.equal(isUniqueViolation({ code: '23505' }), true);
    assert.equal(isUniqueViolation({ message: 'duplicate key value violates unique constraint' }), true);
    assert.equal(isUniqueViolation({ code: '42501' }), false);
  });

  it('admin products page has filters, CRUD, quantity controls, and placeholders only', () => {
    const page = read('client/src/pages/Products.tsx');
    const app = read('client/src/App.tsx');
    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    const ru = read('client/src/i18n/translations.ts');

    assert.match(app, /path="\/products"/);
    assert.match(sidebar, /labelKey: 'nav\.products'/);
    assert.match(ru, /'nav\.products': 'Продукция'/);
    assert.match(ru, /'products\.filterAll': 'Все'/);
    assert.match(ru, /'products\.filterInStock': 'В наличии'/);
    assert.match(ru, /'products\.filterLow': 'Заканчивается'/);
    assert.match(ru, /'products\.filterOut': 'Закончилась'/);
    assert.match(ru, /'products\.filterPurchase': 'К закупке'/);
    assert.match(ru, /'products\.addPhoto': 'Добавить по фото'/);
    assert.match(ru, /'products\.exportExcel': 'Экспорт Excel'/);

    assert.match(page, /api\.products\.create/);
    assert.match(page, /api\.products\.update/);
    assert.match(page, /api\.products\.delete/);
    assert.match(page, /api\.products\.adjustQuantity/);
    assert.match(page, /products\.addPhoto/);
    assert.match(page, /products\.exportExcel/);
    assert.doesNotMatch(page, /openai|vision|exceljs|SheetJS|xlsx/i);
  });
});
