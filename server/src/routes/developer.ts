import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { supabase, checkSupabaseConnection } from '../lib/supabase.js';
import { loadTelegramTokenFromDb } from '../lib/telegramToken.js';
import { restartTelegramPolling } from '../lib/telegramPollingControl.js';
import type {
  IntegrationHealth,
  IntegrationStatus,
} from '../types/database.js';

const router = Router();

export const DEFAULT_SALON_SLUG = 'default';
const TELEGRAM_PROVIDER = 'telegram' as const;

type SalonRow = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  country: string;
  currency: string;
  language: string;
  active: boolean;
  created_at: string;
};

type IntegrationRow = {
  status: IntegrationStatus;
  health: IntegrationHealth;
  bot_username: string | null;
  bot_display_name: string | null;
  connected_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  admin_chat_id: number | null;
};

const INTEGRATION_SUMMARY_SELECT =
  'status, health, bot_username, bot_display_name, connected_at, last_checked_at, last_error, admin_chat_id';

function parseAdminChatIdInput(
  value: unknown
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value === 0) {
    return { ok: false, error: 'Invalid adminChatId' };
  }
  return { ok: true, value };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'salon';
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let suffix = 1;
  while (true) {
    const { data } = await (supabase as any).from('salons').select('id').eq('slug', slug).maybeSingle();
    if (!data) return slug;
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
}

function mapSalonOverview(
  row: SalonRow,
  connectedAt: string | null,
  clientCount: number,
  appointmentCount: number
) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    active: row.active,
    connectedAt,
    clientCount,
    appointmentCount,
    createdAt: row.created_at,
  };
}

function mapSalonCore(row: SalonRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    active: row.active,
    timezone: row.timezone,
    country: row.country,
    currency: row.currency,
    language: row.language,
    createdAt: row.created_at,
  };
}

function emptyTelegramSummary() {
  return {
    status: 'not_connected' as IntegrationStatus,
    health: 'unknown' as IntegrationHealth,
    botUsername: null,
    botDisplayName: null,
    connectedAt: null,
    lastCheckedAt: null,
    lastError: null,
    livePolling: false,
    adminChatId: null,
  };
}

function mapTelegramSummary(integration: IntegrationRow | null, salonSlug: string) {
  if (!integration) return emptyTelegramSummary();
  const multiTelegramEnabled = process.env.MULTI_TELEGRAM_ENABLED === 'true';
  return {
    status: integration.status,
    health: integration.health,
    botUsername: integration.bot_username,
    botDisplayName: displayBotDisplayName(integration),
    connectedAt: integration.connected_at,
    lastCheckedAt: integration.last_checked_at,
    lastError: integration.last_error,
    livePolling:
      integration.status === 'connected' &&
      (multiTelegramEnabled || salonSlug === DEFAULT_SALON_SLUG),
    adminChatId: integration.admin_chat_id ?? null,
  };
}

async function countSalonTable(
  salonId: string,
  table: 'clients' | 'appointments' | 'services' | 'staff'
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('salon_id', salonId);

  if (error) {
    console.error(`[developer] count ${table} for salon ${salonId}:`, error.message);
    return 0;
  }
  return count ?? 0;
}

async function getSalonEntityCounts(salonId: string) {
  const [clients, appointments, services, staff] = await Promise.all([
    countSalonTable(salonId, 'clients'),
    countSalonTable(salonId, 'appointments'),
    countSalonTable(salonId, 'services'),
    countSalonTable(salonId, 'staff'),
  ]);
  return { clients, appointments, services, staff };
}

async function resolveSalonOwner(salonId: string) {
  const { data: membership, error } = await supabase
    .from('salon_members')
    .select('id, user_id, role, active')
    .eq('salon_id', salonId)
    .eq('role', 'owner')
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (error || !membership) {
    if (error) {
      console.error('[developer] owner membership lookup:', error.message);
    }
    return null;
  }

  let email: string | null = null;
  let fullName: string | null = null;

  const { data: authData, error: authError } = await supabase.auth.admin.getUserById(membership.user_id);
  if (authError) {
    console.error('[developer] owner auth lookup:', authError.message);
  } else if (authData.user) {
    email = authData.user.email ?? null;
    const metadata = authData.user.user_metadata as { full_name?: string } | undefined;
    if (typeof metadata?.full_name === 'string' && metadata.full_name.trim()) {
      fullName = metadata.full_name.trim();
    }
  }

  return {
    membershipId: membership.id,
    userId: membership.user_id,
    email,
    fullName,
    role: membership.role,
    membershipActive: membership.active,
  };
}

function readAppVersion(): string {
  const candidates = [
    path.resolve(process.cwd(), '../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return 'unknown';
}

type TelegramGetMeResult =
  | { ok: true; username: string; displayName: string }
  | { ok: false; error: string };

async function checkTelegramBot(token: string): Promise<TelegramGetMeResult> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await response.json()) as {
      ok: boolean;
      result?: { username: string; first_name: string };
      description?: string;
    };

    if (data.ok && data.result) {
      return {
        ok: true,
        username: data.result.username,
        displayName: data.result.first_name,
      };
    }

    return { ok: false, error: data.description ?? 'Invalid Telegram token' };
  } catch {
    return { ok: false, error: 'Could not reach Telegram API' };
  }
}

async function getExistingIntegration(
  salonId: string
): Promise<{ connected_at: string | null; bot_display_name: string | null } | null> {
  const { data } = await (supabase as any)
    .from('salon_integrations')
    .select('connected_at, bot_display_name')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  return data;
}

function resolveBotDisplayName(
  manual: string | undefined,
  getMeDisplayName: string,
  botUsername: string
): string {
  const trimmedManual = typeof manual === 'string' ? manual.trim() : '';
  if (trimmedManual) return trimmedManual;
  if (getMeDisplayName.trim()) return getMeDisplayName.trim();
  return botUsername;
}

function displayBotDisplayName(integration: IntegrationRow): string | null {
  if (integration.bot_display_name?.trim()) return integration.bot_display_name.trim();
  if (integration.bot_username?.trim()) return integration.bot_username.trim();
  return null;
}

async function upsertTelegramIntegration(
  salonId: string,
  fields: {
    status: IntegrationStatus;
    health: IntegrationHealth;
    botUsername: string | null;
    botDisplayName: string | null;
    connectedAt: string | null;
    lastError: string | null;
    tokenCiphertext?: string | null;
  }
): Promise<IntegrationRow | null> {
  const now = new Date().toISOString();

  const payload: Record<string, unknown> = {
    salon_id: salonId,
    provider: TELEGRAM_PROVIDER,
    status: fields.status,
    health: fields.health,
    bot_username: fields.botUsername,
    bot_display_name: fields.botDisplayName,
    connected_at: fields.connectedAt,
    last_checked_at: now,
    last_error: fields.lastError,
    updated_at: now,
  };

  if (fields.tokenCiphertext !== undefined) {
    payload.token_ciphertext = fields.tokenCiphertext;
  }

  const { data, error } = await (supabase as any)
    .from('salon_integrations')
    .upsert(payload, { onConflict: 'salon_id,provider' })
    .select(INTEGRATION_SUMMARY_SELECT)
    .single();

  if (error) {
    console.error('[developer/integrations/telegram] upsert error:', error.message);
    return null;
  }

  return data;
}

async function syncDefaultSalonTelegram(salonId: string): Promise<IntegrationRow> {
  let token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    token = (await loadTelegramTokenFromDb()) ?? undefined;
    if (token) process.env.TELEGRAM_BOT_TOKEN = token;
  }
  const now = new Date().toISOString();

  if (!token) {
    const row = await upsertTelegramIntegration(salonId, {
      status: 'not_connected',
      health: 'unknown',
      botUsername: null,
      botDisplayName: null,
      connectedAt: null,
      lastError: null,
    });

    return (
      row ?? {
        status: 'not_connected',
        health: 'unknown',
        bot_username: null,
        bot_display_name: null,
        connected_at: null,
        last_checked_at: now,
        last_error: null,
        admin_chat_id: null,
      }
    );
  }

  const check = await checkTelegramBot(token);

  if (check.ok) {
    const existing = await getExistingIntegration(salonId);
    const connectedAt = existing?.connected_at ?? now;
    const botDisplayName =
      existing?.bot_display_name?.trim() || check.displayName.trim() || check.username;

    const row = await upsertTelegramIntegration(salonId, {
      status: 'connected',
      health: 'healthy',
      botUsername: check.username,
      botDisplayName,
      connectedAt,
      lastError: null,
      tokenCiphertext: token,
    });

    return (
      row ?? {
        status: 'connected',
        health: 'healthy',
        bot_username: check.username,
        bot_display_name: check.displayName,
        connected_at: connectedAt,
        last_checked_at: now,
        last_error: null,
        admin_chat_id: null,
      }
    );
  }

  const row = await upsertTelegramIntegration(salonId, {
    status: 'error',
    health: 'error',
    botUsername: null,
    botDisplayName: null,
    connectedAt: null,
    lastError: check.error,
  });

  return (
    row ?? {
      status: 'error',
      health: 'error',
      bot_username: null,
      bot_display_name: null,
      connected_at: null,
      last_checked_at: now,
      last_error: check.error,
      admin_chat_id: null,
    }
  );
}

function mapTelegramIntegration(salon: SalonRow, integration: IntegrationRow) {
  return {
    salonId: salon.id,
    salonName: salon.name,
    slug: salon.slug,
    status: integration.status,
    health: integration.health,
    botUsername: integration.bot_username,
    botDisplayName: displayBotDisplayName(integration),
    connectedAt: integration.connected_at,
    lastCheckedAt: integration.last_checked_at,
    lastError: integration.last_error,
    adminChatId: integration.admin_chat_id ?? null,
  };
}

router.get('/salons', async (_req, res) => {
  const { data: salons, error } = await (supabase as any)
    .from('salons')
    .select('*')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });

  const integrationsRes = await (supabase as any)
    .from('salon_integrations')
    .select('salon_id, connected_at')
    .eq('provider', TELEGRAM_PROVIDER);

  if (integrationsRes.error) return res.status(500).json({ error: integrationsRes.error.message });

  const connectedAtBySalon = new Map<string, string>(
    (integrationsRes.data as { salon_id: string; connected_at: string | null }[])
      .filter((row) => row.connected_at)
      .map((row) => [row.salon_id, row.connected_at!])
  );

  const rows = await Promise.all(
    (salons as SalonRow[]).map(async (salon) => {
      const isDefault = salon.slug === DEFAULT_SALON_SLUG;
      const counts = await getSalonEntityCounts(salon.id);
      return mapSalonOverview(
        salon,
        connectedAtBySalon.get(salon.id) ?? (isDefault ? salon.created_at : null),
        counts.clients,
        counts.appointments
      );
    })
  );

  res.json(rows);
});

router.get('/salons/:id', async (req, res) => {
  const salonId = req.params.id?.trim();
  if (!salonId) {
    return res.status(400).json({ error: 'Salon id is required' });
  }

  const { data: salon, error: salonError } = await supabase
    .from('salons')
    .select('*')
    .eq('id', salonId)
    .maybeSingle();

  if (salonError) return res.status(500).json({ error: salonError.message });
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  const row = salon as SalonRow;

  const [counts, owner, integrationRes] = await Promise.all([
    getSalonEntityCounts(salonId),
    resolveSalonOwner(salonId),
    (supabase as any)
      .from('salon_integrations')
      .select(INTEGRATION_SUMMARY_SELECT)
      .eq('salon_id', salonId)
      .eq('provider', TELEGRAM_PROVIDER)
      .maybeSingle(),
  ]);

  if (integrationRes.error) {
    return res.status(500).json({ error: integrationRes.error.message });
  }

  res.json({
    ...mapSalonCore(row),
    counts,
    owner,
    telegram: mapTelegramSummary((integrationRes.data as IntegrationRow | null) ?? null, row.slug),
  });
});

router.patch('/salons/:id', async (req, res) => {
  const salonId = req.params.id?.trim();
  if (!salonId) {
    return res.status(400).json({ success: false, error: 'Salon id is required' });
  }

  const body = req.body as Record<string, unknown>;
  const updates: Partial<
    Pick<SalonRow, 'name' | 'active' | 'timezone' | 'country' | 'currency' | 'language'>
  > = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid name' });
    }
    const trimmed = body.name.trim();
    if (trimmed.length < 2) {
      return res.status(400).json({ success: false, error: 'Salon name must be at least 2 characters' });
    }
    updates.name = trimmed;
  }

  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Invalid active value' });
    }
    updates.active = body.active;
  }

  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || !body.timezone.trim()) {
      return res.status(400).json({ success: false, error: 'Invalid timezone' });
    }
    updates.timezone = body.timezone.trim();
  }

  if (body.country !== undefined) {
    if (typeof body.country !== 'string' || !body.country.trim()) {
      return res.status(400).json({ success: false, error: 'Invalid country' });
    }
    updates.country = body.country.trim();
  }

  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !body.currency.trim()) {
      return res.status(400).json({ success: false, error: 'Invalid currency' });
    }
    updates.currency = body.currency.trim();
  }

  if (body.language !== undefined) {
    if (typeof body.language !== 'string' || !body.language.trim()) {
      return res.status(400).json({ success: false, error: 'Invalid language' });
    }
    updates.language = body.language.trim();
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update' });
  }

  const { data: salon, error: salonError } = await supabase
    .from('salons')
    .update(updates)
    .eq('id', salonId)
    .select('*')
    .maybeSingle();

  if (salonError) return res.status(500).json({ success: false, error: salonError.message });
  if (!salon) return res.status(404).json({ success: false, error: 'Salon not found' });

  return res.json({
    success: true,
    salon: mapSalonCore(salon as SalonRow),
  });
});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isExistingAuthUserError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('already') ||
    lower.includes('registered') ||
    lower.includes('exists')
  );
}

async function deleteProvisionedAuthUser(userId: string | null): Promise<boolean> {
  if (!userId) return true;
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) {
    console.error('[developer] POST /salons cleanup auth user failed:', error.message);
    return false;
  }
  return true;
}

async function deleteProvisionedSalon(salonId: string | null): Promise<boolean> {
  if (!salonId) return true;
  const { error } = await supabase.from('salons').delete().eq('id', salonId);
  if (error) {
    console.error('[developer] POST /salons cleanup salon failed:', error.message);
    return false;
  }
  return true;
}

router.post('/salons', async (req, res) => {
  const body = req.body as {
    name?: string;
    ownerEmail?: string;
    ownerPassword?: string;
    ownerName?: string;
  };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const ownerEmail =
    typeof body.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : '';
  const ownerPassword = typeof body.ownerPassword === 'string' ? body.ownerPassword : '';
  const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : '';

  if (name.length < 2) {
    return res.status(400).json({ success: false, error: 'Salon name is required (min 2 characters)' });
  }
  if (!ownerEmail || !isValidEmail(ownerEmail)) {
    return res.status(400).json({ success: false, error: 'Valid owner email is required' });
  }
  if (ownerPassword.length < 6) {
    return res.status(400).json({ success: false, error: 'Owner password must be at least 6 characters' });
  }

  let createdUserId: string | null = null;
  let createdSalonId: string | null = null;

  try {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
      user_metadata: ownerName ? { full_name: ownerName } : undefined,
    });

    if (authError || !authData.user) {
      if (authError && isExistingAuthUserError(authError.message)) {
        return res.status(409).json({ success: false, error: 'Owner email is already registered' });
      }
      console.error('[developer] POST /salons auth error:', authError?.message);
      return res.status(500).json({ success: false, error: 'Could not create owner account' });
    }

    createdUserId = authData.user.id;

    const slug = await uniqueSlug(slugify(name));
    const { data: salon, error: salonError } = await supabase
      .from('salons')
      .insert({
        name,
        slug,
        timezone: 'Europe/Moscow',
        country: 'RU',
        currency: 'RUB',
        language: 'ru',
        active: true,
      })
      .select('*')
      .single();

    if (salonError || !salon) {
      const authCleanupOk = await deleteProvisionedAuthUser(createdUserId);
      console.error('[developer] POST /salons salon error:', salonError?.message);
      if (!authCleanupOk) {
        return res.status(500).json({ success: false, error: 'Salon provisioning failed during cleanup' });
      }
      return res.status(500).json({ success: false, error: 'Could not create salon' });
    }

    createdSalonId = salon.id;

    const { data: membership, error: membershipError } = await supabase
      .from('salon_members')
      .insert({
        user_id: createdUserId,
        salon_id: createdSalonId,
        role: 'owner',
        active: true,
      })
      .select('*')
      .single();

    if (membershipError || !membership) {
      const salonCleanupOk = await deleteProvisionedSalon(createdSalonId);
      const authCleanupOk = await deleteProvisionedAuthUser(createdUserId);
      console.error('[developer] POST /salons membership error:', membershipError?.message);
      if (!salonCleanupOk || !authCleanupOk) {
        return res.status(500).json({ success: false, error: 'Salon provisioning failed during cleanup' });
      }
      return res.status(500).json({ success: false, error: 'Could not create salon membership' });
    }

    return res.status(201).json({
      success: true,
      salon: {
        id: salon.id,
        name: salon.name,
        slug: salon.slug,
        active: salon.active,
        createdAt: salon.created_at,
      },
      owner: {
        userId: createdUserId,
        email: ownerEmail,
      },
      membership: {
        id: membership.id,
        salonId: membership.salon_id,
        role: membership.role,
        active: membership.active,
      },
    });
  } catch (err) {
    console.error('[developer] POST /salons error:', err);
    const salonCleanupOk = await deleteProvisionedSalon(createdSalonId);
    const authCleanupOk = await deleteProvisionedAuthUser(createdUserId);
    if (!salonCleanupOk || !authCleanupOk) {
      return res.status(500).json({ success: false, error: 'Salon provisioning failed during cleanup' });
    }
    return res.status(500).json({ success: false, error: 'Salon provisioning failed' });
  }
});

router.get('/health', async (_req, res) => {
  const dbConnected = await checkSupabaseConnection();

  let telegramStatus: 'connected' | 'not_connected' | 'error' = 'not_connected';
  let telegramBot: string | null = null;
  let telegramError: string | null = null;

  let token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    token = (await loadTelegramTokenFromDb()) ?? undefined;
  }

  if (token) {
    const check = await checkTelegramBot(token);
    if (check.ok) {
      telegramStatus = 'connected';
      telegramBot = check.username;
    } else {
      telegramStatus = 'error';
      telegramError = check.error;
    }
  }

  res.json({
    api: { status: 'ok' as const },
    supabase: { status: dbConnected ? ('connected' as const) : ('disconnected' as const) },
    telegram: {
      status: telegramStatus,
      bot: telegramBot,
      error: telegramError,
    },
    version: readAppVersion(),
  });
});

router.get('/integrations/telegram', async (_req, res) => {
  const { data: defaultSalon } = await (supabase as any)
    .from('salons')
    .select('*')
    .eq('slug', DEFAULT_SALON_SLUG)
    .maybeSingle();

  if (defaultSalon) {
    await syncDefaultSalonTelegram(defaultSalon.id);
  }

  const { data: integrations, error } = await (supabase as any)
    .from('salon_integrations')
    .select('*')
    .eq('provider', TELEGRAM_PROVIDER)
    .in('status', ['connected', 'error']);

  if (error) return res.status(500).json({ error: error.message });

  const rows = (integrations ?? []) as (IntegrationRow & { salon_id: string })[];
  if (rows.length === 0) {
    return res.json([]);
  }

  const salonIds = rows.map((row) => row.salon_id);
  const { data: salons, error: salonsError } = await (supabase as any)
    .from('salons')
    .select('*')
    .in('id', salonIds)
    .eq('active', true);

  if (salonsError) return res.status(500).json({ error: salonsError.message });

  const salonMap = new Map((salons as SalonRow[]).map((salon) => [salon.id, salon]));
  const result = rows
    .map((integration) => {
      const salon = salonMap.get(integration.salon_id);
      if (!salon) return null;
      return mapTelegramIntegration(salon, integration);
    })
    .filter(Boolean);

  res.json(result);
});

router.patch('/integrations/telegram/:salonId', async (req, res) => {
  const salonId = req.params.salonId?.trim();
  if (!salonId) {
    return res.status(400).json({ success: false, error: 'salonId is required' });
  }

  const body = req.body as {
    salonName?: string;
    botDisplayName?: string;
    adminChatId?: number | null;
  };

  const hasSalonName = typeof body.salonName === 'string' && body.salonName.trim().length > 0;
  const hasBotDisplayName = typeof body.botDisplayName === 'string';
  const hasAdminChatId = Object.prototype.hasOwnProperty.call(body, 'adminChatId');

  if (!hasSalonName && !hasBotDisplayName && !hasAdminChatId) {
    return res.status(400).json({
      success: false,
      error: 'salonName, botDisplayName, or adminChatId is required',
    });
  }

  let parsedAdminChatId: number | null | undefined;
  if (hasAdminChatId) {
    const parsed = parseAdminChatIdInput(body.adminChatId);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    parsedAdminChatId = parsed.value;
  }

  const { data: salon, error: salonError } = await (supabase as any)
    .from('salons')
    .select('*')
    .eq('id', salonId)
    .single();

  if (salonError || !salon) {
    return res.status(404).json({ success: false, error: 'Salon not found' });
  }

  let updatedSalon = salon as SalonRow;

  if (hasSalonName) {
    const trimmedName = body.salonName!.trim();
    const { data, error } = await (supabase as any)
      .from('salons')
      .update({ name: trimmedName })
      .eq('id', salonId)
      .select('*')
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, error: error?.message ?? 'Could not update salon' });
    }
    updatedSalon = data as SalonRow;
  }

  if (hasBotDisplayName || hasAdminChatId) {
    const { data: existingIntegration } = await (supabase as any)
      .from('salon_integrations')
      .select(INTEGRATION_SUMMARY_SELECT)
      .eq('salon_id', salonId)
      .eq('provider', TELEGRAM_PROVIDER)
      .maybeSingle();

    if (!existingIntegration) {
      return res.status(404).json({ success: false, error: 'Telegram integration not found' });
    }

    const now = new Date().toISOString();
    const integrationUpdates: Record<string, unknown> = { updated_at: now };

    if (hasBotDisplayName) {
      integrationUpdates.bot_display_name = body.botDisplayName!.trim() || null;
      integrationUpdates.last_checked_at = now;
    }
    if (hasAdminChatId) {
      integrationUpdates.admin_chat_id = parsedAdminChatId;
    }

    const { data: integration, error: integrationError } = await (supabase as any)
      .from('salon_integrations')
      .update(integrationUpdates)
      .eq('salon_id', salonId)
      .eq('provider', TELEGRAM_PROVIDER)
      .select(INTEGRATION_SUMMARY_SELECT)
      .single();

    if (integrationError || !integration) {
      return res.status(500).json({ success: false, error: integrationError?.message ?? 'Could not update integration' });
    }

    return res.json({
      success: true,
      integration: mapTelegramIntegration(updatedSalon, integration as IntegrationRow),
    });
  }

  const { data: integration, error: integrationError } = await (supabase as any)
    .from('salon_integrations')
    .select(INTEGRATION_SUMMARY_SELECT)
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .single();

  if (integrationError || !integration) {
    return res.status(404).json({ success: false, error: 'Telegram integration not found' });
  }

  return res.json({
    success: true,
    integration: mapTelegramIntegration(updatedSalon, integration as IntegrationRow),
  });
});

const ADMIN_CHAT_CANDIDATE_TTL_MS = 30 * 60 * 1000;

router.get('/integrations/telegram/:salonId/admin-chat-candidate', async (req, res) => {
  const salonId = req.params.salonId?.trim();
  if (!salonId) {
    return res.status(400).json({ error: 'salonId is required' });
  }

  const { data: integration, error } = await (supabase as any)
    .from('salon_integrations')
    .select('admin_chat_candidate_id, admin_chat_candidate_at')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!integration) {
    return res.status(404).json({ error: 'Telegram integration not found' });
  }

  const candidateId = integration.admin_chat_candidate_id;
  const detectedAt = integration.admin_chat_candidate_at as string | null;

  if (candidateId == null || !detectedAt) {
    return res.json({ found: false });
  }

  const detectedMs = new Date(detectedAt).getTime();
  if (Number.isNaN(detectedMs)) {
    return res.json({ found: false });
  }

  const expiresAtMs = detectedMs + ADMIN_CHAT_CANDIDATE_TTL_MS;
  if (Date.now() > expiresAtMs) {
    // Leave expired row in place so Confirm can still reject with expired;
    // GET does not clear — avoids surprising side effects on a read.
    return res.json({ found: false, expired: true });
  }

  return res.json({
    found: true,
    candidateChatId: Number(candidateId),
    detectedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
});

router.post('/integrations/telegram/:salonId/admin-chat-candidate/confirm', async (req, res) => {
  const salonId = req.params.salonId?.trim();
  if (!salonId) {
    return res.status(400).json({ success: false, error: 'salonId is required' });
  }

  const body = req.body as { candidateChatId?: unknown };
  const parsed = parseAdminChatIdInput(body.candidateChatId);
  if (!parsed.ok || parsed.value === null) {
    return res.status(400).json({ success: false, error: 'Invalid candidateChatId' });
  }
  const requestedCandidateChatId = parsed.value;

  const { data: salon, error: salonError } = await (supabase as any)
    .from('salons')
    .select('*')
    .eq('id', salonId)
    .maybeSingle();

  if (salonError) {
    return res.status(500).json({ success: false, error: salonError.message });
  }
  if (!salon) {
    return res.status(404).json({ success: false, error: 'Salon not found' });
  }

  const { data: integration, error: integrationError } = await (supabase as any)
    .from('salon_integrations')
    .select(INTEGRATION_SUMMARY_SELECT + ', admin_chat_candidate_id, admin_chat_candidate_at')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  if (integrationError) {
    return res.status(500).json({ success: false, error: integrationError.message });
  }
  if (!integration) {
    return res.status(404).json({ success: false, error: 'Telegram integration not found' });
  }

  const storedCandidateId = integration.admin_chat_candidate_id;
  const detectedAt = integration.admin_chat_candidate_at as string | null;

  if (storedCandidateId == null || !detectedAt) {
    return res.status(400).json({ success: false, error: 'No admin chat candidate found' });
  }

  const detectedMs = new Date(detectedAt).getTime();
  if (Number.isNaN(detectedMs) || Date.now() > detectedMs + ADMIN_CHAT_CANDIDATE_TTL_MS) {
    return res.status(400).json({ success: false, error: 'Admin chat candidate has expired' });
  }

  if (Number(storedCandidateId) !== requestedCandidateChatId) {
    return res.status(400).json({ success: false, error: 'candidateChatId does not match stored candidate' });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await (supabase as any)
    .from('salon_integrations')
    .update({
      admin_chat_id: Number(storedCandidateId),
      admin_chat_candidate_id: null,
      admin_chat_candidate_at: null,
      updated_at: now,
    })
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .eq('admin_chat_candidate_id', storedCandidateId)
    .eq('admin_chat_candidate_at', detectedAt)
    .select(INTEGRATION_SUMMARY_SELECT)
    .maybeSingle();

  if (updateError) {
    return res.status(500).json({
      success: false,
      error: updateError.message ?? 'Could not confirm admin chat candidate',
    });
  }

  // Zero rows: candidate changed between read and update (e.g. concurrent /start)
  if (!updated) {
    return res.status(409).json({
      success: false,
      error: 'Admin chat candidate changed. Find the candidate again.',
    });
  }

  return res.json({
    success: true,
    integration: mapTelegramIntegration(salon as SalonRow, updated as IntegrationRow),
  });
});

router.post('/integrations/telegram/:salonId/test-admin-notification', async (req, res) => {
  const salonId = req.params.salonId?.trim();
  if (!salonId) {
    return res.status(400).json({ success: false, error: 'salonId is required' });
  }

  const { data: salon, error: salonError } = await (supabase as any)
    .from('salons')
    .select('name')
    .eq('id', salonId)
    .maybeSingle();

  if (salonError) {
    return res.status(500).json({ success: false, error: salonError.message });
  }
  if (!salon) {
    return res.status(404).json({ success: false, error: 'Salon not found' });
  }

  const { data: integration, error: integrationError } = await (supabase as any)
    .from('salon_integrations')
    .select('admin_chat_id, token_ciphertext')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  if (integrationError) {
    return res.status(500).json({ success: false, error: integrationError.message });
  }
  if (!integration) {
    return res.status(404).json({ success: false, error: 'Telegram integration not found' });
  }

  const adminChatId = integration.admin_chat_id;
  if (adminChatId == null) {
    return res.status(400).json({ success: false, error: 'Admin chat ID is not configured' });
  }

  const token = typeof integration.token_ciphertext === 'string' ? integration.token_ciphertext.trim() : '';
  if (!token) {
    return res.status(400).json({ success: false, error: 'Telegram bot token is not configured' });
  }

  const salonName = typeof salon.name === 'string' ? salon.name : 'Salon';
  const message = `🔔 Тестовое уведомление для салона «${salonName}»`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminChatId,
        text: message,
      }),
    });

    const data = (await response.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      const description = data.description ?? 'Telegram API error';
      console.warn(`[developer/test-admin-notify] salonId=${salonId} failed:`, description);
      return res.status(502).json({ success: false, error: description });
    }

    return res.json({ success: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Telegram request failed';
    console.warn(`[developer/test-admin-notify] salonId=${salonId} failed:`, errMsg);
    return res.status(502).json({ success: false, error: errMsg });
  }
});

router.post('/integrations/telegram/connect', async (req, res) => {
  const { salonName, salonId, token, botDisplayName } = req.body as {
    salonName?: string;
    salonId?: string;
    token?: string;
    botDisplayName?: string;
  };

  if (!token || typeof token !== 'string' || token.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  const trimmedName = typeof salonName === 'string' ? salonName.trim() : '';
  const trimmedSalonId = typeof salonId === 'string' ? salonId.trim() : '';

  if (trimmedName && trimmedSalonId) {
    // Reconnect/update existing salon: salonId + optional salonName rename
  } else if (trimmedName) {
    // Create new salon
  } else if (trimmedSalonId) {
    // Reconnect without rename
  } else {
    return res.status(400).json({ success: false, error: 'salonName or salonId is required' });
  }

  const trimmedToken = token.trim();
  const check = await checkTelegramBot(trimmedToken);
  if (!check.ok) {
    return res.status(400).json({ success: false, error: check.error });
  }

  const storedDisplayName = resolveBotDisplayName(botDisplayName, check.displayName, check.username);

  let salon: SalonRow;

  if (trimmedName && !trimmedSalonId) {
    const slug = await uniqueSlug(slugify(trimmedName));
    const { data, error } = await (supabase as any)
      .from('salons')
      .insert({
        name: trimmedName,
        slug,
        timezone: 'Europe/Moscow',
        country: 'RU',
        currency: 'RUB',
        language: 'ru',
        active: true,
      })
      .select('*')
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, error: error?.message ?? 'Could not create salon' });
    }

    salon = data as SalonRow;
  } else {
    const lookupId = trimmedSalonId;
    const { data, error } = await (supabase as any)
      .from('salons')
      .select('*')
      .eq('id', lookupId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Salon not found' });
    }

    salon = data as SalonRow;

    if (trimmedName) {
      const { data: renamed, error: renameError } = await (supabase as any)
        .from('salons')
        .update({ name: trimmedName })
        .eq('id', lookupId)
        .select('*')
        .single();

      if (renameError || !renamed) {
        return res.status(500).json({ success: false, error: renameError?.message ?? 'Could not update salon' });
      }
      salon = renamed as SalonRow;
    }
  }

  const existing = await getExistingIntegration(salon.id);
  const now = new Date().toISOString();
  const integrationHealth: IntegrationHealth =
    salon.slug === DEFAULT_SALON_SLUG ? 'healthy' : 'unknown';

  const integration = await upsertTelegramIntegration(salon.id, {
    status: 'connected',
    health: integrationHealth,
    botUsername: check.username,
    botDisplayName: storedDisplayName,
    connectedAt: existing?.connected_at ?? now,
    lastError: null,
    tokenCiphertext: trimmedToken,
  });

  if (!integration) {
    return res.status(500).json({ success: false, error: 'Could not save integration' });
  }

  if (salon.slug === DEFAULT_SALON_SLUG) {
    process.env.TELEGRAM_BOT_TOKEN = trimmedToken;
    restartTelegramPolling();
  }

  return res.json({
    success: true,
    salonId: salon.id,
    username: check.username,
    name: storedDisplayName,
    integration: mapTelegramIntegration(salon, integration),
  });
});

export default router;
