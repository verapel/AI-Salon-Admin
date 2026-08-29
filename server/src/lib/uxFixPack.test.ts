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
    const desktop = page.slice(page.indexOf('hidden sm:block'), page.indexOf('products.photoProcessing'));
    const mobile = page.slice(page.indexOf('space-y-2 sm:hidden'), page.indexOf('hidden sm:block'));
    assert.match(desktop, /columnPrice[\s\S]*fieldPriceRange[\s\S]*columnActions/);
    assert.match(desktop, /formatProductExactPrice\(product, salonCurrency\)/);
    assert.match(desktop, /formatProductPriceRange\(product, salonCurrency\)/);
    assert.doesNotMatch(desktop, /formatProductPrice\(product\)/);
    assert.match(mobile, /formatProductExactPrice\(product, salonCurrency\)/);
    assert.match(mobile, /formatProductPriceRange\(product, salonCurrency\)/);
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

  it('5. mobile nav starts with Calendar, Clients, then Services', () => {
    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    const mobile = sidebar.slice(sidebar.indexOf('mobileNavItems'), sidebar.indexOf('interface SidebarProps'));
    const desktop = sidebar.slice(sidebar.indexOf('desktopNavItems'), sidebar.indexOf('mobileNavItems'));
    assert.match(mobile, /to: '\/calendar'[\s\S]*to: '\/clients'[\s\S]*to: '\/services'/);
    assert.ok(mobile.indexOf("to: '/calendar'") < mobile.indexOf("to: '/clients'"));
    assert.ok(mobile.indexOf("to: '/clients'") < mobile.indexOf("to: '/services'"));
    assert.ok(mobile.indexOf("to: '/services'") < mobile.indexOf("to: '/products'"));
    assert.match(desktop, /to: '\/'[\s\S]*to: '\/calendar'[\s\S]*to: '\/clients'[\s\S]*to: '\/services'/);
    assert.ok(desktop.indexOf("to: '/'") < desktop.indexOf("to: '/calendar'"));
    assert.match(sidebar, /lg:hidden/);
    assert.match(sidebar, /hidden[\s\S]*lg:flex/);
    assert.doesNotMatch(sidebar, /mobileClass/);
  });

  it('6. revenue formatting uses salon currency, default AMD, not hardcoded USD', () => {
    assert.equal(formatCurrency(2500), '2 500 AMD');
    assert.equal(formatCurrency(0), '0 AMD');
    assert.equal(formatCurrency(2500, 'RUB'), '2 500 RUB');
    assert.equal(formatCurrency(2500, 'USD'), '2 500 USD');
    assert.equal(formatCurrencyAxis(2500), '2 500');
    const currencyLib = read('client/src/lib/currency.ts');
    const header = read('client/src/components/layout/Header.tsx');
    const stats = read('client/src/pages/Statistics.tsx');
    const dashboard = read('client/src/pages/Dashboard.tsx');
    assert.match(currencyLib, /DEFAULT_SALON_CURRENCY: SalonCurrency = 'AMD'/);
    assert.doesNotMatch(currencyLib, /DEFAULT_SALON_CURRENCY[^\n]*USD/);
    assert.match(header, /SALON_CURRENCIES/);
    assert.match(header, /header\.selectCurrency/);
    assert.match(stats, /formatCurrency\(value\)/);
    assert.match(stats, /formatCurrencyAxis/);
    assert.doesNotMatch(stats, /`\$\{v\}`/);
    assert.match(dashboard, /formatCurrency\(stats\?\.monthlyRevenue/);
    assert.match(read('server/src/routes/salonSettings.ts'), /parseSalonCurrency/);
    assert.doesNotMatch(read('server/src/routes/salonSettings.ts'), /\*  [0-9]|amount \*|exchange|fxRate/);
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
    assert.match(page, /WEEK_DAY_HEADER_HEIGHT_PX/);
    assert.match(page, /TIMED_EVENTS_LAYER_OFFSET_PX/);
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

  it('9. product row tap opens edit immediately; mobile cards stay compact and complete', () => {
    const page = read('client/src/pages/Products.tsx');
    assert.match(page, /onClick=\{\(\) => openEdit\(product\)\}/);
    assert.doesNotMatch(page, /setDetailProduct/);
    assert.doesNotMatch(page, /products\.detailsTitle/);
    assert.doesNotMatch(page, /liveDetail/);
    const desktop = page.slice(page.indexOf('hidden sm:block'), page.indexOf('products.photoProcessing'));
    const mobile = page.slice(page.indexOf('space-y-2 sm:hidden'), page.indexOf('hidden sm:block'));
    assert.doesNotMatch(desktop, /columnVolume/);
    assert.doesNotMatch(desktop, /columnPercentage/);
    assert.match(desktop, /columnProduct/);
    assert.match(desktop, /columnQty/);
    assert.match(desktop, /columnStatus/);
    assert.match(desktop, /columnPrice/);
    assert.match(desktop, /fieldPriceRange/);
    assert.match(desktop, /onClick=\{\(\) => openEdit\(product\)\}/);
    assert.match(mobile, /openEdit\(product\)/);
    assert.match(mobile, /formatProductExactPrice\(product, salonCurrency\)/);
    assert.match(mobile, /formatProductPriceRange\(product, salonCurrency\)/);
    assert.match(mobile, /product\.line/);
    assert.match(mobile, /product\.volume/);
    assert.match(mobile, /product\.percentage/);
    assert.match(mobile, /salonCurrency/);
    assert.match(mobile, /p-3/);
    assert.match(page, /api\.products\.parsePhoto/);
    assert.match(page, /api\.products\.parseImport/);
  });
});
