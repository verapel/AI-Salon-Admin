import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
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
};

function mapSalon(row: SalonRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    country: row.country,
    currency: row.currency,
    language: row.language,
    active: row.active,
    createdAt: row.created_at,
  };
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

async function getExistingIntegration(salonId: string): Promise<{ connected_at: string | null } | null> {
  const { data } = await (supabase as any)
    .from('salon_integrations')
    .select('connected_at')
    .eq('salon_id', salonId)
    .eq('provider', TELEGRAM_PROVIDER)
    .maybeSingle();

  return data;
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
  }
): Promise<IntegrationRow | null> {
  const now = new Date().toISOString();

  const { data, error } = await (supabase as any)
    .from('salon_integrations')
    .upsert(
      {
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
      },
      { onConflict: 'salon_id,provider' }
    )
    .select('status, health, bot_username, bot_display_name, connected_at, last_checked_at, last_error')
    .single();

  if (error) {
    console.error('[developer/integrations/telegram] upsert error:', error.message);
    return null;
  }

  return data;
}

async function syncDefaultSalonTelegram(salonId: string): Promise<IntegrationRow> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
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
      }
    );
  }

  const check = await checkTelegramBot(token);

  if (check.ok) {
    const existing = await getExistingIntegration(salonId);
    const connectedAt = existing?.connected_at ?? now;

    const row = await upsertTelegramIntegration(salonId, {
      status: 'connected',
      health: 'healthy',
      botUsername: check.username,
      botDisplayName: check.displayName,
      connectedAt,
      lastError: null,
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
    botDisplayName: integration.bot_display_name,
    connectedAt: integration.connected_at,
    lastCheckedAt: integration.last_checked_at,
    lastError: integration.last_error,
  };
}

function notConnectedIntegration(): IntegrationRow {
  return {
    status: 'not_connected',
    health: 'unknown',
    bot_username: null,
    bot_display_name: null,
    connected_at: null,
    last_checked_at: null,
    last_error: null,
  };
}

router.get('/salons', async (_req, res) => {
  const { data, error } = await (supabase as any)
    .from('salons')
    .select('*')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json((data as SalonRow[]).map(mapSalon));
});

router.get('/integrations/telegram', async (_req, res) => {
  const { data: salons, error } = await (supabase as any)
    .from('salons')
    .select('*')
    .eq('active', true)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });

  const rows = salons as SalonRow[];
  const result = [];

  for (const salon of rows) {
    if (salon.slug === DEFAULT_SALON_SLUG) {
      const integration = await syncDefaultSalonTelegram(salon.id);
      result.push(mapTelegramIntegration(salon, integration));
    } else {
      result.push(mapTelegramIntegration(salon, notConnectedIntegration()));
    }
  }

  res.json(result);
});

export default router;
