/**
 * UX fix pack: Google 1-minute sync, product numeric input, price columns,
 * mobile products navigation, mobile nav order, AMD revenue, calendar layout,
 * mobile search zoom, product list/details.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GOOGLE_CALENDAR_PULL_INTERVAL_MS } from './googleCalendarAutoImport.ts';
import {
  layoutDayEvents,
  parseTimeToMinutes,
  nowLineOffset,
} from '../../../client/src/lib/calendarLayout.ts';
import {
  numericDisplayValue,
  parseDecimalInput,
  parseIntegerInput,
  sanitizeDecimalInput,
  sanitizeIntegerInput,
} from '../../../client/src/lib/numericInput.ts';
import { formatCurrency, formatCurrencyAxis } from '../../../client/src/lib/utils.ts';
import { formatProductExactPrice, formatProductPriceRange } from '../../../client/src/lib/productFormat.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('UX fix pack', () => {
  it('1. Google Calendar auto sync interval is 60 seconds', () => {
    assert.equal(GOOGLE_CALENDAR_PULL_INTERVAL_MS, 60 * 1000);
    const auto = read('server/src/lib/googleCalendarAutoImport.ts');
    const worker = read('server/src/lib/googleCalendarPullWorker.ts');
    assert.match(auto, /GOOGLE_CALENDAR_PULL_INTERVAL_MS = 60 \* 1000/);
    assert.doesNotMatch(auto, /5 \* 60 \* 1000/);
    assert.match(worker, /intervalMs \?\? GOOGLE_CALENDAR_PULL_INTERVAL_MS/);
    assert.match(worker, /tickGoogleCalendarPullWorker/);
    assert.match(read('server/src/lib/googleCalendarImport.ts'), /executeManualGoogleCalendarImport/);
  });

  it('2. numeric product fields strip leading zeros and allow empty', () => {
    assert.equal(sanitizeIntegerInput('05'), '5');
    assert.equal(sanitizeIntegerInput('012'), '12');
    assert.equal(sanitizeIntegerInput('0'), '0');
    assert.equal(sanitizeIntegerInput(''), '');
    assert.equal(sanitizeIntegerInput('5'), '5');
    assert.equal(sanitizeDecimalInput('05'), '5');
    assert.equal(sanitizeDecimalInput('012.50'), '12.50');
    assert.equal(sanitizeDecimalInput('0.5'), '0.5');
    assert.equal(sanitizeDecimalInput(''), '');
    assert.equal(numericDisplayValue(0), '');
    assert.equal(numericDisplayValue(5), '5');
    assert.equal(parseIntegerInput('', 0), 0);
    assert.equal(parseIntegerInput('8', 0), 8);
    assert.equal(parseDecimalInput(''), null);
    assert.equal(parseDecimalInput('2500'), 2500);

    const page = read('client/src/pages/Products.tsx');
    const numeric = read('client/src/components/ui/NumericInput.tsx');
    assert.match(numeric, /sanitizeIntegerInput/);
    assert.match(numeric, /type="text"/);
    assert.match(numeric, /inputMode/);
    assert.doesNotMatch(page, /type="number"/);
    assert.match(page, /parseIntegerInput\(form\.quantity/);
    assert.match(page, /parseDecimalInput\(form\.price\)/);
    assert.match(page, /form\.priceMin/);
    assert.match(page, /form\.priceMax/);
    assert.match(page, /form\.percentage/);
  });

  it('3. product tables keep exact price and a separate range column', () => {
    const page = read('client/src/pages/Products.tsx');
    const desktop = page.slice(page.indexOf('hidden sm:block'), page.indexOf('products.detailsTitle'));
    const mobile = page.slice(page.indexOf('space-y-3 sm:hidden'), page.indexOf('hidden sm:block'));
    assert.match(desktop, /columnPrice[\s\S]*fieldPriceRange[\s\S]*columnActions/);
    assert.match(desktop, /formatProductExactPrice\(product\)/);
    assert.match(desktop, /formatProductPriceRange\(product\)/);
    assert.doesNotMatch(desktop, /formatProductPrice\(product\)/);
    assert.match(mobile, /formatProductExactPrice\(product\)/);
    assert.match(mobile, /formatProductPriceRange\(product\)/);
    assert.equal(formatProductExactPrice({ price: 2500, currency: 'AMD' }), '2 500 AMD');
    assert.equal(formatProductExactPrice({ price: 0, currency: 'AMD' }), '—');
    assert.equal(
      formatProductPriceRange({ priceMin: 2000, priceMax: 3000, currency: 'AMD' }),
      '2 000 – 3 000 AMD'
    );
    assert.equal(formatProductPriceRange({ price: 2500, currency: 'AMD' }), '—');
  });

  it('4. product section navigation is URL-backed so back stays in products', () => {
    const page = read('client/src/pages/Products.tsx');
    assert.match(page, /useSearchParams/);
    assert.match(page, /setSearchParams\(\{ section: next \}\)/);
    assert.match(page, /handleSectionBack/);
    assert.match(page, /setSearchParams\(\{\}, \{ replace: true \}\)/);
    assert.match(page, /isProductSection/);
    assert.doesNotMatch(page, /navigate\('\/calendar'\)/);
  });

  it('5. mobile nav puts Calendar first and Clients immediately after', () => {
    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.match(sidebar, /to: '\/calendar'[\s\S]*mobileClass: 'order-1 lg:order-none'/);
    assert.match(sidebar, /to: '\/clients'[\s\S]*mobileClass: 'order-2 lg:order-none'/);
    assert.match(sidebar, /to: '\/services'[\s\S]*mobileClass: 'order-3 lg:order-none'/);
    assert.match(sidebar, /to: '\/products'[\s\S]*mobileClass: 'order-4 lg:order-none'/);
    assert.match(sidebar, /to: '\/staff'[\s\S]*mobileClass: 'order-5 lg:order-none'/);
    assert.match(sidebar, /to: '\/'[\s\S]*mobileClass: 'order-6 lg:order-none'/);
    assert.match(sidebar, /lg:order-none/);
  });

  it('6. revenue formatting uses AMD not USD', () => {
    assert.equal(formatCurrency(2500), '2 500 AMD');
    assert.equal(formatCurrency(0), '0 AMD');
    assert.equal(formatCurrencyAxis(2500), '2 500');
    const utils = read('client/src/lib/utils.ts');
    const stats = read('client/src/pages/Statistics.tsx');
    const dashboard = read('client/src/pages/Dashboard.tsx');
    assert.match(utils, /currency = 'AMD'/);
    assert.doesNotMatch(utils, /currency: 'USD'/);
    assert.match(stats, /formatCurrency\(value\)/);
    assert.match(stats, /formatCurrencyAxis/);
    assert.doesNotMatch(stats, /`\$\{v\}`/);
    assert.match(dashboard, /formatCurrency\(stats\?\.monthlyRevenue/);
  });

  it('7. calendar positions appointments on a timed day/week grid', () => {
    assert.equal(parseTimeToMinutes('09:30'), 9 * 60 + 30);
    const laid = layoutDayEvents(
      [
        { id: 'a', startTime: '10:00', endTime: '11:00' },
        { id: 'b', startTime: '10:30', endTime: '11:30' },
      ],
      8,
      19,
      60
    );
    assert.equal(laid.length, 2);
    assert.equal(laid[0]?.top, 2 * 60);
    assert.equal(laid[0]?.height, 60);
    assert.ok((laid[0]?.columnCount ?? 0) >= 2);
    assert.notEqual(laid[0]?.column, laid[1]?.column);
    const nowTop = nowLineOffset(8, 60, new Date(2026, 7, 28, 10, 0, 0));
    assert.equal(nowTop, 2 * 60);

    const page = read('client/src/pages/Calendar.tsx');
    assert.match(page, /layoutDayEvents/);
    assert.match(page, /DayTimeline/);
    assert.match(page, /nowLineOffset/);
    assert.match(page, /WEEK_GRID_CLASS/);
    assert.match(page, /navigateWeek/);
    assert.match(page, /kind === 'google_review'/);
    assert.match(page, /getGoogleReviewEvents/);
  });

  it('8. mobile search/input does not use sub-16px fonts or unbounded scale', () => {
    const html = read('client/index.html');
    const css = read('client/src/index.css');
    const search = read('client/src/components/ui/SearchInput.tsx');
    const products = read('client/src/pages/Products.tsx');
    assert.match(html, /maximum-scale=1/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(css, /text-base/);
    assert.match(css, /-webkit-text-size-adjust: 100%/);
    assert.match(search, /text-base/);
    assert.doesNotMatch(search, /sm:text-sm/);
    assert.match(search, /onBlur=\{resetStaleMobileZoom\}/);
    assert.match(products, /overflow-x-clip/);
    assert.match(products, /SearchInput/);
  });

  it('9. product list is essential columns; details open on row tap', () => {
    const page = read('client/src/pages/Products.tsx');
    assert.match(page, /setDetailProduct\(product\)/);
    assert.match(page, /products\.detailsTitle/);
    assert.match(page, /openEdit\(liveDetail\)/);
    const desktop = page.slice(page.indexOf('hidden sm:block'), page.indexOf('products.detailsTitle'));
    assert.doesNotMatch(desktop, /columnVolume/);
    assert.doesNotMatch(desktop, /columnPercentage/);
    assert.match(desktop, /columnProduct/);
    assert.match(desktop, /columnQty/);
    assert.match(desktop, /columnStatus/);
    assert.match(desktop, /columnPrice/);
    assert.match(desktop, /fieldPriceRange/);
    assert.match(page, /api\.products\.parsePhoto/);
    assert.match(page, /api\.products\.parseImport/);
  });
});
