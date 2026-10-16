// The WORK QUEUE. "I'll look into it and come back" becomes a row; a cron worker later claims, runs and
// delivers it. Two independent clocks:
//   run_at      — when a worker may START the job
//   deliver_by  — when the RESULT should have reached the user. Past it with delivered_at null = OWED.
// Idempotence is the UNIQUE dedup_key. Payloads are FACTS ONLY; prose is rendered at delivery.

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm'
import { agentJob, type DB, type JobKind, type JobRow } from './schema'
import { APP_TZ, localDateISO, localIsoWeek } from './local-time'

// Proactive dedup keys name the PERIOD the job is about. That gives idempotence (every tick in the period
// writes the same key) and perishability (the runner asks "is the key I'd mint NOW still this job's key?").
// They live next to enqueueJob so producers and the staleness check can never drift apart.
export const digestDedupKey = (threadId: string, now: Date, tz = APP_TZ) => `digest:${threadId}:${localDateISO(now, tz)}`
/** Keyed on the USER: a check-in is about their day; the thread is only where it lands. */
export const checkinDedupKey = (userId: string, now: Date, tz = APP_TZ) => `checkin:${userId}:${localDateISO(now, tz)}`
export const heartbeatDedupKey = (threadId: string, now: Date, tz = APP_TZ) => `heartbeat:${threadId}:${localIsoWeek(now, tz)}`

export interface NewJob {
  userId: string
  threadId: string
  kind: JobKind
  payload?: Record<string, unknown>
  runAt?: string
  deliverBy?: string | null
  dedupKey: string
}

/** Idempotent enqueue (ON CONFLICT DO NOTHING). `created` is false when the key already existed — the
 *  agent only says "I'll come back to you" for a promise it actually made. */
export async function enqueueJob(db: DB, job: NewJob): Promise<{ job: JobRow; created: boolean }> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db
    .insert(agentJob)
    .values({
      id,
      userId: job.userId,
      threadId: job.threadId,
      kind: job.kind,
      payload: job.payload ?? {},
      status: 'queued',
      runAt: job.runAt ?? now,
      deliverBy: job.deliverBy ?? null,
      deliveredAt: null,
      dedupKey: job.dedupKey,
      createdAt: now,
    })
    .onConflictDoNothing({ target: agentJob.dedupKey })
  const rows = await db.select().from(agentJob).where(eq(agentJob.dedupKey, job.dedupKey)).limit(1)
  if (!rows[0]) throw new Error('agent_job enqueue did not persist')
  return { job: rows[0], created: rows[0].id === id }
}

/** The promise of this kind the thread is still WAITING on (not delivered, not failed). The "already on it"
 *  guard: a REPHRASED ask hashes to a different dedup key, so the key alone wouldn't catch it. */
export async function findOpenJob(db: DB, threadId: string, kind: JobKind): Promise<JobRow | null> {
  const rows = await db
    .select()
    .from(agentJob)
    .where(and(eq(agentJob.threadId, threadId), eq(agentJob.kind, kind), isNull(agentJob.deliveredAt), ne(agentJob.status, 'failed')))
    .orderBy(desc(agentJob.createdAt))
    .limit(1)
  return rows[0] ?? null
}

/** Due queued jobs → running. The status guard on the UPDATE makes a second tick unable to double-run one.
 *  No lease: the cron is single-instance, and a job a crash left 'running' stays visible for a manual requeue. */
export async function claimDueJobs(db: DB, now: string, limit = 10): Promise<JobRow[]> {
  const due = await db
    .select()
    .from(agentJob)
    .where(and(eq(agentJob.status, 'queued'), lte(agentJob.runAt, now)))
    .orderBy(asc(agentJob.runAt))
    .limit(Math.max(1, Math.min(100, limit)))
  if (!due.length) return []
  await db
    .update(agentJob)
    .set({ status: 'running' })
    .where(and(inArray(agentJob.id, due.map((row) => row.id)), eq(agentJob.status, 'queued')))
  return due.map((row) => ({ ...row, status: 'running' as const }))
}

/** Cadence said "not now": back to queued at `runAt`. A deferred send is not a failed one. */
export async function rescheduleJob(db: DB, jobId: string, runAt: string): Promise<void> {
  await db.update(agentJob).set({ status: 'queued', runAt }).where(eq(agentJob.id, jobId))
}

async function mergedPayload(db: DB, jobId: string, patch: Record<string, unknown>) {
  const rows = await db.select({ payload: agentJob.payload }).from(agentJob).where(eq(agentJob.id, jobId)).limit(1)
  return { ...(rows[0]?.payload ?? {}), ...patch }
}

/** Finished; fold the structured RESULT (facts, never prose) into the payload. */
export async function markJobDone(db: DB, jobId: string, result?: Record<string, unknown>): Promise<void> {
  await db
    .update(agentJob)
    .set({ status: 'done', ...(result ? { payload: await mergedPayload(db, jobId, result) } : {}) })
    .where(eq(agentJob.id, jobId))
}

export async function markJobFailed(db: DB, jobId: string, error: string): Promise<void> {
  await db
    .update(agentJob)
    .set({ status: 'failed', payload: await mergedPayload(db, jobId, { error: error.slice(0, 500) }) })
    .where(eq(agentJob.id, jobId))
}

/** Idempotent: a re-call never moves the timestamp. */
export async function markJobDelivered(db: DB, jobId: string, now: string): Promise<void> {
  await db
    .update(agentJob)
    .set({ deliveredAt: now })
    .where(and(eq(agentJob.id, jobId), isNull(agentJob.deliveredAt)))
}

/** Promises past deliver_by with nothing delivered (failed excluded), oldest first. */
export async function listOverdueUndelivered(db: DB, now: string, limit = 50): Promise<JobRow[]> {
  return db
    .select()
    .from(agentJob)
    .where(and(isNotNull(agentJob.deliverBy), lte(agentJob.deliverBy, now), isNull(agentJob.deliveredAt), ne(agentJob.status, 'failed')))
    .orderBy(asc(agentJob.deliverBy))
    .limit(Math.max(1, Math.min(200, limit)))
}
