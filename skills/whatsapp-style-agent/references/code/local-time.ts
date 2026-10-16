// The user's wall clock, DST-correct and pure (no Date.now()). Quiet hours and "one a day" mean the user's
// local hours and local day, and an hour of DST drift moves a message across the quiet-hours line, so the
// offset is resolved AT the instant in question through Intl — never a fixed offset.
//
// One zone per deployment here (APP_TZ). For users across zones, store a tz per user and pass it through.

export const APP_TZ = 'Australia/Sydney'

const DAY_MS = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()

function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    formatters.set(tz, f)
  }
  return f
}

interface Parts {
  y: number
  mo: number
  da: number
  h: number
  mi: number
  s: number
}

function parts(d: Date, tz: string): Parts {
  const p = Object.fromEntries(fmt(tz).formatToParts(d).map((x) => [x.type, x.value]))
  return {
    y: Number(p.year),
    mo: Number(p.month),
    da: Number(p.day),
    // hour12:false emits "24" for midnight on some engines.
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
  }
}

function offsetMs(d: Date, tz: string): number {
  const p = parts(d, tz)
  return Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, p.s) - Math.floor(d.getTime() / 1000) * 1000
}

/** A local wall-clock hour → the real UTC instant. Two-pass so a DST switch between now and the target
 *  still lands on the right hour. Assumes `hour` is not inside a skipped/repeated DST hour. */
function localToUtc(y: number, mo: number, da: number, hour: number, tz: string): Date {
  const localAsUtc = Date.UTC(y, mo - 1, da, hour)
  const approx = new Date(localAsUtc - offsetMs(new Date(localAsUtc), tz))
  return new Date(localAsUtc - offsetMs(approx, tz))
}

export function localHour(now: Date, tz = APP_TZ): number {
  return parts(now, tz).h
}

/** The local calendar date, 'YYYY-MM-DD' — the period a daily job's dedup key names. */
export function localDateISO(now: Date, tz = APP_TZ): string {
  const p = parts(now, tz)
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.da).padStart(2, '0')}`
}

/** 0 = Sunday … 6 = Saturday, read off the LOCAL date. */
export function localWeekday(now: Date, tz = APP_TZ): number {
  const p = parts(now, tz)
  return new Date(Date.UTC(p.y, p.mo - 1, p.da)).getUTCDay()
}

/** The ISO week of the local date, 'YYYY-Www' — the period a weekly job's dedup key names. */
export function localIsoWeek(now: Date, tz = APP_TZ): string {
  const p = parts(now, tz)
  const date = new Date(Date.UTC(p.y, p.mo - 1, p.da))
  const isoDay = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - isoDay)
  const year = date.getUTCFullYear()
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The next instant STRICTLY after `now` whose local time is `hour`:00 — today's if still ahead, else tomorrow's. */
export function nextLocalHour(now: Date, hour: number, tz = APP_TZ): Date {
  const p = parts(now, tz)
  const today = localToUtc(p.y, p.mo, p.da, hour, tz)
  return today.getTime() > now.getTime() ? today : localToUtc(p.y, p.mo, p.da + 1, hour, tz)
}

/** Local midnight of the current local day — where the daily proactive budget is counted from. */
export function localDayStart(now: Date, tz = APP_TZ): Date {
  const p = parts(now, tz)
  return localToUtc(p.y, p.mo, p.da, 0, tz)
}
