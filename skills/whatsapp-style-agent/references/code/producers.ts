// The PROACTIVE PRODUCERS — the half that decides there is something worth saying at all. Runs at the top of
// the runner's tick. Every producer is safe on every tick: each dedup key names the PERIOD it is about, so the
// second and hundredth tick of that period write nothing.
//
// NOTHING here decides whether a message may be SENT. Producing is cheap and reversible; the cadence governor
// rules on every job at delivery time, and the runner retires a job whose period has passed.

import type { DB } from './schema'
import { checkinDedupKey, digestDedupKey, enqueueJob, heartbeatDedupKey } from './jobs'
import { listActiveThreads } from './threads'

/** A thread the user hasn't spoken in for this long is quiet enough to check in on… */
export const HEARTBEAT_SILENT_DAYS = 7
/** …and one this silent is over: talking into it is talking to nobody. */
export const HEARTBEAT_DEAD_DAYS = 60
const DAY_MS = 86_400_000

export interface ProducerHooks {
  /** Users with a real event TODAY worth a check-in, with its measured facts — or omit for no check-ins.
   *  Example: users who had appointments today, with the count. Ground it in what storage can prove. */
  checkins?(db: DB, now: Date): Promise<Map<string, Record<string, unknown>>>
}

export async function runProducers(db: DB, now: Date, hooks: ProducerHooks = {}) {
  const threads = await listActiveThreads(db)
  const stats = { threads: threads.length, digests: 0, heartbeats: 0, checkins: 0 }

  // digest — one standing sweep per active thread per local day. Unconditional on purpose: whether anything
  // is new is a question only the ledger diff answers, and the runner answers "no" with silence.
  for (const t of threads) {
    const { created } = await enqueueJob(db, {
      userId: t.userId,
      threadId: t.id,
      kind: 'digest',
      payload: { trigger: 'standing_sweep' },
      runAt: now.toISOString(),
      dedupKey: digestDedupKey(t.id, now),
    })
    if (created) stats.digests++
  }

  // heartbeat — one per quiet-but-not-dead thread per ISO week. Never for a thread the user never spoke in:
  // that is not silence, it is a conversation that never started.
  for (const t of threads) {
    if (!t.lastUserMessageAt) continue
    const silentDays = (now.getTime() - Date.parse(t.lastUserMessageAt)) / DAY_MS
    if (!(silentDays >= HEARTBEAT_SILENT_DAYS && silentDays <= HEARTBEAT_DEAD_DAYS)) continue
    const { created } = await enqueueJob(db, {
      userId: t.userId,
      threadId: t.id,
      kind: 'heartbeat',
      // Count what is new since the user LAST SPOKE, not since now.
      payload: { since: t.lastUserMessageAt },
      runAt: now.toISOString(),
      dedupKey: heartbeatDedupKey(t.id, now),
    })
    if (created) stats.heartbeats++
  }

  // checkin — delivered into the user's most recently active thread.
  const due = (await hooks.checkins?.(db, now)) ?? new Map()
  if (due.size) {
    const latest = new Map<string, (typeof threads)[number]>()
    for (const t of threads) if (!latest.has(t.userId)) latest.set(t.userId, t) // threads arrive newest-first
    for (const [userId, facts] of due) {
      const t = latest.get(userId)
      if (!t) continue
      const { created } = await enqueueJob(db, {
        userId,
        threadId: t.id,
        kind: 'checkin',
        payload: facts,
        runAt: now.toISOString(),
        dedupKey: checkinDedupKey(userId, now),
      })
      if (created) stats.checkins++
    }
  }
  return stats
}
