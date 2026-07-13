import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapStaff, initialsAvatar } from '../lib/mappers.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import type { Database } from '../types/database.js';

const router = Router();

async function loadServiceIdsByStaff(
  salonId: string,
  staffIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const id of staffIds) map.set(id, []);
  if (staffIds.length === 0) return map;

  const { data, error } = await (supabase as any)
    .from('staff_services')
    .select('staff_id, service_id')
    .eq('salon_id', salonId)
    .in('staff_id', staffIds);

  if (error) {
    console.error('[staff/services] load assignments error:', error.message);
    return map;
  }

  for (const row of data ?? []) {
    const list = map.get(row.staff_id as string);
    if (list) list.push(row.service_id as string);
    else map.set(row.staff_id as string, [row.service_id as string]);
  }
  return map;
}

router.get('/', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('staff')
    .select('*')
    .eq('salon_id', salonId)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });

  const serviceIdsByStaff = await loadServiceIdsByStaff(
    salonId,
    (data ?? []).map((row) => row.id)
  );
  res.json(data.map((row) => mapStaff(row, serviceIdsByStaff.get(row.id) ?? [])));
});

router.get('/:id', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('staff')
    .select('*')
    .eq('id', req.params.id)
    .eq('salon_id', salonId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Staff member not found' });

  const serviceIdsByStaff = await loadServiceIdsByStaff(salonId, [data.id]);
  res.json(mapStaff(data, serviceIdsByStaff.get(data.id) ?? []));
});

router.post('/', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
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
      salon_id: salonId,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapStaff(data, []));
});

router.put('/:id/services', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const staffId = (req.params.id as string)?.trim();
  if (!staffId) return res.status(400).json({ error: 'staff id is required' });

  const body = req.body as { serviceIds?: unknown };
  if (!Array.isArray(body.serviceIds)) {
    return res.status(400).json({ error: 'serviceIds must be an array' });
  }

  const serviceIds = [
    ...new Set(
      body.serviceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    ),
  ];

  const { data: staff, error: staffError } = await supabase
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (staffError) return res.status(500).json({ error: staffError.message });
  if (!staff) return res.status(404).json({ error: 'Staff member not found' });

  if (serviceIds.length > 0) {
    const { data: services, error: servicesError } = await supabase
      .from('services')
      .select('id')
      .eq('salon_id', salonId)
      .in('id', serviceIds);

    if (servicesError) return res.status(500).json({ error: servicesError.message });

    const found = new Set((services ?? []).map((s) => s.id));
    const missing = serviceIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'One or more services do not belong to this salon',
      });
    }
  }

  // Safe replace without DB transaction: delete then insert (Supabase JS has no multi-statement tx).
  const { error: deleteError } = await (supabase as any)
    .from('staff_services')
    .delete()
    .eq('salon_id', salonId)
    .eq('staff_id', staffId);

  if (deleteError) {
    return res.status(500).json({ error: deleteError.message });
  }

  if (serviceIds.length > 0) {
    const rows = serviceIds.map((serviceId) => ({
      salon_id: salonId,
      staff_id: staffId,
      service_id: serviceId,
    }));
    const { error: insertError } = await (supabase as any).from('staff_services').insert(rows);
    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }
  }

  const serviceIdsByStaff = await loadServiceIdsByStaff(salonId, [staffId]);
  return res.json({
    staffId,
    serviceIds: serviceIdsByStaff.get(staffId) ?? [],
  });
});

router.put('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { name, email, phone, role, specialties, active } = req.body;

  const updates: Database['public']['Tables']['staff']['Update'] = {};
  if (name !== undefined) {
    updates.name = name;
    updates.avatar = initialsAvatar(name);
  }
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (role !== undefined) updates.role = role;
  if (specialties !== undefined) updates.specialties = specialties;
  if (active !== undefined) updates.active = active;

  const { data, error } = await supabase
    .from('staff')
    .update(updates)
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Staff member not found' });

  const serviceIdsByStaff = await loadServiceIdsByStaff(salonId, [data.id]);
  res.json(mapStaff(data, serviceIdsByStaff.get(data.id) ?? []));
});

router.delete('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { data, error } = await supabase
    .from('staff')
    .update({ active: false })
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Staff member not found' });

  const serviceIdsByStaff = await loadServiceIdsByStaff(salonId, [data.id]);
  res.json(mapStaff(data, serviceIdsByStaff.get(data.id) ?? []));
});

export default router;
