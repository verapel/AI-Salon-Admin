/**
 * In-app notification read/dismiss. Does not execute SQL or call live Supabase.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  mergeAckWrite,
  reminderIdsToDismiss,
  reminderIdsToMarkRead,
  unreadNotificationCount,
  visiblePendingReminders,
  type ReminderAckRow,
} from './notifications.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const SALON_A = 'salon-a';
const SALON_B = 'salon-b';
const USER_A = 'user-a';
const USER_B = 'user-b';

function reminder(id: string, salonId: string, status = 'pending') {
  return { id, salon_id: salonId, status };
}

function ack(
  reminderId: string,
  salonId: string,
  userId: string,
  patch: Partial<Pick<ReminderAckRow, 'read_at' | 'dismissed_at'>> = {}
): ReminderAckRow {
  return {
    reminder_id: reminderId,
    salon_id: salonId,
    user_id: userId,
    read_at: patch.read_at ?? null,
    dismissed_at: patch.dismissed_at ?? null,
  };
}

describe('in-app notification acks', () => {
  it('counts unread pending reminders and ignores other salons/users', () => {
    const reminders = [
      reminder('r1', SALON_A),
      reminder('r2', SALON_A),
      reminder('r3', SALON_A, 'sent'),
      reminder('r4', SALON_B),
    ];
    const acks = [
      ack('r2', SALON_A, USER_A, { read_at: '2026-08-17T00:00:00.000Z' }),
      ack('r1', SALON_A, USER_B, { dismissed_at: '2026-08-17T00:00:00.000Z' }),
      ack('r4', SALON_B, USER_A, { dismissed_at: '2026-08-17T00:00:00.000Z' }),
    ];

    const visible = visiblePendingReminders(reminders, acks, SALON_A, USER_A);
    assert.deepEqual(
      visible.map((row) => row.id),
      ['r1', 'r2']
    );
    assert.equal(unreadNotificationCount(reminders, acks, SALON_A, USER_A), 1);
    assert.equal(unreadNotificationCount(reminders, acks, SALON_A, USER_B), 1);
    assert.equal(unreadNotificationCount(reminders, acks, SALON_B, USER_A), 0);
  });

  it('mark-read skips dismissed and already-read rows', () => {
    const ids = ['r1', 'r2', 'r3'];
    const acks = [
      ack('r2', SALON_A, USER_A, { read_at: 't' }),
      ack('r3', SALON_A, USER_A, { dismissed_at: 't' }),
    ];
    assert.deepEqual(reminderIdsToMarkRead(ids, acks, SALON_A, USER_A), ['r1']);
    assert.deepEqual(reminderIdsToMarkRead(ids, acks, SALON_A, USER_B), ids);
  });

  it('dismiss-all skips already dismissed and does not touch other users', () => {
    const ids = ['r1', 'r2'];
    const acks = [ack('r1', SALON_A, USER_A, { dismissed_at: 't' })];
    assert.deepEqual(reminderIdsToDismiss(ids, acks, SALON_A, USER_A), ['r2']);
    assert.deepEqual(reminderIdsToDismiss(ids, acks, SALON_A, USER_B), ids);
  });

  it('mark-read merge keeps dismissed_at', () => {
    const existing = ack('r1', SALON_A, USER_A, { dismissed_at: 'd1', read_at: 'r0' });
    assert.deepEqual(mergeAckWrite(existing, { read_at: 'r1' }), {
      read_at: 'r1',
      dismissed_at: 'd1',
    });
    assert.deepEqual(mergeAckWrite(undefined, { read_at: 'r1' }), {
      read_at: 'r1',
      dismissed_at: null,
    });
    assert.deepEqual(mergeAckWrite(existing, { read_at: 'r1', dismissed_at: 'd2' }), {
      read_at: 'r1',
      dismissed_at: 'd2',
    });
  });

  it('empty feed has zero unread', () => {
    assert.equal(unreadNotificationCount([], [], SALON_A, USER_A), 0);
    assert.deepEqual(visiblePendingReminders([], [], SALON_A, USER_A), []);
  });

  it('migration acks reminders without changing reminder status', () => {
    const sql = read('supabase/migrations/20260817000002_reminder_notification_acks.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.reminder_notification_acks/);
    assert.match(sql, /salon_id\s+UUID NOT NULL REFERENCES public\.salons\(id\)/);
    assert.match(sql, /user_id\s+UUID NOT NULL REFERENCES auth\.users\(id\)/);
    assert.match(sql, /reminder_id\s+UUID NOT NULL REFERENCES public\.reminders\(id\)/);
    assert.match(sql, /reminder_notification_acks_unique/);
    assert.match(sql, /read_at/);
    assert.match(sql, /dismissed_at/);
    assert.doesNotMatch(sql, /UPDATE public\.reminders/);
  });

  it('routes scope by salon and user and never hard-delete reminders', () => {
    const route = read('server/src/routes/notifications.ts');
    const index = read('server/src/index.ts');
    const header = read('client/src/components/layout/Header.tsx');

    assert.match(
      index,
      /app\.use\('\/api\/notifications',\s*salonAuth,\s*requireSalonCabinetAccess,\s*notificationsRouter\)/
    );
    assert.match(route, /getSalonId\(req\)/);
    assert.match(route, /getUserId\(req\)/);
    assert.match(route, /\.eq\('salon_id',\s*salonId\)/);
    assert.match(route, /\.eq\('user_id',\s*userId\)/);
    assert.match(route, /requireSalonWriteAccess/);
    assert.match(route, /router\.post\('\/read'/);
    assert.match(route, /router\.post\('\/dismiss-all'/);
    assert.match(route, /router\.post\('\/:id\/dismiss'/);
    assert.match(route, /mergeAckWrite/);
    assert.doesNotMatch(route, /req\.body\?\.salonId|req\.body\.salon_id|req\.body\.userId/);
    assert.doesNotMatch(route, /\.from\('reminders'\)[\s\S]*\.delete\(/);
    assert.doesNotMatch(route, /status:\s*'skipped'|status:\s*'sent'/);

    assert.match(header, /api\.notifications/);
    assert.match(header, /\.list\(\)/);
    assert.match(header, /\.markRead\(\)/);
    assert.match(header, /\.dismissAll\(\)/);
    assert.match(header, /handleDismissOne/);
    assert.doesNotMatch(header, /api\.stats\.getReminders/);
  });
});
