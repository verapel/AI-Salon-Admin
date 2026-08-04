/**
 * WhatsApp-local booking parsers (aligned with Telegram hardening).
 * Do not import from server/src/index.ts.
 * Invalid arbitrary text must NOT silently become 10:00 / today.
 */

import {
  dateStrInTimezone,
  getSalonTimezone,
  isValidIsoDate,
} from './scheduleSlots.js'

const MONTH_MAP: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
  январь: 1,
  февраль: 2,
  март: 3,
  апрель: 4,
  май: 5,
  июнь: 6,
  июль: 7,
  август: 8,
  сентябрь: 9,
  октябрь: 10,
  ноябрь: 11,
  декабрь: 12,
}

/**
 * Strict-ish time parser matching Telegram: HH:MM / HH.MM / HHMM / H / HH.
 * Returns normalized HH:MM or null — never defaults to 10:00.
 */
export function parseWhatsAppAppointmentTime(raw: string): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  let hours: number
  let minutes: number

  const colonOrDot = trimmed.match(/^(\d{1,2})[:.](\d{2})$/)
  if (colonOrDot) {
    hours = Number(colonOrDot[1])
    minutes = Number(colonOrDot[2])
  } else if (/^\d{4}$/.test(trimmed)) {
    hours = Number(trimmed.slice(0, 2))
    minutes = Number(trimmed.slice(2, 4))
  } else if (/^\d{3}$/.test(trimmed)) {
    hours = Number(trimmed.slice(0, 1))
    minutes = Number(trimmed.slice(1, 3))
  } else if (/^\d{1,2}$/.test(trimmed)) {
    hours = Number(trimmed)
    minutes = 0
  } else {
    return null
  }

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** Pure date parse with optional IANA timezone for сегодня/завтра. */
export function parseWhatsAppAppointmentDate(raw: string, timeZone?: string): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  // Use boolean check (not type-predicate) so `trimmed` stays string afterward.
  if (isValidIsoDate(trimmed as unknown) === true) return trimmed

  const text = trimmed.toLowerCase().replace(/\s+/g, ' ')
  const tz = timeZone?.trim() || undefined

  if (text === 'сегодня' || text === 'today' || text.includes('сегодня')) {
    return tz ? dateStrInTimezone(tz, 0) : formatLocalYmd(0)
  }
  if (text === 'завтра' || text === 'tomorrow' || text.includes('завтра')) {
    return tz ? dateStrInTimezone(tz, 1) : formatLocalYmd(1)
  }

  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/)
  if (dmy) {
    const day = Number(dmy[1])
    const month = Number(dmy[2])
    let year = dmy[3] ? Number(dmy[3]) : Number((tz ? dateStrInTimezone(tz, 0) : formatLocalYmd(0)).slice(0, 4))
    if (year < 100) year += 2000
    if (!isValidYmdParts(year, month, day)) return null
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const todayYmd = tz ? dateStrInTimezone(tz, 0) : formatLocalYmd(0)
  const [ty, tm, td] = todayYmd.split('-').map(Number)
  const todayUtc = Date.UTC(ty, tm - 1, td)

  const monthMatch = text.match(/(\d{1,2})(?:-?го)?\s+([а-яё]+)/)
  if (monthMatch) {
    const day = Number.parseInt(monthMatch[1], 10)
    const monthNum = MONTH_MAP[monthMatch[2]]
    if (monthNum && day >= 1 && day <= 31) {
      let year = ty
      let candidate = Date.UTC(year, monthNum - 1, day)
      if (candidate < todayUtc) {
        year += 1
        candidate = Date.UTC(year, monthNum - 1, day)
      }
      if (!isValidYmdParts(year, monthNum, day)) return null
      return `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }

  // Unlike Telegram's silent today fallback, WhatsApp rejects unparseable dates.
  return null
}

export async function parseWhatsAppAppointmentDateForSalon(
  salonId: string,
  raw: string,
): Promise<string | null> {
  const tz = await getSalonTimezone(salonId)
  return parseWhatsAppAppointmentDate(raw, tz)
}

/** Keep name validation conservative — no invented placeholders. */
export function parseWhatsAppBookingName(raw: string): string | null {
  const name = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 80) return null
  if (/^\d{1,2}:\d{2}$/.test(name)) return null
  if (!/[A-Za-zА-Яа-яЁё]/.test(name)) return null
  return name
}

/**
 * Phone collection for WhatsApp booking.
 * Accepts digits with optional +; does not invent country codes beyond a leading +.
 */
export function parseWhatsAppBookingPhone(raw: string): string | null {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[()\s-]/g, '')
  if (!cleaned) return null
  if (!/^\+?\d{10,15}$/.test(cleaned)) return null
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`
}

function formatLocalYmd(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isValidYmdParts(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
