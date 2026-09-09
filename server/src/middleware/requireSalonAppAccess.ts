import type { NextFunction, Request, Response } from 'express';
import { getSalonEntitlements, isSalonEntitlementNotFoundError } from '../lib/salonEntitlement.js';

export const SUBSCRIPTION_REQUIRED_CODE = 'SUBSCRIPTION_REQUIRED';

/**
 * Server-side application access gate.
 * Must not wrap login, auth, billing/subscription, or developer routes.
 */
export function createRequireSalonAppAccess(
  isEntitled: (salonId: string) => Promise<boolean> = defaultIsEntitled,
) {
  return async function requireSalonAppAccess(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (process.env.API_AUTH_REQUIRED !== 'true') {
      next();
      return;
    }

    const salonId = req.auth?.salonId;
    if (!salonId) {
      res.status(403).json({ error: 'No salon access' });
      return;
    }

    try {
      const entitled = await isEntitled(salonId);
      if (!entitled) {
        res.status(402).json({
          error: 'Active subscription required',
          code: SUBSCRIPTION_REQUIRED_CODE,
        });
        return;
      }
      next();
    } catch (err) {
      if (isSalonEntitlementNotFoundError(err)) {
        res.status(404).json({ error: 'Salon not found' });
        return;
      }
      console.error('[billing] application access check failed', { operation: 'require_salon_app_access' });
      res.status(500).json({ error: 'Access check failed' });
    }
  };
}

async function defaultIsEntitled(salonId: string): Promise<boolean> {
  const entitlements = await getSalonEntitlements(salonId);
  return entitlements.aiAutomationAllowed;
}

export const requireSalonAppAccess = createRequireSalonAppAccess();
