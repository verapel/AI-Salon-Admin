import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapClient } from '../lib/mappers.js';

const router = Router();

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapClient));
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/', async (req, res) => {
  const { name, email, phone, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  const { data, error } = await supabase
    .from('clients')
    .insert({
      name,
      email,
      phone: phone || '',
      notes: notes || '',
      total_visits: 0,
      last_visit: null,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapClient(data));
});

router.put('/:id', async (req, res) => {
  const { name, email, phone, notes, totalVisits, lastVisit } = req.body;

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (notes !== undefined) updates.notes = notes;
  if (totalVisits !== undefined) updates.total_visits = totalVisits;
  if (lastVisit !== undefined) updates.last_visit = lastVisit;

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('clients').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

export default router;
