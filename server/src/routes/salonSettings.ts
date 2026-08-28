import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import { DEFAULT_SALON_CURRENCY, isSalonCurrency, parseSalonCurrency } from '../lib/salonCurrency.js';

const router = Router();

router.get('/settings', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('salons')
    .select('currency')
    .eq('id', salonId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ currency: parseSalonCurrency(data?.currency ?? DEFAULT_SALON_CURRENCY) });
});

router.patch('/settings', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const currency = req.body?.currency;
  if (!isSalonCurrency(currency)) {
    return res.status(400).json({ error: 'Currency must be AMD, RUB, or USD' });
  }

  const { data, error } = await supabase
    .from('salons')
    .update({ currency })
    .eq('id', salonId)
    .select('currency')
    .single();

  if (error || !data) {
    return res.status(500).json({ error: error?.message ?? 'Could not update salon settings' });
  }

  res.json({ currency: parseSalonCurrency(data.currency) });
});

export default router;
