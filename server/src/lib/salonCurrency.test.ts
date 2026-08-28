/**
 * Salon currency: AMD / RUB / USD display setting (no conversion).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_SALON_CURRENCY,
  formatCurrency,
  formatCurrencyAxis,
  parseSalonCurrency,
  SALON_CURRENCIES,
} from '../../../client/src/lib/currency.ts';
import { parseSalonCurrency as parseServerCurrency } from './salonCurrency.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('salon global currency', () => {
  it('defaults to AMD and supports AMD/RUB/USD without converting amounts', () => {
    assert.equal(DEFAULT_SALON_CURRENCY, 'AMD');
    assert.deepEqual([...SALON_CURRENCIES], ['AMD', 'RUB', 'USD']);
    assert.equal(parseSalonCurrency(undefined), 'AMD');
    assert.equal(parseSalonCurrency(''), 'AMD');
    assert.equal(parseSalonCurrency('eur'), 'AMD');
    assert.equal(parseSalonCurrency('RUB'), 'RUB');
    assert.equal(parseServerCurrency('usd'), 'USD');
    assert.equal(formatCurrency(2500), '2 500 AMD');
    assert.equal(formatCurrency(2500, 'RUB'), '2 500 RUB');
    assert.equal(formatCurrency(2500, 'USD'), '2 500 USD');
    assert.equal(formatCurrency(2500, 'AMD'), '2 500 AMD');
    assert.equal(formatCurrencyAxis(2500, 'USD'), '2 500');
  });

  it('persists via salon settings API and a header switcher', () => {
    const route = read('server/src/routes/salonSettings.ts');
    const index = read('server/src/index.ts');
    const header = read('client/src/components/layout/Header.tsx');
    const api = read('client/src/lib/api.ts');
    const ctx = read('client/src/context/CurrencyContext.tsx');
    const main = read('client/src/main.tsx');
    assert.match(index, /app\.use\('\/api\/salon',\s*salonAuth,\s*salonSettingsRouter\)/);
    assert.match(route, /router\.get\('\/settings'/);
    assert.match(route, /router\.patch\('\/settings'/);
    assert.match(route, /isSalonCurrency/);
    assert.doesNotMatch(route, /\* ?0\.[0-9]|exchangeRate|convertAmount/);
    assert.match(api, /getSettings: \(\) => request<\{ currency: string }>\('\/salon\/settings'\)/);
    assert.match(api, /method: 'PATCH'/);
    assert.match(header, /header\.selectCurrency/);
    assert.match(header, /SALON_CURRENCIES\.map/);
    assert.match(ctx, /api\.salon\.getSettings/);
    assert.match(ctx, /api\.salon\.updateSettings/);
    assert.match(main, /CurrencyProvider/);
  });

  it('user-facing money UI uses the shared formatter, not hardcoded USD', () => {
    const pages = [
      'client/src/pages/Dashboard.tsx',
      'client/src/pages/Statistics.tsx',
      'client/src/pages/Services.tsx',
      'client/src/pages/Bookings.tsx',
      'client/src/pages/Products.tsx',
    ];
    for (const rel of pages) {
      const src = read(rel);
      assert.doesNotMatch(src, /style:\s*'currency',\s*currency:\s*'USD'/);
      assert.doesNotMatch(src, /Price \(AMD\)/);
      assert.doesNotMatch(src, /\$\{formatCurrency/);
    }
    const services = read('client/src/pages/Services.tsx');
    assert.match(services, /useCurrency/);
    assert.match(services, /t\('services\.fieldPrice'\)\} \(\{currency\}\)/);
    const products = read('client/src/pages/Products.tsx');
    assert.match(products, /formatProductExactPrice\(product, salonCurrency\)/);
    assert.match(products, /formatProductPriceRange\(product, salonCurrency\)/);
    assert.doesNotMatch(products, /<option value="EUR">/);
  });
});
