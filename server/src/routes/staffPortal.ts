import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { formatTimeValue } from '../lib/mappers.js';
import {
  dateStrInTimezone,
  getSalonTimezone,
  isValidHhMm,
  isValidIsoDate,
  timeOrderOk,
} from '../lib/scheduleSlots.js';

const router = Router();

const APPOINTMENT_STATUSES = new Set([
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no-show',
]);

const STAFF_EXCEPTION_KINDS = new Set(['closed', 'vacation', 'custom_hours'] as const);
const NOTE_MAX_LENGTH = 500;

type ScheduleKind = 'closed' | 'vacation' | 'holiday' | 'custom_hours';
type ScheduleScope = 'salon' | 'staff';
type StaffExceptionKind = 'closed' | 'vacation' | 'custom_hours';

interface HoursInput {
  weekday: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
}

/**
 * Same semantics as owner schedule.parseHoursArray:
 * upsert whatever weekdays are provided (not forced to 7).
 * Closed days coerce times to null (no silent open defaults).
 */
function parseHoursArray(raw: unknown): { ok: true; hours: HoursInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'hours must be an array' };

  const hours: HoursInput[] = [];
  const seen = new Set<number>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'each hours entry must be an object' };
    }
    const entry = item as Record<string, unknown>;
    const weekday = entry.weekday;
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      return { ok: false, error: 'weekday must be an integer 1–7 (ISO Monday–Sunday)' };
    }
    if (seen.has(weekday)) {
      return { ok: false, error: `duplicate weekday ${weekday}` };
    }
    seen.add(weekday);

    const isClosed = Boolean(entry.isClosed);
    if (isClosed) {
      hours.push({
        weekday,
        isClosed: true,
        openTime: null,
        closeTime: null,
      });
      continue;
    }

    const openTime = entry.openTime;
    const closeTime = entry.closeTime;
    if (!isValidHhMm(openTime) || !isValidHhMm(closeTime)) {
      return { ok: false, error: 'openTime and closeTime are required as HH:MM when not closed' };
    }
    if (!timeOrderOk(openTime, closeTime)) {
      return { ok: false, error: 'closeTime must be after openTime' };
    }
    hours.push({ weekday, isClosed: false, openTime, closeTime });
  }

  return { ok: true, hours };
}

interface PortalWeeklyHours {
  id: string;
  salonId: string;
  staffId?: string;
  weekday: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PortalException {
  id: string;
  salonId: string;
  scope: ScheduleScope;
  staffId: string | null;
  kind: ScheduleKind;
  startDate: string;
  endDate: string;
  openTime: string | null;
  closeTime: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSalonWeekly(row: {
  id: string;
  salon_id: string;
  weekday: number;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
  created_at: string;
  updated_at: string;
}): PortalWeeklyHours {
  return {
    id: row.id,
    salonId: row.salon_id,
    weekday: row.weekday,
    isClosed: row.is_closed,
    openTime: row.open_time ? formatTimeValue(row.open_time) : null,
    closeTime: row.close_time ? formatTimeValue(row.close_time) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStaffWeekly(row: {
  id: string;
  salon_id: string;
  staff_id: string;
  weekday: number;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
  created_at: string;
  updated_at: string;
}): PortalWeeklyHours {
  return {
    ...mapSalonWeekly(row),
    staffId: row.staff_id,
  };
}

function mapException(row: {
  id: string;
  salon_id: string;
  scope: ScheduleScope;
  staff_id: string | null;
  kind: ScheduleKind;
  start_date: string;
  end_date: string;
  open_time: string | null;
  close_time: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}): PortalException {
  return {
    id: row.id,
    salonId: row.salon_id,
    scope: row.scope,
    staffId: row.staff_id,
    kind: row.kind,
    startDate: row.start_date,
    endDate: row.end_date,
    openTime: row.open_time ? formatTimeValue(row.open_time) : null,
    closeTime: row.close_time ? formatTimeValue(row.close_time) : null,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOptionalDateRange(
  fromRaw: unknown,
  toRaw: unknown
): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const from = typeof fromRaw === 'string' ? fromRaw.trim() : '';
  const to = typeof toRaw === 'string' ? toRaw.trim() : '';

  if (from && !isValidIsoDate(from)) {
    return { ok: false, error: 'from must be YYYY-MM-DD' };
  }
  if (to && !isValidIsoDate(to)) {
    return { ok: false, error: 'to must be YYYY-MM-DD' };
  }
  if (from && to && from > to) {
    return { ok: false, error: 'from must be <= to' };
  }

  return { ok: true, from, to };
}

/** GET /api/staff-portal/me */
router.get('/me', async (req, res) => {
  const auth = req.auth!;
  const salonId = auth.salonId!;
  const staffId = auth.staffId!;

  const { data: staff, error } = await supabase
    .from('staff')
    .select('name')
    .eq('id', staffId)
    .eq('salon_id', salonId)
    .eq('active', true)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!staff) {
    return res.status(403).json({ error: 'Staff portal access required' });
  }

  res.json({
    userId: auth.userId,
    email: auth.email,
    salonId,
    role: 'staff_readonly' as const,
    staffId,
    staffName: staff.name,
  });
});

/** GET /api/staff-portal/appointments */
router.get('/appointments', async (req, res) => {
  const salonId = req.auth!.salonId!;
  const staffId = req.auth!.staffId!;

  const range = parseOptionalDateRange(req.query.from, req.query.to);
  if (!range.ok) return res.status(400).json({ error: range.error });

  const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  if (statusRaw && !APPOINTMENT_STATUSES.has(statusRaw)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // Ignore any client-supplied staffId/salonId/clientId — scope from auth only.
  let query = supabase
    .from('appointments')
    .select(
      `
      id,
      date,
      start_time,
      end_time,
      status,
      notes,
      clients(name, phone),
      services(name)
    `
    )
    .eq('salon_id', salonId)
    .eq('staff_id', staffId);

  if (range.from) query = query.gte('date', range.from);
  if (range.to) query = query.lte('date', range.to);
  if (statusRaw) {
    query = query.eq('status', statusRaw as 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no-show');
  }

  const { data, error } = await query.order('date').order('start_time');
  if (error) return res.status(500).json({ error: error.message });

  type PortalAppointmentJoin = {
    id: string;
    date: string;
    start_time: string;
    end_time: string;
    status: string;
    notes: string | null;
    clients: { name: string; phone: string } | null;
    services: { name: string } | null;
  };

  const rows = ((data ?? []) as unknown as PortalAppointmentJoin[]).map((row) => ({
    id: row.id,
    date: row.date,
    startTime: formatTimeValue(row.start_time),
    endTime: formatTimeValue(row.end_time),
    status: row.status,
    serviceName: row.services?.name ?? 'Unknown',
    clientName: row.clients?.name ?? 'Unknown',
    clientPhone: row.clients?.phone ?? '',
    notes: row.notes ?? '',
  }));

  res.json(rows);
});

/** GET /api/staff-portal/schedule */
router.get('/schedule', async (req, res) => {
  const salonId = req.auth!.salonId!;
  const staffId = req.auth!.staffId!;

  const range = parseOptionalDateRange(req.query.from, req.query.to);
  if (!range.ok) return res.status(400).json({ error: range.error });

  const [salonRes, staffRes, exceptionsRes] = await Promise.all([
    (supabase as any)
      .from('salon_weekly_hours')
      .select('*')
      .eq('salon_id', salonId)
      .order('weekday'),
    (supabase as any)
      .from('staff_weekly_hours')
      .select('*')
      .eq('salon_id', salonId)
      .eq('staff_id', staffId)
      .order('weekday'),
    (() => {
      let q = (supabase as any)
        .from('schedule_exceptions')
        .select('*')
        .eq('salon_id', salonId)
        .or(`staff_id.eq.${staffId},scope.eq.salon`)
        .order('start_date', { ascending: true });
      if (range.to) q = q.lte('start_date', range.to);
      if (range.from) q = q.gte('end_date', range.from);
      return q;
    })(),
  ]);

  if (salonRes.error) return res.status(500).json({ error: salonRes.error.message });
  if (staffRes.error) return res.status(500).json({ error: staffRes.error.message });
  if (exceptionsRes.error) return res.status(500).json({ error: exceptionsRes.error.message });

  res.json({
    salonWeekly: (salonRes.data ?? []).map(mapSalonWeekly),
    staffWeekly: (staffRes.data ?? []).map(mapStaffWeekly),
    exceptions: (exceptionsRes.data ?? []).map(mapException),
  });
});

/** PUT /api/staff-portal/schedule/weekly — own staff_weekly_hours only */
router.put('/schedule/weekly', async (req, res) => {
  const salonId = req.auth!.salonId;
  const staffId = req.auth!.staffId;
  if (!salonId || !staffId) {
    return res.status(403).json({ error: 'Staff portal access required' });
  }

  const parsed = parseHoursArray((req.body as { hours?: unknown })?.hours);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const now = new Date().toISOString();
  const rows = parsed.hours.map((h) => ({
    salon_id: salonId,
    staff_id: staffId,
    weekday: h.weekday,
    is_closed: h.isClosed,
    open_time: h.openTime,
    close_time: h.closeTime,
    updated_at: now,
  }));

  const { data, error } = await (supabase as any)
    .from('staff_weekly_hours')
    .upsert(rows, { onConflict: 'staff_id,weekday' })
    .select('*')
    .order('weekday');

  if (error) {
    console.error('[staffPortal] PUT schedule/weekly error:', error.message);
    return res.status(500).json({ error: 'Failed to save weekly schedule' });
  }

  res.json({
    staffWeekly: (data ?? []).map(mapStaffWeekly),
  });
});

/** POST /api/staff-portal/schedule/exceptions — own staff-scoped exception only */
router.post('/schedule/exceptions', async (req, res) => {
  const salonId = req.auth!.salonId;
  const staffId = req.auth!.staffId;
  if (!salonId || !staffId) {
    return res.status(403).json({ error: 'Staff portal access required' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = body.kind;
  const startDate = body.startDate;
  const endDate = body.endDate;

  if (typeof kind !== 'string' || !STAFF_EXCEPTION_KINDS.has(kind as StaffExceptionKind)) {
    return res.status(400).json({
      error: "kind must be 'closed', 'vacation', or 'custom_hours'",
    });
  }
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    return res.status(400).json({ error: 'startDate and endDate must be YYYY-MM-DD' });
  }
  if (endDate < startDate) {
    return res.status(400).json({ error: 'endDate must be >= startDate' });
  }

  const timeZone = await getSalonTimezone(salonId);
  const todayLocal = dateStrInTimezone(timeZone);
  if (startDate < todayLocal) {
    return res.status(400).json({ error: 'startDate cannot be before today' });
  }

  let openTime: string | null = null;
  let closeTime: string | null = null;
  if (kind === 'custom_hours') {
    if (!isValidHhMm(body.openTime) || !isValidHhMm(body.closeTime)) {
      return res.status(400).json({
        error: 'custom_hours requires openTime and closeTime as HH:MM',
      });
    }
    if (!timeOrderOk(body.openTime, body.closeTime)) {
      return res.status(400).json({ error: 'closeTime must be after openTime' });
    }
    openTime = body.openTime;
    closeTime = body.closeTime;
  } else if (body.openTime != null || body.closeTime != null) {
    return res.status(400).json({
      error: 'closed and vacation exceptions must not include openTime or closeTime',
    });
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') {
      return res.status(400).json({ error: 'note must be a string' });
    }
    const trimmed = body.note.trim();
    if (trimmed.length > NOTE_MAX_LENGTH) {
      return res.status(400).json({ error: `note must be at most ${NOTE_MAX_LENGTH} characters` });
    }
    note = trimmed.length > 0 ? trimmed : null;
  }

  // Force scope/salon/staff from auth — never from body.
  const { data, error } = await (supabase as any)
    .from('schedule_exceptions')
    .insert({
      salon_id: salonId,
      scope: 'staff',
      staff_id: staffId,
      kind,
      start_date: startDate,
      end_date: endDate,
      open_time: openTime,
      close_time: closeTime,
      note,
    })
    .select('*')
    .single();

  if (error) {
    console.error('[staffPortal] POST schedule/exceptions error:', error.message);
    return res.status(500).json({ error: 'Failed to create exception' });
  }

  res.status(201).json({ exception: mapException(data) });
});

/** DELETE /api/staff-portal/schedule/exceptions/:id — own staff exception only */
router.delete('/schedule/exceptions/:id', async (req, res) => {
  const salonId = req.auth!.salonId;
  const staffId = req.auth!.staffId;
  if (!salonId || !staffId) {
    return res.status(403).json({ error: 'Staff portal access required' });
  }

  const id = (req.params.id as string)?.trim();
  if (!id) return res.status(400).json({ error: 'id is required' });

  const { data, error } = await (supabase as any)
    .from('schedule_exceptions')
    .delete()
    .eq('id', id)
    .eq('salon_id', salonId)
    .eq('staff_id', staffId)
    .eq('scope', 'staff')
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[staffPortal] DELETE schedule/exceptions error:', error.message);
    return res.status(500).json({ error: 'Failed to delete exception' });
  }
  if (!data) return res.status(404).json({ error: 'Exception not found' });

  res.json({ ok: true });
});

export default router;
