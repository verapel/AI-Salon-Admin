import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { computeEndTime, mapEnrichedAppointment } from '../lib/mappers.js';
import type { Appointment } from '../types.js';
import type { Database } from '../types/database.js';

const router = Router();

const APPOINTMENT_SELECT = `
  *,
  clients(name),
  staff(name),
  services(name, price, duration)
`;

router.get('/', async (req, res) => {
  let query = supabase.from('appointments').select(APPOINTMENT_SELECT);

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
  const { data, error } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Appointment not found' });
  res.json(mapEnrichedAppointment(data));
});

router.post('/', async (req, res) => {
  const { clientId, staffId, serviceId, date, startTime, notes } = req.body;
  if (!clientId || !staffId || !serviceId || !date || !startTime) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { data: service, error: serviceError } = await supabase
    .from('services')
    .select('duration')
    .eq('id', serviceId)
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
    })
    .select('id')
    .single();

  if (aptError || !appointment) return res.status(500).json({ error: aptError?.message });

  await supabase.from('reminders').insert({
    appointment_id: appointment.id,
    type: 'email',
    scheduled_for: `${date}T08:00:00`,
    status: 'pending',
    message: `Reminder: Your appointment on ${date} at ${startTime}`,
  });

  const { data, error } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', appointment.id)
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message });
  res.status(201).json(mapEnrichedAppointment(data));
});

router.put('/:id', async (req, res) => {
  const { status, notes, clientId, staffId, serviceId, date, startTime } = req.body;

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
      .eq('id', req.params.id)
      .single();

    const resolvedServiceId = serviceId ?? existing?.service_id;
    const resolvedStartTime = startTime ?? existing?.start_time?.slice(0, 5);

    if (resolvedServiceId && resolvedStartTime) {
      const { data: service } = await supabase
        .from('services')
        .select('duration')
        .eq('id', resolvedServiceId)
        .single();

      if (service) {
        updates.end_time = computeEndTime(resolvedStartTime, service.duration);
      }
    }
  }

  const { data: updated, error } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', req.params.id)
    .select('client_id, date, status')
    .single();

  if (error || !updated) return res.status(404).json({ error: 'Appointment not found' });

  if (date !== undefined || startTime !== undefined) {
    const { data: apptForReminder } = await supabase
      .from('appointments')
      .select('date, start_time')
      .eq('id', req.params.id)
      .single();

    if (apptForReminder) {
      const reminderDate = apptForReminder.date;
      const reminderTime = apptForReminder.start_time?.slice(0, 5) ?? '';
      await supabase
        .from('reminders')
        .update({
          scheduled_for: `${reminderDate}T08:00:00`,
          message: `Reminder: Your appointment on ${reminderDate} at ${reminderTime}`,
        })
        .eq('appointment_id', req.params.id)
        .eq('status', 'pending');
    }
  }

  if (status === 'completed') {
    const { data: client } = await supabase
      .from('clients')
      .select('total_visits')
      .eq('id', updated.client_id)
      .single();

    if (client) {
      await supabase
        .from('clients')
        .update({
          total_visits: client.total_visits + 1,
          last_visit: updated.date,
        })
        .eq('id', updated.client_id);
    }
  }

  const { data, error: fetchError } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !data) return res.status(500).json({ error: fetchError?.message });
  res.json(mapEnrichedAppointment(data));
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Appointment not found' });

  await supabase
    .from('reminders')
    .update({ status: 'failed', message: 'Cancelled — appointment was cancelled' })
    .eq('appointment_id', req.params.id)
    .eq('status', 'pending');

  const { data: enriched, error: fetchError } = await supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !enriched) return res.status(500).json({ error: fetchError?.message });
  res.json(mapEnrichedAppointment(enriched));
});

export default router;
