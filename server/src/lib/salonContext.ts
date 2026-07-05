import type { Request } from 'express';
import { PILOT_SALON_ID } from './pilotSalon.js';

export function getSalonId(req: Request): string {
  if (req.auth?.salonId) {
    return req.auth.salonId;
  }

  if (process.env.API_AUTH_REQUIRED === 'true') {
    throw new Error('Missing salon context after auth middleware');
  }

  return PILOT_SALON_ID;
}
