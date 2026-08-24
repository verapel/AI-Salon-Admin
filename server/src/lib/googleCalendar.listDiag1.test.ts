/**
 * GOOGLE-CALENDAR-LIST-DIAG-1: Safe Google token/calendarList error diagnostics.
 * All Google HTTP mocked. No real OAuth / Calendar API calls. No secrets in logs.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  GoogleCalendarOAuthError,
  listGoogleCalendars,
  refreshGoogleAccessToken,
} from './googleCalendarOAuth.js';

const LEAK_ACCESS_TOKEN = 'ya29.leak-access-token';
const LEAK_REFRESH_TOKEN = '1//leak-refresh-token';
const LEAK_CLIENT_SECRET = 'GOCSPX-leak-client-secret';

const BANNED_LOG_KEYS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'Authorization',
  'authorization',
  'accessToken',
  'refreshToken',
  'clientSecret',
];

const TOKEN_LOG_KEYS = [
  'googleError',
  'googleErrorDescription',
  'googleHttpStatus',
  'operation',
];

const CALENDAR_LIST_LOG_KEYS = [
  'googleErrorCode',
  'googleErrorMessage',
  'googleErrorStatus',
  'googleHttpStatus',
  'googleReason',
  'operation',
];

const originalConsoleError = console.error;
let capturedLogs: unknown[][] = [];

function installLogCapture() {
  capturedLogs = [];
  console.error = (...args: unknown[]) => {
    capturedLogs.push(args);
  };
}

afterEach(() => {
  console.error = originalConsoleError;
  capturedLogs = [];
});

function findLogWithOperation(operation: string): Record<string, unknown> {
  for (const args of capturedLogs) {
    for (const arg of args) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        const row = arg as Record<string, unknown>;
        if (row.operation === operation) return row;
      }
    }
  }
  assert.fail(`expected console.error payload with operation=${operation}`);
}

function assertNoSecretsInLogs() {
  const serialized = JSON.stringify(capturedLogs);
  assert.equal(serialized.includes(LEAK_ACCESS_TOKEN), false);
  assert.equal(serialized.includes(LEAK_REFRESH_TOKEN), false);
  assert.equal(serialized.includes(LEAK_CLIENT_SECRET), false);
  assert.equal(serialized.includes('Bearer '), false);
  for (const args of capturedLogs) {
    for (const arg of args) {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const keys = Object.keys(arg);
      for (const banned of BANNED_LOG_KEYS) {
        assert.equal(keys.includes(banned), false, `logged banned key ${banned}`);
      }
    }
  }
}

describe('GOOGLE-CALENDAR-LIST-DIAG-1 safe error diagnostics', () => {
  it('token endpoint 400 logs only safe fields and keeps GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED', async () => {
    installLogCapture();
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
          access_token: LEAK_ACCESS_TOKEN,
          refresh_token: LEAK_REFRESH_TOKEN,
        }),
        { status: 400 },
      );

    await assert.rejects(
      () =>
        refreshGoogleAccessToken({
          refreshToken: LEAK_REFRESH_TOKEN,
          clientId: 'test-client-id',
          clientSecret: LEAK_CLIENT_SECRET,
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthError &&
        err.code === 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED' &&
        err.message === 'Token request failed',
    );

    const payload = findLogWithOperation('google_oauth_token_refresh');
    assert.deepEqual(Object.keys(payload).sort(), [...TOKEN_LOG_KEYS].sort());
    assert.equal(payload.operation, 'google_oauth_token_refresh');
    assert.equal(payload.googleHttpStatus, 400);
    assert.equal(payload.googleError, 'invalid_grant');
    assert.equal(payload.googleErrorDescription, 'Token has been expired or revoked.');
    assert.equal(capturedLogs.length, 1);
    assert.equal(capturedLogs[0]?.length, 1);
    assertNoSecretsInLogs();
  });

  it('calendarList 403 logs only safe fields and keeps GOOGLE_CALENDAR_LIST_FAILED', async () => {
    installLogCapture();
    const fetchImpl: typeof fetch = async (_input, init) => {
      const auth = init && typeof init === 'object' ? (init as RequestInit).headers : undefined;
      assert.ok(auth);
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Google Calendar API has not been used in project 123 before or it is disabled.',
            status: 'PERMISSION_DENIED',
            errors: [
              {
                reason: 'accessNotConfigured',
                message: 'Access Not Configured',
              },
            ],
          },
          access_token: LEAK_ACCESS_TOKEN,
        }),
        { status: 403 },
      );
    };

    await assert.rejects(
      () =>
        listGoogleCalendars({
          accessToken: LEAK_ACCESS_TOKEN,
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof GoogleCalendarOAuthError &&
        err.code === 'GOOGLE_CALENDAR_LIST_FAILED' &&
        err.message === 'Calendar list request failed',
    );

    const payload = findLogWithOperation('google_calendar_list');
    assert.deepEqual(Object.keys(payload).sort(), [...CALENDAR_LIST_LOG_KEYS].sort());
    assert.equal(payload.operation, 'google_calendar_list');
    assert.equal(payload.googleHttpStatus, 403);
    assert.equal(payload.googleErrorCode, 403);
    assert.equal(payload.googleErrorStatus, 'PERMISSION_DENIED');
    assert.equal(
      payload.googleErrorMessage,
      'Google Calendar API has not been used in project 123 before or it is disabled.',
    );
    assert.equal(payload.googleReason, 'accessNotConfigured');
    assert.equal(capturedLogs.length, 1);
    assert.equal(capturedLogs[0]?.length, 1);
    assertNoSecretsInLogs();
  });

  it('success token refresh and calendar list are unchanged and do not emit diagnostics', async () => {
    installLogCapture();
    const tokenFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: 'ya29.ok-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    const refreshed = await refreshGoogleAccessToken({
      refreshToken: 'rt-ok',
      clientId: 'test-client-id',
      clientSecret: 'ok-secret',
      fetchImpl: tokenFetch,
    });
    assert.equal(refreshed.accessToken, 'ya29.ok-access-token');
    assert.equal(refreshed.expiresIn, 3600);

    const listFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          items: [{ id: 'primary', summary: 'Work', primary: true, accessRole: 'owner' }],
        }),
        { status: 200 },
      );
    const calendars = await listGoogleCalendars({
      accessToken: 'ya29.ok-access-token',
      fetchImpl: listFetch,
    });
    assert.equal(calendars.length, 1);
    assert.equal(calendars[0]?.id, 'primary');
    assert.equal(calendars[0]?.summary, 'Work');
    assert.equal(calendars[0]?.primary, true);

    const operations = capturedLogs.flat().flatMap((arg) => {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        const op = (arg as Record<string, unknown>).operation;
        return typeof op === 'string' ? [op] : [];
      }
      return [];
    });
    assert.equal(operations.includes('google_oauth_token_refresh'), false);
    assert.equal(operations.includes('google_calendar_list'), false);
  });
});
