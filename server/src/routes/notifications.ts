import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapEnrichedReminder } from '../lib/mappers.js';
import { getSalonId, getUserId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import {
  indexAcks,
  mergeAckWrite,
  reminderIdsToDismiss,
  reminderIdsToMarkRead,
  unreadNotificationCount,
  visiblePendingReminders,
  type ReminderAckRow,
} from '../lib/notifications.js';

const router = Router();

const PENDING_SELECT = `
  *,
  appointments(
    date,
    start_time,
    clients(name)
  )
`;

type PendingJoinRow = {
  id: string;
  salon_id: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  appointment_id: string;
  type: 'email' | 'sms' | 'telegram';
  scheduled_for: string;
  message: string;
  appointments: {
    date: string;
    start_time: string;
    clients: { name: string } | null;
  } | null;
};

async function loadPendingReminders(salonId: string): Promise<PendingJoinRow[]> {
  const { data, error } = await supabase
    .from('reminders')
    .select(PENDING_SELECT)
    .eq('salon_id', salonId)
    .eq('status', 'pending')
    .order('scheduled_for');

  if (error) throw error;
  return (data ?? []) as PendingJoinRow[];
}

async function loadAcks(salonId: string, userId: string): Promise<ReminderAckRow[]> {
  const { data, error } = await supabase
    .from('reminder_notification_acks')
    .select('reminder_id, salon_id, user_id, read_at, dismissed_at')
    .eq('salon_id', salonId)
    .eq('user_id', userId);

  if (error) throw error;
  return (data ?? []) as ReminderAckRow[];
}

function toFeed(rows: PendingJoinRow[], acks: ReminderAckRow[], salonId: string, userId: string) {
  const visible = visiblePendingReminders(rows, acks, salonId, userId);
  return {
    items: visible.map((row) => ({
      ...mapEnrichedReminder(row),
      read: Boolean(
        acks.find(
          (ack) =>
            ack.salon_id === salonId &&
            ack.user_id === userId &&
            ack.reminder_id === row.id &&
            ack.read_at
        )
      ),
    })),
    unreadCount: unreadNotificationCount(rows, acks, salonId, userId),
  };
}

async function upsertAcks(
  salonId: string,
  userId: string,
  reminderIds: string[],
  patch: { read_at?: string | null; dismissed_at?: string | null },
  existingAcks: ReminderAckRow[]
) {
  if (reminderIds.length === 0) return;
  const byId = indexAcks(existingAcks, salonId, userId);
  const rows = reminderIds.map((reminder_id) => {
    const merged = mergeAckWrite(byId.get(reminder_id), patch);
    return {
      salon_id: salonId,
      user_id: userId,
      reminder_id,
      read_at: merged.read_at,
      dismissed_at: merged.dismissed_at,
    };
  });
  const { error } = await supabase.from('reminder_notification_acks').upsert(rows, {
    onConflict: 'salon_id,user_id,reminder_id',
  });
  if (error) throw error;
}

router.get('/', async (req, res) => {
  try {
    const salonId = getSalonId(req);
    const userId = getUserId(req);
    const [rows, acks] = await Promise.all([loadPendingReminders(salonId), loadAcks(salonId, userId)]);
    res.json(toFeed(rows, acks, salonId, userId));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load notifications';
    res.status(500).json({ error: message });
  }
});

router.post('/read', requireSalonWriteAccess, async (req, res) => {
  try {
    const salonId = getSalonId(req);
    const userId = getUserId(req);
    const [rows, acks] = await Promise.all([loadPendingReminders(salonId), loadAcks(salonId, userId)]);
    const visible = visiblePendingReminders(rows, acks, salonId, userId);
    const ids = reminderIdsToMarkRead(
      visible.map((row) => row.id),
      acks,
      salonId,
      userId
    );
    await upsertAcks(salonId, userId, ids, { read_at: new Date().toISOString() }, acks);
    const nextAcks = await loadAcks(salonId, userId);
    res.json(toFeed(rows, nextAcks, salonId, userId));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to mark notifications read';
    res.status(500).json({ error: message });
  }
});

router.post('/dismiss-all', requireSalonWriteAccess, async (req, res) => {
  try {
    const salonId = getSalonId(req);
    const userId = getUserId(req);
    const now = new Date().toISOString();
    const [rows, acks] = await Promise.all([loadPendingReminders(salonId), loadAcks(salonId, userId)]);
    const visible = visiblePendingReminders(rows, acks, salonId, userId);
    const ids = reminderIdsToDismiss(
      visible.map((row) => row.id),
      acks,
      salonId,
      userId
    );
    await upsertAcks(salonId, userId, ids, { read_at: now, dismissed_at: now }, acks);
    const nextAcks = await loadAcks(salonId, userId);
    res.json(toFeed(rows, nextAcks, salonId, userId));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to dismiss notifications';
    res.status(500).json({ error: message });
  }
});

router.post('/:id/dismiss', requireSalonWriteAccess, async (req, res) => {
  try {
    const salonId = getSalonId(req);
    const userId = getUserId(req);
    const id = String(req.params.id ?? '');
    const { data: reminder, error: lookupError } = await supabase
      .from('reminders')
      .select('id')
      .eq('id', id)
      .eq('salon_id', salonId)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!reminder) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    const now = new Date().toISOString();
    const existingAcks = await loadAcks(salonId, userId);
    await upsertAcks(salonId, userId, [id], { read_at: now, dismissed_at: now }, existingAcks);
    const [rows, acks] = await Promise.all([loadPendingReminders(salonId), loadAcks(salonId, userId)]);
    res.json(toFeed(rows, acks, salonId, userId));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to dismiss notification';
    res.status(500).json({ error: message });
  }
});

export default router;
