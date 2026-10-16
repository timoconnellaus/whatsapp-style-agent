// THE JOB RUNNER — the second speed. A cron tick (every 10 minutes) claims due jobs, does the work, and
// messages the user back. Wire it in the Worker's `scheduled` handler under ctx.waitUntil with a catch:
//
//   async scheduled(_event, env, ctx) { ctx.waitUntil(runJobs(deps(env)).catch((e) => console.error(e))) }
//
// Per tick:
//   0. produce    — queue the period's proactive work (producers.ts)
//   1. claim      — due queued → running; sorted by VALUE so when the daily budget fits one message, the one
//                   carrying items wins it
//   2. stale      — a proactive job whose period has passed is retired, not delivered late
//   3. cadence    — checked BEFORE the work, so a 03:00 tick spends no search or model call on a message it
//                   can't send; blocked → back to queued at retryAt
//   4. execute → deliver (post the message, record the ledger, push) → mark
// Then SWEEP promises past deliver_by that nothing delivered: an honest fallback beats silence.
//
// SILENCE IS A RESULT. A digest with nothing new sends nothing — no message, no push. Requested work ALWAYS
// answers, even empty-handed: they asked. Everything the user reads is deterministic text built from the
// job's facts, or one composer pass over those facts. The model never decides whether or when to speak.

import type { LanguageModel } from 'ai'
import { allowProactiveSend, cadenceInputsFor, type ProactiveKind } from './cadence'
import { composeDelivery, type ComposeFacts } from './compose'
import type { AgentDomain, ResearchFacts } from './domain'
import {
  checkinDedupKey,
  claimDueJobs,
  digestDedupKey,
  heartbeatDedupKey,
  listOverdueUndelivered,
  markJobDelivered,
  markJobDone,
  markJobFailed,
  rescheduleJob,
} from './jobs'
import { runProducers, type ProducerHooks } from './producers'
import { sendPushes } from './push'
import type { DB, JobKind, JobRow } from './schema'
import { getThread, listShownIds, postMessage, recordShown } from './threads'

export interface RunnerDeps {
  db: DB
  domain: AgentDomain
  /** The composer model; undefined = deterministic notes only (a kill switch for model spend). */
  composer?: LanguageModel
  fcmServiceAccountJson?: string
  /** Product name for push titles. */
  appName: string
  producers?: ProducerHooks
  /** Deterministic copy for the check-in, from the facts its producer measured. */
  checkinText?(facts: Record<string, unknown>): string
}

const CLAIM_LIMIT = 10
const MAX_SEND = 5
const BLIND_RETRY_MS = 60 * 60 * 1000
export const JOB_FALLBACK_TEXT = 'I couldn’t finish that properly — give me a nudge and I’ll try again.'

const CADENCE_KIND: Record<JobKind, ProactiveKind> = {
  requested: 'work_delivery',
  digest: 'digest',
  checkin: 'checkin',
  heartbeat: 'heartbeat',
}
const KIND_ORDER: Record<JobKind, number> = { requested: 0, digest: 1, checkin: 2, heartbeat: 3 }

export function heartbeatText(newSince: number): string {
  if (newSince <= 0) return 'Quiet week here — nothing new has come up since we last spoke. I’ll keep watching.'
  return `Still on it — ${newSince} new ${newSince === 1 ? 'one has' : 'ones have'} come up since we last spoke. Want me to send them through?`
}

/** The honest empty-handed reply to REQUESTED work, from the job's own counts. */
export function emptyHandedText(facts: ResearchFacts): string {
  if (facts.searched === 0) {
    const tight = facts.tightestFilter
    const squeeze = tight ? ` The ${tight.filter} is what’s squeezing it — without it there are ${tight.wouldMatch}.` : ''
    return `Nothing fits right now.${squeeze} I’ll keep at it.`
  }
  return `Went through ${facts.searched} — nothing there you haven’t already seen. I’ll keep at it.`
}

/** Is this job about a period that has passed? Reuses the producers' key builders, so they can't drift.
 *  `requested` never expires: it is a promise, and the overdue sweep answers for it. */
export function isStale(job: Pick<JobRow, 'kind' | 'userId' | 'threadId' | 'dedupKey'>, now: Date): boolean {
  const current =
    job.kind === 'digest'
      ? digestDedupKey(job.threadId, now)
      : job.kind === 'checkin'
        ? checkinDedupKey(job.userId, now)
        : job.kind === 'heartbeat'
          ? heartbeatDedupKey(job.threadId, now)
          : null
  return current !== null && current !== job.dedupKey
}

/** Research, then diff against the ledger: never re-send an item this thread has already seen. */
async function freshFacts(deps: RunnerDeps, job: JobRow): Promise<ComposeFacts> {
  const thread = await getThread(deps.db, job.userId, job.threadId)
  if (!thread) throw new Error('thread not found')
  const task = typeof job.payload.task === 'string' ? job.payload.task : undefined
  const overrides = (job.payload.overrides ?? undefined) as Record<string, unknown> | undefined
  const facts = await deps.domain.research(deps.db, { userId: job.userId, threadId: job.threadId, criteria: thread.criteria, task, overrides })
  const shown = new Set(await listShownIds(deps.db, job.threadId))
  const fresh = facts.candidates.filter((c) => !shown.has(c.id))
  return { ...facts, candidates: fresh.slice(0, MAX_SEND), alreadyShown: facts.candidates.length - fresh.length }
}

/** Post the items message (composed words + deterministic scores), then the ledger (fail-soft: a sent
 *  message must never become a failed job, or it would be re-sent). */
async function postItems(deps: RunnerDeps, job: JobRow, facts: ComposeFacts): Promise<string[]> {
  const itemIds = facts.candidates.map((c) => c.id)
  const composed = await composeDelivery(deps.composer, facts, deps.domain)
  const scores = Object.fromEntries(facts.candidates.flatMap((c) => (c.score === null ? [] : [[c.id, c.score]])))
  await postMessage(deps.db, {
    threadId: job.threadId,
    sender: 'agent',
    kind: 'items',
    body: { itemIds, note: composed.note, ...(composed.reasons.length ? { reasons: composed.reasons } : {}), ...(Object.keys(scores).length ? { scores } : {}) },
    origin: 'proactive',
  })
  await recordShown(deps.db, { userId: job.userId, threadId: job.threadId, itemIds, source: 'digest' }).catch((err) =>
    console.error('ledger write failed', String(err)),
  )
  return itemIds
}

async function postLine(deps: RunnerDeps, job: JobRow, text: string): Promise<void> {
  await postMessage(deps.db, { threadId: job.threadId, sender: 'agent', kind: 'text', body: { text }, origin: 'proactive' })
}

function push(deps: RunnerDeps, job: JobRow, body: string): Promise<void> {
  return sendPushes(deps.db, deps.fcmServiceAccountJson, [{ userId: job.userId, threadId: job.threadId, title: deps.appName, body }])
}

/** Only a PROMISE gets an apology: the user asked, so a silent failure would be a promise that evaporates.
 *  Unrequested work fails silently into the row. The fallback is a plain line — no push, no cadence. */
async function failJob(deps: RunnerDeps, job: JobRow, error: string): Promise<void> {
  await markJobFailed(deps.db, job.id, error)
  if (job.kind !== 'requested') return
  await postLine(deps, job, JOB_FALLBACK_TEXT).catch((err) => console.error('fallback post failed', String(err)))
}

export async function runJobs(deps: RunnerDeps, opts: { now?: Date; produce?: boolean } = {}) {
  const { db } = deps
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const stats = { claimed: 0, delivered: 0, silent: 0, rescheduled: 0, expired: 0, failed: 0, swept: 0 }

  // Swallow-wrapped: the user is owed the deliveries below whether or not a producer read fell over.
  if (opts.produce !== false) await runProducers(db, now, deps.producers).catch((err) => console.error('producers failed', String(err)))

  const claimed = await claimDueJobs(db, nowIso, CLAIM_LIMIT)
  stats.claimed = claimed.length
  claimed.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  const handled = new Set<string>()

  for (const job of claimed) {
    handled.add(job.id)
    try {
      if (isStale(job, now)) {
        await markJobDone(db, job.id, { noSend: true, expired: true })
        stats.expired++
        continue
      }
      const verdict = allowProactiveSend({ now, kind: CADENCE_KIND[job.kind], ...(await cadenceInputsFor(db, job.userId, job.threadId, now)) })
      if (!verdict.allow) {
        await rescheduleJob(db, job.id, (verdict.retryAt ?? new Date(now.getTime() + BLIND_RETRY_MS)).toISOString())
        stats.rescheduled++
        continue
      }

      switch (job.kind) {
        case 'requested': {
          const facts = await freshFacts(deps, job)
          const itemIds = facts.candidates.length ? await postItems(deps, job, facts) : []
          if (!itemIds.length) await postLine(deps, job, emptyHandedText(facts))
          await push(deps, job, itemIds.length ? `I had a look — ${itemIds.length} worth a look` : 'I had a look — nothing new yet')
          await markJobDone(db, job.id, { searched: facts.searched, alreadyShown: facts.alreadyShown, itemIds })
          break
        }
        case 'digest': {
          const facts = await freshFacts(deps, job)
          if (!facts.candidates.length) {
            // Nothing new. Say nothing — no message, no push, no spent budget.
            await markJobDone(db, job.id, { noSend: true, searched: facts.searched, alreadyShown: facts.alreadyShown })
            stats.silent++
            continue
          }
          const itemIds = await postItems(deps, job, facts)
          await push(deps, job, `${itemIds.length} new worth a look`)
          await markJobDone(db, job.id, { searched: facts.searched, alreadyShown: facts.alreadyShown, itemIds })
          break
        }
        case 'checkin': {
          if (!deps.checkinText) throw new Error('checkin job without checkinText')
          // The producer measured the facts; the day they describe is over, so don't re-read them.
          const text = deps.checkinText(job.payload)
          await postLine(deps, job, text)
          await push(deps, job, text)
          await markJobDone(db, job.id, { sent: true })
          break
        }
        case 'heartbeat': {
          // One counted fact, read at delivery time so the number is current.
          const since = typeof job.payload.since === 'string' ? job.payload.since : null
          const thread = await getThread(db, job.userId, job.threadId)
          const newSince = since && thread && deps.domain.countNewSince ? await deps.domain.countNewSince(db, thread.criteria, since) : 0
          const text = heartbeatText(newSince)
          await postLine(deps, job, text)
          await push(deps, job, text)
          await markJobDone(db, job.id, { since, newSince })
          break
        }
      }
      await markJobDelivered(db, job.id, nowIso)
      stats.delivered++
    } catch (err) {
      console.error('job failed', job.id, job.kind, String(err))
      await failJob(deps, job, String(err))
      stats.failed++
    }
  }

  // Sweep the promises we OWE. A quiet-hours reschedule (run_at in the future) is waiting its turn, not stuck.
  for (const job of await listOverdueUndelivered(db, nowIso)) {
    if (handled.has(job.id) || job.runAt > nowIso) continue
    await failJob(deps, job, 'deliver_by passed with nothing delivered')
    stats.swept++
  }
  return stats
}
