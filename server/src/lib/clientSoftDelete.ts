/** Salon-scoped client soft-delete. Does not touch appointments or integrations. */

export type ClientSoftDeleteRow = {
  id: string;
  salon_id: string;
  deleted_at: string | null;
};

export type AppointmentHistoryRow = {
  id: string;
  client_id: string;
};

export type SoftDeleteClientResult = 'ok' | 'not_found';

export function isActiveClient(row: { deleted_at: string | null }): boolean {
  return row.deleted_at == null;
}

export function listActiveClientsForSalon<T extends ClientSoftDeleteRow>(
  rows: T[],
  salonId: string
): T[] {
  return rows.filter((row) => row.salon_id === salonId && isActiveClient(row));
}

export function softDeleteClientInSalon(
  rows: ClientSoftDeleteRow[],
  params: { id: string; salonId: string; now: string }
): SoftDeleteClientResult {
  const row = rows.find(
    (candidate) =>
      candidate.id === params.id &&
      candidate.salon_id === params.salonId &&
      isActiveClient(candidate)
  );
  if (!row) return 'not_found';
  row.deleted_at = params.now;
  return 'ok';
}

export function appointmentsForClient(
  appointments: AppointmentHistoryRow[],
  clientId: string
): AppointmentHistoryRow[] {
  return appointments.filter((appointment) => appointment.client_id === clientId);
}
