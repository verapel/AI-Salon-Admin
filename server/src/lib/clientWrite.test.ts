/**
 * FIX-CLIENT-OPTIONAL-EMAIL: email is optional on client create/edit.
 * Does not execute SQL. Does not call live Supabase.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildClientCreateRow, buildClientUpdate } from './clientWrite.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const SALON_A = 'salon-a';

describe('FIX-CLIENT-OPTIONAL-EMAIL client create/edit', () => {
  it('creates a client without email using empty-string DB convention', () => {
    const result = buildClientCreateRow({ name: 'Anna' }, SALON_A);
    assert.ok(!('error' in result));
    assert.equal(result.row.name, 'Anna');
    assert.equal(result.row.email, '');
    assert.equal(result.row.phone, '');
    assert.equal(result.row.notes, '');
    assert.equal(result.row.birthday, null);
    assert.equal(result.row.salon_id, SALON_A);
  });

  it('creates a client with email unchanged', () => {
    const result = buildClientCreateRow(
      { name: 'Emma', email: 'emma.wilson@email.com' },
      SALON_A
    );
    assert.ok(!('error' in result));
    assert.equal(result.row.email, 'emma.wilson@email.com');
  });

  it('saves with other optional fields empty', () => {
    const result = buildClientCreateRow(
      { name: 'Olga', email: '  ', phone: '', notes: '', birthday: '' },
      SALON_A
    );
    assert.ok(!('error' in result));
    assert.equal(result.row.email, '');
    assert.equal(result.row.phone, '');
    assert.equal(result.row.notes, '');
    assert.equal(result.row.birthday, null);
  });

  it('clears email on edit without requiring a synthetic value', () => {
    const result = buildClientUpdate({
      name: 'Anna',
      email: '',
      phone: '',
      notes: '',
      birthday: '',
    });
    assert.ok(!('error' in result));
    assert.equal(result.updates.email, '');
    assert.equal(result.updates.phone, '');
    assert.equal(result.updates.notes, '');
    assert.equal(result.updates.birthday, null);
  });

  it('keeps an existing email when it is still provided', () => {
    const result = buildClientUpdate({ email: 'keep@salon.local' });
    assert.ok(!('error' in result));
    assert.equal(result.updates.email, 'keep@salon.local');
  });

  it('still requires a name', () => {
    const create = buildClientCreateRow({ email: 'a@b.com' }, SALON_A);
    assert.deepEqual(create, { error: 'Name is required' });
    const update = buildClientUpdate({ name: '   ' });
    assert.deepEqual(update, { error: 'Name is required' });
  });

  it('POST/PUT use optional-email helpers and keep salon isolation', () => {
    const route = read('server/src/routes/clients.ts');
    const post = route.slice(route.indexOf("router.post('/',"), route.indexOf("router.put('/:id'"));
    const put = route.slice(route.indexOf("router.put('/:id'"), route.indexOf("router.post('/:id/block'"));

    assert.match(post, /buildClientCreateRow\(req\.body,\s*salonId\)/);
    assert.match(post, /getSalonId\(req\)/);
    assert.doesNotMatch(post, /Name and email are required/);
    assert.doesNotMatch(post, /!name \|\| !email/);
    assert.doesNotMatch(post, /no-email\.local/);

    assert.match(put, /buildClientUpdate/);
    assert.match(put, /\.eq\('salon_id',\s*salonId\)/);
    assert.doesNotMatch(put, /no-email\.local/);
  });

  it('Clients form does not require email', () => {
    const page = read('client/src/pages/Clients.tsx');
    const form = page.slice(page.indexOf('<form onSubmit={handleSubmit}'), page.indexOf('</form>'));
    const emailBlock = form.slice(
      form.indexOf("t('clients.fieldEmail')"),
      form.indexOf("t('clients.fieldPhone')")
    );
    assert.doesNotMatch(emailBlock, /required/);
    const nameBlock = form.slice(
      form.indexOf("t('clients.fieldName')"),
      form.indexOf("t('clients.fieldEmail')")
    );
    assert.match(nameBlock, /required/);
  });
});
