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

export function getUserId(req: Request): string {
  if (req.auth?.userId) {
    return req.auth.userId;
  }

  if (process.env.API_AUTH_REQUIRED === 'true') {
    throw new Error('Missing user context after auth middleware');
  }

  return process.env.PILOT_USER_ID ?? 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001';
}
