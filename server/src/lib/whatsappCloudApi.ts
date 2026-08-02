/**
 * Minimal Meta WhatsApp Cloud API client for WA-2 connection verification only.
 * Does not send messages, register webhooks, or touch Telegram/Apple.
 * Never logs access tokens or raw provider payloads.
 */

export const WHATSAPP_GRAPH_API_VERSION = 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}`;
const REQUEST_TIMEOUT_MS = 12_000;
/** Bounded WABA phone_numbers pages (cursor-based; never follow paging.next URLs). */
const WABA_PHONE_NUMBERS_MAX_PAGES = 10;
const WABA_PHONE_NUMBERS_PAGE_LIMIT = 100;

export type WhatsAppErrorCode =
  | 'WHATSAPP_NOT_CONFIGURED'
  | 'WHATSAPP_ENCRYPTION_KEY_MISSING'
  | 'WHATSAPP_INVALID_CREDENTIALS'
  | 'WHATSAPP_META_API_ERROR'
  | 'WHATSAPP_PHONE_NUMBER_NOT_FOUND'
  | 'WHATSAPP_WABA_MISMATCH'
  | 'WHATSAPP_CONNECTION_NOT_FOUND'
  | 'WHATSAPP_PHONE_NUMBER_IN_USE'
  | 'WHATSAPP_FORBIDDEN';

export class WhatsAppAppError extends Error {
  readonly code: WhatsAppErrorCode;
  readonly httpStatus: number;

  constructor(code: WhatsAppErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'WhatsAppAppError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isWhatsAppAppError(err: unknown): err is WhatsAppAppError {
  return err instanceof WhatsAppAppError;
}

export interface WhatsAppPhoneNumberMetadata {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
}

export interface VerifyWhatsAppCloudConnectionInput {
  accessToken: string;
  businessAccountId: string;
  phoneNumberId: string;
}

type GraphPhoneNumber = {
  id?: unknown;
  display_phone_number?: unknown;
  verified_name?: unknown;
  quality_rating?: unknown;
  messaging_limit_tier?: unknown;
};

function asNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function graphGetJson(
  path: string,
  accessToken: string
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${GRAPH_BASE}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    return { status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WhatsAppAppError(
        'WHATSAPP_META_API_ERROR',
        502,
        'WhatsApp provider temporarily unavailable'
      );
    }
    throw new WhatsAppAppError(
      'WHATSAPP_META_API_ERROR',
      502,
      'WhatsApp provider temporarily unavailable'
    );
  } finally {
    clearTimeout(timer);
  }
}

function classifyAuthOrNotFound(status: number): never {
  if (status === 401 || status === 403) {
    throw new WhatsAppAppError(
      'WHATSAPP_INVALID_CREDENTIALS',
      400,
      'Could not verify WhatsApp credentials'
    );
  }
  if (status === 404) {
    throw new WhatsAppAppError(
      'WHATSAPP_PHONE_NUMBER_NOT_FOUND',
      400,
      'Phone number ID was not found for this account'
    );
  }
  throw new WhatsAppAppError(
    'WHATSAPP_META_API_ERROR',
    502,
    'WhatsApp provider temporarily unavailable'
  );
}

function mapPhoneNumber(raw: GraphPhoneNumber, expectedId: string): WhatsAppPhoneNumberMetadata {
  const id = asNonBlankString(raw.id);
  if (!id || id !== expectedId) {
    throw new WhatsAppAppError(
      'WHATSAPP_PHONE_NUMBER_NOT_FOUND',
      400,
      'Phone number ID was not found for this account'
    );
  }

  return {
    id,
    displayPhoneNumber: asNonBlankString(raw.display_phone_number),
    verifiedName: asNonBlankString(raw.verified_name),
    qualityRating: asNonBlankString(raw.quality_rating),
    messagingLimitTier: asNonBlankString(raw.messaging_limit_tier),
  };
}

/**
 * Verify access token + phone number + WABA membership via Meta Graph API.
 * Token is sent only in the Authorization header (never in the query string).
 */
export async function verifyWhatsAppCloudConnection(
  input: VerifyWhatsAppCloudConnectionInput
): Promise<WhatsAppPhoneNumberMetadata> {
  const accessToken = input.accessToken.trim();
  const businessAccountId = input.businessAccountId.trim();
  const phoneNumberId = input.phoneNumberId.trim();

  if (!accessToken || !businessAccountId || !phoneNumberId) {
    throw new WhatsAppAppError(
      'WHATSAPP_INVALID_CREDENTIALS',
      400,
      'Could not verify WhatsApp credentials'
    );
  }

  const fields = [
    'id',
    'display_phone_number',
    'verified_name',
    'quality_rating',
    'messaging_limit_tier',
  ].join(',');

  const phoneResult = await graphGetJson(
    `/${encodeURIComponent(phoneNumberId)}?fields=${encodeURIComponent(fields)}`,
    accessToken
  );

  if (phoneResult.status < 200 || phoneResult.status >= 300) {
    classifyAuthOrNotFound(phoneResult.status);
  }

  if (!phoneResult.body || typeof phoneResult.body !== 'object') {
    throw new WhatsAppAppError(
      'WHATSAPP_META_API_ERROR',
      502,
      'WhatsApp provider temporarily unavailable'
    );
  }

  const phoneMeta = mapPhoneNumber(phoneResult.body as GraphPhoneNumber, phoneNumberId);

  await assertPhoneBelongsToWaba({
    accessToken,
    businessAccountId,
    phoneNumberId,
  });

  return phoneMeta;
}

/**
 * Confirm phoneNumberId is listed under the WABA via cursor pagination.
 * Uses Authorization Bearer only — never follows Meta paging.next URLs (they may embed tokens).
 */
async function assertPhoneBelongsToWaba(input: {
  accessToken: string;
  businessAccountId: string;
  phoneNumberId: string;
}): Promise<void> {
  const { accessToken, businessAccountId, phoneNumberId } = input;
  let afterCursor: string | null = null;

  for (let page = 0; page < WABA_PHONE_NUMBERS_MAX_PAGES; page++) {
    let path =
      `/${encodeURIComponent(businessAccountId)}/phone_numbers` +
      `?fields=id&limit=${WABA_PHONE_NUMBERS_PAGE_LIMIT}`;
    if (afterCursor) {
      path += `&after=${encodeURIComponent(afterCursor)}`;
    }

    const wabaResult = await graphGetJson(path, accessToken);

    if (wabaResult.status === 401 || wabaResult.status === 403) {
      throw new WhatsAppAppError(
        'WHATSAPP_INVALID_CREDENTIALS',
        400,
        'Could not verify WhatsApp credentials'
      );
    }
    if (wabaResult.status === 404) {
      throw new WhatsAppAppError(
        'WHATSAPP_WABA_MISMATCH',
        400,
        'Phone number does not belong to this business account'
      );
    }
    if (wabaResult.status < 200 || wabaResult.status >= 300) {
      throw new WhatsAppAppError(
        'WHATSAPP_META_API_ERROR',
        502,
        'WhatsApp provider temporarily unavailable'
      );
    }

    if (!wabaResult.body || typeof wabaResult.body !== 'object') {
      throw new WhatsAppAppError(
        'WHATSAPP_META_API_ERROR',
        502,
        'WhatsApp provider temporarily unavailable'
      );
    }

    const wabaBody = wabaResult.body as {
      data?: unknown;
      paging?: { cursors?: { after?: unknown }; next?: unknown };
    };

    const list = Array.isArray(wabaBody.data) ? wabaBody.data : null;
    if (!list) {
      throw new WhatsAppAppError(
        'WHATSAPP_META_API_ERROR',
        502,
        'WhatsApp provider temporarily unavailable'
      );
    }

    const belongs = list.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const id = asNonBlankString((entry as { id?: unknown }).id);
      return id === phoneNumberId;
    });

    if (belongs) {
      return;
    }

    const nextCursor = asNonBlankString(wabaBody.paging?.cursors?.after);
    // No further page, or cursor did not advance — stop (never follow paging.next).
    if (!nextCursor || nextCursor === afterCursor) {
      break;
    }
    afterCursor = nextCursor;
  }

  throw new WhatsAppAppError(
    'WHATSAPP_WABA_MISMATCH',
    400,
    'Phone number does not belong to this business account'
  );
}
