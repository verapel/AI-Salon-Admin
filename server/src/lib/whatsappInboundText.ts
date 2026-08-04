/**
 * In-memory WhatsApp text extraction for booking FSM (WA-4C).
 * Never persist raw body into receipt metadata, conversation.state, or logs.
 */

import type { ClassifiedWhatsAppWebhookEvent } from './whatsappWebhookEvents.js'

export function extractWhatsAppInboundTextBody(
  event: Pick<ClassifiedWhatsAppWebhookEvent, 'messageType' | 'messageTextBody'>,
): string | null {
  if (event.messageType !== 'text') return null
  const body = event.messageTextBody
  if (typeof body !== 'string') return null
  const trimmed = body.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeWhatsAppCommandText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isWhatsAppStartCommand(text: string): boolean {
  const n = normalizeWhatsAppCommandText(text)
  return n === 'start' || n === 'начать' || n === 'запись' || n === '/start'
}

export function isWhatsAppCancelCommand(text: string): boolean {
  const n = normalizeWhatsAppCommandText(text)
  return n === 'cancel' || n === 'отмена' || n === 'отменить' || n === '/cancel'
}
