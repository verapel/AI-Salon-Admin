import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { appointments, services, clients, staff, reminders } from '../data/store.js';
import type { Appointment } from '../types.js';

const router = Router();

function enrichAppointment(apt: Appointment) {
  const client = clients.find((c) => c.id === apt.clientId);
  const staffMember = staff.find((s) => s.id === apt.staffId);
  const service = services.find((s) => s.id === apt.serviceId);
  return {
    ...apt,
    clientName: client?.name ?? 'Unknown',
    staffName: staffMember?.name ?? 'Unknown',
    serviceName: service?.name ?? 'Unknown',
    servicePrice: service?.price ?? 0,
    serviceDuration: service?.duration ?? 0,
  };
}

router.get('/', (req, res) => {
  let result = [...appointments];
  const { date, status, staffId, clientId } = req.query;

  if (date) result = result.filter((a) => a.date === date);
  if (status) result = result.filter((a) => a.status === status);
  if (staffId) result = result.filter((a) => a.staffId === staffId);
  if (clientId) result = result.filter((a) => a.clientId === clientId);

  res.json(result.map(enrichAppointment));
});

router.get('/:id', (req, res) => {
  const apt = appointments.find((a) => a.id === req.params.id);
  if (!apt) return res.status(404).json({ error: 'Appointment not found' });
  res.json(enrichAppointment(apt));
});

router.post('/', (req, res) => {
  const { clientId, staffId, serviceId, date, startTime, notes } = req.body;
  if (!clientId || !staffId || !serviceId || !date || !startTime) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const service = services.find((s) => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Invalid service' });

  const [h, m] = startTime.split(':').map(Number);
  const endMinutes = h * 60 + m + service.duration;
  const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

  const appointment: Appointment = {
    id: uuidv4(),
    clientId,
    staffId,
    serviceId,
    date,
    startTime,
    endTime,
    status: 'scheduled',
    notes: notes || '',
    reminderSent: false,
    createdAt: new Date().toISOString().split('T')[0],
  };
  appointments.push(appointment);

  reminders.push({
    id: uuidv4(),
    appointmentId: appointment.id,
    type: 'email',
    scheduledFor: `${date}T08:00:00`,
    status: 'pending',
    message: `Reminder: Your appointment on ${date} at ${startTime}`,
  });

  res.status(201).json(enrichAppointment(appointment));
});

router.put('/:id', (req, res) => {
  const index = appointments.findIndex((a) => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Appointment not found' });

  appointments[index] = { ...appointments[index], ...req.body, id: appointments[index].id };

  if (req.body.status === 'completed') {
    const client = clients.find((c) => c.id === appointments[index].clientId);
    if (client) {
      client.totalVisits += 1;
      client.lastVisit = appointments[index].date;
    }
  }

  res.json(enrichAppointment(appointments[index]));
});

router.delete('/:id', (req, res) => {
  const index = appointments.findIndex((a) => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Appointment not found' });
  appointments[index].status = 'cancelled';
  res.json(enrichAppointment(appointments[index]));
});

export default router;
