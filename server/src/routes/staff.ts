import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { staff } from '../data/store.js';
import type { Staff } from '../types.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(staff);
});

router.get('/:id', (req, res) => {
  const member = staff.find((s) => s.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Staff member not found' });
  res.json(member);
});

router.post('/', (req, res) => {
  const { name, email, phone, role, specialties } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  const member: Staff = {
    id: uuidv4(),
    name,
    email,
    phone: phone || '',
    role: role || 'Stylist',
    specialties: specialties || [],
    avatar: name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase(),
    active: true,
  };
  staff.push(member);
  res.status(201).json(member);
});

router.put('/:id', (req, res) => {
  const index = staff.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Staff member not found' });

  staff[index] = { ...staff[index], ...req.body, id: staff[index].id };
  res.json(staff[index]);
});

router.delete('/:id', (req, res) => {
  const index = staff.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Staff member not found' });
  staff[index].active = false;
  res.json(staff[index]);
});

export default router;
