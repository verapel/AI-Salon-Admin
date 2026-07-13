export type SalonMemberRole = 'owner' | 'admin' | 'staff_readonly';

export type PlatformUserRole = 'developer';

export interface RequestAuth {
  userId: string;
  email: string;
  role?: SalonMemberRole;
  salonId?: string;
  /** Linked staff row from salon_members.staff_id; never from request input. */
  staffId?: string;
  isDeveloper: boolean;
  platformRole?: PlatformUserRole;
}
