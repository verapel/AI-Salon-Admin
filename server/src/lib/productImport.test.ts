/**
 * PRODUCTS-2: Excel/photo import planning. Does not write to the database.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import {
  draftsFromPhotoPayload,
  mapSpreadsheetObject,
  parseJsonFromModelText,
  parseSpreadsheetBuffer,
  planImportRows,
  sanitizeDraft,
} from './productImport.js';
import { extractProductDraftsFromImage, productPhotoVisionModel } from './productPhotoVision.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const SALON_A = 'salon-a';

describe('PRODUCTS-2 excel and photo import', () => {
  it('maps Armenian, Russian, and English spreadsheet headers', () => {
    const en = mapSpreadsheetObject({
      Brand: 'Kaaral',
      Line: 'BACO',
      'Code/Shade': '5.01',
      Name: 'BACO 5.01',
      Quantity: '2',
    });
    const ru = mapSpreadsheetObject({
      Бренд: 'Kaaral',
      Линия: 'BACO',
      'Код/оттенок': '5.18',
      Название: 'BACO 5.18',
      Количество: '1',
      'К закупке': 'да',
    });
    const hy = mapSpreadsheetObject({
      Բրենդ: 'Kaaral',
      Գիծ: 'BACO',
      Կոդ: '8.11',
      Անվանում: 'BACO 8.11',
      Քանակ: '3',
    });
    assert.equal(en.brand, 'Kaaral');
    assert.equal(en.codeShade, '5.01');
    assert.equal(en.quantity, 2);
    assert.equal(ru.codeShade, '5.18');
    assert.equal(ru.markedForPurchase, true);
    assert.equal(hy.codeShade, '8.11');
    assert.equal(hy.quantity, 3);
  });

  it('parses an xlsx buffer into product drafts', () => {
    const sheet = XLSX.utils.json_to_sheet([
      { Бренд: 'Kaaral', Линия: 'BACO', Код: 'SL12.0', Название: 'BACO SL12.0', Количество: 1 },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
    const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const rows = parseSpreadsheetBuffer(buffer);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.codeShade, 'SL12.0');
    assert.equal(rows[0]?.brand, 'Kaaral');
  });

  it('updates quantity for existing identity and creates new identity', () => {
    const existing = [
      {
        id: 'p1',
        salon_id: SALON_A,
        brand: 'Kaaral',
        line: 'BACO',
        code_shade: '5.01',
        name: 'BACO 5.01',
        quantity: 2,
      },
    ];
    const actions = planImportRows(existing, SALON_A, [
      sanitizeDraft({ brand: 'kaaral', line: 'baco', codeShade: '5.01', quantity: 3, name: 'BACO 5.01' }),
      sanitizeDraft({ brand: 'Kaaral', line: 'BACO', codeShade: '8.11', quantity: 1, name: 'BACO 8.11' }),
      sanitizeDraft({ name: '', brand: '', line: '', codeShade: '' }),
    ]);
    assert.equal(actions[0]?.kind, 'update');
    if (actions[0]?.kind === 'update') assert.equal(actions[0].quantityDelta, 3);
    assert.equal(actions[1]?.kind, 'create');
    assert.equal(actions[2]?.kind, 'skip');
  });

  it('parses multi-label photo JSON without writing to the database', () => {
    const parsed = parseJsonFromModelText(
      '```json\n{"products":[{"brand":"Kaaral","line":"BACO","codeShade":"5.01","quantity":1},{"brand":"Kaaral","line":"BACO","codeShade":"5.18"}]}\n```'
    );
    const rows = draftsFromPhotoPayload(parsed);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.codeShade, '5.01');
    assert.equal(rows[1]?.codeShade, '5.18');
    const vision = read('server/src/lib/productPhotoVision.ts');
    assert.match(vision, /openrouter\.ai\/api\/v1\/chat\/completions/);
    assert.match(vision, /openai\/gpt-4o-mini/);
    assert.doesNotMatch(vision, /from\('products'\)/);
    assert.doesNotMatch(vision, /\.insert\(/);
  });

  it('photo extractor uses injected fetch and never touches supabase', async () => {
    let called = 0;
    const rows = await extractProductDraftsFromImage({
      mimeType: 'image/jpeg',
      contentBase64: 'abc',
      apiKey: 'test-key',
      fetchImpl: async () => {
        called += 1;
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    products: [{ brand: 'Kaaral', line: 'BACO', codeShade: '5.01', name: 'BACO 5.01' }],
                  }),
                },
              },
            ],
          }),
        } as Response;
      },
    });
    assert.equal(called, 1);
    assert.equal(rows[0]?.codeShade, '5.01');
    assert.equal(productPhotoVisionModel(), 'openai/gpt-4o-mini');
  });

  it('parse and photo routes do not write products; commit is salon-scoped', () => {
    const route = read('server/src/routes/products.ts');
    const parse = route.slice(route.indexOf("router.post('/import/parse'"), route.indexOf("router.post('/import/photo'"));
    const photo = route.slice(route.indexOf("router.post('/import/photo'"), route.indexOf("router.post('/import/commit'"));
    const commit = route.slice(route.indexOf("router.post('/import/commit'"), route.indexOf("router.post('/', requireSalonWriteAccess"));
    assert.match(parse, /requireSalonWriteAccess/);
    assert.match(parse, /parseSpreadsheetBuffer/);
    assert.doesNotMatch(parse, /\.insert\(/);
    assert.match(photo, /extractProductDraftsFromImage/);
    assert.doesNotMatch(photo, /\.insert\(/);
    assert.doesNotMatch(photo, /\.update\(/);
    assert.match(commit, /\.eq\('salon_id',\s*salonId\)/);
    assert.match(commit, /findIdentityConflict/);
    assert.match(commit, /\.insert\(/);
    assert.match(commit, /\.update\(/);
  });

  it('malformed photo JSON and unknown fields fail safely', () => {
    assert.deepEqual(parseJsonFromModelText('not json at all'), []);
    assert.deepEqual(draftsFromPhotoPayload({ products: 'nope' }), []);
    const draft = sanitizeDraft({
      name: 'BACO 5.01',
      brand: 'Kaaral',
      quantity: 'nope',
      markedForPurchase: 'false',
    });
    assert.equal(draft.quantity, 1);
    assert.equal(draft.markedForPurchase, false);
  });

  it('excel export workbook is a valid xlsx', () => {
    const sheet = XLSX.utils.json_to_sheet([
      {
        Name: 'BACO 5.01',
        Brand: 'Kaaral',
        Line: 'BACO',
        'Code/Shade': '5.01',
        Category: 'Color',
        Quantity: 2,
        'Min quantity': 1,
        Unit: 'pcs',
        Price: 10,
        Supplier: '',
        Status: 'in_stock',
        'To order': 'yes',
      },
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Products');
    const buffer = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');
    const rows = parseSpreadsheetBuffer(buffer);
    assert.equal(rows[0]?.name, 'BACO 5.01');
    assert.equal(rows[0]?.codeShade, '5.01');
    assert.equal(rows[0]?.markedForPurchase, true);
  });

  it('products page uses one import pipeline, shared preview, and excel export', () => {
    const page = read('client/src/pages/Products.tsx');
    const ru = read('client/src/i18n/translations.ts');
    assert.match(page, /api\.products\.parseImport/);
    assert.match(page, /api\.products\.parsePhoto/);
    assert.match(page, /api\.products\.commitImport/);
    assert.match(page, /exportProductsXlsx/);
    assert.match(page, /previewRows/);
    assert.match(ru, /'products\.import': 'Импорт'/);
    assert.match(ru, /'products\.addPhoto': 'Добавить по фото'/);
    assert.match(ru, /'products\.exportExcel': 'Экспорт Excel'/);
    assert.match(page, /products\.photoProcessing/);
    assert.match(page, /photoStage === 'upload'/);
    assert.match(page, /photoStage === 'recognition'/);
    assert.match(page, /if \(!file \|\| importBusy\) return/);
  });
});
