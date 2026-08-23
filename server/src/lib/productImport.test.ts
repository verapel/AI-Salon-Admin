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
import {
  formatProductPrice,
  parseCurrency,
  parsePercentage,
  parseProductPricing,
  parseVolume,
} from './productFields.js';

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

  it('creates two care products with the same brand/line and only updates the same name on reimport', () => {
    const hydra = sanitizeDraft({
      name: 'Hydra',
      brand: 'KAARAL',
      line: 'Les Crèmes',
      volume: '500 ml',
      category: 'care',
      quantity: 1,
    });
    const renew = sanitizeDraft({
      name: 'Renew Care',
      brand: 'KAARAL',
      line: 'Les Crèmes',
      volume: '500 ml',
      category: 'care',
      quantity: 1,
    });
    const first = planImportRows([], SALON_A, [hydra, renew]);
    assert.equal(first[0]?.kind, 'create');
    assert.equal(first[1]?.kind, 'create');

    const existing = [
      {
        id: 'hydra-1',
        salon_id: SALON_A,
        name: 'Hydra',
        brand: 'KAARAL',
        line: 'Les Crèmes',
        code_shade: 'Hydra',
        quantity: 1,
      },
      {
        id: 'renew-1',
        salon_id: SALON_A,
        name: 'Renew Care',
        brand: 'KAARAL',
        line: 'Les Crèmes',
        code_shade: 'Renew Care',
        quantity: 1,
      },
    ];
    const second = planImportRows(existing, SALON_A, [
      sanitizeDraft({ name: 'Hydra', brand: 'KAARAL', line: 'Les Crèmes', quantity: 1 }),
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.kind, 'update');
    if (second[0]?.kind === 'update') {
      assert.equal(second[0].id, 'hydra-1');
      assert.equal(second[0].quantityDelta, 1);
    }
  });

  it('parses volume, optional percentage, price, range, and currency', () => {
    assert.equal(parseVolume('100 ml'), '100 ml');
    assert.equal(parseVolume('250мл'), '250 ml');
    assert.equal(parseVolume('1 L'), '1 L');
    assert.equal(parseVolume(''), '');
    assert.equal(parsePercentage('1.5%'), 1.5);
    assert.equal(parsePercentage('9%'), 9);
    assert.equal(parsePercentage(''), null);
    const priced = parseProductPricing({ price: '2500', currency: 'AMD' });
    assert.equal(priced.price, 2500);
    assert.equal(priced.currency, 'AMD');
    assert.equal(formatProductPrice({ ...priced, priceMin: priced.priceMin, priceMax: priced.priceMax }), '2 500 AMD');
    const ranged = parseProductPricing({ priceRange: '2000–3000 AMD', currency: 'AMD' });
    assert.equal(ranged.priceMin, 2000);
    assert.equal(ranged.priceMax, 3000);
    assert.equal(formatProductPrice(ranged), '2 000–3 000 AMD');
    assert.equal(
      formatProductPrice({ price: 0, priceMin: 2000, priceMax: 3000, currency: 'AMD' }),
      '2 000–3 000 AMD'
    );
    assert.equal(
      formatProductPrice({ price: 0, price_min: 2000, price_max: 3000, currency: 'RUB' }),
      '2 000–3 000 RUB'
    );
    assert.notEqual(
      formatProductPrice({ price: 0, priceMin: 2000, priceMax: 3000, currency: 'AMD' }),
      '0 AMD'
    );
    assert.equal(formatProductPrice({ priceMin: 2000, currency: 'AMD' }), 'от 2 000 AMD');
    assert.equal(formatProductPrice({ price_min: '2000', currency: 'AMD' }), 'от 2 000 AMD');
    assert.equal(formatProductPrice({ priceMax: 3000, currency: 'AMD' }), 'до 3 000 AMD');
    assert.equal(formatProductPrice({ price_max: '3 000', currency: 'AMD' }), 'до 3 000 AMD');
    assert.equal(formatProductPrice({ price: 2500, currency: 'AMD' }), '2 500 AMD');
    assert.equal(formatProductPrice({ price: 0, currency: 'AMD' }), '—');
    assert.equal(formatProductPrice({ price: 0, priceMin: 0, priceMax: 0, currency: 'AMD' }), '—');
    assert.equal(formatProductPrice({ priceMin: '', priceMax: '', price: '', currency: 'AMD' }), '—');
    assert.equal(
      formatProductPrice({ price_min: '2 000', price_max: '3 000', currency: 'AMD' }),
      '2 000–3 000 AMD'
    );
    for (const category of ['paint', 'oxide', 'care'] as const) {
      assert.equal(
        formatProductPrice({
          price: 0,
          priceMin: 2000,
          priceMax: 3000,
          currency: 'USD',
        }),
        '2 000–3 000 USD',
        `${category} uses the same price formatter`
      );
      assert.equal(formatProductPrice({ price: 0, currency: 'EUR' }), '—', `${category} hides zero price`);
    }
    const productsPage = read('client/src/pages/Products.tsx');
    assert.match(productsPage, /import \{ formatProductPrice \} from '@\/lib\/productFormat'/);
    assert.equal((productsPage.match(/formatProductPrice\(product\)/g) || []).length, 2);
    assert.doesNotMatch(productsPage, /0 AMD/);
    const clientFormatter = read('client/src/lib/productFormat.ts');
    assert.match(clientFormatter, /от \$\{formatMoneyAmount\(min\)\} \$\{currency\}/);
    assert.match(clientFormatter, /до \$\{formatMoneyAmount\(max\)\} \$\{currency\}/);
    assert.match(clientFormatter, /return '—'/);
    assert.match(clientFormatter, /price_min/);
    assert.match(clientFormatter, /price_max/);
    assert.equal(parseCurrency('RUB'), 'RUB');
    assert.equal(parseCurrency('EUR'), 'EUR');
    const saved = sanitizeDraft({
      name: 'Oxydant',
      category: 'oxide',
      volume: '1л',
      percentage: '6%',
      price_min: 2000,
      price_max: 3000,
      currency: 'AMD',
    });
    assert.equal(saved.volume, '1 L');
    assert.equal(saved.percentage, 6);
    assert.equal(saved.priceMin, 2000);
    assert.equal(saved.priceMax, 3000);
    assert.equal(saved.currency, 'AMD');
    const legacy = sanitizeDraft({ name: 'Old Majirel', brand: 'Loreal', codeShade: '7.1', price: 1800 });
    assert.equal(legacy.volume, '');
    assert.equal(legacy.percentage, null);
    assert.equal(legacy.price, 1800);
    assert.equal(legacy.currency, 'AMD');
  });

  it('returns two preview rows for two care products and does not merge them', () => {
    const rows = draftsFromPhotoPayload({
      products: [
        { name: 'Absolut Repair Mask', brand: "L'Oreal", volume: '250 ml', category: 'care', price: 4200 },
        { name: 'Vitamino Color Shampoo', brand: "L'Oreal", volume: '300 ml', category: 'care', price: 3800 },
      ],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.name, 'Absolut Repair Mask');
    assert.equal(rows[1]?.name, 'Vitamino Color Shampoo');
    assert.equal(rows[0]?.volume, '250 ml');
    assert.equal(rows[1]?.volume, '300 ml');
  });

  it('parses paint photo JSON with shade, volume, and price', () => {
    const parsed = parseJsonFromModelText(
      '```json\n{"product":{"name":"Majirel","brand":"Loreal","codeShade":"6.1","volume":"50 ml","price":2500,"currency":"AMD","category":"paint"}}\n```'
    );
    const rows = draftsFromPhotoPayload(parsed);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.category, 'paint');
    assert.equal(rows[0]?.codeShade, '6.1');
    assert.equal(rows[0]?.volume, '50 ml');
    assert.equal(rows[0]?.price, 2500);
  });

  it('parses oxide photo JSON with percentage and price range', () => {
    const rows = draftsFromPhotoPayload({
      products: [
        {
          name: 'Oxydant Creme',
          brand: 'Loreal',
          percentage: '9%',
          volume: '1000 ml',
          price_min: 2000,
          price_max: 3000,
          currency: 'AMD',
          category: 'oxide',
        },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.category, 'oxide');
    assert.equal(rows[0]?.percentage, 9);
    assert.equal(rows[0]?.volume, '1000 ml');
    assert.equal(rows[0]?.priceMin, 2000);
    assert.equal(rows[0]?.priceMax, 3000);
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

  it('keeps two concatenated product objects instead of taking only the first', () => {
    const parsed = parseJsonFromModelText(
      '{"name":"Oil","brand":"Moroccanoil","volume":"100 ml","category":"care"}{"name":"Cream","brand":"Moroccanoil","volume":"250 ml","category":"care"}'
    );
    const rows = draftsFromPhotoPayload(parsed);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.name, 'Oil');
    assert.equal(rows[1]?.name, 'Cream');
  });

  it('malformed photo JSON and unknown fields fail safely', () => {
    assert.deepEqual(parseJsonFromModelText('not json at all'), []);
    assert.deepEqual(parseJsonFromModelText('{"products":[{"name":"One"},{"name":"Two"'), []);
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
        Volume: '100 ml',
        Percentage: 9,
        Price: 10,
        'Price min': '',
        'Price max': '',
        Currency: 'AMD',
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
    assert.equal(rows[0]?.volume, '100 ml');
    assert.equal(rows[0]?.percentage, 9);
    assert.equal(rows[0]?.currency, 'AMD');
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
