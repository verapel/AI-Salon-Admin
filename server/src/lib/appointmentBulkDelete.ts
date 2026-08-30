import { skipPendingRemindersForAppointment } from './appointmentReminders.js';

export function normalizeAppointmentIds(raw: unknown): string[] {
  const rawIds = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      rawIds
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim()),
    ),
  ];
}

/**
 * User-initiated /bookings bulk delete.
 * Cancels only the provided appointment IDs in this salon.
 * Does not touch clients or unselected rows.
 */
export async function cancelSelectedAppointments(params: {
  db: any;
  salonId: string;
  ids: string[];
  skipReminders?: typeof skipPendingRemindersForAppointment;
}): Promise<{ cancelledIds: string[] }> {
  const ids = normalizeAppointmentIds(params.ids);
  if (ids.length === 0) return { cancelledIds: [] };

  const selected = await params.db
    .from('appointments')
    .select('id')
    .eq('salon_id', params.salonId)
    .in('id', ids);
  if (selected?.error) {
    throw new Error(String(selected.error.message || selected.error));
  }
  const selectedIds = [
    ...new Set(
      (Array.isArray(selected?.data) ? selected.data : [])
        .map((row: { id?: string }) => (typeof row?.id === 'string' ? row.id : ''))
        .filter(Boolean),
    ),
  ];
  if (selectedIds.length === 0) return { cancelledIds: [] };

  const updated = await params.db
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('salon_id', params.salonId)
    .in('id', selectedIds)
    .select('id');
  if (updated?.error) {
    throw new Error(String(updated.error.message || updated.error));
  }
  const cancelledFromUpdate: string[] = [];
  const rawUpdated = Array.isArray(updated?.data) ? updated.data : selectedIds;
  for (const row of rawUpdated) {
    const id = typeof row === 'string' ? row : typeof row?.id === 'string' ? row.id : '';
    if (id) cancelledFromUpdate.push(id);
  }
  const cancelledIds = [...new Set(cancelledFromUpdate)];

  const skip = params.skipReminders ?? skipPendingRemindersForAppointment;
  await Promise.all(
    cancelledIds.map((appointmentId) => skip({ salonId: params.salonId, appointmentId })),
  );

  return { cancelledIds };
}
