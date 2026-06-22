-- AI Salon Admin: seed data
-- Uses CURRENT_DATE so dashboard/calendar always show relevant demo data.

-- Fixed UUIDs for referential integrity across re-runs
-- Clients
INSERT INTO clients (id, name, email, phone, notes, total_visits, last_visit, created_at) VALUES
  ('11111111-1111-1111-1111-111111111001', 'Emma Wilson',      'emma.wilson@email.com',   '+1 (555) 123-4567', 'Prefers morning appointments',       12, CURRENT_DATE - 3,  '2024-01-15'),
  ('11111111-1111-1111-1111-111111111002', 'Sophia Martinez',  'sophia.m@email.com',      '+1 (555) 234-5678', 'Allergic to certain hair dyes',       8, CURRENT_DATE - 7,  '2024-03-22'),
  ('11111111-1111-1111-1111-111111111003', 'Olivia Chen',      'olivia.chen@email.com',   '+1 (555) 345-6789', 'VIP client - monthly package',       24, CURRENT_DATE - 1,  '2023-11-08'),
  ('11111111-1111-1111-1111-111111111004', 'Isabella Brown',   'isabella.b@email.com',    '+1 (555) 456-7890', '',                                    3, CURRENT_DATE - 14, '2025-01-10'),
  ('11111111-1111-1111-1111-111111111005', 'Ava Thompson',     'ava.t@email.com',         '+1 (555) 567-8901', 'Referred by Emma Wilson',             5, CURRENT_DATE - 5,  '2024-08-30')
ON CONFLICT (id) DO NOTHING;

-- Services
INSERT INTO services (id, name, description, duration, price, category, active) VALUES
  ('22222222-2222-2222-2222-222222222001', 'Haircut & Style',   'Professional cut with blow-dry styling',        60,  65.00,  'Hair',     TRUE),
  ('22222222-2222-2222-2222-222222222002', 'Balayage',          'Hand-painted highlights for natural look',     180, 220.00,  'Color',    TRUE),
  ('22222222-2222-2222-2222-222222222003', 'Manicure',          'Classic manicure with polish',                  45,  35.00,  'Nails',    TRUE),
  ('22222222-2222-2222-2222-222222222004', 'Pedicure',          'Relaxing spa pedicure treatment',               60,  50.00,  'Nails',    TRUE),
  ('22222222-2222-2222-2222-222222222005', 'Facial Treatment',  'Deep cleansing and hydrating facial',             75,  90.00,  'Skincare', TRUE),
  ('22222222-2222-2222-2222-222222222006', 'Blowout',           'Professional blow-dry and styling',             45,  45.00,  'Hair',     TRUE),
  ('22222222-2222-2222-2222-222222222007', 'Full Color',        'Complete hair color transformation',           120, 150.00,  'Color',    TRUE),
  ('22222222-2222-2222-2222-222222222008', 'Eyebrow Shaping',   'Precision brow shaping and tinting',            30,  25.00,  'Beauty',   TRUE)
ON CONFLICT (id) DO NOTHING;

-- Staff
INSERT INTO staff (id, name, email, phone, role, specialties, avatar, active) VALUES
  ('33333333-3333-3333-3333-333333333001', 'Sarah Johnson',  'sarah@salon.com',     '+1 (555) 111-2222', 'Senior Stylist',    ARRAY['Hair', 'Color'],           'SJ', TRUE),
  ('33333333-3333-3333-3333-333333333002', 'Maria Garcia',   'maria@salon.com',     '+1 (555) 222-3333', 'Color Specialist',  ARRAY['Color', 'Balayage'],       'MG', TRUE),
  ('33333333-3333-3333-3333-333333333003', 'Lisa Park',      'lisa@salon.com',      '+1 (555) 333-4444', 'Nail Technician',   ARRAY['Nails'],                   'LP', TRUE),
  ('33333333-3333-3333-3333-333333333004', 'Jennifer Lee',   'jennifer@salon.com',  '+1 (555) 444-5555', 'Esthetician',       ARRAY['Skincare', 'Beauty'],      'JL', TRUE),
  ('33333333-3333-3333-3333-333333333005', 'Amanda White',   'amanda@salon.com',    '+1 (555) 555-6666', 'Junior Stylist',    ARRAY['Hair'],                    'AW', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Appointments (day offsets relative to CURRENT_DATE)
INSERT INTO appointments (id, client_id, staff_id, service_id, date, start_time, end_time, status, notes, reminder_sent, created_at) VALUES
  ('44444444-4444-4444-4444-444444444001', '11111111-1111-1111-1111-111111111001', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222001', CURRENT_DATE,     '09:00', '10:00', 'confirmed',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444002', '11111111-1111-1111-1111-111111111003', '33333333-3333-3333-3333-333333333002', '22222222-2222-2222-2222-222222222002', CURRENT_DATE,     '10:30', '13:30', 'scheduled',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444003', '11111111-1111-1111-1111-111111111005', '33333333-3333-3333-3333-333333333003', '22222222-2222-2222-2222-222222222003', CURRENT_DATE,     '11:00', '11:45', 'confirmed',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444004', '11111111-1111-1111-1111-111111111002', '33333333-3333-3333-3333-333333333004', '22222222-2222-2222-2222-222222222005', CURRENT_DATE,     '14:00', '15:15', 'scheduled',  '', FALSE, CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444005', '11111111-1111-1111-1111-111111111004', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222006', CURRENT_DATE + 1, '09:30', '10:15', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444006', '11111111-1111-1111-1111-111111111001', '33333333-3333-3333-3333-333333333002', '22222222-2222-2222-2222-222222222007', CURRENT_DATE + 1, '13:00', '15:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444007', '11111111-1111-1111-1111-111111111003', '33333333-3333-3333-3333-333333333005', '22222222-2222-2222-2222-222222222001', CURRENT_DATE + 2, '10:00', '11:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444008', '11111111-1111-1111-1111-111111111005', '33333333-3333-3333-3333-333333333003', '22222222-2222-2222-2222-222222222004', CURRENT_DATE + 2, '15:00', '16:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444009', '11111111-1111-1111-1111-111111111002', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222001', CURRENT_DATE - 1, '11:00', '12:00', 'completed',  '', TRUE,  CURRENT_DATE - 5),
  ('44444444-4444-4444-4444-444444444010', '11111111-1111-1111-1111-111111111004', '33333333-3333-3333-3333-333333333004', '22222222-2222-2222-2222-222222222008', CURRENT_DATE - 2, '16:00', '16:30', 'completed',  '', TRUE,  CURRENT_DATE - 5),
  ('44444444-4444-4444-4444-444444444011', '11111111-1111-1111-1111-111111111001', '33333333-3333-3333-3333-333333333002', '22222222-2222-2222-2222-222222222002', CURRENT_DATE - 3, '09:00', '12:00', 'completed',  '', TRUE,  CURRENT_DATE - 5),
  ('44444444-4444-4444-4444-444444444012', '11111111-1111-1111-1111-111111111003', '33333333-3333-3333-3333-333333333001', '22222222-2222-2222-2222-222222222006', CURRENT_DATE - 5, '14:30', '15:15', 'completed',  '', TRUE,  CURRENT_DATE - 7),
  ('44444444-4444-4444-4444-444444444013', '11111111-1111-1111-1111-111111111005', '33333333-3333-3333-3333-333333333003', '22222222-2222-2222-2222-222222222003', CURRENT_DATE - 7, '10:00', '10:45', 'cancelled',  '', TRUE,  CURRENT_DATE - 10),
  ('44444444-4444-4444-4444-444444444014', '11111111-1111-1111-1111-111111111002', '33333333-3333-3333-3333-333333333004', '22222222-2222-2222-2222-222222222005', CURRENT_DATE + 3, '11:30', '12:45', 'scheduled',  '', TRUE,  CURRENT_DATE - 2),
  ('44444444-4444-4444-4444-444444444015', '11111111-1111-1111-1111-111111111004', '33333333-3333-3333-3333-333333333005', '22222222-2222-2222-2222-222222222001', CURRENT_DATE + 4, '09:00', '10:00', 'scheduled',  '', TRUE,  CURRENT_DATE - 2)
ON CONFLICT (id) DO NOTHING;

-- Reminders
INSERT INTO reminders (id, appointment_id, type, scheduled_for, status, message) VALUES
  ('55555555-5555-5555-5555-555555555001', '44444444-4444-4444-4444-444444444005', 'email', (CURRENT_DATE + 1)::timestamptz + TIME '08:00', 'pending', 'Reminder: Your appointment tomorrow at 9:30 AM'),
  ('55555555-5555-5555-5555-555555555002', '44444444-4444-4444-4444-444444444006', 'sms',   (CURRENT_DATE + 1)::timestamptz + TIME '08:00', 'pending', 'Hi! Reminder for your color appointment tomorrow at 1:00 PM'),
  ('55555555-5555-5555-5555-555555555003', '44444444-4444-4444-4444-444444444007', 'email', (CURRENT_DATE + 2)::timestamptz + TIME '08:00', 'pending', 'Your haircut is scheduled for 10:00 AM'),
  ('55555555-5555-5555-5555-555555555004', '44444444-4444-4444-4444-444444444001', 'sms',   CURRENT_DATE::timestamptz + TIME '07:00',         'sent',    'See you today at 9:00 AM!'),
  ('55555555-5555-5555-5555-555555555005', '44444444-4444-4444-4444-444444444009', 'email', (CURRENT_DATE - 1)::timestamptz + TIME '08:00', 'sent',    'Appointment reminder sent')
ON CONFLICT (id) DO NOTHING;
