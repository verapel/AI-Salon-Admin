import { createHash } from 'crypto';
import { supabase } from './supabase.js';

/** Runtime context for a single salon Telegram bot poller (includes token — never log). */
export interface TelegramBotRuntimeContext {
  salonId: string;
  salonSlug: string;
  botToken: string;
  botUsername: string | null;
}

export type TelegramUpdateHandler = (
  ctx: TelegramBotRuntimeContext,
  update: Record<string, unknown>
) => Promise<void>;

interface BotPollerRuntime {
  salonId: string;
  salonSlug: string;
  botToken: string;
  botUsername: string | null;
  offset: number;
  intervalId: ReturnType<typeof setInterval> | null;
  isTickRunning: boolean;
}

const POLL_INTERVAL_MS = 3000;

export function isMultiTelegramEnabled(): boolean {
  return process.env.MULTI_TELEGRAM_ENABLED === 'true';
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function botLogLabel(salonId: string, botUsername: string | null): string {
  const user = botUsername ? `@${botUsername}` : 'unknown';
  return `[telegram][salonId=${salonId}][bot=${user}]`;
}

export class TelegramBotManager {
  private pollers = new Map<string, BotPollerRuntime>();
  private tokenIndex = new Map<string, string>();
  private handleUpdate: TelegramUpdateHandler | null = null;

  /** Load connected Telegram integrations for active salons (tokens stay server-side only). */
  async loadConnectedIntegrations(): Promise<TelegramBotRuntimeContext[]> {
    const { data: rows, error } = await (supabase as any)
      .from('salon_integrations')
      .select('salon_id, token_ciphertext, bot_username, salons!inner(slug, active)')
      .eq('provider', 'telegram')
      .eq('status', 'connected')
      .eq('salons.active', true);

    if (error) {
      console.error('[telegram/manager] load integrations error:', error.message);
      return [];
    }

    const integrations: TelegramBotRuntimeContext[] = [];

    for (const row of rows ?? []) {
      const token = (row.token_ciphertext as string | null)?.trim();
      if (!token) continue;

      const salon = row.salons as { slug: string; active: boolean } | null;
      if (!salon?.slug) continue;

      integrations.push({
        salonId: row.salon_id as string,
        salonSlug: salon.slug,
        botToken: token,
        botUsername: (row.bot_username as string | null) ?? null,
      });
    }

    return integrations;
  }

  async startAll(handler: TelegramUpdateHandler): Promise<void> {
    this.handleUpdate = handler;
    const integrations = await this.loadConnectedIntegrations();
    console.log(`[telegram/manager] starting ${integrations.length} poller(s)`);

    for (const integration of integrations) {
      this.startPoller(integration);
    }
  }

  startPoller(ctx: TelegramBotRuntimeContext): void {
    if (this.pollers.has(ctx.salonId)) {
      console.warn(`${botLogLabel(ctx.salonId, ctx.botUsername)} poller already running — skip`);
      return;
    }

    const fingerprint = tokenFingerprint(ctx.botToken);
    const existingSalonId = this.tokenIndex.get(fingerprint);
    if (existingSalonId && existingSalonId !== ctx.salonId) {
      console.warn(`${botLogLabel(ctx.salonId, ctx.botUsername)} duplicate token — skip`);
      return;
    }
    this.tokenIndex.set(fingerprint, ctx.salonId);

    const runtime: BotPollerRuntime = {
      salonId: ctx.salonId,
      salonSlug: ctx.salonSlug,
      botToken: ctx.botToken,
      botUsername: ctx.botUsername,
      offset: 0,
      intervalId: null,
      isTickRunning: false,
    };

    console.log(`${botLogLabel(ctx.salonId, ctx.botUsername)} polling started`);

    runtime.intervalId = setInterval(async () => {
      if (runtime.isTickRunning) return;
      runtime.isTickRunning = true;
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${runtime.botToken}/getUpdates?offset=${runtime.offset + 1}`
        );
        const data = (await response.json()) as {
          ok: boolean;
          result?: Array<Record<string, unknown> & { update_id: number }>;
        };

        if (!data.ok || !data.result) return;

        for (const update of data.result) {
          runtime.offset = update.update_id;
          const handlerCtx: TelegramBotRuntimeContext = {
            salonId: runtime.salonId,
            salonSlug: runtime.salonSlug,
            botToken: runtime.botToken,
            botUsername: runtime.botUsername,
          };
          await this.handleUpdate?.(handlerCtx, update);
        }
      } catch (err) {
        console.error(`${botLogLabel(runtime.salonId, runtime.botUsername)} polling error`, err);
      } finally {
        runtime.isTickRunning = false;
      }
    }, POLL_INTERVAL_MS);

    this.pollers.set(ctx.salonId, runtime);
  }

  stopPoller(salonId: string): void {
    const runtime = this.pollers.get(salonId);
    if (!runtime) return;

    if (runtime.intervalId !== null) {
      clearInterval(runtime.intervalId);
    }

    const fingerprint = tokenFingerprint(runtime.botToken);
    if (this.tokenIndex.get(fingerprint) === salonId) {
      this.tokenIndex.delete(fingerprint);
    }

    this.pollers.delete(salonId);
    console.log(`${botLogLabel(salonId, runtime.botUsername)} polling stopped`);
  }

  stopAll(): void {
    for (const salonId of [...this.pollers.keys()]) {
      this.stopPoller(salonId);
    }
  }

  async restartSalon(salonId: string): Promise<void> {
    this.stopPoller(salonId);
    const integrations = await this.loadConnectedIntegrations();
    const match = integrations.find((i) => i.salonId === salonId);
    if (match) {
      this.startPoller(match);
    } else {
      console.warn(`[telegram/manager] no connected integration for salonId=${salonId}`);
    }
  }

  async restartAll(): Promise<void> {
    this.stopAll();
    if (this.handleUpdate) {
      await this.startAll(this.handleUpdate);
    }
  }
}

export const telegramBotManager = new TelegramBotManager();
