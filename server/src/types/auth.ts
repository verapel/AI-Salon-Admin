export type SalonMemberRole = 'owner' | 'admin' | 'staff_readonly';

export type PlatformUserRole = 'developer';

export interface RequestAuth {
  userId: string;
  email: string;
  role?: SalonMemberRole;
  salonId?: string;
  isDeveloper: boolean;
  platformRole?: PlatformUserRole;
}
