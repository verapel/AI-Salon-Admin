import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { formatTimeValue } from '../lib/mappers.js';
import { isValidIsoDate } from '../lib/scheduleSlots.js';

const router = Router();

const APPOINTMENT_STATUSES = new Set([
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no-show',
]);

type ScheduleKind = 'closed' | 'vacation' | 'holiday' | 'custom_hours';
type ScheduleScope = 'salon' | 'staff';

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

export default router;
