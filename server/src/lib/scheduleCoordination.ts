/**
 * IG-6B: call schedule mutation RPCs that hold shared advisory locks
 * in the same DB transaction as the DML (Supabase REST cannot span txns).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type CoordinatedHoursInput = {
  weekday: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
};

function hoursToRpcPayload(hours: CoordinatedHoursInput[]): unknown[] {
  return hours.map((h) => ({
    weekday: h.weekday,
    is_closed: h.isClosed,
    open_time: h.isClosed ? null : h.openTime,
    close_time: h.isClosed ? null : h.closeTime,
  }));
}

export async function upsertSalonWeeklyHoursCoordinated(
  db: SupabaseClient | any,
  salonId: string,
  hours: CoordinatedHoursInput[],
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  const { data, error } = await db.rpc('upsert_salon_weekly_hours_coordinated', {
    p_salon_id: salonId,
    p_hours: hoursToRpcPayload(hours),
  });
  if (error) return { ok: false, error: error.message };
  if (!Array.isArray(data)) return { ok: false, error: 'invalid_weekly_rpc_shape' };
  return { ok: true, rows: data as Record<string, unknown>[] };
}

export async function upsertStaffWeeklyHoursCoordinated(
  db: SupabaseClient | any,
  salonId: string,
  staffId: string,
  hours: CoordinatedHoursInput[],
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  const { data, error } = await db.rpc('upsert_staff_weekly_hours_coordinated', {
    p_salon_id: salonId,
    p_staff_id: staffId,
    p_hours: hoursToRpcPayload(hours),
  });
  if (error) return { ok: false, error: error.message };
  if (!Array.isArray(data)) return { ok: false, error: 'invalid_weekly_rpc_shape' };
  return { ok: true, rows: data as Record<string, unknown>[] };
}

export async function createScheduleExceptionCoordinated(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    scope: 'salon' | 'staff';
    staffId: string | null;
    kind: string;
    startDate: string;
    endDate: string;
    openTime: string | null;
    closeTime: string | null;
    note: string | null;
  },
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; error: string; code?: string }> {
  const { data, error } = await db.rpc('create_schedule_exception_coordinated', {
    p_salon_id: params.salonId,
    p_scope: params.scope,
    p_staff_id: params.staffId,
    p_kind: params.kind,
    p_start_date: params.startDate,
    p_end_date: params.endDate,
    p_open_time: params.openTime,
    p_close_time: params.closeTime,
    p_note: params.note,
  });
  if (error) {
    const msg = String(error.message ?? '');
    if (msg.includes('IG6B_EXCEPTION_RANGE_TOO_LARGE')) {
      return { ok: false, error: 'exception date range too large', code: 'range_too_large' };
    }
    return { ok: false, error: msg };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'invalid_exception_rpc_shape' };
  }
  return { ok: true, row: data as Record<string, unknown> };
}

export async function deleteScheduleExceptionCoordinated(
  db: SupabaseClient | any,
  params: {
    salonId: string;
    exceptionId: string;
    requireStaffId?: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const { data, error } = await db.rpc('delete_schedule_exception_coordinated', {
    p_salon_id: params.salonId,
    p_exception_id: params.exceptionId,
    p_require_staff_id: params.requireStaffId ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const row = data as { ok?: boolean; code?: string } | null;
  if (!row || row.ok !== true) {
    return {
      ok: false,
      error: row?.code === 'not_found' ? 'Exception not found' : 'delete_failed',
      notFound: row?.code === 'not_found',
    };
  }
  return { ok: true };
}
