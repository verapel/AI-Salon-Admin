/**
 * Client create/edit payload normalization.
 * DB clients.email is TEXT NOT NULL — empty email is stored as ''.
 */

export function optionalClientText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function requiredClientName(value: unknown): string | null {
  const name = optionalClientText(value);
  return name || null;
}

export function optionalClientBirthday(value: unknown): string | null {
  const birthday = optionalClientText(value);
  return birthday || null;
}

export type ClientCreateRow = {
  name: string;
  email: string;
  phone: string;
  notes: string;
  birthday: string | null;
  total_visits: number;
  last_visit: null;
  salon_id: string;
};

export function buildClientCreateRow(
  body: Record<string, unknown> | null | undefined,
  salonId: string
): { error: string } | { row: ClientCreateRow } {
  const payload = body ?? {};
  const name = requiredClientName(payload.name);
  if (!name) return { error: 'Name is required' };

  return {
    row: {
      name,
      email: optionalClientText(payload.email),
      phone: optionalClientText(payload.phone),
      notes: optionalClientText(payload.notes),
      birthday: optionalClientBirthday(payload.birthday),
      total_visits: 0,
      last_visit: null,
      salon_id: salonId,
    },
  };
}

export type ClientUpdateFields = {
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
  total_visits?: number;
  last_visit?: string | null;
  birthday?: string | null;
};

export function buildClientUpdate(
  body: Record<string, unknown> | null | undefined
): { error: string } | { updates: ClientUpdateFields } {
  const payload = body ?? {};
  const updates: ClientUpdateFields = {};

  if (payload.name !== undefined) {
    const name = requiredClientName(payload.name);
    if (!name) return { error: 'Name is required' };
    updates.name = name;
  }
  if (payload.email !== undefined) updates.email = optionalClientText(payload.email);
  if (payload.phone !== undefined) updates.phone = optionalClientText(payload.phone);
  if (payload.notes !== undefined) updates.notes = optionalClientText(payload.notes);
  if (payload.totalVisits !== undefined) {
    updates.total_visits =
      typeof payload.totalVisits === 'number' ? payload.totalVisits : Number(payload.totalVisits);
  }
  if (payload.lastVisit !== undefined) {
    updates.last_visit =
      typeof payload.lastVisit === 'string' && payload.lastVisit.trim()
        ? payload.lastVisit
        : null;
  }
  if (payload.birthday !== undefined) {
    updates.birthday = optionalClientBirthday(payload.birthday);
  }

  return { updates };
}
