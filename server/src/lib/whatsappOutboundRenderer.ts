/**
 * WA-4F1: Map internal WhatsApp FSM/commit results to plain-text RU pilot replies.
 * No booking logic. No Meta send. No templates/buttons.
 */

import type { WhatsAppBookingCommitResult } from './whatsappBookingCommit.js';
import type { WhatsAppBookingActionResult } from './whatsappBookingState.js';

export type WhatsAppOutboundOption = { id: string; label: string };

export type WhatsAppOutboundRenderResult = {
  messageKey: string;
  text: string;
};

function appendNumberedOptions(
  body: string,
  options: WhatsAppOutboundOption[] | undefined,
  mode: 'numbered' | 'labels',
  instruction?: string,
): string {
  if (!options || options.length === 0) return body;
  const lines =
    mode === 'numbered'
      ? options.map((o, i) => `${i + 1}. ${o.label}`)
      : options.map((o) => `• ${o.label}`);
  const parts = [body, '', ...lines];
  if (instruction) parts.push('', instruction);
  return parts.join('\n');
}

/** Render FSM reply / ready_to_book_pending_commit (pre-commit) text. */
export function renderWhatsAppFsmOutbound(
  result: Extract<WhatsAppBookingActionResult, { kind: 'reply' | 'ready_to_book_pending_commit' }>,
): WhatsAppOutboundRenderResult {
  const key = result.messageKey;
  let text = result.text;
  const options = result.kind === 'reply' ? result.options : undefined;

  if (
    key === 'whatsapp.booking.chooseService' ||
    key === 'whatsapp.booking.serviceInvalid' ||
    key === 'whatsapp.booking.serviceAmbiguous' ||
    key === 'whatsapp.booking.chooseStaff' ||
    key === 'whatsapp.booking.staffInvalid'
  ) {
    text = appendNumberedOptions(text, options, 'numbered', 'Ответьте номером или названием.');
  } else if (
    key === 'whatsapp.booking.chooseDate' ||
    key === 'whatsapp.booking.dateInvalid' ||
    key === 'whatsapp.booking.datePast' ||
    key === 'whatsapp.booking.noSlots' ||
    key === 'whatsapp.booking.slot_unavailable_choose_date'
  ) {
    text = appendNumberedOptions(
      text,
      options,
      'labels',
      'Напишите дату из списка (например 2099-06-15).',
    );
  } else if (
    key === 'whatsapp.booking.chooseTime' ||
    key === 'whatsapp.booking.timeInvalid' ||
    key === 'whatsapp.booking.timeBusy'
  ) {
    text = appendNumberedOptions(
      text,
      options,
      'labels',
      'Напишите время, например 14:00.',
    );
  }

  return { messageKey: key, text };
}

/**
 * Render booking commit / recovery outcomes for outbound.
 * Sensitive conflicts use generic copy (no internal codes).
 */
export function renderWhatsAppCommitOutbound(
  result: WhatsAppBookingCommitResult,
  display?: {
    serviceName?: string;
    staffName?: string;
    date?: string;
    time?: string;
  },
): WhatsAppOutboundRenderResult | null {
  switch (result.kind) {
    case 'booking_created': {
      const svc = display?.serviceName?.trim();
      const staff = display?.staffName?.trim();
      const date = display?.date?.trim();
      const time = display?.time?.trim();
      if (svc && staff && date && time) {
        return {
          messageKey: 'whatsapp.booking.confirmed',
          text: `Готово! Вы записаны:\n${svc}\nмастер: ${staff}\n${date} в ${time}\n\nДо встречи!`,
        };
      }
      return {
        messageKey: 'whatsapp.booking.confirmed',
        text: 'Готово! Ваша запись создана. До встречи!',
      };
    }
    case 'already_booked':
    case 'already_booked_no_repair':
      return {
        messageKey: 'whatsapp.booking.alreadyBooked',
        text: 'Эта запись уже оформлена. Если нужно изменить время, напишите «запись», чтобы начать заново, или свяжитесь с салоном.',
      };
    case 'already_booked_repair_conflict':
    case 'identity_conflict':
    case 'client_resolution_conflict':
    case 'ambiguous_client':
      return {
        messageKey: 'whatsapp.booking.clientConflict',
        text: 'Не удалось подтвердить данные для записи. Пожалуйста, свяжитесь с салоном — мы поможем оформить визит.',
      };
    case 'client_blocked':
      return {
        messageKey: 'whatsapp.booking.clientBlocked',
        text: 'Онлайн-запись сейчас недоступна. Пожалуйста, свяжитесь с салоном напрямую.',
      };
    case 'service_unavailable':
      return {
        messageKey: 'whatsapp.booking.serviceUnavailable',
        text: 'Выбранная услуга сейчас недоступна. Напишите «запись», чтобы выбрать другую.',
      };
    case 'staff_unavailable':
      return {
        messageKey: 'whatsapp.booking.staffUnavailable',
        text: 'Выбранный мастер сейчас недоступен. Напишите «запись», чтобы начать заново.',
      };
    case 'slot_unavailable_choose_time': {
      const body =
        'К сожалению, выбранное время уже занято. Доступное время на эту дату:';
      return {
        messageKey: 'whatsapp.booking.slotUnavailableChooseTime',
        text: appendNumberedOptions(
          body,
          result.options,
          'labels',
          'Напишите время, например 14:00.',
        ),
      };
    }
    case 'slot_unavailable_choose_date': {
      const body =
        'На выбранную дату свободного времени больше нет. Доступные даты:';
      return {
        messageKey: 'whatsapp.booking.slotUnavailableChooseDate',
        text: appendNumberedOptions(
          body,
          result.options,
          'labels',
          'Напишите дату из списка.',
        ),
      };
    }
    case 'slot_unavailable':
      return {
        messageKey: 'whatsapp.booking.slotUnavailable',
        text: 'Выбранное время недоступно. Напишите «запись», чтобы выбрать другое.',
      };
    case 'stale_state':
      // Soft prompt — no internal codes.
      return {
        messageKey: 'whatsapp.booking.staleSoft',
        text: 'Сессия записи устарела. Напишите «запись», чтобы начать снова.',
      };
    case 'lost_ownership':
    case 'error':
      return null;
    default:
      return null;
  }
}
