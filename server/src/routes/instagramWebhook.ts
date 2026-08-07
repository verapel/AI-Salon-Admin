/**
 * IG-3: Instagram Messaging webhook (Meta).
 * GET: hub verification with INSTAGRAM_WEBHOOK_VERIFY_TOKEN.
 * POST: X-Hub-Signature-256 over raw body with INSTAGRAM_APP_SECRET.
 * No developer/salon Bearer. No conversations/booking/outbound.
 */

import express, { Router, type Request, type Response } from 'express';
import { normalizeInstagramWebhookPayload } from '../lib/instagramWebhookEvents.js';
import {
  createDefaultInstagramProcessDeps,
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from '../lib/instagramWebhookProcess.js';
import {
  loadInstagramAppSecretForWebhook,
  loadInstagramWebhookVerifyToken,
  timingSafeEqualUtf8,
  verifyInstagramHubSignature,
} from '../lib/instagramWebhookSignature.js';

const router = Router();

/** Injectable process deps for tests. */
export let instagramWebhookProcessDeps: InstagramProcessDeps =
  createDefaultInstagramProcessDeps();

export function setInstagramWebhookProcessDepsForTests(
  deps: InstagramProcessDeps | null,
): void {
  instagramWebhookProcessDeps = deps ?? createDefaultInstagramProcessDeps();
}

function queryStringParam(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    const trimmed = value[0].trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * GET /api/webhooks/instagram
 * Meta hub.mode / hub.verify_token / hub.challenge.
 */
router.get('/', async (req: Request, res: Response) => {
  const mode = queryStringParam(req.query['hub.mode']);
  const verifyToken = queryStringParam(req.query['hub.verify_token']);
  const challenge = queryStringParam(req.query['hub.challenge']);

  if (mode !== 'subscribe' || !verifyToken || !challenge) {
    return res.status(403).send('Forbidden');
  }

  const configured = loadInstagramWebhookVerifyToken();
  if (!configured) {
    console.error('[instagram/webhook] GET verify not configured', {
      operation: 'get_verify_not_configured',
    });
    return res.status(403).send('Forbidden');
  }

  if (!timingSafeEqualUtf8(verifyToken, configured)) {
    console.error('[instagram/webhook] GET verify token mismatch', {
      operation: 'get_verify_mismatch',
    });
    return res.status(403).send('Forbidden');
  }

  return res.status(200).type('text/plain').send(challenge);
});

/**
 * POST /api/webhooks/instagram
 * Raw-body HMAC, normalize events, durable receipts. No messaging FSM.
 */
router.post(
  '/',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const appSecret = loadInstagramAppSecretForWebhook();
    if (!appSecret) {
      console.error('[instagram/webhook] POST not configured', {
        operation: 'post_not_configured',
      });
      return res.status(503).send('Service Unavailable');
    }

    if (!Buffer.isBuffer(req.body)) {
      console.error('[instagram/webhook] POST missing raw body', {
        operation: 'post_missing_raw_body',
      });
      return res.status(400).send('Bad Request');
    }

    const signatureHeader =
      typeof req.get === 'function'
        ? req.get('x-hub-signature-256') ?? undefined
        : undefined;

    const okSig = verifyInstagramHubSignature({
      appSecret,
      rawBody: req.body,
      signatureHeader,
    });
    if (!okSig) {
      console.error('[instagram/webhook] POST signature rejected', {
        operation: 'post_signature_rejected',
      });
      return res.status(401).send('Unauthorized');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      // Signed but malformed JSON — permanent HTTP 200 ignored (WA anti-retry-storm parity).
      console.error('[instagram/webhook] POST malformed JSON', {
        operation: 'post_malformed_json',
      });
      return res.status(200).json({ status: 'ignored' });
    }

    // Empty list includes wrong/missing object=instagram (fail closed, no receipt, no 500).
    const events = normalizeInstagramWebhookPayload(payload);
    if (events.length === 0) {
      return res.status(200).json({ status: 'ok' });
    }

    let transientFailure = false;

    for (const event of events) {
      try {
        const result = await processInstagramWebhookEvent(
          event,
          instagramWebhookProcessDeps,
        );
        if (
          result.outcome === 'failed_transient' ||
          result.outcome === 'in_flight'
        ) {
          transientFailure = true;
        }
      } catch {
        console.error('[instagram/webhook] POST event processing error', {
          operation: 'post_event_error',
          kind: event.kind,
        });
        transientFailure = true;
      }
    }

    // Multi-event: progress independently; any sticky failure → 500 so Meta retries.
    if (transientFailure) {
      return res.status(500).json({ status: 'retry' });
    }
    return res.status(200).json({ status: 'ok' });
  },
);

export default router;
