import { Router } from 'express';
import { runBirthdayOwnerNotifications } from '../lib/birthdayOwnerNotify.js';
import { runTelegramReminderWorker } from '../lib/telegramReminderWorker.js';

const router = Router();

function isAuthorized(req: { headers: Record<string, unknown> }): boolean {
  const configured = process.env.BIRTHDAY_CRON_SECRET?.trim();
  if (!configured) return false;

  const headerVal = req.headers['x-cron-secret'];
  const provided = typeof headerVal === 'string' ? headerVal.trim() : '';
  return provided.length > 0 && provided === configured;
}

function parseDryRun(query: Record<string, unknown>): boolean {
  const dryRunRaw = query.dryRun;
  return dryRunRaw === 'true' || dryRunRaw === '1' || dryRunRaw === 'yes';
}

/**
 * POST /api/internal/birthday-owner-notify
 * Optional: ?dryRun=true — match only, no Telegram / no DB writes.
 * Auth: header x-cron-secret === BIRTHDAY_CRON_SECRET
 */
router.post('/birthday-owner-notify', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = parseDryRun(req.query as Record<string, unknown>);

  try {
    const summary = await runBirthdayOwnerNotifications({ dryRun });
    return res.status(200).json({
      ok: true,
      salonsProcessed: summary.salonsProcessed,
      notificationsSent: summary.notificationsSent,
      notificationsSkipped: summary.notificationsSkipped,
      notificationsFailed: summary.notificationsFailed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processor failed';
    console.error('[birthday-owner-notify] fatal:', message);
    return res.status(500).json({ ok: false, error: 'Birthday notify processor failed' });
  }
});

/**
 * POST /api/internal/telegram-reminders
 * Optional: ?dryRun=true — select + validate only, no claims / sends / writes.
 * Auth: header x-cron-secret === BIRTHDAY_CRON_SECRET
 */
router.post('/telegram-reminders', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = parseDryRun(req.query as Record<string, unknown>);

  try {
    const summary = await runTelegramReminderWorker({ dryRun });
    return res.status(200).json({
      ok: true,
      dryRun,
      scanned: summary.scanned,
      claimed: summary.claimed,
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failed,
      retried: summary.retried,
      errors: summary.errors.slice(0, 20),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processor failed';
    console.error('[telegram-reminders] fatal:', message);
    return res.status(500).json({ ok: false, error: 'Telegram reminder worker failed' });
  }
});

export default router;
