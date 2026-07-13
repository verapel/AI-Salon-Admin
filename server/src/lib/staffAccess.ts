import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase.js';
import type { SalonMemberRole } from '../types/database.js';

export type StaffAccessStatus = 'none' | 'active' | 'disabled';

export interface StaffAccessDto {
  staffId: string;
  status: StaffAccessStatus;
  email: string | null;
  active: boolean;
  canInvite: boolean;
  canResend: boolean;
  canDisable: boolean;
  canEnable: boolean;
}

interface MembershipRow {
  id: string;
  user_id: string;
  salon_id: string;
  role: SalonMemberRole;
  active: boolean;
  staff_id: string | null;
}

interface AuthProfile {
  email: string | null;
  lastSignInAt: string | null;
  invitedAt: string | null;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isExistingAuthUserError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('already') || lower.includes('registered') || lower.includes('exists');
}

export function getStaffInviteRedirectUrl(): string | null {
  const value = process.env.STAFF_INVITE_REDIRECT_URL?.trim();
  return value || null;
}

export async function findAuthUserByEmail(email: string): Promise<User | null> {
  const normalized = normalizeEmail(email);
  let page = 1;
  const perPage = 200;

  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(error.message);
    }
    const users = data.users ?? [];
    const found = users.find((u) => (u.email || '').toLowerCase() === normalized);
    if (found) return found;
    if (users.length < perPage) return null;
    page += 1;
    if (page > 50) return null;
  }
}

async function loadAuthProfile(userId: string): Promise<AuthProfile | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  const user = data.user as User & { invited_at?: string | null };
  return {
    email: user.email ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    invitedAt: user.invited_at ?? null,
  };
}

export async function loadAuthProfiles(
  userIds: string[]
): Promise<Map<string, AuthProfile>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const map = new Map<string, AuthProfile>();
  await Promise.all(
    unique.map(async (id) => {
      const profile = await loadAuthProfile(id);
      if (profile) map.set(id, profile);
    })
  );
  return map;
}

function canResendFromProfile(profile: AuthProfile | null | undefined): boolean {
  if (!profile) return false;
  // Never signed in after invite — safe to resend invite email.
  return !profile.lastSignInAt && Boolean(profile.invitedAt);
}

export function buildStaffAccessDto(input: {
  staffId: string;
  staffActive: boolean;
  membership: MembershipRow | null;
  authProfile: AuthProfile | null;
}): StaffAccessDto {
  const { staffId, staffActive, membership, authProfile } = input;

  if (!membership) {
    return {
      staffId,
      status: 'none',
      email: null,
      active: false,
      canInvite: staffActive,
      canResend: false,
      canDisable: false,
      canEnable: false,
    };
  }

  if (!membership.active) {
    return {
      staffId,
      status: 'disabled',
      email: authProfile?.email ?? null,
      active: false,
      canInvite: false,
      canResend: false,
      canDisable: false,
      canEnable: true,
    };
  }

  return {
    staffId,
    status: 'active',
    email: authProfile?.email ?? null,
    active: true,
    canInvite: false,
    canResend: canResendFromProfile(authProfile),
    canDisable: true,
    canEnable: false,
  };
}

export async function loadSalonMembershipsWithStaff(
  salonId: string
): Promise<MembershipRow[]> {
  const { data, error } = await supabase
    .from('salon_members')
    .select('id, user_id, salon_id, role, active, staff_id')
    .eq('salon_id', salonId)
    .not('staff_id', 'is', null);

  if (error) throw new Error(error.message);
  return (data ?? []) as MembershipRow[];
}

export async function findMembershipForStaff(
  salonId: string,
  staffId: string
): Promise<MembershipRow | null> {
  const { data, error } = await supabase
    .from('salon_members')
    .select('id, user_id, salon_id, role, active, staff_id')
    .eq('salon_id', salonId)
    .eq('staff_id', staffId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as MembershipRow | null) ?? null;
}

export async function findAnyMembershipForStaffId(
  staffId: string
): Promise<MembershipRow | null> {
  const { data, error } = await supabase
    .from('salon_members')
    .select('id, user_id, salon_id, role, active, staff_id')
    .eq('staff_id', staffId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as MembershipRow | null) ?? null;
}

export async function findUserMembershipInSalon(
  salonId: string,
  userId: string
): Promise<MembershipRow | null> {
  const { data, error } = await supabase
    .from('salon_members')
    .select('id, user_id, salon_id, role, active, staff_id')
    .eq('salon_id', salonId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as MembershipRow | null) ?? null;
}

export async function inviteOrGetAuthUser(
  email: string,
  redirectTo: string
): Promise<{ user: User; createdByInvite: boolean; invitationSent: boolean }> {
  const existing = await findAuthUserByEmail(email);
  if (existing) {
    return { user: existing, createdByInvite: false, invitationSent: false };
  }

  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  });

  if (error) {
    if (isExistingAuthUserError(error.message)) {
      const raced = await findAuthUserByEmail(email);
      if (raced) {
        return { user: raced, createdByInvite: false, invitationSent: false };
      }
    }
    throw new Error(error.message);
  }

  if (!data.user) {
    throw new Error('Invite did not return a user');
  }

  return { user: data.user, createdByInvite: true, invitationSent: true };
}

export async function resendInviteEmail(
  email: string,
  redirectTo: string
): Promise<void> {
  const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  });
  if (error) {
    throw new Error(error.message);
  }
}

export async function insertStaffReadonlyMembership(input: {
  userId: string;
  salonId: string;
  staffId: string;
}): Promise<MembershipRow> {
  const { data, error } = await supabase
    .from('salon_members')
    .insert({
      user_id: input.userId,
      salon_id: input.salonId,
      role: 'staff_readonly',
      active: true,
      staff_id: input.staffId,
    })
    .select('id, user_id, salon_id, role, active, staff_id')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Could not create membership');
  }
  return data as MembershipRow;
}

export async function setMembershipActive(
  membershipId: string,
  active: boolean
): Promise<MembershipRow> {
  const { data, error } = await supabase
    .from('salon_members')
    .update({ active })
    .eq('id', membershipId)
    .select('id, user_id, salon_id, role, active, staff_id')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Could not update membership');
  }
  return data as MembershipRow;
}

/** Best-effort cleanup for Auth users created solely by this invite request. */
export async function cleanupInvitedAuthUser(userId: string): Promise<void> {
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) {
    console.error('[staff-access] cleanup invited auth user failed:', error.message);
  }
}

export async function buildDtoForStaff(input: {
  staffId: string;
  staffActive: boolean;
  salonId: string;
}): Promise<StaffAccessDto> {
  const membership = await findMembershipForStaff(input.salonId, input.staffId);
  const authProfile = membership ? await loadAuthProfile(membership.user_id) : null;
  return buildStaffAccessDto({
    staffId: input.staffId,
    staffActive: input.staffActive,
    membership,
    authProfile,
  });
}
