import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { computeEndTime, mapEnrichedAppointment } from '../lib/mappers.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import {
  skipPendingRemindersForAppointment,
  syncAppointmentReminder,
} from '../lib/appointmentReminders.js';
import { cancelSelectedAppointments, normalizeAppointmentIds } from '../lib/appointmentBulkDelete.js';
import type { Appointment } from '../types.js';
import type { Database } from '../types/database.js';

const router = Router();

const APPOINTMENT_SELECT = `
  *,
  clients(name, birthday),
  staff(name),
  services(name, price, duration)
`;

async function isInSalon(
  table: 'clients' | 'staff' | 'services',
  id: string,
  salonId: string
): Promise<boolean> {
  const { data } = await supabase
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('salon_id', salonId)
    .maybeSingle();
  return !!data;
}

router.get('/', async (req, res) => {
  const salonId = getSalonId(req);
  let query = supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('salon_id', salonId);

  const { date, status, staffId, clientId } = req.query;
  if (date) query = query.eq('date', String(date));
  if (status) query = query.eq('status', String(status) as Appointment['status']);
  if (staffId) query = query.eq('staff_id', String(staffId));
  if (clientId) query = query.eq('client_id', String(clientId));

  const { data, error } = await query.order('date').order('start_time');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapEnrichedAppointment));
});

router.get('/:id', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', req.params.id)
    .eq('salon_id', salonId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Appointment not found' });
  res.json(mapEnrichedAppointment(data));
});

/** Cancel only the IDs the user selected. Never expands to other rows or sources. */
router.post('/bulk-delete', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const ids = normalizeAppointmentIds(req.body?.ids);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }

  try {
    const { cancelledIds } = await cancelSelectedAppointments({
      db: supabase,
      salonId,
      ids,
      skipReminders: skipPendingRemindersForAppointment,
    });
    if (cancelledIds.length === 0) {
      return res.status(409).json({ error: 'No appointments cancelled', cancelledIds });
    }
    res.json({ cancelledIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bulk delete failed';
    return res.status(500).json({ error: message });
  }
});

router.post('/', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const { clientId, staffId, serviceId, date, startTime, notes } = req.body;
  if (!clientId || !staffId || !serviceId || !date || !startTime) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const [clientOk, staffOk, serviceOk] = await Promise.all([
    isInSalon('clients', clientId, salonId),
    isInSalon('staff', staffId, salonId),
    isInSalon('services', serviceId, salonId),
  ]);

  if (!clientOk || !staffOk || !serviceOk) {
    return res.status(400).json({ error: 'Invalid client, staff, or service for this salon' });
  }

  const { data: service, error: serviceError } = await supabase
    .from('services')
    .select('duration')
    .eq('id', serviceId)
    .eq('salon_id', salonId)
    .single();

  if (serviceError || !service) return res.status(400).json({ error: 'Invalid service' });

  const endTime = computeEndTime(startTime, service.duration);

  const { data: appointment, error: aptError } = await supabase
    .from('appointments')
    .insert({
      client_id: clientId,
      staff_id: staffId,
      service_id: serviceId,
      date,
      start_time: startTime,
      end_time: endTime,
      status: 'scheduled',
      notes: notes || '',
      reminder_sent: false,
      salon_id: salonId,
    })
    .select('id')
    .single();

  if (aptError || !appointment) return res.status(500).json({ error: aptError?.message });

  await syncAppointmentReminder({
    salonId,
    appointmentId: appointment.id,
    appointmentDate: date,
    startTime,
  });

  const { data, error } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', appointment.id)
    .eq('salon_id', salonId)
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message });
  res.status(201).json(mapEnrichedAppointment(data));
});

router.put('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { status, notes, clientId, staffId, serviceId, date, startTime } = req.body;

  if (clientId !== undefined && !(await isInSalon('clients', clientId, salonId))) {
    return res.status(400).json({ error: 'Invalid client for this salon' });
  }
  if (staffId !== undefined && !(await isInSalon('staff', staffId, salonId))) {
    return res.status(400).json({ error: 'Invalid staff for this salon' });
  }
  if (serviceId !== undefined && !(await isInSalon('services', serviceId, salonId))) {
    return res.status(400).json({ error: 'Invalid service for this salon' });
  }

  const updates: Database['public']['Tables']['appointments']['Update'] = {};
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  if (clientId !== undefined) updates.client_id = clientId;
  if (staffId !== undefined) updates.staff_id = staffId;
  if (serviceId !== undefined) updates.service_id = serviceId;
  if (date !== undefined) updates.date = date;
  if (startTime !== undefined) updates.start_time = startTime;

  if (startTime !== undefined || serviceId !== undefined) {
    const { data: existing } = await supabase
      .from('appointments')
      .select('service_id, start_time')
      .eq('id', id)
      .eq('salon_id', salonId)
      .single();

    const resolvedServiceId = serviceId ?? existing?.service_id;
    const resolvedStartTime = startTime ?? existing?.start_time?.slice(0, 5);

    if (resolvedServiceId && resolvedStartTime) {
      const { data: service } = await supabase
        .from('services')
        .select('duration')
        .eq('id', resolvedServiceId)
        .eq('salon_id', salonId)
        .single();

      if (service) {
        updates.end_time = computeEndTime(resolvedStartTime, service.duration);
      }
    }
  }

  const { data: updated, error } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('client_id, date, status')
    .single();

  if (error || !updated) return res.status(404).json({ error: 'Appointment not found' });

  if (date !== undefined || startTime !== undefined) {
    const { data: apptForReminder } = await supabase
      .from('appointments')
      .select('date, start_time')
      .eq('id', id)
      .eq('salon_id', salonId)
      .single();

    if (apptForReminder) {
      await syncAppointmentReminder({
        salonId,
        appointmentId: id,
        appointmentDate: apptForReminder.date,
        startTime: apptForReminder.start_time,
      });
    }
  }

  if (status === 'cancelled') {
    await skipPendingRemindersForAppointment({ salonId, appointmentId: id });
  }

  if (status === 'completed') {
    const { data: client } = await supabase
      .from('clients')
      .select('total_visits')
      .eq('id', updated.client_id)
      .eq('salon_id', salonId)
      .single();

    if (client) {
      await supabase
        .from('clients')
        .update({
          total_visits: client.total_visits + 1,
          last_visit: updated.date,
        })
        .eq('id', updated.client_id)
        .eq('salon_id', salonId);
    }
  }

  const { data, error: fetchError } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', id)
    .eq('salon_id', salonId)
    .single();

  if (fetchError || !data) return res.status(500).json({ error: fetchError?.message });
  res.json(mapEnrichedAppointment(data));
});

router.delete('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { data, error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('id')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Appointment not found' });

  await skipPendingRemindersForAppointment({ salonId, appointmentId: id });

  const { data: enriched, error: fetchError } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', id)
    .eq('salon_id', salonId)
    .single();

  if (fetchError || !enriched) return res.status(500).json({ error: fetchError?.message });
  res.json(mapEnrichedAppointment(enriched));
});

export default router;
