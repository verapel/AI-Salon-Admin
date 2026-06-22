import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapService } from '../lib/mappers.js';

const router = Router();

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapService));
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Service not found' });
  res.json(mapService(data));
});

router.post('/', async (req, res) => {
  const { name, description, duration, price, category } = req.body;
  if (!name || !duration || price === undefined) {
    return res.status(400).json({ error: 'Name, duration, and price are required' });
  }

  const { data, error } = await supabase
    .from('services')
    .insert({
      name,
      description: description || '',
      duration: Number(duration),
      price: Number(price),
      category: category || 'General',
      active: true,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapService(data));
});

router.put('/:id', async (req, res) => {
  const { name, description, duration, price, category, active } = req.body;

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (duration !== undefined) updates.duration = Number(duration);
  if (price !== undefined) updates.price = Number(price);
  if (category !== undefined) updates.category = category;
  if (active !== undefined) updates.active = active;

  const { data, error } = await supabase
    .from('services')
    .update(updates)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Service not found' });
  res.json(mapService(data));
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .update({ active: false })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Service not found' });
  res.json(mapService(data));
});

export default router;
