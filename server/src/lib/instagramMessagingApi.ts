/**
 * IG-7: Instagram Messaging Send API client (Instagram Login).
 * Injectable fetch. No SDK. Never logs tokens or message bodies.
 *
 * Contract (Meta Instagram API with Instagram Login):
 *   POST https://graph.instagram.com/{version}/{IG_ID}/messages
 *   Authorization: Bearer <INSTAGRAM_USER_ACCESS_TOKEN>
 *   Body: { recipient: { id: <IGSID> }, message: { text } }
 *   Response: { recipient_id, message_id } — both opaque strings.
 *
 * Limits / policy (document):
 * - Text messages supported; IG-7 text-only first (quick replies deferred).
 * - Typical text limit ~1000 characters.
 * - Human-agent messaging window (~24h) after user-initiated contact.
 * - Permission: instagram_business_manage_messages (among required scopes).
 * - No documented client idempotency key → unknown post-send timeout is
 *   ambiguous (do not blind-retry).
 */

import {
  INSTAGRAM_GRAPH_API_VERSION,
  parseRequiredInstagramOpaqueId,
  type InstagramFetch,
} from './instagramApi.js';
import { INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS } from './instagramOutboundIntent.js';

const REQUEST_TIMEOUT_MS = 12_000;
const MESSAGES_HOST = 'https://graph.instagram.com';

export type InstagramSendTextResult =
  | { kind: 'sent'; providerMessageId: string }
  | {
      kind: 'retryable_error';
      code:
        | 'timeout_pre_send'
        | 'network'
        | 'rate_limited'
        | 'provider_5xx'
        | 'provider_unavailable';
    }
  | {
      kind: 'permanent_error';
      code:
        | 'invalid_input'
        | 'invalid_payload'
        | 'invalid_recipient'
        | 'invalid_credentials'
        | 'malformed_response'
        | 'numeric_id_rejected';
    }
  | {
      /** Request may have reached Meta; retry could duplicate. Fail closed. */
      kind: 'ambiguous_outcome';
      code: 'timeout_post_send' | 'unknown_response';
    };

export type InstagramSendTextFn = (input: {
  accessToken: string;
  professionalAccountId: string;
  recipientExternalUserId: string;
  text: string;
  fetchImpl?: InstagramFetch;
}) => Promise<InstagramSendTextResult>;

function asNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/** Reject numeric coercion for recipient / professional / message ids. */
export function parseInstagramMessagingOpaqueId(
  value: unknown,
  field: 'recipient' | 'professional_account' | 'provider_message_id',
): string | null {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return null;
  }
  try {
    return parseRequiredInstagramOpaqueId(value);
  } catch {
    void field;
    return null;
  }
}

export function buildInstagramSendMessageUrl(professionalAccountId: string): string {
  const id = parseInstagramMessagingOpaqueId(
    professionalAccountId,
    'professional_account',
  );
  if (!id) {
    throw new Error('numeric_id_rejected');
  }
  return `${MESSAGES_HOST}/${INSTAGRAM_GRAPH_API_VERSION}/${encodeURIComponent(id)}/messages`;
}

async function postSendJson(
  fetchImpl: InstagramFetch,
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown; timedOut: boolean; network: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, timedOut: false, network: false };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 0, body: null, timedOut: true, network: false };
    }
    return { status: 0, body: null, timedOut: false, network: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a text Instagram DM via Messaging API (Instagram Login).
 * Does not resolve salons/credentials, does not retry, does not log secrets/bodies.
 */
export async function sendInstagramTextMessage(input: {
  accessToken: string;
  professionalAccountId: string;
  recipientExternalUserId: string;
  text: string;
  fetchImpl?: InstagramFetch;
}): Promise<InstagramSendTextResult> {
  const accessToken = asNonBlankString(input.accessToken);
  const text = asNonBlankString(input.text);
  if (!accessToken || !text) {
    return { kind: 'permanent_error', code: 'invalid_input' };
  }
  if (text.length > INSTAGRAM_OUTBOUND_TEXT_MAX_CHARS) {
    return { kind: 'permanent_error', code: 'invalid_payload' };
  }

  const professionalAccountId = parseInstagramMessagingOpaqueId(
    input.professionalAccountId,
    'professional_account',
  );
  const recipient = parseInstagramMessagingOpaqueId(
    input.recipientExternalUserId,
    'recipient',
  );
  if (!professionalAccountId || !recipient) {
    return { kind: 'permanent_error', code: 'numeric_id_rejected' };
  }

  let url: string;
  try {
    url = buildInstagramSendMessageUrl(professionalAccountId);
  } catch {
    return { kind: 'permanent_error', code: 'numeric_id_rejected' };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const result = await postSendJson(fetchImpl, url, accessToken, {
    recipient: { id: recipient },
    message: { text },
  });

  // Timeout after request dispatch is ambiguous (Meta may have accepted).
  if (result.timedOut) {
    return { kind: 'ambiguous_outcome', code: 'timeout_post_send' };
  }
  if (result.network) {
    return { kind: 'retryable_error', code: 'network' };
  }

  if (result.status === 401 || result.status === 403) {
    return { kind: 'permanent_error', code: 'invalid_credentials' };
  }
  if (result.status === 429) {
    return { kind: 'retryable_error', code: 'rate_limited' };
  }
  if (result.status >= 500) {
    return { kind: 'retryable_error', code: 'provider_5xx' };
  }
  if (result.status === 400 || result.status === 404 || result.status === 422) {
    return { kind: 'permanent_error', code: 'invalid_recipient' };
  }
  if (result.status < 200 || result.status >= 300) {
    return { kind: 'retryable_error', code: 'provider_unavailable' };
  }

  const body = result.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'permanent_error', code: 'malformed_response' };
  }

  const rawMid = (body as { message_id?: unknown }).message_id;
  if (typeof rawMid === 'number' || typeof rawMid === 'bigint') {
    return { kind: 'permanent_error', code: 'numeric_id_rejected' };
  }
  const providerMessageId = parseInstagramMessagingOpaqueId(
    rawMid,
    'provider_message_id',
  );
  if (!providerMessageId) {
    return { kind: 'permanent_error', code: 'malformed_response' };
  }

  return { kind: 'sent', providerMessageId };
}
