/**
 * IG-3 / IG-3A / IG-3B: Instagram webhook + durable receipt foundation tests (mocks/fixtures only).
 * No real Meta. No SQL execution. No credentials.
 *
 * IG-3A: postback without mid → unsupported, no synthetic id / no receipt claim.
 * Object must equal exact "instagram" (fail closed). Wrong/missing object → HTTP 200, no receipt.
 * Malformed signed JSON → HTTP 200 ignored (WA anti-retry-storm parity).
 * IG-3B: no stable Meta mid → no durable receipt (no ig_malformed synthetic IDs).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import {
  instagramReceiptPayloadHash,
  normalizeInstagramWebhookPayload,
  tryParseInstagramWebhookOpaqueId,
} from './instagramWebhookEvents.js';
import {
  classifyExistingReceiptForClaim,
  RECEIPT_PROCESSING_STALE_MS,
} from './whatsappWebhookReceipts.js';
import {
  claimInstagramEventReceipt,
  finalizeInstagramEventReceipt,
  INSTAGRAM_RECEIPT_PROVIDER,
  markInstagramEventReceiptFailed,
} from './instagramWebhookReceipts.js';
import { resolveInstagramProfessionalAccountRoute } from './instagramWebhookRouting.js';
import {
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from './instagramWebhookProcess.js';
import {
  computeInstagramHubSignatureHex,
  parseHubSignature256,
  timingSafeEqualUtf8,
  verifyInstagramHubSignature,
} from './instagramWebhookSignature.js';
import instagramWebhookRouter, {
  setInstagramWebhookProcessDepsForTests,
} from '../routes/instagramWebhook.js';

const LARGE_IG_ID = '17841400000000001';
const LARGE_SENDER = '17841400000000099';

const ENV_KEYS = [
  'INSTAGRAM_WEBHOOK_VERIFY_TOKEN',
  'INSTAGRAM_APP_SECRET',
] as const;

const previousEnv: Record<string, string | undefined> = {};

const noopApplyIdentityConversation: InstagramProcessDeps['applyIdentityConversation'] =
  async () => ({
    kind: 'ok',
    identityId: 'id-noop',
    conversationId: 'conv-noop',
    clientId: null,
    advanced: true,
    identityCreated: false,
    conversationCreated: false,
  });


beforeEach(() => {
  for (const key of ENV_KEYS) {
    previousEnv[key] = process.env[key];
  }
  process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'ig-verify-token-test';
  process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret-test';
  setInstagramWebhookProcessDepsForTests(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  setInstagramWebhookProcessDepsForTests(null);
});

function signBody(raw: Buffer, secret = process.env.INSTAGRAM_APP_SECRET!): string {
  return `sha256=${computeInstagramHubSignatureHex(secret, raw)}`;
}

function messagePayload(opts: {
  professionalId?: string;
  senderId?: string;
  mid?: string;
  text?: string;
  isEcho?: boolean;
  numericProfessional?: boolean;
  numericSender?: boolean;
}): unknown {
  const professionalId = opts.professionalId ?? LARGE_IG_ID;
  const senderId = opts.senderId ?? LARGE_SENDER;
  return {
    object: 'instagram',
    entry: [
      {
        id: opts.numericProfessional ? Number(professionalId) : professionalId,
        time: 1_500_000_000_000,
        messaging: [
          {
            sender: { id: opts.numericSender ? Number(senderId) : senderId },
            recipient: { id: professionalId },
            timestamp: 1_500_000_000_001,
            message: {
              mid: opts.mid ?? 'mid.ig.test.1',
              text: opts.text ?? 'hello secret text',
              ...(opts.isEcho ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  };
}

async function withApp(
  handler: (port: number, base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/webhooks/instagram', instagramWebhookRouter);
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${addr.port}/api/webhooks/instagram`;
  try {
    await handler(addr.port, base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('IG-3 GET verification (executed)', () => {
  it('1. valid token/challenge returns challenge', async () => {
    await withApp(async (_p, base) => {
      const url = `${base}?hub.mode=subscribe&hub.verify_token=ig-verify-token-test&hub.challenge=12345`;
      const res = await fetch(url);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '12345');
    });
  });

  it('2/3. wrong or missing verify token rejected', async () => {
    await withApp(async (_p, base) => {
      const wrong = await fetch(
        `${base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
      );
      assert.equal(wrong.status, 403);
      const missing = await fetch(`${base}?hub.mode=subscribe&hub.challenge=1`);
      assert.equal(missing.status, 403);
    });
  });

  it('4. invalid mode / missing challenge rejected', async () => {
    await withApp(async (_p, base) => {
      const mode = await fetch(
        `${base}?hub.mode=unsubscribe&hub.verify_token=ig-verify-token-test&hub.challenge=1`,
      );
      assert.equal(mode.status, 403);
      const challenge = await fetch(
        `${base}?hub.mode=subscribe&hub.verify_token=ig-verify-token-test`,
      );
      assert.equal(challenge.status, 403);
    });
  });

  it('IG-3A: unequal-length verify token rejects safely (no throw)', async () => {
    await withApp(async (_p, base) => {
      const short = await fetch(
        `${base}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`,
      );
      assert.equal(short.status, 403);
      const longer = await fetch(
        `${base}?hub.mode=subscribe&hub.verify_token=ig-verify-token-test-EXTRA&hub.challenge=1`,
      );
      assert.equal(longer.status, 403);
      assert.equal(timingSafeEqualUtf8('short', 'ig-verify-token-test'), false);
    });
  });
});

describe('IG-3 POST signature (executed)', () => {
  it('5. valid signature accepted (with mocked process)', async () => {
    setInstagramWebhookProcessDepsForTests({
      route: async () => ({
        kind: 'connected',
        salonId: 'salon-1',
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async () => ({ kind: 'claimed', receiptId: 'r1', attemptCount: 1 }),
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    });
    await withApp(async (_p, base) => {
      const body = Buffer.from(JSON.stringify(messagePayload({})), 'utf8');
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody(body),
        },
        body,
      });
      assert.equal(res.status, 200);
    });
  });

  it('6/7/8. invalid/missing/tampered signature rejected before DB', async () => {
    let claimCalled = 0;
    setInstagramWebhookProcessDepsForTests({
      route: async () => {
        throw new Error('should not route');
      },
      claim: async () => {
        claimCalled += 1;
        return { kind: 'claimed', receiptId: 'r', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    });
    await withApp(async (_p, base) => {
      const body = Buffer.from(JSON.stringify(messagePayload({})), 'utf8');
      const bad = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': 'sha256=' + 'ab'.repeat(32),
        },
        body,
      });
      assert.equal(bad.status, 401);

      const missing = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(missing.status, 401);

      const tampered = Buffer.from(body.toString('utf8').replace('hello', 'HELLO'), 'utf8');
      const tamperedRes = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody(body),
        },
        body: tampered,
      });
      assert.equal(tamperedRes.status, 401);
      assert.equal(claimCalled, 0);
    });
  });

  it('9/10. signature compare safe; no secret/body in signature helpers', () => {
    const raw = Buffer.from('{"object":"instagram"}', 'utf8');
    assert.equal(
      verifyInstagramHubSignature({
        appSecret: 'secret',
        rawBody: raw,
        signatureHeader: signBody(raw, 'secret'),
      }),
      true,
    );
    assert.equal(timingSafeEqualUtf8('a', 'b'), false);
    assert.equal(parseHubSignature256('sha256=nothex'), null);
    const sigSrc = readFileSync(new URL('./instagramWebhookSignature.ts', import.meta.url), 'utf8');
    const routeSrc = readFileSync(
      new URL('../routes/instagramWebhook.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(sigSrc, /console\.(log|error|warn)\([^)]*appSecret/);
    assert.doesNotMatch(routeSrc, /console\.(log|error|warn)\([^)]*req\.body/);
    assert.doesNotMatch(routeSrc, /console\.(log|error|warn)\([^)]*signatureHeader/);
  });

  it('IG-3A: bad signature prefix + malformed hex reject safely (no DB)', async () => {
    let claimCalled = 0;
    setInstagramWebhookProcessDepsForTests({
      route: async () => {
        throw new Error('should not route');
      },
      claim: async () => {
        claimCalled += 1;
        return { kind: 'claimed', receiptId: 'r', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    });
    assert.equal(parseHubSignature256('sha1=' + 'ab'.repeat(32)), null);
    assert.equal(parseHubSignature256('sha256=' + 'gg'.repeat(32)), null);
    assert.equal(parseHubSignature256('sha256='), null);
    assert.equal(
      verifyInstagramHubSignature({
        appSecret: 'secret',
        rawBody: Buffer.from('{}'),
        signatureHeader: 'md5=deadbeef',
      }),
      false,
    );
    await withApp(async (_p, base) => {
      const body = Buffer.from(JSON.stringify(messagePayload({})), 'utf8');
      const badPrefix = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': 'sha1=' + 'ab'.repeat(32),
        },
        body,
      });
      assert.equal(badPrefix.status, 401);
      const badHex = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': 'sha256=' + 'zz'.repeat(32),
        },
        body,
      });
      assert.equal(badHex.status, 401);
      assert.equal(claimCalled, 0);
    });
  });

  it('IG-3A: malformed signed JSON → HTTP 200 ignored (anti-retry parity)', async () => {
    let claimCalled = 0;
    setInstagramWebhookProcessDepsForTests({
      route: async () => {
        throw new Error('should not route');
      },
      claim: async () => {
        claimCalled += 1;
        return { kind: 'claimed', receiptId: 'r', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    });
    await withApp(async (_p, base) => {
      const body = Buffer.from('{not-json', 'utf8');
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody(body),
        },
        body,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ignored' });
      assert.equal(claimCalled, 0);
    });
  });
});

describe('IG-3 opaque IDs + normalization (executed)', () => {
  it('17/18/19/20. large string IDs preserved; numeric IDs rejected', () => {
    assert.equal(tryParseInstagramWebhookOpaqueId(LARGE_IG_ID), LARGE_IG_ID);
    assert.equal(tryParseInstagramWebhookOpaqueId(Number(LARGE_IG_ID)), null);
    assert.equal(tryParseInstagramWebhookOpaqueId(null), null);

    const ok = normalizeInstagramWebhookPayload(messagePayload({}));
    assert.equal(ok.length, 1);
    assert.equal(ok[0].professionalAccountId, LARGE_IG_ID);
    assert.equal(ok[0].externalUserId, LARGE_SENDER);
    assert.equal(ok[0].externalEventId, 'mid.ig.test.1');
    assert.equal(ok[0].kind, 'message');
    assert.equal(ok[0].receiptMetadata.hasText, '1');
    assert.ok(!JSON.stringify(ok[0].receiptMetadata).includes('hello'));
    assert.equal(ok[0].inboundText, 'hello secret text');

    const numericProf = normalizeInstagramWebhookPayload(
      messagePayload({ numericProfessional: true }),
    );
    assert.equal(numericProf[0].kind, 'malformed');
    assert.equal(numericProf[0].receiptMetadata.reason, 'numeric_identity');

    const numericSender = normalizeInstagramWebhookPayload(
      messagePayload({ numericSender: true }),
    );
    assert.equal(numericSender[0].kind, 'malformed');
  });

  it('postback + unsupported echo + privacy metadata', () => {
    const postbackPayload = {
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              postback: { mid: 'mid.post.1', title: 'Start', payload: 'GET_STARTED' },
            },
          ],
        },
      ],
    };
    const pb = normalizeInstagramWebhookPayload(postbackPayload);
    assert.equal(pb[0].kind, 'postback');
    assert.equal(pb[0].externalEventId, 'mid.post.1');
    assert.ok(!JSON.stringify(pb[0].receiptMetadata).includes('GET_STARTED'));
    assert.ok(!JSON.stringify(pb[0].receiptMetadata).includes('Start'));
    assert.equal(pb[0].inboundPostbackPayload, 'GET_STARTED');

    const echo = normalizeInstagramWebhookPayload(messagePayload({ isEcho: true }));
    assert.equal(echo[0].kind, 'unsupported');
    assert.equal(echo[0].isEcho, true);
  });
});

describe('IG-3A postback identity + object contract (executed)', () => {
  function postbackPayload(opts: {
    mid?: string | null;
    title?: string;
    payload?: string;
    object?: unknown;
    omitObject?: boolean;
  }): Record<string, unknown> {
    const root: Record<string, unknown> = {
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1_700_000_000_000,
              postback: {
                ...(opts.mid === null
                  ? {}
                  : { mid: opts.mid ?? 'mid.post.stable' }),
                title: opts.title ?? 'Book now',
                payload: opts.payload ?? 'BOOK_FLOW',
              },
            },
          ],
        },
      ],
    };
    if (!opts.omitObject) {
      root.object = opts.object === undefined ? 'instagram' : opts.object;
    }
    return root;
  }

  it('1. postback with valid mid → kind postback, externalEventId exact mid', () => {
    const events = normalizeInstagramWebhookPayload(
      postbackPayload({ mid: 'mid.exact.meta.42' }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'postback');
    assert.equal(events[0].externalEventId, 'mid.exact.meta.42');
    assert.equal(events[0].externalMessageId, 'mid.exact.meta.42');
  });

  it('2. retry same postback mid → duplicate_terminal', async () => {
    const claims: string[] = [];
    let claimN = 0;
    const deps: InstagramProcessDeps = {
      route: async () => ({
        kind: 'connected',
        salonId: 'salon-1',
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async (input) => {
        claims.push(input.externalEventId);
        claimN += 1;
        if (claimN === 1) {
          return { kind: 'claimed', receiptId: 'r-pb', attemptCount: 1 };
        }
        return { kind: 'duplicate_terminal', status: 'processed' };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };
    const event = normalizeInstagramWebhookPayload(
      postbackPayload({ mid: 'mid.retry.same' }),
    )[0];
    const first = await processInstagramWebhookEvent(event, deps);
    const second = await processInstagramWebhookEvent(event, deps);
    assert.equal(first.outcome, 'processed');
    assert.equal(second.outcome, 'duplicate_terminal');
    assert.deepEqual(claims, ['mid.retry.same', 'mid.retry.same']);
  });

  it('3/4/5. postback without mid → unsupported, no synthetic id, no receipt claim', async () => {
    const a = normalizeInstagramWebhookPayload(postbackPayload({ mid: null }));
    const b = normalizeInstagramWebhookPayload(
      postbackPayload({ mid: null, payload: 'OTHER_BUTTON', title: 'Other' }),
    );
    assert.equal(a[0].kind, 'unsupported');
    assert.equal(a[0].receiptMetadata.reason, 'postback_missing_mid');
    assert.equal(a[0].externalEventId, '');
    assert.equal(b[0].kind, 'unsupported');
    assert.equal(b[0].externalEventId, '');
    assert.ok(!a[0].externalEventId.startsWith('ig_unsupported:'));
    assert.ok(!b[0].externalEventId.startsWith('ig_unsupported:'));
    assert.notEqual(a[0].externalEventId, 'ig_unsupported:anything');

    let claimCalled = 0;
    let routeCalled = 0;
    const deps: InstagramProcessDeps = {
      route: async () => {
        routeCalled += 1;
        return {
          kind: 'connected',
          salonId: 'salon-1',
          professionalAccountId: LARGE_IG_ID,
        };
      },
      claim: async () => {
        claimCalled += 1;
        return { kind: 'claimed', receiptId: 'should-not', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'ignored' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };
    const ra = await processInstagramWebhookEvent(a[0], deps);
    const rb = await processInstagramWebhookEvent(b[0], deps);
    assert.equal(ra.outcome, 'ignored');
    assert.equal(rb.outcome, 'ignored');
    assert.equal(claimCalled, 0);
    assert.equal(routeCalled, 0);
  });

  it('6. postback payload/title not stored in receipt metadata', async () => {
    const events = normalizeInstagramWebhookPayload(
      postbackPayload({
        mid: 'mid.priv.pb',
        title: 'SECRET_TITLE',
        payload: 'SECRET_PAYLOAD',
      }),
    );
    const meta = JSON.stringify(events[0].receiptMetadata);
    assert.ok(!meta.includes('SECRET_TITLE'));
    assert.ok(!meta.includes('SECRET_PAYLOAD'));
    assert.ok(!('payload' in events[0].receiptMetadata));
    assert.ok(!('title' in events[0].receiptMetadata));

    let storedMeta: Record<string, string> | null = null;
    await processInstagramWebhookEvent(events[0], {
      route: async () => ({
        kind: 'connected',
        salonId: 'salon-1',
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async (input) => {
        storedMeta = input.metadata;
        return { kind: 'claimed', receiptId: 'r', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    });
    assert.ok(storedMeta);
    const blob = JSON.stringify(storedMeta);
    assert.ok(!blob.includes('SECRET_TITLE'));
    assert.ok(!blob.includes('SECRET_PAYLOAD'));
  });

  it('7. object=instagram accepted; missing/null/empty/page/non-string ignored', () => {
    assert.equal(
      normalizeInstagramWebhookPayload(postbackPayload({ object: 'instagram' })).length,
      1,
    );
    assert.deepEqual(normalizeInstagramWebhookPayload(postbackPayload({ omitObject: true })), []);
    assert.deepEqual(normalizeInstagramWebhookPayload(postbackPayload({ object: null })), []);
    assert.deepEqual(normalizeInstagramWebhookPayload(postbackPayload({ object: '' })), []);
    assert.deepEqual(normalizeInstagramWebhookPayload(postbackPayload({ object: 'page' })), []);
    assert.deepEqual(normalizeInstagramWebhookPayload(postbackPayload({ object: 1 })), []);
    assert.deepEqual(normalizeInstagramWebhookPayload(postbackPayload({ object: { x: 1 } })), []);
    assert.deepEqual(normalizeInstagramWebhookPayload(postbackPayload({ object: ['instagram'] })), []);
  });

  it('8. signed payload with messaging but no object → HTTP 200, no receipt', async () => {
    let claimCalled = 0;
    setInstagramWebhookProcessDepsForTests({
      route: async () => {
        throw new Error('should not route');
      },
      claim: async () => {
        claimCalled += 1;
        return { kind: 'claimed', receiptId: 'r', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    });
    await withApp(async (_p, base) => {
      const body = Buffer.from(
        JSON.stringify(postbackPayload({ omitObject: true, mid: 'mid.orphan' })),
        'utf8',
      );
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody(body),
        },
        body,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
      assert.equal(claimCalled, 0);
    });
  });

  it('9. wrong object page → HTTP 200, no receipt (no retry storm)', async () => {
    let claimCalled = 0;
    setInstagramWebhookProcessDepsForTests({
      route: async () => {
        throw new Error('should not route');
      },
      claim: async () => {
        claimCalled += 1;
        return { kind: 'claimed', receiptId: 'r', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    });
    await withApp(async (_p, base) => {
      const body = Buffer.from(
        JSON.stringify(postbackPayload({ object: 'page', mid: 'mid.page' })),
        'utf8',
      );
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody(body),
        },
        body,
      });
      assert.equal(res.status, 200);
      assert.equal(claimCalled, 0);
    });
  });

  it('10. valid message + postback-without-mid multi-event isolation', async () => {
    const claims: string[] = [];
    const deps: InstagramProcessDeps = {
      route: async () => ({
        kind: 'connected',
        salonId: 'salon-1',
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async (input) => {
        claims.push(input.externalEventId);
        return { kind: 'claimed', receiptId: `r-${input.externalEventId}`, attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { mid: 'mid.valid.msg', text: 'hi' },
            },
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 2,
              postback: { title: 'X', payload: 'Y' },
            },
          ],
        },
      ],
    };
    const events = normalizeInstagramWebhookPayload(payload);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'message');
    assert.equal(events[0].externalEventId, 'mid.valid.msg');
    assert.equal(events[1].kind, 'unsupported');
    assert.equal(events[1].externalEventId, '');
    assert.ok(!JSON.stringify(events).includes('ig_unsupported:'));

    const r0 = await processInstagramWebhookEvent(events[0], deps);
    const r1 = await processInstagramWebhookEvent(events[1], deps);
    assert.equal(r0.outcome, 'processed');
    assert.equal(r1.outcome, 'ignored');
    assert.deepEqual(claims, ['mid.valid.msg']);
  });

  it('static: no ig_unsupported synthetic id helper remains', () => {
    const eventsSrc = readFileSync(
      new URL('./instagramWebhookEvents.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(eventsSrc, /ig_unsupported:/);
    assert.doesNotMatch(eventsSrc, /unsupportedEventId/);
  });
});

describe('IG-3B no-id malformed → no receipt (executed)', () => {
  function connectedDeps(track: { route: number; claim: number }): InstagramProcessDeps {
    return {
      route: async () => {
        track.route += 1;
        return {
          kind: 'connected',
          salonId: 'salon-1',
          professionalAccountId: LARGE_IG_ID,
        };
      },
      claim: async () => {
        track.claim += 1;
        return { kind: 'claimed', receiptId: 'should-not', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'ignored' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };
  }

  async function assertNoRouteNoClaim(payload: unknown, reason: string): Promise<void> {
    const events = normalizeInstagramWebhookPayload(payload);
    assert.ok(events.length >= 1);
    assert.equal(events[0].externalEventId, '');
    assert.ok(!events[0].externalEventId.startsWith('ig_malformed:'));
    const track = { route: 0, claim: 0 };
    const result = await processInstagramWebhookEvent(events[0], connectedDeps(track));
    assert.equal(result.outcome, 'ignored');
    if (result.outcome === 'ignored') {
      assert.equal(result.reason, reason);
    }
    assert.equal(track.route, 0);
    assert.equal(track.claim, 0);
  }

  it('1. message_no_mid → no route, no claim', async () => {
    await assertNoRouteNoClaim(
      {
        object: 'instagram',
        entry: [
          {
            id: LARGE_IG_ID,
            messaging: [
              {
                sender: { id: LARGE_SENDER },
                recipient: { id: LARGE_IG_ID },
                timestamp: 1,
                message: { text: 'no mid here' },
              },
            ],
          },
        ],
      },
      'missing_mid',
    );
  });

  it('2. bad_messaging_item → no route, no claim', async () => {
    await assertNoRouteNoClaim(
      {
        object: 'instagram',
        entry: [{ id: LARGE_IG_ID, messaging: [null] }],
      },
      'bad_messaging_item',
    );
  });

  it('3. bad_entry → no route, no claim', async () => {
    await assertNoRouteNoClaim(
      { object: 'instagram', entry: [null] },
      'bad_entry',
    );
  });

  it('4. numeric identity → no route, no claim', async () => {
    await assertNoRouteNoClaim(
      messagePayload({ numericSender: true }),
      'numeric_identity',
    );
  });

  it('5. postback_missing_mid → no route, no claim', async () => {
    await assertNoRouteNoClaim(
      {
        object: 'instagram',
        entry: [
          {
            id: LARGE_IG_ID,
            messaging: [
              {
                sender: { id: LARGE_SENDER },
                recipient: { id: LARGE_IG_ID },
                timestamp: 1,
                postback: { title: 'X', payload: 'Y' },
              },
            ],
          },
        ],
      },
      'postback_missing_mid',
    );
  });

  it('6/7. no ig_malformed / no index-proId synthetic IDs; collision case neither claims', async () => {
    const eventsSrc = readFileSync(
      new URL('./instagramWebhookEvents.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(eventsSrc, /ig_malformed:/);
    assert.doesNotMatch(eventsSrc, /malformedEventId/);
    assert.doesNotMatch(eventsSrc, /ig_unsupported:/);

    const a = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { text: 'CONTENT_A_SECRET' },
            },
          ],
        },
      ],
    });
    const b = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { text: 'CONTENT_B_DIFFERENT' },
            },
          ],
        },
      ],
    });
    assert.equal(a[0].kind, 'malformed');
    assert.equal(b[0].kind, 'malformed');
    assert.equal(a[0].externalEventId, '');
    assert.equal(b[0].externalEventId, '');
    assert.ok(!JSON.stringify(a).includes('CONTENT_A_SECRET'));
    assert.ok(!JSON.stringify(b).includes('CONTENT_B_DIFFERENT'));

    const track = { route: 0, claim: 0 };
    const deps = connectedDeps(track);
    const ra = await processInstagramWebhookEvent(a[0], deps);
    const rb = await processInstagramWebhookEvent(b[0], deps);
    assert.equal(ra.outcome, 'ignored');
    assert.equal(rb.outcome, 'ignored');
    assert.equal(track.route, 0);
    assert.equal(track.claim, 0);
  });

  it('valid message/postback mid still route+claim; echo with mid claims ignored', async () => {
    const claims: string[] = [];
    const deps: InstagramProcessDeps = {
      route: async () => ({
        kind: 'connected',
        salonId: 'salon-1',
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async (input) => {
        claims.push(`${input.eventType}:${input.externalEventId}`);
        return { kind: 'claimed', receiptId: `r-${input.externalEventId}`, attemptCount: 1 };
      },
      finalize: async ({ finalStatus }) => ({ ok: true, status: finalStatus }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };

    const msg = normalizeInstagramWebhookPayload(
      messagePayload({ mid: 'mid.valid.keep', text: 'hi' }),
    )[0];
    const pb = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              postback: { mid: 'mid.pb.keep', title: 'T', payload: 'P' },
            },
          ],
        },
      ],
    })[0];
    const echo = normalizeInstagramWebhookPayload(
      messagePayload({ mid: 'mid.echo.keep', isEcho: true }),
    )[0];

    assert.equal((await processInstagramWebhookEvent(msg, deps)).outcome, 'processed');
    assert.equal((await processInstagramWebhookEvent(pb, deps)).outcome, 'processed');
    assert.equal((await processInstagramWebhookEvent(echo, deps)).outcome, 'ignored');
    assert.deepEqual(claims, [
      'instagram.message:mid.valid.keep',
      'instagram.postback:mid.pb.keep',
      'instagram.unsupported:mid.echo.keep',
    ]);
  });

  it('multi-event: valid mid + message_no_mid + postback_missing_mid isolation', async () => {
    const claims: string[] = [];
    const routes: number[] = [];
    const deps: InstagramProcessDeps = {
      route: async () => {
        routes.push(1);
        return {
          kind: 'connected',
          salonId: 'salon-1',
          professionalAccountId: LARGE_IG_ID,
        };
      },
      claim: async (input) => {
        claims.push(input.externalEventId);
        return { kind: 'claimed', receiptId: `r-${input.externalEventId}`, attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { mid: 'mid.multi.ok', text: 'ok' },
            },
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 2,
              message: { text: 'missing mid' },
            },
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 3,
              postback: { title: 'X', payload: 'Y' },
            },
          ],
        },
      ],
    };
    const events = normalizeInstagramWebhookPayload(payload);
    assert.equal(events.length, 3);
    assert.equal(events[0].externalEventId, 'mid.multi.ok');
    assert.equal(events[1].externalEventId, '');
    assert.equal(events[2].externalEventId, '');
    assert.ok(!JSON.stringify(events).includes('ig_malformed:'));

    const results = [];
    for (const event of events) {
      results.push(await processInstagramWebhookEvent(event, deps));
    }
    assert.equal(results[0].outcome, 'processed');
    assert.equal(results[1].outcome, 'ignored');
    assert.equal(results[2].outcome, 'ignored');
    assert.deepEqual(claims, ['mid.multi.ok']);
    assert.equal(routes.length, 1);
  });

  it('payload_hash helper only hashes externalEventId string (not content)', () => {
    const hash = instagramReceiptPayloadHash('mid.only');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, instagramReceiptPayloadHash('mid.other'));
    const processSrc = readFileSync(
      new URL('./instagramWebhookProcess.ts', import.meta.url),
      'utf8',
    );
    assert.match(processSrc, /instagramReceiptPayloadHash\(event\.externalEventId\)/);
    assert.doesNotMatch(processSrc, /instagramReceiptPayloadHash\([^)]*text/);
    assert.doesNotMatch(processSrc, /instagramReceiptPayloadHash\([^)]*payload/);
  });
});

describe('IG-3 routing (executed mocks)', () => {
  it('11/13/14/15. connected routes; unknown/disconnected/inactive ignored', async () => {
    const connected = await resolveInstagramProfessionalAccountRoute(LARGE_IG_ID, {
      findConnectionByProfessionalId: async () => ({
        ok: true,
        row: { salon_id: 'salon-a', status: 'connected' },
      }),
      findSalonActive: async () => ({ ok: true, active: true }),
      findTokenTripleStored: async () => ({ ok: true, stored: true }),
    });
    assert.deepEqual(connected, {
      kind: 'connected',
      salonId: 'salon-a',
      professionalAccountId: LARGE_IG_ID,
    });

    const unknown = await resolveInstagramProfessionalAccountRoute(LARGE_IG_ID, {
      findConnectionByProfessionalId: async () => ({ ok: true, row: null }),
      findSalonActive: async () => ({ ok: true, active: true }),
      findTokenTripleStored: async () => ({ ok: true, stored: true }),
    });
    assert.equal(unknown.kind, 'unknown');

    const disconnected = await resolveInstagramProfessionalAccountRoute(LARGE_IG_ID, {
      findConnectionByProfessionalId: async () => ({
        ok: true,
        row: { salon_id: 'salon-a', status: 'not_connected' },
      }),
      findSalonActive: async () => ({ ok: true, active: true }),
      findTokenTripleStored: async () => ({ ok: true, stored: true }),
    });
    assert.equal(disconnected.kind, 'disconnected');

    const inactive = await resolveInstagramProfessionalAccountRoute(LARGE_IG_ID, {
      findConnectionByProfessionalId: async () => ({
        ok: true,
        row: { salon_id: 'salon-a', status: 'connected' },
      }),
      findSalonActive: async () => ({ ok: true, active: false }),
      findTokenTripleStored: async () => ({ ok: true, stored: true }),
    });
    assert.equal(inactive.kind, 'disconnected');
    if (inactive.kind === 'disconnected') {
      assert.equal(inactive.reason, 'inactive_salon');
    }
  });

  it('12/16. username cannot route; two salons independent', async () => {
    let queriedId = '';
    await resolveInstagramProfessionalAccountRoute(LARGE_IG_ID, {
      findConnectionByProfessionalId: async (id) => {
        queriedId = id;
        return { ok: true, row: { salon_id: 'salon-a', status: 'connected' } };
      },
      findSalonActive: async () => ({ ok: true, active: true }),
      findTokenTripleStored: async () => ({ ok: true, stored: true }),
    });
    assert.equal(queriedId, LARGE_IG_ID);
    assert.notEqual(queriedId, 'salon_demo');

    const a = await resolveInstagramProfessionalAccountRoute(LARGE_IG_ID, {
      findConnectionByProfessionalId: async () => ({
        ok: true,
        row: { salon_id: 'salon-a', status: 'connected' },
      }),
      findSalonActive: async () => ({ ok: true, active: true }),
      findTokenTripleStored: async () => ({ ok: true, stored: true }),
    });
    const b = await resolveInstagramProfessionalAccountRoute('17841400000000002', {
      findConnectionByProfessionalId: async () => ({
        ok: true,
        row: { salon_id: 'salon-b', status: 'connected' },
      }),
      findSalonActive: async () => ({ ok: true, active: true }),
      findTokenTripleStored: async () => ({ ok: true, stored: true }),
    });
    assert.equal(a.kind === 'connected' && a.salonId, 'salon-a');
    assert.equal(b.kind === 'connected' && b.salonId, 'salon-b');
  });
});

describe('IG-3 receipts (executed mocks)', () => {
  type Row = {
    id: string;
    salon_id: string;
    provider: string;
    external_event_id: string;
    processing_status: string;
    attempt_count: number;
    updated_at: string;
    metadata: Record<string, string>;
    last_error: string | null;
  };

  function mockDb(rows: Row[]) {
    return {
      from(_table: string) {
        const api: any = {
          _filters: {} as Record<string, unknown>,
          _update: null as Record<string, unknown> | null,
          insert(values: Record<string, unknown>) {
            const existing = rows.find(
              (r) =>
                r.salon_id === values.salon_id &&
                r.provider === values.provider &&
                r.external_event_id === values.external_event_id,
            );
            if (existing) {
              return {
                select() {
                  return {
                    maybeSingle: async () => ({
                      data: null,
                      error: { code: '23505', message: 'duplicate key' },
                    }),
                  };
                },
              };
            }
            const row: Row = {
              id: `id-${rows.length + 1}`,
              salon_id: String(values.salon_id),
              provider: String(values.provider),
              external_event_id: String(values.external_event_id),
              processing_status: String(values.processing_status),
              attempt_count: Number(values.attempt_count),
              updated_at: String(values.updated_at),
              metadata: (values.metadata as Record<string, string>) ?? {},
              last_error: null,
            };
            rows.push(row);
            return {
              select() {
                return {
                  maybeSingle: async () => ({
                    data: { id: row.id, attempt_count: row.attempt_count },
                    error: null,
                  }),
                };
              },
            };
          },
          select(_cols: string) {
            // Keep update mode when select follows update(...).select().maybeSingle().
            if (api._mode !== 'update') api._mode = 'select';
            return api;
          },
          update(values: Record<string, unknown>) {
            api._mode = 'update';
            api._update = values;
            return api;
          },
          eq(col: string, val: unknown) {
            api._filters[col] = val;
            return api;
          },
          in(col: string, vals: unknown[]) {
            api._filters[`${col}__in`] = vals;
            return api;
          },
          lt(col: string, val: unknown) {
            api._filters[`${col}__lt`] = val;
            return api;
          },
          maybeSingle: async () => {
            let list = rows.filter((r) => r.provider === INSTAGRAM_RECEIPT_PROVIDER);
            for (const [k, v] of Object.entries(api._filters)) {
              if (k.endsWith('__in')) {
                const col = k.replace(/__in$/, '');
                list = list.filter((r) => (v as unknown[]).includes((r as any)[col]));
              } else if (k.endsWith('__lt')) {
                const col = k.replace(/__lt$/, '');
                list = list.filter((r) => String((r as any)[col]) < String(v));
              } else {
                list = list.filter((r) => (r as any)[k] === v);
              }
            }
            if (api._mode === 'update') {
              const target = list[0];
              if (!target) return { data: null, error: null };
              Object.assign(target, api._update);
              return { data: { id: target.id, attempt_count: target.attempt_count }, error: null };
            }
            const row = list[0] ?? null;
            return { data: row, error: null };
          },
        };
        return api;
      },
    };
  }

  it('21/22. new Instagram event claims receipt with provider=instagram', async () => {
    const rows: Row[] = [];
    const claim = await claimInstagramEventReceipt(mockDb(rows) as any, {
      salonId: 'salon-1',
      externalEventId: 'mid.1',
      externalMessageId: 'mid.1',
      eventType: 'instagram.message',
      payloadHash: instagramReceiptPayloadHash('mid.1'),
      metadata: { kind: 'message', hasText: '1' },
    });
    assert.equal(claim.kind, 'claimed');
    assert.equal(rows[0].provider, 'instagram');
    assert.equal(rows[0].attempt_count, 1);
    assert.ok(!JSON.stringify(rows[0].metadata).includes('hello'));
  });

  it('23/24/25. duplicate terminal; in_flight; stale reclaim increments', async () => {
    const now = Date.now();
    const rows: Row[] = [
      {
        id: 'r1',
        salon_id: 'salon-1',
        provider: 'instagram',
        external_event_id: 'mid.dup',
        processing_status: 'processed',
        attempt_count: 2,
        updated_at: new Date(now).toISOString(),
        metadata: {},
        last_error: null,
      },
    ];
    const dup = await claimInstagramEventReceipt(mockDb(rows) as any, {
      salonId: 'salon-1',
      externalEventId: 'mid.dup',
      externalMessageId: 'mid.dup',
      eventType: 'instagram.message',
      payloadHash: null,
      metadata: { kind: 'message' },
    });
    assert.equal(dup.kind, 'duplicate_terminal');

    rows[0].processing_status = 'processing';
    rows[0].updated_at = new Date(now).toISOString();
    const inflight = await claimInstagramEventReceipt(mockDb(rows) as any, {
      salonId: 'salon-1',
      externalEventId: 'mid.dup',
      externalMessageId: 'mid.dup',
      eventType: 'instagram.message',
      payloadHash: null,
      metadata: { kind: 'message' },
    });
    assert.equal(inflight.kind, 'in_flight');

    rows[0].updated_at = new Date(now - RECEIPT_PROCESSING_STALE_MS - 1000).toISOString();
    rows[0].attempt_count = 3;
    const stale = await claimInstagramEventReceipt(mockDb(rows) as any, {
      salonId: 'salon-1',
      externalEventId: 'mid.dup',
      externalMessageId: 'mid.dup',
      eventType: 'instagram.message',
      payloadHash: null,
      metadata: { kind: 'message' },
    });
    assert.equal(stale.kind, 'claimed');
    if (stale.kind === 'claimed') {
      assert.equal(stale.attemptCount, 4);
    }
  });

  it('IG-3A: two-worker stale reclaim — only one obtains next generation', async () => {
    const now = Date.now();
    const rows: Row[] = [
      {
        id: 'r-race',
        salon_id: 'salon-1',
        provider: 'instagram',
        external_event_id: 'mid.race',
        processing_status: 'processing',
        attempt_count: 3,
        updated_at: new Date(now - RECEIPT_PROCESSING_STALE_MS - 1000).toISOString(),
        metadata: {},
        last_error: null,
      },
    ];
    const db = mockDb(rows);
    const input = {
      salonId: 'salon-1',
      externalEventId: 'mid.race',
      externalMessageId: 'mid.race',
      eventType: 'instagram.message',
      payloadHash: null as string | null,
      metadata: { kind: 'message' },
    };
    const [a, b] = await Promise.all([
      claimInstagramEventReceipt(db as any, input),
      claimInstagramEventReceipt(db as any, input),
    ]);
    const claimed = [a, b].filter((r) => r.kind === 'claimed');
    const losers = [a, b].filter((r) => r.kind !== 'claimed');
    assert.equal(claimed.length, 1);
    assert.equal(losers.length, 1);
    if (claimed[0].kind === 'claimed') {
      assert.equal(claimed[0].attemptCount, 4);
    }
    assert.equal(rows[0].attempt_count, 4);
    // Loser must not invent a second claim; typically in_flight after lost CAS.
    assert.ok(
      losers[0].kind === 'in_flight' || losers[0].kind === 'failed_transient',
      `loser kind=${losers[0].kind}`,
    );
  });

  it('26/27/28. stale owner finalize/fail rejected; current owner finalize ok', async () => {
    const rows: Row[] = [
      {
        id: 'r1',
        salon_id: 'salon-1',
        provider: 'instagram',
        external_event_id: 'mid.own',
        processing_status: 'processing',
        attempt_count: 4,
        updated_at: new Date().toISOString(),
        metadata: {},
        last_error: null,
      },
    ];
    const db = mockDb(rows);
    const staleFinalize = await finalizeInstagramEventReceipt(db as any, {
      salonId: 'salon-1',
      receiptId: 'r1',
      attemptCount: 3,
      finalStatus: 'processed',
    });
    assert.equal(staleFinalize.ok, false);

    const staleFail = await markInstagramEventReceiptFailed(db as any, {
      salonId: 'salon-1',
      receiptId: 'r1',
      attemptCount: 3,
      errorCode: 'x',
    });
    assert.equal(staleFail.ok, false);

    const ok = await finalizeInstagramEventReceipt(db as any, {
      salonId: 'salon-1',
      receiptId: 'r1',
      attemptCount: 4,
      finalStatus: 'processed',
    });
    assert.equal(ok.ok, true);
    assert.equal(rows[0].processing_status, 'processed');
  });

  it('29/30/31. unknown account no receipt; transient route; cross-salon isolation', async () => {
    const claims: string[] = [];
    const unknownDeps: InstagramProcessDeps = {
      route: async () => ({
        kind: 'unknown',
        professionalAccountId: LARGE_IG_ID,
        reason: 'unknown_account',
      }),
      claim: async (input) => {
        claims.push(input.salonId);
        return { kind: 'claimed', receiptId: 'r', attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'ignored' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };
    const events = normalizeInstagramWebhookPayload(messagePayload({}));
    const unknown = await processInstagramWebhookEvent(events[0], unknownDeps);
    assert.equal(unknown.outcome, 'ignored');
    assert.deepEqual(claims, []);

    const transient = await processInstagramWebhookEvent(events[0], {
      ...unknownDeps,
      route: async () => ({ kind: 'failed_transient', code: 'route_lookup' }),
    });
    assert.equal(transient.outcome, 'failed_transient');

    assert.equal(
      classifyExistingReceiptForClaim({
        processing_status: 'processed',
        updated_at: new Date().toISOString(),
      }),
      'duplicate_processed',
    );
  });
});

describe('IG-3 process + multi-event (executed)', () => {
  it('33-37. privacy: receipt metadata has no body/caption/username/raw', () => {
    const events = normalizeInstagramWebhookPayload(
      messagePayload({ text: 'PRIVATE_BODY_TEXT', mid: 'mid.priv' }),
    );
    assert.ok(!JSON.stringify(events[0].receiptMetadata).includes('PRIVATE_BODY_TEXT'));
    assert.equal(events[0].inboundText, 'PRIVATE_BODY_TEXT');
    assert.ok(!('text' in events[0].receiptMetadata));
    assert.ok(!('username' in events[0].receiptMetadata));
    assert.ok(!('raw' in events[0].receiptMetadata));
  });

  it('38-41. multi-event independent processing; attempts not shared', async () => {
    const attempts: number[] = [];
    const deps: InstagramProcessDeps = {
      route: async () => ({
        kind: 'connected',
        salonId: 'salon-1',
        professionalAccountId: LARGE_IG_ID,
      }),
      claim: async (input) => {
        const n = attempts.length + 1;
        attempts.push(n);
        return { kind: 'claimed', receiptId: `r-${input.externalEventId}`, attemptCount: 1 };
      },
      finalize: async () => ({ ok: true, status: 'processed' }),
      markFailed: async () => ({ ok: true }),
      applyIdentityConversation: noopApplyIdentityConversation,
    };

    const payload = {
      object: 'instagram',
      entry: [
        {
          id: LARGE_IG_ID,
          messaging: [
            {
              sender: { id: LARGE_SENDER },
              recipient: { id: LARGE_IG_ID },
              timestamp: 1,
              message: { mid: 'mid.a', text: 'one' },
            },
            {
              sender: { id: '17841400000000088' },
              recipient: { id: LARGE_IG_ID },
              timestamp: 2,
              message: { mid: 'mid.b', text: 'two' },
            },
            {
              sender: { id: 12345 },
              recipient: { id: LARGE_IG_ID },
              timestamp: 3,
              message: { mid: 'mid.c', text: 'bad' },
            },
          ],
        },
      ],
    };
    const events = normalizeInstagramWebhookPayload(payload);
    assert.equal(events.length, 3);
    assert.equal(events[0].externalUserId, LARGE_SENDER);
    assert.equal(events[1].externalUserId, '17841400000000088');
    assert.equal(events[2].kind, 'malformed');

    const results = [];
    for (const event of events) {
      results.push(await processInstagramWebhookEvent(event, deps));
    }
    assert.equal(results[0].outcome, 'processed');
    assert.equal(results[1].outcome, 'processed');
    assert.equal(results[2].outcome, 'ignored');
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts, [1, 2]);
  });
});

describe('IG-3 static / regression (static)', () => {
  const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const routeSrc = readFileSync(
    new URL('../routes/instagramWebhook.ts', import.meta.url),
    'utf8',
  );
  const mig = readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000003_instagram_webhook_receipts.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const waReceipts = readFileSync(
    new URL('./whatsappWebhookReceipts.ts', import.meta.url),
    'utf8',
  );
  const convMig = readFileSync(
    new URL(
      '../../../supabase/migrations/20260727000002_whatsapp_channel_foundation.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it('32. WhatsApp receipt helper file unchanged in provider constant', () => {
    assert.match(waReceipts, /WHATSAPP_RECEIPT_PROVIDER = 'whatsapp'/);
    assert.doesNotMatch(waReceipts, /instagram/);
  });

  it('migration widens receipts only; conversations stay whatsapp', () => {
    assert.match(mig, /whatsapp',\s*'instagram'/);
    assert.doesNotMatch(mig, /ALTER TABLE public\.channel_conversations/);
    assert.doesNotMatch(mig, /ALTER TABLE public\.client_channel_identities/);
    assert.match(convMig, /provider IN \('whatsapp'\)/);
  });

  it('webhook mounted before express.json; OAuth callback separate', () => {
    assert.match(
      indexSrc,
      /app\.use\('\/api\/webhooks\/instagram',\s*instagramWebhookRouter\)/,
    );
    const igMount = indexSrc.indexOf("app.use('/api/webhooks/instagram'");
    const jsonMount = indexSrc.indexOf('app.use(express.json())');
    assert.ok(igMount >= 0 && igMount < jsonMount);
    assert.match(indexSrc, /\/api\/integrations\/instagram/);
    assert.doesNotMatch(routeSrc, /requireDeveloperAuth|requireSalonAuth/);
  });

  it('no subscribed_apps / outbound / booking in IG-3 modules', () => {
    assert.doesNotMatch(routeSrc, /subscribed_apps/);
    assert.doesNotMatch(routeSrc, /\bsendMessage\b/);
    assert.doesNotMatch(routeSrc, /channel_conversations/);
    const processSrc = readFileSync(
      new URL('./instagramWebhookProcess.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(processSrc, /appointments|scheduleSlots|reminders/);
  });

  it('Telegram / Apple / WhatsApp runtime presence unchanged', () => {
    const wa = readFileSync(new URL('../routes/whatsappWebhook.ts', import.meta.url), 'utf8');
    assert.match(wa, /whatsapp/);
    const tg = readFileSync(new URL('./telegramBotManager.ts', import.meta.url), 'utf8');
    assert.match(tg, /telegram/i);
    const apple = readFileSync(new URL('./calendarCredentialsCrypto.ts', import.meta.url), 'utf8');
    assert.match(apple, /CALENDAR_CREDENTIALS_ENCRYPTION_KEY/);
  });
});
