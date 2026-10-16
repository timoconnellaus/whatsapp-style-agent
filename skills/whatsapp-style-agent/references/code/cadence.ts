// The CADENCE GOVERNOR — the one place that decides whether a proactive message may leave the building.
//
// The LLM writes words; this deterministic code decides whether and when to send. Every push-bearing
// proactive message passes through `allowProactiveSend` first. PURE: no DB, no fetch, no Date.now() — the
// caller supplies `now` and the counts it read (cadenceInputsFor), so every rule is table-testable.
// A blocked send is not dropped: the caller reschedules it to `retryAt` (time rules) or leaves it queued.
//
// Rules, in short-circuit order (the reason returned is the FIRST that fired):
//   1. quiet_hours    — 21:00–08:00 local. Every kind, requested work included.
//   2. daily_budget   — at most 1 proactive per user per local day, user-wide across threads.
//                       work_delivery is exempt (the user asked for it).
//   3. unanswered     — never a third unanswered proactive in a row (digest + checkin).
//   4. heartbeat      — only into a thread quiet ≥7 days, and at most one per user per 7 days.

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { agentJob, thread, threadMessage, type DB } from './schema'
import { APP_TZ, localDayStart, localHour, nextLocalHour } from './local-time'

export type ProactiveKind = 'digest' | 'checkin' | 'heartbeat' | 'work_delivery'
export type CadenceReason = 'quiet_hours' | 'daily_budget' | 'unanswered' | 'heartbeat_too_soon' | 'thread_active'

export interface CadenceInput {
  now: Date
  kind: ProactiveKind
  /** When the user last spoke IN THIS THREAD; null if never. */
  lastUserMessageAt: Date | null
  /** This thread's recent agent messages (any order — re-sorted defensively). */
  recentAgentMessages: { at: Date; proactive: boolean }[]
  /** Proactive messages already sent to this user today (local day), across ALL their threads. */
  proactiveSendsToday: number
  /** When this user last got a heartbeat, user-wide; null if never. */
  lastHeartbeatAt: Date | null
  tz?: string
}

export type CadenceVerdict = { allow: true } | { allow: false; reason: CadenceReason; retryAt?: Date }

export const QUIET_START_HOUR = 21
export const QUIET_END_HOUR = 8
export const DAILY_PROACTIVE_BUDGET = 1
export const HEARTBEAT_QUIET_DAYS = 7
const DAY_MS = 86_400_000

export function isQuietHours(now: Date, tz = APP_TZ): boolean {
  const h = localHour(now, tz)
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR
}

export function allowProactiveSend(input: CadenceInput): CadenceVerdict {
  const { now, kind } = input
  const tz = input.tz ?? APP_TZ

  if (isQuietHours(now, tz)) {
    return { allow: false, reason: 'quiet_hours', retryAt: nextLocalHour(now, QUIET_END_HOUR, tz) }
  }
  // retryAt = next local midnight; a retry then is deferred by rule 1 to 08:00, which is intended.
  if (kind !== 'work_delivery' && input.proactiveSendsToday >= DAILY_PROACTIVE_BUDGET) {
    return { allow: false, reason: 'daily_budget', retryAt: nextLocalHour(now, 0, tz) }
  }
  // Heartbeat is the sanctioned exception (own stricter gate below); requested work was asked for.
  if ((kind === 'digest' || kind === 'checkin') && hasTwoUnansweredProactive(input)) {
    return { allow: false, reason: 'unanswered' }
  }
  if (kind === 'heartbeat') {
    // A live thread makes a heartbeat wrong in principle; checked before the rate limit.
    if (input.lastUserMessageAt && !atLeastDaysAgo(now, input.lastUserMessageAt, HEARTBEAT_QUIET_DAYS)) {
      return { allow: false, reason: 'thread_active' }
    }
    if (input.lastHeartbeatAt && !atLeastDaysAgo(now, input.lastHeartbeatAt, HEARTBEAT_QUIET_DAYS)) {
      return { allow: false, reason: 'heartbeat_too_soon' }
    }
  }
  return { allow: true }
}

function atLeastDaysAgo(now: Date, then: Date, days: number): boolean {
  return now.getTime() - then.getTime() >= days * DAY_MS
}

/** The two newest agent messages are both proactive AND the user hasn't spoken since the older one. A user
 *  message at exactly the same instant counts as a reply (errs toward the user having engaged). */
function hasTwoUnansweredProactive(input: CadenceInput): boolean {
  const [newest, older] = [...input.recentAgentMessages].sort((a, b) => b.at.getTime() - a.at.getTime())
  if (!newest || !older || !newest.proactive || !older.proactive) return false
  if (!input.lastUserMessageAt) return true
  return input.lastUserMessageAt.getTime() < older.at.getTime()
}

// ── the read that feeds it ──────────────────────────────────────────────────────────────────────

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms) : null
}

/** Everything the governor needs beyond `now` + `kind`. Four small indexed reads, in parallel; the one
 *  place that turns storage into cadence numbers, so every sender means the same thing by "one a day". */
export async function cadenceInputsFor(
  db: DB,
  userId: string,
  threadId: string,
  now: Date,
  tz = APP_TZ,
): Promise<Omit<CadenceInput, 'now' | 'kind'>> {
  const dayStart = localDayStart(now, tz).toISOString()
  const [lastUser, agentTail, today, heartbeat] = await Promise.all([
    db
      .select({ createdAt: threadMessage.createdAt })
      .from(threadMessage)
      .where(and(eq(threadMessage.threadId, threadId), eq(threadMessage.sender, 'user')))
      .orderBy(desc(threadMessage.createdAt))
      .limit(1),
    db
      .select({ createdAt: threadMessage.createdAt, origin: threadMessage.origin })
      .from(threadMessage)
      .where(and(eq(threadMessage.threadId, threadId), eq(threadMessage.sender, 'agent')))
      .orderBy(desc(threadMessage.createdAt))
      .limit(10),
    // USER-WIDE on purpose: three threads must not buy three interruptions.
    db
      .select({ count: sql<number>`count(*)` })
      .from(threadMessage)
      .innerJoin(thread, eq(thread.id, threadMessage.threadId))
      .where(
        and(
          eq(thread.userId, userId),
          eq(threadMessage.sender, 'agent'),
          eq(threadMessage.origin, 'proactive'),
          gte(threadMessage.createdAt, dayStart),
        ),
      ),
    db
      .select({ deliveredAt: agentJob.deliveredAt })
      .from(agentJob)
      .where(and(eq(agentJob.userId, userId), eq(agentJob.kind, 'heartbeat'), isNotNull(agentJob.deliveredAt)))
      .orderBy(desc(agentJob.deliveredAt))
      .limit(1),
  ])
  return {
    lastUserMessageAt: parseDate(lastUser[0]?.createdAt),
    recentAgentMessages: agentTail.flatMap((row) => {
      const at = parseDate(row.createdAt)
      return at ? [{ at, proactive: row.origin === 'proactive' }] : []
    }),
    proactiveSendsToday: Number(today[0]?.count ?? 0),
    lastHeartbeatAt: parseDate(heartbeat[0]?.deliveredAt),
    tz,
  }
}
