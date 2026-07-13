import type { NextFunction, Request, Response } from 'express';
import { supabase } from '../lib/supabase.js';
import type { PlatformUserRole, RequestAuth, SalonMemberRole } from '../types/auth.js';

export interface AuthMeResponse {
  userId: string;
  email: string;
  isDeveloper: boolean;
  platformRole: PlatformUserRole | null;
  salonId: string | null;
  role: SalonMemberRole | null;
  staffId: string | null;
}

export function toAuthMeResponse(auth: RequestAuth): AuthMeResponse {
  return {
    userId: auth.userId,
    email: auth.email,
    isDeveloper: auth.isDeveloper,
    platformRole: auth.platformRole ?? null,
    salonId: auth.salonId ?? null,
    role: auth.role ?? null,
    staffId: auth.staffId ?? null,
  };
}

export async function populateAuthFromDb(auth: RequestAuth): Promise<void> {
  const { data: platformUser, error: platformError } = await supabase
    .from('platform_users')
    .select('role')
    .eq('user_id', auth.userId)
    .eq('active', true)
    .maybeSingle();

  if (platformError) {
    throw new Error(platformError.message);
  }

  if (platformUser) {
    auth.isDeveloper = true;
    auth.platformRole = platformUser.role as PlatformUserRole;
  }

  const { data: memberships, error: membershipError } = await supabase
    .from('salon_members')
    .select('salon_id, role, staff_id')
    .eq('user_id', auth.userId)
    .eq('active', true);

  if (membershipError) {
    throw new Error(membershipError.message);
  }

  if (memberships?.length) {
    const membership = memberships[0];
    auth.salonId = membership.salon_id;
    auth.role = membership.role as SalonMemberRole;
    // Trusted membership only — never from body/query/path.
    // Same-salon (membership.salon_id === staff.salon_id) is not DB-enforced yet;
    // Staff-2b / provisioning must validate before setting staff_id.
    if (membership.staff_id) {
      auth.staffId = membership.staff_id;
    }
  }
}

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

async function loadAuthUser(req: Request, res: Response): Promise<boolean> {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  const { data, error } = await supabase.auth.getUser(token);
  const user = data?.user;

  if (error || !user) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  const auth: RequestAuth = {
    userId: user.id,
    email: user.email ?? '',
    isDeveloper: false,
  };
  req.auth = auth;
  return true;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (await loadAuthUser(req, res)) next();
  } catch (err) {
    console.error('[auth] requireAuth error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
}

export async function requireSalonAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (!(await loadAuthUser(req, res))) return;

    await populateAuthFromDb(req.auth!);

    if (!req.auth!.salonId) {
      res.status(403).json({ error: 'No salon access' });
      return;
    }

    next();
  } catch (err) {
    console.error('[auth] requireSalonAuth error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
}

export async function requireDeveloperAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (!(await loadAuthUser(req, res))) return;

    await populateAuthFromDb(req.auth!);

    if (!req.auth!.isDeveloper) {
      res.status(403).json({ error: 'Developer access required' });
      return;
    }

    next();
  } catch (err) {
    console.error('[auth] requireDeveloperAuth error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
}

/**
 * Salon write gate for owner/admin.
 * Assumes requireSalonAuth already ran (when salon routers are auth-mounted).
 * Role is taken only from req.auth (membership DB), never from the request body.
 * Fail closed: missing auth/role or non-write roles → 403.
 */
export function requireSalonWriteAccess(req: Request, res: Response, next: NextFunction) {
  const role = req.auth?.role;

  if (role === 'owner' || role === 'admin') {
    next();
    return;
  }

  res.status(403).json({ error: 'Write access required' });
}

/**
 * Owner/admin salon cabinet gate.
 * Assumes requireSalonAuth already ran when salon routers are auth-mounted.
 * Denies staff_readonly so they cannot use normal salon APIs.
 */
export function requireSalonCabinetAccess(req: Request, res: Response, next: NextFunction) {
  const role = req.auth?.role;

  if (role === 'owner' || role === 'admin') {
    next();
    return;
  }

  res.status(403).json({ error: 'Salon cabinet access required' });
}

/**
 * Staff portal gate for staff_readonly with a linked active staff row.
 * Assumes requireSalonAuth already ran.
 * Role and staffId come only from req.auth (membership DB).
 * Verifies staff belongs to the same salon and is active.
 */
export async function requireStaffPortalAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.auth;
    const salonId = auth?.salonId;
    const staffId = auth?.staffId;

    if (!auth || auth.role !== 'staff_readonly' || !salonId || !staffId) {
      res.status(403).json({ error: 'Staff portal access required' });
      return;
    }

    const { data: staff, error } = await supabase
      .from('staff')
      .select('id')
      .eq('id', staffId)
      .eq('salon_id', salonId)
      .eq('active', true)
      .maybeSingle();

    if (error) {
      console.error('[auth] requireStaffPortalAccess error:', error.message);
      res.status(500).json({ error: 'Auth failed' });
      return;
    }

    if (!staff) {
      res.status(403).json({ error: 'Staff portal access required' });
      return;
    }

    next();
  } catch (err) {
    console.error('[auth] requireStaffPortalAccess error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
}
