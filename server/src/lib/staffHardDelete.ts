import { supabase } from './supabase.js';
import { normalizeEmail } from './staffAccess.js';
import type { RequestAuth } from '../types/auth.js';

export type StaffDeleteProtectedReason =
  | 'PRIMARY_STAFF'
  | 'self_membership'
  | 'owner_or_admin_membership'
  | 'authenticated_user_email'
  | null;

export interface StaffDeletePreview {
  staff: {
    id: string;
    name: string;
    active: boolean;
    isPrimary: boolean;
  };
  totalAppointments: number;
  activeAppointments: number;
  hasPortalMembership: boolean;
  protected: boolean;
  protectedReason: StaffDeleteProtectedReason;
}

export interface StaffHardDeleteResult {
  success: true;
  deletedStaffId: string;
  deletedAppointments: number;
  affectedMemberships: number;
  affectedMappingRules: number;
}

function parseCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return 0;
}

export async function countStaffAppointments(
  salonId: string,
  staffId: string
): Promise<{ totalAppointments: number; activeAppointments: number }> {
  const { count: totalAppointments, error: totalError } = await supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('salon_id', salonId)
    .eq('staff_id', staffId);

  if (totalError) {
    throw new Error(totalError.message);
  }

  const { count: activeAppointments, error: activeError } = await supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('salon_id', salonId)
    .eq('staff_id', staffId)
    .in('status', ['scheduled', 'confirmed']);

  if (activeError) {
    throw new Error(activeError.message);
  }

  return {
    totalAppointments: totalAppointments ?? 0,
    activeAppointments: activeAppointments ?? 0,
  };
}

export async function loadStaffInSalon(
  salonId: string,
  staffId: string
): Promise<{ id: string; name: string; active: boolean; email: string; is_primary: boolean } | null> {
  const { data, error } = await (supabase as any)
    .from('staff')
    .select('id, name, active, email, is_primary')
    .eq('id', staffId)
    .eq('salon_id', salonId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) return null;

  return {
    id: data.id as string,
    name: data.name as string,
    active: Boolean(data.active),
    email: (data.email as string) ?? '',
    is_primary: Boolean(data.is_primary),
  };
}

export async function evaluateStaffDeleteProtection(params: {
  salonId: string;
  staffId: string;
  staffEmail: string;
  isPrimary: boolean;
  auth: RequestAuth;
}): Promise<{ protected: boolean; protectedReason: StaffDeleteProtectedReason; hasPortalMembership: boolean }> {
  const { salonId, staffId, staffEmail, isPrimary, auth } = params;

  const { data: memberships, error } = await supabase
    .from('salon_members')
    .select('id, role, active, user_id')
    .eq('salon_id', salonId)
    .eq('staff_id', staffId);

  if (error) {
    throw new Error(error.message);
  }

  const rows = memberships ?? [];
  const hasPortalMembership = rows.length > 0;

  if (isPrimary) {
    return {
      protected: true,
      protectedReason: 'PRIMARY_STAFF',
      hasPortalMembership,
    };
  }

  if (auth.staffId && auth.staffId === staffId) {
    return {
      protected: true,
      protectedReason: 'self_membership',
      hasPortalMembership,
    };
  }

  const linkedOwnerAdmin = rows.find(
    (row) =>
      row.active === true && (row.role === 'owner' || row.role === 'admin')
  );
  if (linkedOwnerAdmin) {
    return {
      protected: true,
      protectedReason: 'owner_or_admin_membership',
      hasPortalMembership,
    };
  }

  const authEmail = normalizeEmail(auth.email ?? '');
  const memberEmail = normalizeEmail(staffEmail ?? '');
  if (authEmail && memberEmail && authEmail === memberEmail) {
    return {
      protected: true,
      protectedReason: 'authenticated_user_email',
      hasPortalMembership,
    };
  }

  return {
    protected: false,
    protectedReason: null,
    hasPortalMembership,
  };
}

export async function buildStaffDeletePreview(
  salonId: string,
  staffId: string,
  auth: RequestAuth
): Promise<StaffDeletePreview | null> {
  const staff = await loadStaffInSalon(salonId, staffId);
  if (!staff) return null;

  const counts = await countStaffAppointments(salonId, staffId);
  const protection = await evaluateStaffDeleteProtection({
    salonId,
    staffId,
    staffEmail: staff.email,
    isPrimary: staff.is_primary,
    auth,
  });

  return {
    staff: {
      id: staff.id,
      name: staff.name,
      active: staff.active,
      isPrimary: staff.is_primary,
    },
    totalAppointments: counts.totalAppointments,
    activeAppointments: counts.activeAppointments,
    hasPortalMembership: protection.hasPortalMembership,
    protected: protection.protected,
    protectedReason: protection.protectedReason,
  };
}

export async function callHardDeleteStaffRpc(params: {
  salonId: string;
  staffId: string;
  deleteAppointments: boolean;
}): Promise<StaffHardDeleteResult> {
  const { data, error } = await (supabase as any).rpc('hard_delete_staff_with_appointments', {
    p_salon_id: params.salonId,
    p_staff_id: params.staffId,
    p_delete_appointments: params.deleteAppointments,
  });

  if (error) {
    const message = String(error.message ?? '');
    const details = String(error.details ?? '');

    if (message.includes('PRIMARY_STAFF_CANNOT_DELETE')) {
      const err = new Error('PRIMARY_STAFF_CANNOT_DELETE') as Error & { code?: string };
      err.code = 'PRIMARY_STAFF_CANNOT_DELETE';
      throw err;
    }

    if (message.includes('STAFF_NOT_FOUND')) {
      const err = new Error('STAFF_NOT_FOUND') as Error & { code?: string };
      err.code = 'STAFF_NOT_FOUND';
      throw err;
    }

    if (message.includes('STAFF_HAS_APPOINTMENTS')) {
      const totalMatch = details.match(/totalAppointments=(\d+)/);
      const activeMatch = details.match(/activeAppointments=(\d+)/);
      const err = new Error('STAFF_HAS_APPOINTMENTS') as Error & {
        code?: string;
        totalAppointments?: number;
        activeAppointments?: number;
      };
      err.code = 'STAFF_HAS_APPOINTMENTS';
      err.totalAppointments = totalMatch ? Number(totalMatch[1]) : undefined;
      err.activeAppointments = activeMatch ? Number(activeMatch[1]) : undefined;
      throw err;
    }

    throw new Error(error.message || 'Hard delete failed');
  }

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    success: true,
    deletedStaffId: String(row.deletedStaffId ?? params.staffId),
    deletedAppointments: parseCount(row.deletedAppointments),
    affectedMemberships: parseCount(row.affectedMemberships),
    affectedMappingRules: parseCount(row.affectedMappingRules),
  };
}
