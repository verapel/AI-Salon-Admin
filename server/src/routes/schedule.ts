import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { getSalonId } from '../lib/salonContext.js';
import { formatTimeValue } from '../lib/mappers.js';
import { isValidHhMm, isValidIsoDate, timeOrderOk } from '../lib/scheduleSlots.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';

const router = Router();

type ScheduleKind = 'closed' | 'vacation' | 'holiday' | 'custom_hours';
type ScheduleScope = 'salon' | 'staff';

interface WeeklyHoursApiRow {
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

interface ExceptionApiRow {
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
}): WeeklyHoursApiRow {
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
}): WeeklyHoursApiRow {
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
}): ExceptionApiRow {
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

interface HoursInput {
  weekday: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
}

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

async function assertStaffInSalon(
  salonId: string,
  staffId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data, error } = await supabase
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: 'Staff member not found' };
  return { ok: true };
}

/** GET /api/schedule/weekly */
router.get('/weekly', async (req, res) => {
  const salonId = getSalonId(req);

  const [salonRes, staffRes] = await Promise.all([
    (supabase as any)
      .from('salon_weekly_hours')
      .select('*')
      .eq('salon_id', salonId)
      .order('weekday'),
    (supabase as any)
      .from('staff_weekly_hours')
      .select('*')
      .eq('salon_id', salonId)
      .order('weekday'),
  ]);

  if (salonRes.error) return res.status(500).json({ error: salonRes.error.message });
  if (staffRes.error) return res.status(500).json({ error: staffRes.error.message });

  const staff: Record<string, WeeklyHoursApiRow[]> = {};
  for (const row of staffRes.data ?? []) {
    const mapped = mapStaffWeekly(row);
    const key = row.staff_id as string;
    if (!staff[key]) staff[key] = [];
    staff[key].push(mapped);
  }

  res.json({
    salon: (salonRes.data ?? []).map(mapSalonWeekly),
    staff,
  });
});

/** PUT /api/schedule/salon-weekly */
router.put('/salon-weekly', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const parsed = parseHoursArray((req.body as { hours?: unknown })?.hours);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const now = new Date().toISOString();
  const rows = parsed.hours.map((h) => ({
    salon_id: salonId,
    weekday: h.weekday,
    is_closed: h.isClosed,
    open_time: h.openTime,
    close_time: h.closeTime,
    updated_at: now,
  }));

  const { data, error } = await (supabase as any)
    .from('salon_weekly_hours')
    .upsert(rows, { onConflict: 'salon_id,weekday' })
    .select('*')
    .order('weekday');

  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(mapSalonWeekly));
});

/** PUT /api/schedule/staff/:staffId/weekly */
router.put('/staff/:staffId/weekly', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const staffId = (req.params.staffId as string)?.trim();
  if (!staffId) return res.status(400).json({ error: 'staffId is required' });

  const staffCheck = await assertStaffInSalon(salonId, staffId);
  if (!staffCheck.ok) return res.status(staffCheck.status).json({ error: staffCheck.error });

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

  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(mapStaffWeekly));
});

/** GET /api/schedule/exceptions */
router.get('/exceptions', async (req, res) => {
  const salonId = getSalonId(req);
  const staffId = typeof req.query.staffId === 'string' ? req.query.staffId.trim() : '';
  const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';

  if (from && !isValidIsoDate(from)) {
    return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
  }
  if (to && !isValidIsoDate(to)) {
    return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
  }
  if (from && to && from > to) {
    return res.status(400).json({ error: 'from must be <= to' });
  }

  let q = (supabase as any)
    .from('schedule_exceptions')
    .select('*')
    .eq('salon_id', salonId)
    .order('start_date', { ascending: true });

  if (staffId) {
    q = q.eq('staff_id', staffId);
  }
  // Overlap with [from, to]: start_date <= to AND end_date >= from
  if (to) q = q.lte('start_date', to);
  if (from) q = q.gte('end_date', from);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(mapException));
});

/** POST /api/schedule/exceptions */
router.post('/exceptions', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const body = req.body as Record<string, unknown>;

  const scope = body.scope;
  const kind = body.kind;
  const startDate = body.startDate;
  const endDate = body.endDate;

  if (scope !== 'salon' && scope !== 'staff') {
    return res.status(400).json({ error: "scope must be 'salon' or 'staff'" });
  }
  if (
    kind !== 'closed' &&
    kind !== 'vacation' &&
    kind !== 'holiday' &&
    kind !== 'custom_hours'
  ) {
    return res.status(400).json({ error: 'invalid kind' });
  }
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    return res.status(400).json({ error: 'startDate and endDate must be YYYY-MM-DD' });
  }
  if (endDate < startDate) {
    return res.status(400).json({ error: 'endDate must be >= startDate' });
  }

  let staffId: string | null = null;
  if (scope === 'staff') {
    const raw = typeof body.staffId === 'string' ? body.staffId.trim() : '';
    if (!raw) return res.status(400).json({ error: 'staffId is required for staff scope' });
    const staffCheck = await assertStaffInSalon(salonId, raw);
    if (!staffCheck.ok) return res.status(staffCheck.status).json({ error: staffCheck.error });
    staffId = raw;
  }

  let openTime: string | null = null;
  let closeTime: string | null = null;
  if (kind === 'custom_hours') {
    if (!isValidHhMm(body.openTime) || !isValidHhMm(body.closeTime)) {
      return res.status(400).json({ error: 'custom_hours requires openTime and closeTime as HH:MM' });
    }
    if (!timeOrderOk(body.openTime, body.closeTime)) {
      return res.status(400).json({ error: 'closeTime must be after openTime' });
    }
    openTime = body.openTime;
    closeTime = body.closeTime;
  }

  const note =
    typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

  const { data, error } = await (supabase as any)
    .from('schedule_exceptions')
    .insert({
      salon_id: salonId,
      scope,
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

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapException(data));
});

/** DELETE /api/schedule/exceptions/:id */
router.delete('/exceptions/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = (req.params.id as string)?.trim();
  if (!id) return res.status(400).json({ error: 'id is required' });

  const { data, error } = await (supabase as any)
    .from('schedule_exceptions')
    .delete()
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Exception not found' });
  res.status(204).send();
});

export default router;
