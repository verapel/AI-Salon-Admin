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
  compareProductCodeShade,
  deriveProductStockStatus,
  findIdentityConflict,
  findProductInSalon,
  isUniqueViolation,
  type ProductIdentityRow,
} from './products.js';
import { mapProduct } from './mappers.js';
import { formatProductPrice } from './productFields.js';
import {
  categoryForProductSection,
  isProductInSection,
  resolveProductSection,
} from '../../../client/src/lib/productSection.ts';

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
  code: string,
  name = 'Color'
): ProductIdentityRow {
  return { id, salon_id: salonId, name, brand, line, code_shade: code };
}

describe('PRODUCTS-1 products foundation', () => {
  it('sorts code/shade numerically, with prefixes after numbers and empty last', () => {
    const shuffled = ['SL12.0', '10', '2', '5.18', '', '0', '12', '1', '5.01', '8.11'];
    shuffled.sort(compareProductCodeShade);
    assert.deepEqual(shuffled, ['0', '1', '2', '5.01', '5.18', '8.11', '10', '12', 'SL12.0', '']);

    assert.ok(compareProductCodeShade('2', '10') < 0);
    assert.ok(compareProductCodeShade('5.01', '5.18') < 0);
    assert.ok(compareProductCodeShade('12', 'SL12.0') < 0);
    assert.ok(compareProductCodeShade('SL2', 'SL12.0') < 0);
    assert.ok(compareProductCodeShade('SL12.0', '') < 0);
  });

  it('GET products list sorts in memory by code_shade, not by name', () => {
    const route = read('server/src/routes/products.ts');
    const getAll = route.slice(route.indexOf("router.get('/',"), route.indexOf('const MAX_IMPORT_BYTES'));
    assert.match(getAll, /compareProductCodeShade/);
    assert.doesNotMatch(getAll, /\.order\(/);
  });

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
        name: 'Color',
        brand: 'loreal',
        line: 'majirel',
        codeShade: '6.1',
      })
    );
    assert.equal(
      findIdentityConflict(rows, {
        salonId: SALON_A,
        name: 'Color',
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
        name: 'Color',
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
        { salonId: SALON_B, name: 'Color', brand: 'Loreal', line: 'Majirel', codeShade: '6.1' }
      ),
      null
    );
    assert.equal(
      findIdentityConflict(rows, {
        salonId: SALON_A,
        name: '',
        brand: '',
        line: '',
        codeShade: '',
      }),
      null
    );
  });

  it('does not merge different care names that share brand and line', () => {
    const rows = [row('p1', SALON_A, 'KAARAL', 'Les Crèmes', 'Hydra', 'Hydra')];
    assert.equal(
      findIdentityConflict(rows, {
        salonId: SALON_A,
        name: 'Renew Care',
        brand: 'KAARAL',
        line: 'Les Crèmes',
        codeShade: '',
      }),
      null
    );
    assert.ok(
      findIdentityConflict(rows, {
        salonId: SALON_A,
        name: 'Hydra',
        brand: 'kaaral',
        line: 'les crèmes',
        codeShade: '',
      })
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
    assert.equal(mapped.volume, '');
    assert.equal(mapped.percentage, null);
    assert.equal(mapped.priceMin, null);
    assert.equal(mapped.priceMax, null);
    assert.equal(mapped.currency, 'AMD');
    const ranged = mapProduct({
      id: 'p2',
      name: 'Mask',
      brand: 'KAARAL',
      line: 'Les Crèmes',
      code_shade: 'Mask',
      category: 'care',
      quantity: 1,
      min_quantity: 0,
      unit: '',
      price: 0,
      price_min: 2000,
      price_max: 3000,
      currency: 'AMD',
      supplier: '',
      marked_for_purchase: false,
      created_at: '2026-08-17T00:00:00.000Z',
      updated_at: '2026-08-17T00:00:00.000Z',
    });
    assert.equal(ranged.codeShade, '');
    assert.equal(ranged.priceMin, 2000);
    assert.equal(ranged.priceMax, 3000);
    assert.equal(formatProductPrice(ranged), '2 000–3 000 AMD');
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
    assert.match(page, /api\.products\.parseImport/);
    assert.match(page, /exportProductsXlsx/);
    assert.match(page, /isProductInSection/);
    assert.match(page, /openSection\('paint'\)/);
    assert.match(page, /openSection\('oxide'\)/);
    assert.match(page, /openSection\('care'\)/);
    assert.match(ru, /'products\.sectionPaint': 'Краска'/);
    assert.match(ru, /'products\.sectionOxide': 'Оксид'/);
    assert.match(ru, /'products\.sectionCare': 'Уход'/);
    assert.doesNotMatch(page, /CREATE TABLE/);

    const toggle = page.slice(page.indexOf('const handlePurchaseToggle'), page.indexOf('const readFileAsBase64'));
    assert.match(toggle, /api\.products\.update\(product\.id/);
    assert.match(toggle, /markedForPurchase:\s*!product\.markedForPurchase/);
    assert.doesNotMatch(toggle, /openEdit|setModalOpen\(true\)/);

    const mobileCards = page.slice(page.indexOf('space-y-3 sm:hidden'), page.indexOf('hidden sm:block'));
    const desktopTable = page.slice(page.indexOf('hidden sm:block'));
    assert.match(mobileCards, /type="checkbox"/);
    assert.match(mobileCards, /checked=\{product\.markedForPurchase\}/);
    assert.match(mobileCards, /onChange=\{\(\) => handlePurchaseToggle\(product\)\}/);
    assert.doesNotMatch(mobileCards, /w-full rounded-lg px-3 py-2/);
    assert.doesNotMatch(mobileCards, /aria-pressed/);
    assert.doesNotMatch(desktopTable, /handlePurchaseToggle/);
  });

  it('paint, oxide, and care sections split on category without a new table', () => {
    assert.equal(resolveProductSection('Color'), 'paint');
    assert.equal(resolveProductSection('краска'), 'paint');
    assert.equal(resolveProductSection('paint'), 'paint');
    assert.equal(resolveProductSection('уход'), 'care');
    assert.equal(resolveProductSection('care'), 'care');
    assert.equal(resolveProductSection('shampoo'), 'care');
    assert.equal(resolveProductSection('', '5.01'), 'paint');
    assert.equal(resolveProductSection('', ''), 'care');
    assert.equal(resolveProductSection('оксид'), 'oxide');
    assert.equal(resolveProductSection('oxide'), 'oxide');
    assert.equal(resolveProductSection('developer'), 'oxide');

    const rows = [
      { category: 'Color', codeShade: '10', name: 'Dark' },
      { category: 'уход', codeShade: '', name: 'Mask' },
      { category: 'paint', codeShade: '2', name: 'Light' },
      { category: 'care', codeShade: '', name: 'Shampoo' },
      { category: '', codeShade: '5.01', name: 'Shade' },
      { category: 'оксид', codeShade: '9%', name: 'Ox 9' },
      { category: 'oxide', codeShade: '', name: 'Ox 3' },
    ];
    const paint = rows.filter((row) => isProductInSection(row, 'paint')).map((row) => row.name);
    const oxide = rows.filter((row) => isProductInSection(row, 'oxide')).map((row) => row.name);
    const care = rows.filter((row) => isProductInSection(row, 'care')).map((row) => row.name);
    assert.deepEqual(paint, ['Dark', 'Light', 'Shade']);
    assert.deepEqual(oxide, ['Ox 9', 'Ox 3']);
    assert.deepEqual(care, ['Mask', 'Shampoo']);
    assert.equal(paint.includes('Ox 9'), false);
    assert.equal(paint.includes('Mask'), false);
    assert.equal(care.includes('Dark'), false);
    assert.equal(care.includes('Ox 3'), false);
    assert.equal(oxide.includes('Dark'), false);
    assert.equal(oxide.includes('Shampoo'), false);

    assert.equal(categoryForProductSection('paint'), 'paint');
    assert.equal(categoryForProductSection('oxide'), 'oxide');
    assert.equal(categoryForProductSection('care', 'Уход'), 'Уход');
    assert.equal(categoryForProductSection('paint', 'уход'), 'paint');
    assert.equal(categoryForProductSection('oxide', 'Color'), 'oxide');
    assert.equal(categoryForProductSection('oxide', 'оксид 6%'), 'оксид 6%');

    const sql = read('supabase/migrations/20260817000001_products_foundation.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.products/);
    assert.equal(
      [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.products/g)].length,
      1
    );
  });
});
