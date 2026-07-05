import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapClient } from '../lib/mappers.js';
import { PILOT_SALON_ID } from '../lib/pilotSalon.js';
import type { Database } from '../types/database.js';

const router = Router();

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('salon_id', PILOT_SALON_ID)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapClient));
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', req.params.id)
    .eq('salon_id', PILOT_SALON_ID)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/', async (req, res) => {
  const { name, email, phone, notes, birthday } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  const { data, error } = await supabase
    .from('clients')
    .insert({
      name,
      email,
      phone: phone || '',
      notes: notes || '',
      birthday: birthday || null,
      total_visits: 0,
      last_visit: null,
      salon_id: PILOT_SALON_ID,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapClient(data));
});

router.put('/:id', async (req, res) => {
  const { name, email, phone, notes, totalVisits, lastVisit, birthday } = req.body;

  const updates: Database['public']['Tables']['clients']['Update'] = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (notes !== undefined) updates.notes = notes;
  if (totalVisits !== undefined) updates.total_visits = totalVisits;
  if (lastVisit !== undefined) updates.last_visit = lastVisit;
  if (birthday !== undefined) updates.birthday = birthday || null;

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', req.params.id)
    .eq('salon_id', PILOT_SALON_ID)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/:id/block', async (req, res) => {
  const { blockedReason } = req.body ?? {};
  const reason =
    typeof blockedReason === 'string' && blockedReason.trim() ? blockedReason.trim() : null;

  const { data, error } = await supabase
    .from('clients')
    .update({
      is_blocked: true,
      blocked_at: new Date().toISOString(),
      blocked_reason: reason,
    })
    .eq('id', req.params.id)
    .eq('salon_id', PILOT_SALON_ID)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/:id/unblock', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .update({
      is_blocked: false,
      blocked_at: null,
      blocked_reason: null,
    })
    .eq('id', req.params.id)
    .eq('salon_id', PILOT_SALON_ID)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .delete()
    .eq('id', req.params.id)
    .eq('salon_id', PILOT_SALON_ID)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Client not found' });
  res.status(204).send();
});

export default router;
