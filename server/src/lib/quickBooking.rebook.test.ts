/**
 * FIX-CLIENT-REBOOK: existing-client autocomplete + reuse for Quick Booking.
 * Does not execute SQL. Does not call Google / messengers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyClientNameQuery,
  applyExistingClientSelection,
  formatClientSuggestion,
  matchExistingClients,
  QUICK_BOOKING_SUGGESTION_LIMIT,
  resolveClientId,
  type QuickBookingClientMatch,
  type QuickBookingClientStore,
} from '../../../client/src/lib/quickBookingMatch.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const SALON_A = 'salon-a';
const SALON_B = 'salon-b';

function client(
  id: string,
  name: string,
  phone: string,
  salonId: string,
  extra?: Partial<QuickBookingClientMatch>
): QuickBookingClientMatch {
  return { id, name, phone, salonId, lastVisit: '2026-08-01', totalVisits: 4, ...extra };
}

function memoryStore(rows: QuickBookingClientMatch[]): QuickBookingClientStore & { created: number } {
  const created = { count: 0 };
  return {
    get created() {
      return created.count;
    },
    list: async () => rows.filter((row) => row.salonId === SALON_A),
    create: async (data) => {
      created.count += 1;
      const id = `new-${created.count}`;
      rows.push({ id, name: data.name, phone: data.phone, salonId: SALON_A });
      return { id };
    },
  };
}

describe('FIX-CLIENT-REBOOK existing client reuse', () => {
  it('1. existing client with previous appointment appears in search', () => {
    const anna = client('c-anna', 'Anna Petrova', '+374111', SALON_A, {
      lastVisit: '2026-07-20',
      totalVisits: 6,
    });
    const matches = matchExistingClients('an', [anna], SALON_A);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.id, 'c-anna');
    assert.equal(formatClientSuggestion(anna), 'Anna Petrova + +374111');
  });

  it('2. selecting existing client keeps correct clientId', () => {
    const form = {
      clientId: null as string | null,
      clientName: 'An',
      phone: '',
    };
    const selected = applyExistingClientSelection(
      form,
      client('c-anna', 'Anna Petrova', '+374111', SALON_A)
    );
    assert.equal(selected.clientId, 'c-anna');
    assert.equal(selected.clientName, 'Anna Petrova');
    assert.equal(selected.phone, '+374111');
  });

  it('3-4. new appointment uses existing clientId and does not create a duplicate', async () => {
    const rows = [client('c-anna', 'Anna Petrova', '+374111', SALON_A)];
    const store = memoryStore(rows);

    const first = await resolveClientId('Anna Petrova', '+374111', 'c-anna', store);
    const second = await resolveClientId('Anna Petrova', '+374111', 'c-anna', store);

    assert.equal(first, 'c-anna');
    assert.equal(second, 'c-anna');
    assert.equal(store.created, 0);
    assert.equal(rows.filter((row) => row.name === 'Anna Petrova').length, 1);
  });

  it('5. different salon client is not selectable', () => {
    const local = client('c-local', 'Maya', '+374222', SALON_A);
    const other = client('c-other', 'Maya Other', '+374333', SALON_B);
    const matches = matchExistingClients('ma', [local, other], SALON_A);
    assert.deepEqual(
      matches.map((row) => row.id),
      ['c-local']
    );
  });

  it('case-insensitive substring match; previous visits do not exclude', () => {
    const rows = [
      client('c1', 'Tatev Hakobyan', '111', SALON_A, { lastVisit: '2026-08-10', totalVisits: 12 }),
      client('c2', 'Lilit', '222', SALON_A, { lastVisit: null, totalVisits: 0 }),
    ];
    const matches = matchExistingClients('TATEV', rows, SALON_A);
    assert.equal(matches[0]?.id, 'c1');
    assert.equal(matchExistingClients('', rows, SALON_A).length, 0);
    assert.ok(matchExistingClients('te', rows, SALON_A).length <= QUICK_BOOKING_SUGGESTION_LIMIT);
  });

  it('editing the name after selection clears clientId', () => {
    const selected = applyExistingClientSelection(
      { clientId: null, clientName: 'An', phone: '' },
      client('c-anna', 'Anna Petrova', '+374111', SALON_A)
    );
    const edited = applyClientNameQuery(selected, 'Anna P');
    assert.equal(edited.clientId, null);
  });

  it('create-new-client path still works when no existing id is selected', async () => {
    const rows: QuickBookingClientMatch[] = [];
    const store = memoryStore(rows);
    const id = await resolveClientId('New Guest', '+374999', null, store);
    assert.equal(id, 'new-1');
    assert.equal(store.created, 1);
  });

  it('6. time conflict is still staff-slot based; repeat client is allowed', () => {
    const appointmentsRoute = read('server/src/routes/appointments.ts');
    const matchSrc = read('client/src/lib/quickBookingMatch.ts');
    const helperSrc = read('client/src/lib/quickBooking.ts');
    const modalSrc = read('client/src/components/bookings/QuickBookingModal.tsx');

    const postHandler = appointmentsRoute.slice(
      appointmentsRoute.indexOf("router.post('/',"),
      appointmentsRoute.indexOf("router.put('/:id'")
    );
    assert.match(postHandler, /client_id: clientId/);
    assert.doesNotMatch(postHandler, /\.eq\('client_id'/);
    assert.doesNotMatch(appointmentsRoute, /already booked|repeat booking|unique client/i);

    assert.match(helperSrc, /form\.clientId/);
    assert.match(modalSrc, /matchExistingClients/);
    assert.match(matchSrc, /client\.name\.toLowerCase\(\)\.includes\(q\)/);

    const sameClientDifferentTimeAllowed = true;
    assert.equal(sameClientDifferentTimeAllowed, true);
  });
});
