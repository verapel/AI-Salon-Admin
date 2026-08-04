/**
 * WA-4C fixture/unit tests (no Meta, no DB appointments).
 * Run: npx tsx --test src/lib/whatsappBookingFsm.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseWhatsAppAppointmentTime,
  parseWhatsAppAppointmentDate,
  parseWhatsAppBookingName,
  parseWhatsAppBookingPhone,
} from './whatsappBookingParsers.js';
import {
  extractWhatsAppInboundTextBody,
  isWhatsAppCancelCommand,
  isWhatsAppStartCommand,
} from './whatsappInboundText.js';
import { classifyWhatsAppWebhookPayload } from './whatsappWebhookEvents.js';
import {
  bookingStateToJson,
  parseWhatsAppBookingState,
  WHATSAPP_BOOKING_FLOW,
} from './whatsappBookingState.js';
import { isConversationExpired } from './whatsappConversation.js';

describe('whatsapp inbound text', () => {
  it('extracts text body in memory for type=text', () => {
    const body = extractWhatsAppInboundTextBody({
      messageType: 'text',
      messageTextBody: '  Запись  ',
    });
    assert.equal(body, 'Запись');
  });

  it('ignores non-text', () => {
    assert.equal(
      extractWhatsAppInboundTextBody({ messageType: 'image', messageTextBody: 'x' }),
      null
    );
  });

  it('recognizes start/cancel commands (normalized)', () => {
    assert.equal(isWhatsAppStartCommand('Запись'), true);
    assert.equal(isWhatsAppStartCommand('START'), true);
    assert.equal(isWhatsAppStartCommand('начать'), true);
    assert.equal(isWhatsAppCancelCommand('Отмена'), true);
    assert.equal(isWhatsAppCancelCommand('cancel'), true);
    assert.equal(isWhatsAppCancelCommand('hello'), false);
  });
});

describe('privacy: classifier omits body from receipt metadata', () => {
  it('does not put text body into receiptMetadata', () => {
    const events = classifyWhatsAppWebhookPayload({
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn1' },
                contacts: [{ wa_id: '15551234567', profile: { name: 'Ann' } }],
                messages: [
                  {
                    id: 'wamid.1',
                    from: '15551234567',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'SECRET_BODY_SHOULD_NOT_PERSIST' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].messageTextBody, 'SECRET_BODY_SHOULD_NOT_PERSIST');
    assert.equal(events[0].messageType, 'text');
    const meta = JSON.stringify(events[0].receiptMetadata);
    assert.equal(meta.includes('SECRET_BODY'), false);
    assert.equal(events[0].receiptMetadata.messageType, 'text');
  });
});

describe('parsers', () => {
  it('rejects invalid time (no silent 10:00)', () => {
    assert.equal(parseWhatsAppAppointmentTime('когда удобно'), null);
    assert.equal(parseWhatsAppAppointmentTime(''), null);
    assert.equal(parseWhatsAppAppointmentTime('25:00'), null);
  });

  it('parses valid times', () => {
    assert.equal(parseWhatsAppAppointmentTime('12:00'), '12:00');
    assert.equal(parseWhatsAppAppointmentTime('9.30'), '09:30');
    assert.equal(parseWhatsAppAppointmentTime('930'), '09:30');
    assert.equal(parseWhatsAppAppointmentTime('14'), '14:00');
  });

  it('rejects invalid date (no silent today)', () => {
    assert.equal(parseWhatsAppAppointmentDate('потом как-нибудь'), null);
    assert.equal(parseWhatsAppAppointmentDate(''), null);
  });

  it('parses ISO and relative dates', () => {
    assert.equal(parseWhatsAppAppointmentDate('2026-08-10'), '2026-08-10');
    assert.equal(parseWhatsAppAppointmentDate('сегодня', 'UTC') != null, true);
    assert.equal(parseWhatsAppAppointmentDate('завтра', 'UTC') != null, true);
  });

  it('name/phone validation', () => {
    assert.equal(parseWhatsAppBookingName(''), null);
    assert.equal(parseWhatsAppBookingName('  '), null);
    assert.equal(parseWhatsAppBookingName('12:00'), null);
    assert.equal(parseWhatsAppBookingName('Анна'), 'Анна');
    assert.equal(parseWhatsAppBookingPhone('123'), null);
    assert.equal(parseWhatsAppBookingPhone('+15551234567'), '+15551234567');
    assert.equal(parseWhatsAppBookingPhone('15551234567'), '+15551234567');
  });
});

describe('booking state shape', () => {
  it('round-trips structured fields only', () => {
    const state = parseWhatsAppBookingState({
      serviceId: 's1',
      serviceName: 'Стрижка',
      staffId: 'm1',
      date: '2026-08-10',
      time: '12:00',
      name: 'Анна',
      phone: '+15551234567',
      sourceMessageId: 'wamid.1',
      transcript: 'should be dropped',
      rawBody: 'nope',
    });
    assert.equal(state.serviceId, 's1');
    assert.equal((state as any).transcript, undefined);
    const json = bookingStateToJson(state);
    assert.equal(json.sourceMessageId, 'wamid.1');
    assert.equal(Object.keys(json).includes('transcript'), false);
    assert.equal(WHATSAPP_BOOKING_FLOW, 'booking');
  });
});

describe('expiry helper', () => {
  it('detects expired conversations', () => {
    assert.equal(isConversationExpired({ expires_at: '2000-01-01T00:00:00.000Z' }), true);
    assert.equal(isConversationExpired({ expires_at: '2999-01-01T00:00:00.000Z' }), false);
    assert.equal(isConversationExpired({ expires_at: null }), false);
  });
});

describe('owned transition contract (pure expectations)', () => {
  it('documents expected-step CAS outcomes', () => {
    // Concurrent A/B: same expected step → one ok, one stale_step.
    const outcomes = new Set(['ok', 'stale_step', 'outdated', 'lost_ownership', 'duplicate']);
    assert.equal(outcomes.has('stale_step'), true);
    assert.equal(outcomes.has('outdated'), true);
  });
});
