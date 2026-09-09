import { Router, type Request, type Response } from 'express';
import { getSalonId } from '../lib/salonContext.js';
import { createBillingService, isBillingError, type BillingService } from '../lib/billingService.js';
import { createSupabaseBillingStore } from '../lib/supabaseBillingStore.js';
import { requireSalonCabinetAccess } from '../middleware/auth.js';
import type { CheckoutOutcome } from '../lib/payment/index.js';

function sendBillingError(res: Response, err: unknown): void {
  if (isBillingError(err)) {
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[billing] unexpected error', { operation: 'billing_route' });
  res.status(500).json({ error: 'Billing request failed', code: 'INTERNAL_ERROR' });
}

export function createBillingRouter(service: BillingService): Router {
  const router = Router();

  router.get('/subscription', async (req: Request, res: Response) => {
    try {
      const salonId = getSalonId(req);
      const body = await service.getOwnerSubscription(salonId);
      res.json(body);
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  router.post('/checkout', requireSalonCabinetAccess, async (req: Request, res: Response) => {
    try {
      const salonId = getSalonId(req);
      const planId = req.body?.planId;
      const body = await service.createCheckout(salonId, planId);
      res.status(201).json(body);
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  router.get('/checkout/:id', requireSalonCabinetAccess, async (req: Request, res: Response) => {
    try {
      const salonId = getSalonId(req);
      const checkoutId = typeof req.params.id === 'string' ? req.params.id : '';
      const body = await service.getCheckout(salonId, checkoutId);
      res.json(body);
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  router.post('/checkout/:id/complete', requireSalonCabinetAccess, async (req: Request, res: Response) => {
    try {
      const salonId = getSalonId(req);
      const checkoutId = typeof req.params.id === 'string' ? req.params.id : '';
      const outcome = req.body?.result as CheckoutOutcome;
      const body = await service.completeTestCheckout(salonId, checkoutId, outcome);
      res.json(body);
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  router.post('/subscription/cancel', requireSalonCabinetAccess, async (req: Request, res: Response) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ error: 'Confirmation required', code: 'CONFIRMATION_REQUIRED' });
        return;
      }
      const salonId = getSalonId(req);
      const body = await service.cancelAtPeriodEnd(salonId);
      res.json(body);
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  return router;
}

const defaultService = createBillingService({
  store: createSupabaseBillingStore(),
});

export default createBillingRouter(defaultService);
