import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapClient } from '../lib/mappers.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import { buildClientCreateRow, buildClientUpdate } from '../lib/clientWrite.js';
import type { Database } from '../types/database.js';

const router = Router();

router.get('/', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('salon_id', salonId)
    .is('deleted_at', null)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapClient));
});

router.get('/:id', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', req.params.id)
    .eq('salon_id', salonId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const built = buildClientCreateRow(req.body, salonId);
  if ('error' in built) return res.status(400).json({ error: built.error });

  const { data, error } = await supabase
    .from('clients')
    .insert(built.row)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapClient(data));
});

router.put('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const built = buildClientUpdate(req.body);
  if ('error' in built) return res.status(400).json({ error: built.error });
  const updates: Database['public']['Tables']['clients']['Update'] = built.updates;

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/:id/block', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
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
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/:id/unblock', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { data, error } = await supabase
    .from('clients')
    .update({
      is_blocked: false,
      blocked_at: null,
      blocked_reason: null,
    })
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.delete('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { data, error } = await supabase
    .from('clients')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('salon_id', salonId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Client not found' });
  res.status(204).send();
});

export default router;
