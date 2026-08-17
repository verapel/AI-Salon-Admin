export type ReminderAckRow = {
  reminder_id: string;
  salon_id: string;
  user_id: string;
  read_at: string | null;
  dismissed_at: string | null;
};

export type PendingReminderRow = {
  id: string;
  salon_id: string;
  status: string;
};

export function ackKey(salonId: string, userId: string, reminderId: string): string {
  return `${salonId}:${userId}:${reminderId}`;
}

export function indexAcks(
  acks: ReminderAckRow[],
  salonId: string,
  userId: string
): Map<string, ReminderAckRow> {
  const map = new Map<string, ReminderAckRow>();
  for (const ack of acks) {
    if (ack.salon_id !== salonId || ack.user_id !== userId) continue;
    map.set(ack.reminder_id, ack);
  }
  return map;
}

export function visiblePendingReminders<T extends PendingReminderRow>(
  reminders: T[],
  acks: ReminderAckRow[],
  salonId: string,
  userId: string
): T[] {
  const byId = indexAcks(acks, salonId, userId);
  return reminders.filter(
    (row) =>
      row.salon_id === salonId &&
      row.status === 'pending' &&
      !byId.get(row.id)?.dismissed_at
  );
}

export function isNotificationRead(
  acks: ReminderAckRow[],
  salonId: string,
  userId: string,
  reminderId: string
): boolean {
  return Boolean(indexAcks(acks, salonId, userId).get(reminderId)?.read_at);
}

export function unreadNotificationCount<T extends PendingReminderRow>(
  reminders: T[],
  acks: ReminderAckRow[],
  salonId: string,
  userId: string
): number {
  const visible = visiblePendingReminders(reminders, acks, salonId, userId);
  return visible.filter((row) => !isNotificationRead(acks, salonId, userId, row.id)).length;
}

export function reminderIdsToMarkRead(
  pendingIds: string[],
  acks: ReminderAckRow[],
  salonId: string,
  userId: string
): string[] {
  const byId = indexAcks(acks, salonId, userId);
  return pendingIds.filter((id) => {
    const ack = byId.get(id);
    return !ack?.dismissed_at && !ack?.read_at;
  });
}

export function mergeAckWrite(
  existing: ReminderAckRow | undefined,
  patch: { read_at?: string | null; dismissed_at?: string | null }
): { read_at: string | null; dismissed_at: string | null } {
  return {
    read_at: patch.read_at !== undefined ? patch.read_at : (existing?.read_at ?? null),
    dismissed_at:
      patch.dismissed_at !== undefined ? patch.dismissed_at : (existing?.dismissed_at ?? null),
  };
}

export function reminderIdsToDismiss(
  pendingIds: string[],
  acks: ReminderAckRow[],
  salonId: string,
  userId: string
): string[] {
  const byId = indexAcks(acks, salonId, userId);
  return pendingIds.filter((id) => !byId.get(id)?.dismissed_at);
}
