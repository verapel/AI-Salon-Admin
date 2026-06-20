import type { Client, Service, Staff, Appointment, Reminder } from './types.js';

const today = new Date();
const formatDate = (d: Date) => d.toISOString().split('T')[0];

export const clients: Client[] = [
  {
    id: 'c1',
    name: 'Emma Wilson',
    email: 'emma.wilson@email.com',
    phone: '+1 (555) 123-4567',
    notes: 'Prefers morning appointments',
    totalVisits: 12,
    lastVisit: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3)),
    createdAt: '2024-01-15',
  },
  {
    id: 'c2',
    name: 'Sophia Martinez',
    email: 'sophia.m@email.com',
    phone: '+1 (555) 234-5678',
    notes: 'Allergic to certain hair dyes',
    totalVisits: 8,
    lastVisit: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7)),
    createdAt: '2024-03-22',
  },
  {
    id: 'c3',
    name: 'Olivia Chen',
    email: 'olivia.chen@email.com',
    phone: '+1 (555) 345-6789',
    notes: 'VIP client - monthly package',
    totalVisits: 24,
    lastVisit: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)),
    createdAt: '2023-11-08',
  },
  {
    id: 'c4',
    name: 'Isabella Brown',
    email: 'isabella.b@email.com',
    phone: '+1 (555) 456-7890',
    notes: '',
    totalVisits: 3,
    lastVisit: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 14)),
    createdAt: '2025-01-10',
  },
  {
    id: 'c5',
    name: 'Ava Thompson',
    email: 'ava.t@email.com',
    phone: '+1 (555) 567-8901',
    notes: 'Referred by Emma Wilson',
    totalVisits: 5,
    lastVisit: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5)),
    createdAt: '2024-08-30',
  },
];

export const services: Service[] = [
  { id: 's1', name: 'Haircut & Style', description: 'Professional cut with blow-dry styling', duration: 60, price: 65, category: 'Hair', active: true },
  { id: 's2', name: 'Balayage', description: 'Hand-painted highlights for natural look', duration: 180, price: 220, category: 'Color', active: true },
  { id: 's3', name: 'Manicure', description: 'Classic manicure with polish', duration: 45, price: 35, category: 'Nails', active: true },
  { id: 's4', name: 'Pedicure', description: 'Relaxing spa pedicure treatment', duration: 60, price: 50, category: 'Nails', active: true },
  { id: 's5', name: 'Facial Treatment', description: 'Deep cleansing and hydrating facial', duration: 75, price: 90, category: 'Skincare', active: true },
  { id: 's6', name: 'Blowout', description: 'Professional blow-dry and styling', duration: 45, price: 45, category: 'Hair', active: true },
  { id: 's7', name: 'Full Color', description: 'Complete hair color transformation', duration: 120, price: 150, category: 'Color', active: true },
  { id: 's8', name: 'Eyebrow Shaping', description: 'Precision brow shaping and tinting', duration: 30, price: 25, category: 'Beauty', active: true },
];

export const staff: Staff[] = [
  { id: 'st1', name: 'Sarah Johnson', email: 'sarah@salon.com', phone: '+1 (555) 111-2222', role: 'Senior Stylist', specialties: ['Hair', 'Color'], avatar: 'SJ', active: true },
  { id: 'st2', name: 'Maria Garcia', email: 'maria@salon.com', phone: '+1 (555) 222-3333', role: 'Color Specialist', specialties: ['Color', 'Balayage'], avatar: 'MG', active: true },
  { id: 'st3', name: 'Lisa Park', email: 'lisa@salon.com', phone: '+1 (555) 333-4444', role: 'Nail Technician', specialties: ['Nails'], avatar: 'LP', active: true },
  { id: 'st4', name: 'Jennifer Lee', email: 'jennifer@salon.com', phone: '+1 (555) 444-5555', role: 'Esthetician', specialties: ['Skincare', 'Beauty'], avatar: 'JL', active: true },
  { id: 'st5', name: 'Amanda White', email: 'amanda@salon.com', phone: '+1 (555) 555-6666', role: 'Junior Stylist', specialties: ['Hair'], avatar: 'AW', active: true },
];

function makeAppointment(
  id: string,
  clientId: string,
  staffId: string,
  serviceId: string,
  dayOffset: number,
  startTime: string,
  status: Appointment['status']
): Appointment {
  const service = services.find((s) => s.id === serviceId)!;
  const [h, m] = startTime.split(':').map(Number);
  const endMinutes = h * 60 + m + service.duration;
  const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

  return {
    id,
    clientId,
    staffId,
    serviceId,
    date: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset)),
    startTime,
    endTime,
    status,
    notes: '',
    reminderSent: dayOffset > 0,
    createdAt: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2)),
  };
}

export const appointments: Appointment[] = [
  makeAppointment('a1', 'c1', 'st1', 's1', 0, '09:00', 'confirmed'),
  makeAppointment('a2', 'c3', 'st2', 's2', 0, '10:30', 'scheduled'),
  makeAppointment('a3', 'c5', 'st3', 's3', 0, '11:00', 'confirmed'),
  makeAppointment('a4', 'c2', 'st4', 's5', 0, '14:00', 'scheduled'),
  makeAppointment('a5', 'c4', 'st1', 's6', 1, '09:30', 'scheduled'),
  makeAppointment('a6', 'c1', 'st2', 's7', 1, '13:00', 'scheduled'),
  makeAppointment('a7', 'c3', 'st5', 's1', 2, '10:00', 'scheduled'),
  makeAppointment('a8', 'c5', 'st3', 's4', 2, '15:00', 'scheduled'),
  makeAppointment('a9', 'c2', 'st1', 's1', -1, '11:00', 'completed'),
  makeAppointment('a10', 'c4', 'st4', 's8', -2, '16:00', 'completed'),
  makeAppointment('a11', 'c1', 'st2', 's2', -3, '09:00', 'completed'),
  makeAppointment('a12', 'c3', 'st1', 's6', -5, '14:30', 'completed'),
  makeAppointment('a13', 'c5', 'st3', 's3', -7, '10:00', 'cancelled'),
  makeAppointment('a14', 'c2', 'st4', 's5', 3, '11:30', 'scheduled'),
  makeAppointment('a15', 'c4', 'st5', 's1', 4, '09:00', 'scheduled'),
];

export const reminders: Reminder[] = [
  { id: 'r1', appointmentId: 'a5', type: 'email', scheduledFor: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)) + 'T08:00:00', status: 'pending', message: 'Reminder: Your appointment tomorrow at 9:30 AM' },
  { id: 'r2', appointmentId: 'a6', type: 'sms', scheduledFor: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)) + 'T08:00:00', status: 'pending', message: 'Hi! Reminder for your color appointment tomorrow at 1:00 PM' },
  { id: 'r3', appointmentId: 'a7', type: 'email', scheduledFor: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2)) + 'T08:00:00', status: 'pending', message: 'Your haircut is scheduled for 10:00 AM' },
  { id: 'r4', appointmentId: 'a1', type: 'sms', scheduledFor: formatDate(today) + 'T07:00:00', status: 'sent', message: 'See you today at 9:00 AM!' },
  { id: 'r5', appointmentId: 'a9', type: 'email', scheduledFor: formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)) + 'T08:00:00', status: 'sent', message: 'Appointment reminder sent' },
];
