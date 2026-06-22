import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapStaff, initialsAvatar } from '../lib/mappers.js';

const router = Router();

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('staff')
    .select('*')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapStaff));
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('staff')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Staff member not found' });
  res.json(mapStaff(data));
});

router.post('/', async (req, res) => {
  const { name, email, phone, role, specialties } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  const { data, error } = await supabase
    .from('staff')
    .insert({
      name,
      email,
      phone: phone || '',
      role: role || 'Stylist',
      specialties: specialties || [],
      avatar: initialsAvatar(name),
      active: true,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapStaff(data));
});

router.put('/:id', async (req, res) => {
  const { name, email, phone, role, specialties, active } = req.body;

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (role !== undefined) updates.role = role;
  if (specialties !== undefined) updates.specialties = specialties;
  if (active !== undefined) updates.active = active;

  const { data, error } = await supabase
    .from('staff')
    .update(updates)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Staff member not found' });
  res.json(mapStaff(data));
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('staff')
    .update({ active: false })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Staff member not found' });
  res.json(mapStaff(data));
});

export default router;
