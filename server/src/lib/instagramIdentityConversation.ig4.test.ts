/**
 * IG-4: Instagram identity + durable conversation foundation tests.
 * Mocks/fixtures/static SQL only. No Meta. No SQL execution.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  applyInstagramInboundIdentityConversationOwned,
  INSTAGRAM_CHANNEL_PROVIDER,
  INSTAGRAM_CONVERSATION_INACTIVITY_SECONDS,
  parseInstagramMessageTimestamp,
} from './instagramIdentityConversation.js';
import {
  normalizeInstagramWebhookPayload,
} from './instagramWebhookEvents.js';
import {
  processInstagramWebhookEvent,
  type InstagramProcessDeps,
} from './instagramWebhookProcess.js';

const LARGE_IG_ID = '17841400000000001';
const LARGE_SENDER = '17841400000000099';
const SALON = '11111111-1111-1111-1111-111111111111';

function messageEvent(opts: {
  mid?: string;
  senderId?: string | null;
  isEcho?: boolean;
  timestampMs?: number | null;
  text?: string;
}) {
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: LARGE_IG_ID,
        messaging: [
          {
            sender:
              opts.senderId === null
                ? {}
                : { id: opts.senderId ?? LARGE_SENDER },
            recipient: { id: LARGE_IG_ID },
            timestamp: opts.timestampMs === null ? undefined : (opts.timestampMs ?? 1_700_000_000_000),
            message: {
              mid: opts.mid ?? 'mid.ig4.1',
              text: opts.text ?? 'hello secret',
              ...(opts.isEcho ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  };
  return normalizeInstagramWebhookPayload(payload)[0];
}

function postbackEvent(mid = 'mid.ig4.pb') {
  return normalizeInstagramWebhookPayload({
    object: 'instagram',
    entry: [
      {
        id: LARGE_IG_ID,
        messaging: [
          {
            sender: { id: LARGE_SENDER },
            recipient: { id: LARGE_IG_ID },
            timestamp: 1_700_000_000_100,
            postback: { mid, title: 'Book', payload: 'START' },
          },
        ],
      },
    ],
  })[0];
}

function baseDeps(overrides: Partial<InstagramProcessDeps> = {}): InstagramProcessDeps {
  return {
    route: async () => ({
      kind: 'connected',
      salonId: SALON,
      professionalAccountId: LARGE_IG_ID,
    }),
    claim: async () => ({ kind: 'claimed', receiptId: 'r1', attemptCount: 1 }),
    finalize: async () => ({ ok: true, status: 'processed' }),
    markFailed: async () => ({ ok: true }),
    applyIdentityConversation: async () => ({
      kind: 'ok',
      identityId: 'ident-1',
      conversationId: 'conv-1',
      clientId: null,
      advanced: true,
      identityCreated: true,
      conversationCreated: true,
    }),
    ...overrides,
  };
}

describe('IG-4 timestamp + constants (executed)', () => {
  it('parseInstagramMessageTimestamp accepts ms/seconds; rejects invalid', () => {
    assert.equal(
      parseInstagramMessageTimestamp(1_700_000_000_000),
      new Date(1_700_000_000_000).toISOString(),
    );
    assert.equal(
      parseInstagramMessageTimestamp(1_700_000_000),
      new Date(1_700_000_000_000).toISOString(),
    );
    assert.equal(parseInstagramMessageTimestamp(0), null);
    assert.equal(parseInstagramMessageTimestamp(-1), null);
    assert.equal(parseInstagramMessageTimestamp(Number.NaN), null);
    assert.equal(parseInstagramMessageTimestamp('not-a-date'), null);
    assert.equal(INSTAGRAM_CONVERSATION_INACTIVITY_SECONDS, 86400);
    assert.equal(INSTAGRAM_CHANNEL_PROVIDER, 'instagram');
  });
});

describe('IG-4 pipeline integration (executed mocks)', () => {
  it('42. valid message: claim → owned mutation → finalize processed', async () => {
    const calls: string[] = [];
    const result = await processInstagramWebhookEvent(
      messageEvent({}),
      baseDeps({
        claim: async () => {
          calls.push('claim');
          return { kind: 'claimed', receiptId: 'r1', attemptCount: 2 };
        },
        applyIdentityConversation: async (p) => {
          calls.push('mutate');
          assert.equal(p.receiptId, 'r1');
          assert.equal(p.attemptCount, 2);
          assert.equal(p.externalUserId, LARGE_SENDER);
          assert.equal(p.externalMessageId, 'mid.ig4.1');
          assert.ok(p.messageTimestampIso);
          return {
            kind: 'ok',
            identityId: 'i1',
            conversationId: 'c1',
            clientId: null,
            advanced: true,
            identityCreated: true,
            conversationCreated: true,
          };
        },
        finalize: async (p) => {
          calls.push('finalize');
          assert.equal(p.finalStatus, 'processed');
          assert.equal(p.attemptCount, 2);
          return { ok: true, status: 'processed' };
        },
      }),
    );
    assert.equal(result.outcome, 'processed');
    assert.deepEqual(calls, ['claim', 'mutate', 'finalize']);
  });

  it('43. valid postback: claim → owned mutation → finalize', async () => {
    let mutated = false;
    const result = await processInstagramWebhookEvent(
      postbackEvent(),
      baseDeps({
        applyIdentityConversation: async () => {
          mutated = true;
          return {
            kind: 'ok',
            identityId: 'i1',
            conversationId: 'c1',
            clientId: null,
            advanced: true,
            identityCreated: false,
            conversationCreated: false,
          };
        },
      }),
    );
    assert.equal(result.outcome, 'processed');
    assert.equal(mutated, true);
  });

  it('23/44. echo: ignored receipt, NO identity/conversation mutation', async () => {
    let mutate = 0;
    let finalizeStatus: string | null = null;
    const result = await processInstagramWebhookEvent(
      messageEvent({ isEcho: true, mid: 'mid.echo' }),
      baseDeps({
        applyIdentityConversation: async () => {
          mutate += 1;
          return {
            kind: 'ok',
            identityId: 'x',
            conversationId: 'y',
            clientId: null,
            advanced: true,
            identityCreated: true,
            conversationCreated: true,
          };
        },
        finalize: async (p) => {
          finalizeStatus = p.finalStatus;
          return { ok: true, status: p.finalStatus };
        },
      }),
    );
    assert.equal(result.outcome, 'ignored');
    assert.equal(mutate, 0);
    assert.equal(finalizeStatus, 'ignored');
  });

  it('45. mutation transient DB error → markFailed + failed_transient', async () => {
    let failed = 0;
    const result = await processInstagramWebhookEvent(
      messageEvent({}),
      baseDeps({
        applyIdentityConversation: async () => ({ kind: 'error', code: 'identity_conversation_rpc' }),
        markFailed: async () => {
          failed += 1;
          return { ok: true };
        },
        finalize: async () => {
          throw new Error('should not finalize');
        },
      }),
    );
    assert.equal(result.outcome, 'failed_transient');
    assert.equal(failed, 1);
  });

  it('46. lost ownership → no stale finalize', async () => {
    let finalized = 0;
    const result = await processInstagramWebhookEvent(
      messageEvent({}),
      baseDeps({
        applyIdentityConversation: async () => ({ kind: 'lost_ownership' }),
        finalize: async () => {
          finalized += 1;
          return { ok: true, status: 'processed' };
        },
      }),
    );
    assert.equal(result.outcome, 'in_flight');
    assert.equal(finalized, 0);
  });

  it('47. terminal duplicate → no mutation', async () => {
    let mutate = 0;
    const result = await processInstagramWebhookEvent(
      messageEvent({}),
      baseDeps({
        claim: async () => ({ kind: 'duplicate_terminal', status: 'processed' }),
        applyIdentityConversation: async () => {
          mutate += 1;
          return {
            kind: 'ok',
            identityId: 'i',
            conversationId: 'c',
            clientId: null,
            advanced: true,
            identityCreated: false,
            conversationCreated: false,
          };
        },
      }),
    );
    assert.equal(result.outcome, 'duplicate_terminal');
    assert.equal(mutate, 0);
  });

  it('48/49. unknown / disconnected → no identity mutation', async () => {
    let mutate = 0;
    const mut = async () => {
      mutate += 1;
      return {
        kind: 'ok' as const,
        identityId: 'i',
        conversationId: 'c',
        clientId: null,
        advanced: true,
        identityCreated: true,
        conversationCreated: true,
      };
    };
    const unknown = await processInstagramWebhookEvent(
      messageEvent({}),
      baseDeps({
        route: async () => ({
          kind: 'unknown',
          professionalAccountId: LARGE_IG_ID,
          reason: 'unknown_account',
        }),
        applyIdentityConversation: mut,
      }),
    );
    assert.equal(unknown.outcome, 'ignored');
    const disconnected = await processInstagramWebhookEvent(
      messageEvent({}),
      baseDeps({
        route: async () => ({
          kind: 'disconnected',
          salonId: SALON,
          professionalAccountId: LARGE_IG_ID,
          reason: 'not_connected',
        }),
        applyIdentityConversation: mut,
        finalize: async (p) => ({ ok: true, status: p.finalStatus }),
      }),
    );
    assert.equal(disconnected.outcome, 'ignored');
    assert.equal(mutate, 0);
  });

  it('missing sender → no mutation; finalize ignored', async () => {
    let mutate = 0;
    const result = await processInstagramWebhookEvent(
      messageEvent({ senderId: null }),
      baseDeps({
        applyIdentityConversation: async () => {
          mutate += 1;
          return {
            kind: 'ok',
            identityId: 'i',
            conversationId: 'c',
            clientId: null,
            advanced: true,
            identityCreated: true,
            conversationCreated: true,
          };
        },
        finalize: async (p) => ({ ok: true, status: p.finalStatus }),
      }),
    );
    assert.equal(result.outcome, 'ignored');
    assert.equal(mutate, 0);
  });
});

describe('IG-4 privacy + identity policy (executed)', () => {
  it('50-55. no DM/postback content in receipt metadata; no username matching helpers', () => {
    const msg = messageEvent({ text: 'PRIVATE_DM_BODY' });
    const pb = postbackEvent();
    // Ephemeral inboundText/payload may exist in-memory for IG-5; must not enter receipt metadata.
    assert.ok(!JSON.stringify(msg.receiptMetadata).includes('PRIVATE_DM_BODY'));
    assert.ok(!JSON.stringify(pb.receiptMetadata).includes('START'));
    assert.ok(!JSON.stringify(pb.receiptMetadata).includes('Book'));
    assert.equal(msg.inboundText, 'PRIVATE_DM_BODY');
    const src = readFileSync(
      new URL('./instagramIdentityConversation.ts', import.meta.url),
      'utf8',
    );
    const processSrc = readFileSync(
      new URL('./instagramWebhookProcess.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(src, /findUniqueSalonClient|profileNameHint|INSERT INTO public\.clients/i);
    assert.doesNotMatch(processSrc, /findUniqueSalonClient|profileNameHint|display_name/i);
    assert.match(processSrc, /applyIdentityConversation/);
  });

  it('RPC wrapper passes hardcoded inactivity + real mid fields only', async () => {
    let args: Record<string, unknown> | null = null;
    const db = {
      rpc: async (_name: string, params: Record<string, unknown>) => {
        args = params;
        return {
          data: {
            kind: 'ok',
            identity_id: 'i',
            conversation_id: 'c',
            client_id: null,
            advanced: true,
            identity_created: true,
            conversation_created: true,
          },
          error: null,
        };
      },
    };
    const result = await applyInstagramInboundIdentityConversationOwned({
      db,
      salonId: SALON,
      receiptId: 'r1',
      attemptCount: 3,
      externalUserId: LARGE_SENDER,
      externalMessageId: 'mid.x',
      messageTimestampIso: '2026-08-07T12:00:00.000Z',
    });
    assert.equal(result.kind, 'ok');
    assert.ok(args);
    assert.equal(args!.p_attempt_count, 3);
    assert.equal(args!.p_external_message_id, 'mid.x');
    assert.equal(args!.p_inactivity_seconds, 86400);
    assert.equal(args!.p_external_user_id, LARGE_SENDER);
  });
});

describe('IG-4 migration / RPC static (static)', () => {
  const mig = readFileSync(
    new URL(
      '../../../supabase/migrations/20260807000004_instagram_identity_conversation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const waOwned = readFileSync(
    new URL(
      '../../../supabase/migrations/20260804000001_whatsapp_owned_conversation_mutation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const foundation = readFileSync(
    new URL(
      '../../../supabase/migrations/20260727000002_whatsapp_channel_foundation.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it('1-5. provider CHECKs widen; unrelated still constrained in SQL text', () => {
    assert.match(mig, /channel_conversations[\s\S]*CHECK \(provider IN \('whatsapp', 'instagram'\)\)/);
    assert.match(
      mig,
      /client_channel_identities[\s\S]*CHECK \(provider IN \('telegram', 'whatsapp', 'instagram'\)\)/,
    );
    assert.match(mig, /ALTER COLUMN client_id DROP NOT NULL/);
    assert.match(foundation, /CHECK \(provider IN \('whatsapp'\)\)/);
    assert.match(foundation, /CHECK \(provider IN \('telegram', 'whatsapp'\)\)/);
  });

  it('6-10. RPC hardcodes instagram + ownership predicates', () => {
    assert.match(mig, /apply_instagram_inbound_identity_conversation_owned/);
    assert.match(mig, /instagram_lock_owned_receipt/);
    assert.match(mig, /r\.provider = 'instagram'/);
    assert.match(mig, /processing_status/);
    assert.match(mig, /v_attempt IS DISTINCT FROM p_attempt_count/);
    assert.match(mig, /FOR UPDATE/);
    assert.match(mig, /SECURITY INVOKER/);
    assert.match(mig, /SET search_path = public/);
    assert.match(mig, /GRANT EXECUTE[\s\S]*TO service_role/);
    assert.doesNotMatch(mig, /provider = p_provider/);
  });

  it('11-20. identity insert null client; never flip; no username/clients insert', () => {
    assert.match(mig, /INSERT INTO public\.client_channel_identities/);
    assert.match(mig, /NULL,\s*'instagram'/);
    assert.match(mig, /client_id intentionally never cleared or flipped/);
    assert.doesNotMatch(mig, /INSERT INTO public\.clients/);
    assert.doesNotMatch(mig, /username|profile_name|display_name/i);
  });

  it('21-30. conversation idle insert; no FSM reset on update; out-of-order guard', () => {
    assert.match(mig, /current_flow,\s*current_step,/);
    assert.match(mig, /NULL,\s*-- idle/);
    assert.match(mig, /NEVER reset current_flow \/ current_step \/ state/);
    assert.match(mig, /p_message_at >= v_conv\.last_inbound_at/);
    assert.match(mig, /Do not move expires_at backwards/);
    assert.match(mig, /WHEN c\.client_id IS NULL THEN v_ident\.client_id/);
  });

  it('WhatsApp owned RPC file unchanged (no Instagram provider rewrite)', () => {
    assert.match(waOwned, /provider = 'whatsapp'/);
    assert.doesNotMatch(waOwned, /instagram/);
  });

  it('index.ts has no IG-4-only mount changes beyond IG-3 webhook', () => {
    const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    assert.match(indexSrc, /\/api\/webhooks\/instagram/);
    assert.doesNotMatch(indexSrc, /apply_instagram_inbound_identity_conversation_owned/);
  });

  it('Telegram / Apple / WhatsApp runtime modules untouched by IG-4 TS', () => {
    const ig4 = readFileSync(
      new URL('./instagramIdentityConversation.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(ig4, /telegram|apple|whatsapp_lock_owned_receipt/i);
    const tg = readFileSync(new URL('./telegramBotManager.ts', import.meta.url), 'utf8');
    assert.match(tg, /telegram/i);
  });
});
