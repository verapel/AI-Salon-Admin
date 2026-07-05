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
}

export function toAuthMeResponse(auth: RequestAuth): AuthMeResponse {
  return {
    userId: auth.userId,
    email: auth.email,
    isDeveloper: auth.isDeveloper,
    platformRole: auth.platformRole ?? null,
    salonId: auth.salonId ?? null,
    role: auth.role ?? null,
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
    .select('salon_id, role')
    .eq('user_id', auth.userId)
    .eq('active', true);

  if (membershipError) {
    throw new Error(membershipError.message);
  }

  if (memberships?.length) {
    const membership = memberships[0];
    auth.salonId = membership.salon_id;
    auth.role = membership.role as SalonMemberRole;
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
