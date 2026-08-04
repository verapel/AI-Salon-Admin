/**
 * Public Meta WhatsApp Cloud webhook foundation (WA-3B / WA-4B / WA-4C).
 * GET verification + POST HMAC + receipt dedupe + inbound identity + booking FSM.
 * FSM produces internal reply results only — no Meta outbound, no appointments/clients.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { supabase } from '../lib/supabase.js';
import {
  decryptWhatsAppCredential,
  isWhatsAppCredentialCryptoError,
} from '../lib/whatsappCredentialsCrypto.js';
import {
  timingSafeEqualUtf8,
  verifyWhatsAppHubSignature,
} from '../lib/whatsappWebhookSignature.js';
import {
  classifyWhatsAppWebhookPayload,
  sha256Hex,
  type ClassifiedWhatsAppWebhookEvent,
} from '../lib/whatsappWebhookEvents.js';
import {
  claimWhatsAppEventReceipt,
  finalizeWhatsAppEventReceipt,
  markWhatsAppEventReceiptFailed,
  RECEIPT_PROCESSING_STALE_MS,
} from '../lib/whatsappWebhookReceipts.js';
import { processWhatsAppInboundIdentityFoundation } from '../lib/whatsappIdentity.js';
import { extractWhatsAppInboundTextBody } from '../lib/whatsappInboundText.js';
import { processWhatsAppBookingFsm } from '../lib/whatsappBookingFlow.js';

const router = Router();
const WHATSAPP_PROVIDER = 'whatsapp' as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ConnectionRow = {
  id: string;
  salon_id: string;
  integration_id: string;
  phone_number_id: string | null;
  webhook_key: string;
  app_secret_ciphertext: string | null;
  app_secret_iv: string | null;
  app_secret_auth_tag: string | null;
  verify_token_ciphertext: string | null;
  verify_token_iv: string | null;
  verify_token_auth_tag: string | null;
};

type IntegrationRow = {
  id: string;
  salon_id: string;
  provider: string;
  status: string;
};

type RoutedConnection = {
  connection: ConnectionRow;
  integration: IntegrationRow;
};

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isTriplePresent(
  ciphertext: string | null,
  iv: string | null,
  authTag: string | null
): boolean {
  return (
    typeof ciphertext === 'string' &&
    ciphertext.trim().length > 0 &&
    typeof iv === 'string' &&
    iv.trim().length > 0 &&
    typeof authTag === 'string' &&
    authTag.trim().length > 0
  );
}

function queryStringParam(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

async function loadRoutedConnection(webhookKey: string): Promise<RoutedConnection | null> {
  const { data: connection, error: connectionError } = await (supabase as any)
    .from('whatsapp_business_connections')
    .select(
      `
      id,
      salon_id,
      integration_id,
      phone_number_id,
      webhook_key,
      app_secret_ciphertext,
      app_secret_iv,
      app_secret_auth_tag,
      verify_token_ciphertext,
      verify_token_iv,
      verify_token_auth_tag
    `
    )
    .eq('webhook_key', webhookKey)
    .maybeSingle();

  if (connectionError) {
    throw new Error(connectionError.message);
  }
  if (!connection) return null;

  const conn = connection as ConnectionRow;

  const { data: integration, error: integrationError } = await (supabase as any)
    .from('salon_integrations')
    .select('id, salon_id, provider, status')
    .eq('id', conn.integration_id)
    .eq('salon_id', conn.salon_id)
    .eq('provider', WHATSAPP_PROVIDER)
    .maybeSingle();

  if (integrationError) {
    throw new Error(integrationError.message);
  }
  if (!integration) return null;

  const integ = integration as IntegrationRow;
  if (integ.salon_id !== conn.salon_id || integ.id !== conn.integration_id) {
    return null;
  }

  return { connection: conn, integration: integ };
}

function isConnected(integration: IntegrationRow): boolean {
  return integration.status === 'connected';
}

async function touchWebhookTimestamps(params: {
  connectionId: string;
  salonId: string;
  inbound: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, string> = {
    last_webhook_at: now,
    updated_at: now,
  };
  if (params.inbound) {
    patch.last_inbound_at = now;
  }

  const { error } = await (supabase as any)
    .from('whatsapp_business_connections')
    .update(patch)
    .eq('id', params.connectionId)
    .eq('salon_id', params.salonId);

  if (error) {
    // Non-blocking: receipt correctness preferred over cosmetic timestamps.
    console.error('[whatsapp/webhook] timestamp update failed', {
      provider: WHATSAPP_PROVIDER,
      salonId: params.salonId,
      operation: 'touch_webhook_timestamps',
    });
  }
}

/**
 * Claim → (inbound identity/conversation foundation) → (booking FSM) → finalize.
 *
 * Transitions:
 *   NEW → processing → processed|ignored
 *   received|failed → processing → processed|ignored
 *   stale processing → processing → processed|ignored
 *   processed|ignored → terminal duplicate
 *   fresh processing → in_flight (HTTP 500 so Meta retries; stale reclaim after threshold)
 *   finalize DB error → mark-failed with same attemptCount → HTTP 500
 *   finalize/mark-failed lost_ownership → no further mutation → HTTP 500
 *
 * attemptCount from claim is the ownership generation and must be passed to finalize/fail.
 * Booking FSM durable writes use owned expected-step RPC (WA-4C); no appointments yet.
 *
 * Permanent identity conflicts finalize as ignored (terminal) to avoid Meta retry storms.
 * Ambiguous/unresolved phone match finalizes as processed with conversation only.
 */
type ReceiptOutcome =
  | 'processed'
  | 'ignored'
  | 'duplicate'
  | 'in_flight'
  | 'failed_transient';

async function claimAndFinalizeReceipt(params: {
  salonId: string;
  event: ClassifiedWhatsAppWebhookEvent;
  payloadHash: string | null;
  finalStatus: 'processed' | 'ignored';
}): Promise<ReceiptOutcome> {
  const claim = await claimWhatsAppEventReceipt(supabase as any, {
    salonId: params.salonId,
    externalEventId: params.event.externalEventId,
    externalMessageId: params.event.externalMessageId,
    eventType: params.event.eventType,
    payloadHash: params.payloadHash,
    metadata: params.event.receiptMetadata,
  });

  if (claim.kind === 'duplicate_terminal') {
    return 'duplicate';
  }

  if (claim.kind === 'in_flight') {
    // Another delivery holds a fresh processing claim. Do not return terminal 200:
    // if that worker dies without finalizing, Meta must keep retrying until stale reclaim.
    console.log('[whatsapp/webhook] receipt in-flight', {
      provider: WHATSAPP_PROVIDER,
      salonId: params.salonId,
      operation: 'receipt_in_flight',
      externalEventId: params.event.externalEventId,
      staleMs: RECEIPT_PROCESSING_STALE_MS,
    });
    return 'in_flight';
  }

  if (claim.kind === 'cross_salon_conflict') {
    console.error('[whatsapp/webhook] receipt cross-salon conflict', {
      provider: WHATSAPP_PROVIDER,
      salonId: params.salonId,
      operation: 'receipt_cross_salon_conflict',
      externalEventId: params.event.externalEventId,
    });
    return 'failed_transient';
  }

  if (claim.kind === 'failed_transient') {
    console.error('[whatsapp/webhook] receipt claim failed', {
      provider: WHATSAPP_PROVIDER,
      salonId: params.salonId,
      operation: 'receipt_claim',
      externalEventId: params.event.externalEventId,
      code: claim.code,
    });
    return 'failed_transient';
  }

  // Ownership generation for this worker — required for finalize/fail CAS.
  const receiptId = claim.receiptId;
  const attemptCount = claim.attemptCount;
  let finalizeStatus: 'processed' | 'ignored' = params.finalStatus;

  // WA-4B: inbound message identity + durable conversation (no replies/FSM/appointments).
  if (params.event.isInboundMessage) {
    const foundation = await processWhatsAppInboundIdentityFoundation({
      db: supabase as any,
      salonId: params.salonId,
      sender: params.event.inboundSender,
      externalMessageId: params.event.externalMessageId,
      messageTimestampIso: params.event.messageTimestampIso,
      receiptId,
      attemptCount,
    });

    if (foundation.kind === 'lost_ownership') {
      console.error('[whatsapp/webhook] inbound foundation lost ownership', {
        provider: WHATSAPP_PROVIDER,
        salonId: params.salonId,
        operation: 'inbound_identity',
        result: 'lost_ownership',
        externalEventId: params.event.externalEventId,
      });
      return 'failed_transient';
    }

    if (foundation.kind === 'error') {
      console.error('[whatsapp/webhook] inbound foundation error', {
        provider: WHATSAPP_PROVIDER,
        salonId: params.salonId,
        operation: 'inbound_identity',
        result: 'error',
        errorCode: foundation.code,
        externalEventId: params.event.externalEventId,
      });

      const markedFailed = await markWhatsAppEventReceiptFailed(supabase as any, {
        salonId: params.salonId,
        receiptId,
        attemptCount,
        errorCode: foundation.code,
      });

      if (!markedFailed.ok) {
        console.error('[whatsapp/webhook] receipt mark-failed failed', {
          provider: WHATSAPP_PROVIDER,
          salonId: params.salonId,
          operation: 'receipt_mark_failed',
          result:
            markedFailed.code === 'mark_failed_lost_ownership'
              ? 'mark_failed_lost_ownership'
              : 'mark_failed_db_error',
          externalEventId: params.event.externalEventId,
          code: markedFailed.code,
        });
      }

      return 'failed_transient';
    }

    if (foundation.kind === 'skipped') {
      // Malformed sender — no conversation/identity writes; terminal ignore.
      console.log('[whatsapp/webhook] inbound foundation skipped', {
        provider: WHATSAPP_PROVIDER,
        salonId: params.salonId,
        operation: 'inbound_identity',
        result: foundation.code,
        externalEventId: params.event.externalEventId,
      });
      finalizeStatus = 'ignored';
    } else if (foundation.kind === 'conflict') {
      // Permanent data/payload conflict — fail closed, terminal ignore (no retry storm).
      console.error('[whatsapp/webhook] inbound foundation conflict', {
        provider: WHATSAPP_PROVIDER,
        salonId: params.salonId,
        operation: 'inbound_identity',
        result: foundation.code,
        externalEventId: params.event.externalEventId,
      });
      finalizeStatus = 'ignored';
    } else {
      console.log('[whatsapp/webhook] inbound foundation', {
        provider: WHATSAPP_PROVIDER,
        salonId: params.salonId,
        operation: 'inbound_identity',
        result: foundation.outcome,
        expiredReset: foundation.expiredReset,
        advanced: foundation.advanced,
        externalEventId: params.event.externalEventId,
      });

      // WA-4C: durable booking FSM (internal reply only — no Meta send / no appointments).
      const textBody = extractWhatsAppInboundTextBody(params.event);
      if (textBody) {
        const fsm = await processWhatsAppBookingFsm({
          db: supabase as any,
          salonId: params.salonId,
          externalUserId: foundation.externalUserId,
          text: textBody,
          externalMessageId: params.event.externalMessageId,
          messageTimestampIso: params.event.messageTimestampIso,
          receiptId,
          attemptCount,
          inboundAdvanced: foundation.advanced,
        });

        if (fsm.kind === 'lost_ownership') {
          console.error('[whatsapp/webhook] booking fsm lost ownership', {
            provider: WHATSAPP_PROVIDER,
            salonId: params.salonId,
            operation: 'booking_fsm',
            result: 'lost_ownership',
            externalEventId: params.event.externalEventId,
          });
          return 'failed_transient';
        }

        if (fsm.kind === 'error') {
          console.error('[whatsapp/webhook] booking fsm error', {
            provider: WHATSAPP_PROVIDER,
            salonId: params.salonId,
            operation: 'booking_fsm',
            result: 'error',
            errorCode: fsm.code,
            externalEventId: params.event.externalEventId,
          });
          const markedFailed = await markWhatsAppEventReceiptFailed(supabase as any, {
            salonId: params.salonId,
            receiptId,
            attemptCount,
            errorCode: fsm.code,
          });
          if (!markedFailed.ok) {
            console.error('[whatsapp/webhook] receipt mark-failed failed', {
              provider: WHATSAPP_PROVIDER,
              salonId: params.salonId,
              operation: 'receipt_mark_failed',
              result:
                markedFailed.code === 'mark_failed_lost_ownership'
                  ? 'mark_failed_lost_ownership'
                  : 'mark_failed_db_error',
              externalEventId: params.event.externalEventId,
              code: markedFailed.code,
            });
          }
          return 'failed_transient';
        }

        // Log structured outcome only — never raw message body.
        console.log('[whatsapp/webhook] booking fsm', {
          provider: WHATSAPP_PROVIDER,
          salonId: params.salonId,
          operation: 'booking_fsm',
          result: fsm.kind,
          messageKey: fsm.kind === 'reply' ? fsm.messageKey : undefined,
          reason: fsm.kind === 'noop' ? fsm.reason : undefined,
          externalEventId: params.event.externalEventId,
        });
      }

      finalizeStatus = 'processed';
    }
  }

  const finalized = await finalizeWhatsAppEventReceipt(supabase as any, {
    salonId: params.salonId,
    receiptId,
    attemptCount,
    finalStatus: finalizeStatus,
  });

  if (finalized.ok) {
    return finalized.status === 'ignored' ? 'ignored' : 'processed';
  }

  if (finalized.code === 'finalize_lost_ownership') {
    // Another worker holds a newer generation — do not markFailed with stale ownership.
    console.error('[whatsapp/webhook] receipt finalize lost ownership', {
      provider: WHATSAPP_PROVIDER,
      salonId: params.salonId,
      operation: 'receipt_finalize',
      result: 'finalize_lost_ownership',
      externalEventId: params.event.externalEventId,
    });
    return 'failed_transient';
  }

  console.error('[whatsapp/webhook] receipt finalize failed', {
    provider: WHATSAPP_PROVIDER,
    salonId: params.salonId,
    operation: 'receipt_finalize',
    result: 'finalize_db_error',
    externalEventId: params.event.externalEventId,
    code: finalized.code,
  });

  const markedFailed = await markWhatsAppEventReceiptFailed(supabase as any, {
    salonId: params.salonId,
    receiptId,
    attemptCount,
    errorCode: finalized.code,
  });

  if (!markedFailed.ok) {
    console.error('[whatsapp/webhook] receipt mark-failed failed', {
      provider: WHATSAPP_PROVIDER,
      salonId: params.salonId,
      operation: 'receipt_mark_failed',
      result:
        markedFailed.code === 'mark_failed_lost_ownership'
          ? 'mark_failed_lost_ownership'
          : 'mark_failed_db_error',
      externalEventId: params.event.externalEventId,
      code: markedFailed.code,
    });
  }

  return 'failed_transient';
}

/**
 * GET /api/webhooks/whatsapp/:webhookKey
 * Meta hub.verify_token challenge.
 */
router.get('/:webhookKey', async (req: Request, res: Response) => {
  const webhookKey =
    typeof req.params.webhookKey === 'string' ? req.params.webhookKey.trim() : '';

  if (!webhookKey || !isUuid(webhookKey)) {
    return res.status(403).send('Forbidden');
  }

  const mode = queryStringParam(req.query['hub.mode']);
  const verifyToken = queryStringParam(req.query['hub.verify_token']);
  const challenge = queryStringParam(req.query['hub.challenge']);

  if (mode !== 'subscribe' || !verifyToken || !challenge) {
    return res.status(403).send('Forbidden');
  }

  try {
    const routed = await loadRoutedConnection(webhookKey);
    if (!routed) {
      return res.status(403).send('Forbidden');
    }

    const { connection, integration } = routed;
    if (!isConnected(integration)) {
      console.error('[whatsapp/webhook] GET rejected: disconnected', {
        provider: WHATSAPP_PROVIDER,
        salonId: connection.salon_id,
        operation: 'get_verify_disconnected',
      });
      return res.status(403).send('Forbidden');
    }

    if (
      !isTriplePresent(
        connection.verify_token_ciphertext,
        connection.verify_token_iv,
        connection.verify_token_auth_tag
      )
    ) {
      console.error('[whatsapp/webhook] GET rejected: missing verify credentials', {
        provider: WHATSAPP_PROVIDER,
        salonId: connection.salon_id,
        operation: 'get_verify_missing_credentials',
      });
      return res.status(403).send('Forbidden');
    }

    let storedToken: string;
    try {
      storedToken = decryptWhatsAppCredential({
        ciphertext: connection.verify_token_ciphertext!,
        iv: connection.verify_token_iv!,
        authTag: connection.verify_token_auth_tag!,
      });
    } catch (err) {
      console.error('[whatsapp/webhook] GET decrypt verify token failed', {
        provider: WHATSAPP_PROVIDER,
        salonId: connection.salon_id,
        operation: 'get_verify_decrypt',
        cryptoError: isWhatsAppCredentialCryptoError(err),
      });
      return res.status(403).send('Forbidden');
    }

    if (!timingSafeEqualUtf8(verifyToken, storedToken)) {
      console.error('[whatsapp/webhook] GET verify token mismatch', {
        provider: WHATSAPP_PROVIDER,
        salonId: connection.salon_id,
        operation: 'get_verify_mismatch',
      });
      return res.status(403).send('Forbidden');
    }

    res.status(200).type('text/plain').send(challenge);
  } catch (err) {
    console.error('[whatsapp/webhook] GET unexpected failure', {
      provider: WHATSAPP_PROVIDER,
      operation: 'get_verify',
    });
    return res.status(403).send('Forbidden');
  }
});

/**
 * POST /api/webhooks/whatsapp/:webhookKey
 * Raw-body HMAC, classify events, idempotent receipts. No messaging/FSM.
 */
router.post(
  '/:webhookKey',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const webhookKey =
      typeof req.params.webhookKey === 'string' ? req.params.webhookKey.trim() : '';

    if (!webhookKey || !isUuid(webhookKey)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let routed: RoutedConnection | null;
    try {
      routed = await loadRoutedConnection(webhookKey);
    } catch {
      console.error('[whatsapp/webhook] POST connection load failed', {
        provider: WHATSAPP_PROVIDER,
        operation: 'post_load_connection',
      });
      return res.status(500).json({ error: 'Temporary failure' });
    }

    if (!routed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { connection, integration } = routed;
    const salonId = connection.salon_id;

    if (!isConnected(integration)) {
      console.error('[whatsapp/webhook] POST rejected: disconnected', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_disconnected',
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!asNonEmptyPhone(connection.phone_number_id)) {
      console.error('[whatsapp/webhook] POST rejected: missing phone_number_id', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_missing_phone',
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (
      !isTriplePresent(
        connection.app_secret_ciphertext,
        connection.app_secret_iv,
        connection.app_secret_auth_tag
      )
    ) {
      console.error('[whatsapp/webhook] POST rejected: missing app secret', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_missing_app_secret',
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!rawBody) {
      console.error('[whatsapp/webhook] POST rejected: raw body unavailable', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_raw_body_missing',
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    let appSecret: string;
    try {
      appSecret = decryptWhatsAppCredential({
        ciphertext: connection.app_secret_ciphertext!,
        iv: connection.app_secret_iv!,
        authTag: connection.app_secret_auth_tag!,
      });
    } catch (err) {
      console.error('[whatsapp/webhook] POST decrypt app secret failed', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_decrypt_app_secret',
        cryptoError: isWhatsAppCredentialCryptoError(err),
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    const signatureHeader =
      typeof req.headers['x-hub-signature-256'] === 'string'
        ? req.headers['x-hub-signature-256']
        : undefined;

    const signatureOk = verifyWhatsAppHubSignature({
      appSecret,
      rawBody,
      signatureHeader,
    });

    if (!signatureOk) {
      console.error('[whatsapp/webhook] POST signature rejected', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_signature_reject',
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      console.error('[whatsapp/webhook] POST malformed JSON after valid signature', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_malformed_json',
      });
      // Permanently invalid after auth — avoid Meta retry storms.
      return res.status(200).json({ ok: true, ignored: true });
    }

    const events = classifyWhatsAppWebhookPayload(payload);
    const expectedPhone = connection.phone_number_id!.trim();
    let sawInbound = false;
    let transientFailure = false;

    for (const event of events) {
      if (!event.phoneNumberId || event.phoneNumberId !== expectedPhone) {
        console.error('[whatsapp/webhook] phone mismatch ignored', {
          provider: WHATSAPP_PROVIDER,
          salonId,
          operation: 'post_phone_mismatch',
          externalEventId: event.externalEventId,
          eventCategory: event.category,
        });
        continue;
      }

      const finalStatus = event.category === 'unsupported' ? 'ignored' : 'processed';
      const outcome = await claimAndFinalizeReceipt({
        salonId,
        event,
        payloadHash: sha256Hex(event.externalEventId),
        finalStatus,
      });

      if (outcome === 'failed_transient' || outcome === 'in_flight') {
        // in_flight → 500 so Meta retries; stale reclaim after RECEIPT_PROCESSING_STALE_MS.
        transientFailure = true;
        continue;
      }

      if (outcome === 'duplicate') {
        console.log('[whatsapp/webhook] duplicate event', {
          provider: WHATSAPP_PROVIDER,
          salonId,
          operation: 'post_duplicate',
          externalEventId: event.externalEventId,
          eventCategory: event.category,
        });
        continue;
      }

      console.log('[whatsapp/webhook] event handled', {
        provider: WHATSAPP_PROVIDER,
        salonId,
        operation: 'post_event',
        externalEventId: event.externalEventId,
        eventCategory: event.category,
        result: outcome,
      });

      if (event.isInboundMessage && outcome === 'processed') {
        sawInbound = true;
      }
    }

    if (transientFailure) {
      return res.status(500).json({ error: 'Temporary failure' });
    }

    // Timestamp update is best-effort after safe receipt handling.
    await touchWebhookTimestamps({
      connectionId: connection.id,
      salonId,
      inbound: sawInbound,
    });

    return res.status(200).json({ ok: true });
  }
);

function asNonEmptyPhone(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export default router;
