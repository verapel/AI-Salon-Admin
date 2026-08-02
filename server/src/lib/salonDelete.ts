/**
 * Developer-only permanent salon deletion helpers (SALON-CLEANUP-2).
 * Does not delete auth.users. Telegram FSM/booking untouched.
 */

import { supabase } from './supabase.js';
import { DEFAULT_SALON_SLUG } from './telegramToken.js';

export const PILOT_SALON_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';

/** Accept canonical UUID text form (includes seeded non-RFC pilot id). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SalonProtectedReason = 'DEFAULT_SALON' | 'DELETION_PROTECTED' | null;

export type SalonDeleteTelegramStatus =
  | 'connected'
  | 'not_connected'
  | 'error'
  | 'disabled'
  | 'none';

export interface SalonDeleteCounts {
  clients: number;
  staff: number;
  services: number;
  appointments: number;
  activeAppointments: number;
  reminders: number;
  salonMembers: number;
  integrations: number;
  scheduleExceptions: number;
  calendarConnections: number;
}

export interface SalonDeletePreview {
  salonId: string;
  name: string;
  slug: string;
  active: boolean;
  deletionProtected: boolean;
  protectedReason: SalonProtectedReason;
  canPermanentlyDelete: boolean;
  counts: SalonDeleteCounts;
  whatsappConnected: boolean;
  telegramStatus: SalonDeleteTelegramStatus;
}

export interface SalonPermanentDeleteResult {
  salonId: string;
  deleted: boolean;
  counts: {
    clients: number;
    staff: number;
    services: number;
    appointments: number;
    reminders: number;
    salonMembers: number;
  };
}

export function isSalonUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function evaluateSalonDeleteProtection(params: {
  salonId: string;
  slug: string;
  deletionProtected: boolean;
}): { protected: boolean; protectedReason: SalonProtectedReason } {
  if (
    params.salonId === PILOT_SALON_ID ||
    params.slug === DEFAULT_SALON_SLUG
  ) {
    return { protected: true, protectedReason: 'DEFAULT_SALON' };
  }
  if (params.deletionProtected) {
    return { protected: true, protectedReason: 'DELETION_PROTECTED' };
  }
  return { protected: false, protectedReason: null };
}

async function countEq(table: string, salonId: string): Promise<number> {
  const { count, error } = await (supabase as any)
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('salon_id', salonId);

  if (error) {
    throw new Error(error.message);
  }
  return count ?? 0;
}

export async function buildSalonDeletePreview(
  salonId: string
): Promise<SalonDeletePreview | null> {
  const { data: salon, error } = await (supabase as any)
    .from('salons')
    .select('id, name, slug, active, deletion_protected')
    .eq('id', salonId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!salon) {
    return null;
  }

  const deletionProtected = Boolean(salon.deletion_protected);
  const protection = evaluateSalonDeleteProtection({
    salonId: salon.id as string,
    slug: salon.slug as string,
    deletionProtected,
  });

  const [
    clients,
    staff,
    services,
    appointments,
    activeAppointmentsRes,
    reminders,
    salonMembers,
    integrations,
    scheduleExceptions,
    calendarConnections,
    telegramRes,
    whatsappRes,
  ] = await Promise.all([
    countEq('clients', salonId),
    countEq('staff', salonId),
    countEq('services', salonId),
    countEq('appointments', salonId),
    (supabase as any)
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('salon_id', salonId)
      .in('status', ['scheduled', 'confirmed']),
    countEq('reminders', salonId),
    countEq('salon_members', salonId),
    countEq('salon_integrations', salonId),
    countEq('schedule_exceptions', salonId),
    countEq('calendar_connections', salonId),
    (supabase as any)
      .from('salon_integrations')
      .select('status')
      .eq('salon_id', salonId)
      .eq('provider', 'telegram')
      .maybeSingle(),
    (supabase as any)
      .from('salon_integrations')
      .select('status')
      .eq('salon_id', salonId)
      .eq('provider', 'whatsapp')
      .maybeSingle(),
  ]);

  if (activeAppointmentsRes.error) {
    throw new Error(activeAppointmentsRes.error.message);
  }
  if (telegramRes.error) {
    throw new Error(telegramRes.error.message);
  }
  if (whatsappRes.error) {
    throw new Error(whatsappRes.error.message);
  }

  const telegramStatusRaw = (telegramRes.data as { status?: string } | null)?.status;
  let telegramStatus: SalonDeleteTelegramStatus = 'none';
  if (
    telegramStatusRaw === 'connected' ||
    telegramStatusRaw === 'not_connected' ||
    telegramStatusRaw === 'error' ||
    telegramStatusRaw === 'disabled'
  ) {
    telegramStatus = telegramStatusRaw;
  }

  const whatsappStatus = (whatsappRes.data as { status?: string } | null)?.status;
  const whatsappConnected = whatsappStatus === 'connected';

  return {
    salonId: salon.id as string,
    name: salon.name as string,
    slug: salon.slug as string,
    active: Boolean(salon.active),
    deletionProtected,
    protectedReason: protection.protectedReason,
    canPermanentlyDelete: !protection.protected,
    counts: {
      clients,
      staff,
      services,
      appointments,
      activeAppointments: activeAppointmentsRes.count ?? 0,
      reminders,
      salonMembers,
      integrations,
      scheduleExceptions,
      calendarConnections,
    },
    whatsappConnected,
    telegramStatus,
  };
}

function parseCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function callHardDeleteSalonRpc(
  salonId: string
): Promise<SalonPermanentDeleteResult> {
  const { data, error } = await (supabase as any).rpc('hard_delete_salon', {
    p_salon_id: salonId,
  });

  if (error) {
    const message = String(error.message ?? '');
    if (message.includes('SALON_PROTECTED')) {
      const err = new Error('SALON_PROTECTED') as Error & { code?: string };
      err.code = 'SALON_PROTECTED';
      throw err;
    }
    if (message.includes('SALON_NOT_FOUND')) {
      const err = new Error('SALON_NOT_FOUND') as Error & { code?: string };
      err.code = 'SALON_NOT_FOUND';
      throw err;
    }
    const err = new Error('SALON_DELETE_FAILED') as Error & { code?: string };
    err.code = 'SALON_DELETE_FAILED';
    throw err;
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const countsRaw = (row.counts ?? {}) as Record<string, unknown>;

  return {
    salonId: String(row.salonId ?? salonId),
    deleted: row.deleted === true,
    counts: {
      clients: parseCount(countsRaw.clients),
      staff: parseCount(countsRaw.staff),
      services: parseCount(countsRaw.services),
      appointments: parseCount(countsRaw.appointments),
      reminders: parseCount(countsRaw.reminders),
      salonMembers: parseCount(countsRaw.salonMembers),
    },
  };
}
