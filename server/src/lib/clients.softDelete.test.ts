/**
 * FIX-CLIENT-DELETE: salon-scoped client soft-delete.
 * Does not execute SQL. Does not call Google / messengers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  appointmentsForClient,
  listActiveClientsForSalon,
  softDeleteClientInSalon,
  type AppointmentHistoryRow,
  type ClientSoftDeleteRow,
} from './clientSoftDelete.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const NOW = '2026-08-16T20:00:00.000Z';
const SALON_A = 'salon-a';
const SALON_B = 'salon-b';

function client(
  id: string,
  salonId: string,
  deletedAt: string | null = null
): ClientSoftDeleteRow {
  return { id, salon_id: salonId, deleted_at: deletedAt };
}

describe('FIX-CLIENT-DELETE client soft-delete', () => {
  it('A. client with zero appointments disappears from the active list', () => {
    const rows = [client('c-empty', SALON_A)];
    const appointments: AppointmentHistoryRow[] = [];

    const result = softDeleteClientInSalon(rows, {
      id: 'c-empty',
      salonId: SALON_A,
      now: NOW,
    });

    assert.equal(result, 'ok');
    assert.equal(rows[0]?.deleted_at, NOW);
    assert.deepEqual(listActiveClientsForSalon(rows, SALON_A), []);
    assert.deepEqual(appointmentsForClient(appointments, 'c-empty'), []);
  });

  it('B. client with appointment history deletes from the list; history stays', () => {
    const rows = [client('c-hist', SALON_A)];
    const appointments: AppointmentHistoryRow[] = [
      { id: 'appt-1', client_id: 'c-hist' },
      { id: 'appt-2', client_id: 'c-hist' },
    ];
    const snapshot = appointments.map((row) => ({ ...row }));

    const result = softDeleteClientInSalon(rows, {
      id: 'c-hist',
      salonId: SALON_A,
      now: NOW,
    });

    assert.equal(result, 'ok');
    assert.deepEqual(listActiveClientsForSalon(rows, SALON_A), []);
    assert.deepEqual(appointments, snapshot);
    assert.equal(appointmentsForClient(appointments, 'c-hist').length, 2);
  });

  it('C. cannot delete a client that belongs to another salon', () => {
    const rows = [client('c-other', SALON_B)];

    const result = softDeleteClientInSalon(rows, {
      id: 'c-other',
      salonId: SALON_A,
      now: NOW,
    });

    assert.equal(result, 'not_found');
    assert.equal(rows[0]?.deleted_at, null);
    assert.equal(listActiveClientsForSalon(rows, SALON_B).length, 1);
    assert.deepEqual(listActiveClientsForSalon(rows, SALON_A), []);
  });

  it('D. repeated delete is controlled (not_found), not a crash', () => {
    const rows = [client('c-once', SALON_A)];

    assert.equal(
      softDeleteClientInSalon(rows, { id: 'c-once', salonId: SALON_A, now: NOW }),
      'ok'
    );
    assert.equal(
      softDeleteClientInSalon(rows, { id: 'c-once', salonId: SALON_A, now: NOW }),
      'not_found'
    );
    assert.equal(rows[0]?.deleted_at, NOW);
    assert.deepEqual(listActiveClientsForSalon(rows, SALON_A), []);
  });

  it('route uses salon-scoped soft delete, not physical DELETE', () => {
    const route = read('server/src/routes/clients.ts');
    const listHandler = route.slice(route.indexOf("router.get('/',"), route.indexOf("router.get('/:id'"));
    const deleteHandler = route.slice(route.indexOf("router.delete('/:id'"));

    assert.match(listHandler, /\.is\('deleted_at',\s*null\)/);
    assert.match(listHandler, /\.eq\('salon_id',\s*salonId\)/);
    assert.doesNotMatch(listHandler, /\.delete\(\)/);

    assert.match(deleteHandler, /\.update\(\{\s*deleted_at:/);
    assert.match(deleteHandler, /\.eq\('id',\s*id\)/);
    assert.match(deleteHandler, /\.eq\('salon_id',\s*salonId\)/);
    assert.match(deleteHandler, /\.is\('deleted_at',\s*null\)/);
    assert.doesNotMatch(deleteHandler, /\.delete\(\)/);
    assert.doesNotMatch(deleteHandler, /from\('appointments'\)/);
    assert.doesNotMatch(deleteHandler, /from\('reminders'\)/);
  });

  it('GET /:id still loads by id + salon only so appointment joins keep working', () => {
    const route = read('server/src/routes/clients.ts');
    const getOne = route.slice(route.indexOf("router.get('/:id'"), route.indexOf("router.post('/',"));
    assert.match(getOne, /\.eq\('id',\s*req\.params\.id\)/);
    assert.match(getOne, /\.eq\('salon_id',\s*salonId\)/);
    assert.doesNotMatch(getOne, /deleted_at/);
  });

  it('Clients page waits for API success before removing the card', () => {
    const page = read('client/src/pages/Clients.tsx');
    const handleDelete = page.slice(page.indexOf('const handleDelete'), page.indexOf('const handleBlock'));
    assert.match(handleDelete, /await api\.clients\.delete\(id\)/);
    assert.match(handleDelete, /setClients\(\(prev\) => prev\.filter/);
    assert.match(handleDelete, /loadClients\(\)/);
    assert.match(handleDelete, /catch \(err\)/);
    assert.match(handleDelete, /console\.error\(err\)/);
    assert.doesNotMatch(handleDelete, /setClients\(\(prev\) => prev\.filter[\s\S]*await api\.clients\.delete/);
  });

  it('migration is additive deleted_at only', () => {
    const sql = read('supabase/migrations/20260816000004_clients_deleted_at.sql');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL/);
    assert.doesNotMatch(sql, /ON DELETE CASCADE/);
    assert.doesNotMatch(sql, /DROP TABLE/);
    assert.doesNotMatch(sql, /ALTER TABLE public\.appointments/);
    assert.doesNotMatch(sql, /DELETE FROM/);
  });

  it('does not change Google / messenger / Apple / Quick Booking sources', () => {
    const route = read('server/src/routes/clients.ts');
    assert.doesNotMatch(route, /googleCalendar|telegram|whatsapp|instagram|apple|quickBooking/i);
    const helper = read('server/src/lib/clientSoftDelete.ts');
    assert.doesNotMatch(helper, /googleCalendar|telegram|whatsapp|instagram|apple/i);
  });
});
