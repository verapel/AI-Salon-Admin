import { Router } from 'express';
import { runBirthdayOwnerNotifications } from '../lib/birthdayOwnerNotify.js';

const router = Router();

function isAuthorized(req: { headers: Record<string, unknown> }): boolean {
  const configured = process.env.BIRTHDAY_CRON_SECRET?.trim();
  if (!configured) return false;

  const headerVal = req.headers['x-cron-secret'];
  const provided = typeof headerVal === 'string' ? headerVal.trim() : '';
  return provided.length > 0 && provided === configured;
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

  const dryRunRaw = req.query.dryRun;
  const dryRun =
    dryRunRaw === 'true' || dryRunRaw === '1' || dryRunRaw === 'yes';

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

export default router;
