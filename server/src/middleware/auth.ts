import type { NextFunction, Request, Response } from 'express';
import { supabase } from '../lib/supabase.js';
import type { PlatformUserRole, RequestAuth, SalonMemberRole } from '../types/auth.js';

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

    const { data: memberships, error: membershipError } = await supabase
      .from('salon_members')
      .select('salon_id, role')
      .eq('user_id', req.auth!.userId)
      .eq('active', true);

    if (membershipError) {
      res.status(500).json({ error: membershipError.message });
      return;
    }

    if (!memberships?.length) {
      res.status(403).json({ error: 'No salon access' });
      return;
    }

    const membership = memberships[0];
    req.auth!.salonId = membership.salon_id;
    req.auth!.role = membership.role as SalonMemberRole;

    const { data: platformUser } = await supabase
      .from('platform_users')
      .select('role')
      .eq('user_id', req.auth!.userId)
      .eq('active', true)
      .maybeSingle();

    if (platformUser) {
      req.auth!.isDeveloper = true;
      req.auth!.platformRole = platformUser.role as PlatformUserRole;
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

    const { data: platformUser, error: platformError } = await supabase
      .from('platform_users')
      .select('role')
      .eq('user_id', req.auth!.userId)
      .eq('active', true)
      .maybeSingle();

    if (platformError) {
      res.status(500).json({ error: platformError.message });
      return;
    }

    if (!platformUser) {
      res.status(403).json({ error: 'Developer access required' });
      return;
    }

    req.auth!.isDeveloper = true;
    req.auth!.platformRole = platformUser.role as PlatformUserRole;
    next();
  } catch (err) {
    console.error('[auth] requireDeveloperAuth error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
}
