import { api } from '@/lib/api';
import type { Staff, StaffAccessDto, StaffAccessStatus } from '@/types';

export type { StaffAccessStatus };

/** Staff roster row merged with portal-access DTO for the owner UI. */
export interface StaffAccessItem {
  staffId: string;
  name: string;
  avatar: string;
  specialty: string;
  specialties: string[];
  staffEmail: string;
  staffActive: boolean;
  status: StaffAccessStatus;
  email: string | null;
  active: boolean;
  canInvite: boolean;
  canResend: boolean;
  canDisable: boolean;
  canEnable: boolean;
}

function specialtyOf(member: Staff): string {
  return (
    member.specialties.find((s) => s.trim().length > 0)?.trim() ||
    member.role?.trim() ||
    ''
  );
}

function mergeRow(member: Staff, access: StaffAccessDto | undefined): StaffAccessItem {
  const dto =
    access ??
    ({
      staffId: member.id,
      status: 'none',
      email: null,
      active: false,
      canInvite: member.active,
      canResend: false,
      canDisable: false,
      canEnable: false,
    } satisfies StaffAccessDto);

  return {
    staffId: member.id,
    name: member.name,
    avatar: member.avatar || member.name.slice(0, 1).toUpperCase() || '?',
    specialty: specialtyOf(member),
    specialties: member.specialties ?? [],
    staffEmail: member.email,
    staffActive: member.active,
    status: dto.status,
    email: dto.email,
    active: dto.active,
    canInvite: dto.canInvite,
    canResend: dto.canResend,
    canDisable: dto.canDisable,
    canEnable: dto.canEnable,
  };
}

export async function listStaffAccess(): Promise<StaffAccessItem[]> {
  const [staff, accessRes] = await Promise.all([api.staff.getAll(), api.staffAccess.list()]);
  const byId = new Map(accessRes.items.map((item) => [item.staffId, item]));
  return staff
    .map((member) => mergeRow(member, byId.get(member.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function inviteStaff(staffId: string, email: string) {
  return api.staffAccess.invite(staffId, email);
}

export async function resendStaffInvite(staffId: string) {
  return api.staffAccess.resend(staffId);
}

export async function setStaffAccessActive(staffId: string, active: boolean) {
  return api.staffAccess.setActive(staffId, active);
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
