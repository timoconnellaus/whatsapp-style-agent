// Thread, message and ledger storage. Deterministic D1 over drizzle — no policy lives here. The API layer
// owns the trust boundary: every user-facing read takes the VERIFIED session's userId.

import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import {
  shownItem,
  thread,
  threadMessage,
  type Criteria,
  type DB,
  type MessageBody,
  type MessageKind,
  type MessageRow,
  type Reaction,
  type ShownSource,
  type ThreadRow,
} from './schema'

export interface ThreadListItem extends ThreadRow {
  unreadCount: number
  lastMessage: { sender: 'user' | 'agent'; kind: MessageKind; preview: string; createdAt: string } | null
}

/** Criteria start EMPTY. Nothing is pre-filled from a profile: the conversation sets every filter, visibly,
 *  so the client's criteria chips never show state the user didn't put there. */
export async function createThread(db: DB, userId: string, title: string): Promise<ThreadRow> {
  const now = new Date().toISOString()
  const row: ThreadRow = {
    id: crypto.randomUUID(),
    userId,
    title: title.trim().slice(0, 120) || 'New chat',
    criteria: {},
    status: 'active',
    lastReadAt: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(thread).values(row)
  return row
}

/** One OWNER-SCOPED thread. Every route resolves the thread through this, so another user's id is a 404. */
export async function getThread(db: DB, userId: string, threadId: string): Promise<ThreadRow | null> {
  const rows = await db
    .select()
    .from(thread)
    .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

function previewOf(message: MessageRow): string {
  if (message.kind === 'items' && 'itemIds' in message.body) {
    const n = message.body.itemIds.length
    return `Sent ${n} item${n === 1 ? '' : 's'}`
  }
  const text = 'text' in message.body ? message.body.text : ''
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

/** The inbox: active threads newest-first, with unread counts (agent messages past the read cursor —
 *  the user's own messages never count) and a last-message preview. */
export async function listThreads(db: DB, userId: string): Promise<ThreadListItem[]> {
  const threads = await db
    .select()
    .from(thread)
    .where(and(eq(thread.userId, userId), eq(thread.status, 'active')))
    .orderBy(desc(thread.updatedAt))
  if (!threads.length) return []

  const unreadRows = await db
    .select({ threadId: threadMessage.threadId, count: sql<number>`count(*)` })
    .from(threadMessage)
    .innerJoin(thread, eq(thread.id, threadMessage.threadId))
    .where(
      and(
        eq(thread.userId, userId),
        eq(thread.status, 'active'),
        eq(threadMessage.sender, 'agent'),
        or(isNull(thread.lastReadAt), gt(threadMessage.createdAt, thread.lastReadAt)),
      ),
    )
    .groupBy(threadMessage.threadId)
  const unread = new Map(unreadRows.map((row) => [row.threadId, Number(row.count)]))

  const latest = new Map<string, MessageRow>()
  await Promise.all(
    threads.map(async (t) => {
      const rows = await db
        .select()
        .from(threadMessage)
        .where(eq(threadMessage.threadId, t.id))
        .orderBy(desc(threadMessage.createdAt))
        .limit(1)
      if (rows[0]) latest.set(t.id, rows[0])
    }),
  )

  return threads.map((t) => {
    const last = latest.get(t.id)
    return {
      ...t,
      unreadCount: unread.get(t.id) ?? 0,
      lastMessage: last
        ? { sender: last.sender, kind: last.kind, preview: previewOf(last), createdAt: last.createdAt }
        : null,
    }
  })
}

/** Every active thread across all users, with when its owner last spoke — the one read producers run on. */
export async function listActiveThreads(
  db: DB,
  limit = 500,
): Promise<{ id: string; userId: string; title: string; updatedAt: string; lastUserMessageAt: string | null }[]> {
  const threads = await db
    .select()
    .from(thread)
    .where(eq(thread.status, 'active'))
    .orderBy(desc(thread.updatedAt))
    .limit(Math.max(1, Math.min(2000, limit)))
  if (!threads.length) return []
  const lastUser = await db
    .select({ threadId: threadMessage.threadId, at: sql<string>`max(${threadMessage.createdAt})` })
    .from(threadMessage)
    .innerJoin(thread, eq(thread.id, threadMessage.threadId))
    .where(and(eq(thread.status, 'active'), eq(threadMessage.sender, 'user')))
    .groupBy(threadMessage.threadId)
  const byThread = new Map(lastUser.map((row) => [row.threadId, row.at]))
  return threads.map((t) => ({
    id: t.id,
    userId: t.userId,
    title: t.title,
    updatedAt: t.updatedAt,
    lastUserMessageAt: byThread.get(t.id) ?? null,
  }))
}

/** Chronological messages after an optional EXCLUSIVE timestamp cursor — the client's incremental poll. */
export async function getMessages(
  db: DB,
  threadId: string,
  { afterTs, limit = 50 }: { afterTs?: string; limit?: number } = {},
): Promise<MessageRow[]> {
  return db
    .select()
    .from(threadMessage)
    .where(
      afterTs
        ? and(eq(threadMessage.threadId, threadId), gt(threadMessage.createdAt, afterTs))
        : eq(threadMessage.threadId, threadId),
    )
    .orderBy(asc(threadMessage.createdAt))
    .limit(Math.max(1, Math.min(200, Math.trunc(limit))))
}

/** The newest `n` messages, paging forward so a long thread still includes its latest message. */
export async function recentMessages(db: DB, threadId: string, n: number): Promise<MessageRow[]> {
  let afterTs: string | undefined
  let recent: MessageRow[] = []
  while (true) {
    const page = await getMessages(db, threadId, { afterTs, limit: 200 })
    recent = [...recent, ...page].slice(-n)
    if (page.length < 200) return recent
    const next = page[page.length - 1]!.createdAt
    if (next === afterTs) return recent
    afterTs = next
  }
}

/** Append one typed message and bump the thread to the top of the inbox. Pushing is the CALLER's job. */
export async function postMessage(
  db: DB,
  input: { threadId: string; sender: 'user' | 'agent'; kind: MessageKind; body: MessageBody; origin?: 'proactive' },
): Promise<MessageRow> {
  const now = new Date().toISOString()
  const row: MessageRow = {
    id: crypto.randomUUID(),
    threadId: input.threadId,
    sender: input.sender,
    kind: input.kind,
    body: input.body,
    origin: input.origin ?? null,
    createdAt: now,
  }
  await db.insert(threadMessage).values(row)
  await db.update(thread).set({ updatedAt: now }).where(eq(thread.id, input.threadId))
  return row
}

export async function markRead(db: DB, userId: string, threadId: string): Promise<boolean> {
  if (!(await getThread(db, userId, threadId))) return false
  await db.update(thread).set({ lastReadAt: new Date().toISOString() }).where(eq(thread.id, threadId))
  return true
}

/** Merge a patch onto the thread's criteria. Absent keys are left alone; `null` clears a field. */
export async function updateCriteria(db: DB, threadId: string, patch: Criteria): Promise<Criteria | null> {
  const rows = await db.select({ criteria: thread.criteria }).from(thread).where(eq(thread.id, threadId)).limit(1)
  if (!rows[0]) return null
  const next: Criteria = { ...rows[0].criteria }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  await db.update(thread).set({ criteria: next, updatedAt: new Date().toISOString() }).where(eq(thread.id, threadId))
  return next
}

// ── the never-show-twice ledger ─────────────────────────────────────────────────────────────────

/** Record items as shown, IDEMPOTENTLY: the first shown_at and any reaction survive a re-record. Returns
 *  the ids that were NEW to this thread. */
export async function recordShown(
  db: DB,
  input: { userId: string; threadId: string; itemIds: string[]; source: ShownSource },
): Promise<string[]> {
  const ids = [...new Set(input.itemIds.filter(Boolean))]
  if (!ids.length) return []
  const seen = new Set(await listShownIds(db, input.threadId))
  const fresh = ids.filter((id) => !seen.has(id))
  const now = new Date().toISOString()
  for (const id of fresh) {
    await db
      .insert(shownItem)
      .values({
        id: crypto.randomUUID(),
        userId: input.userId,
        threadId: input.threadId,
        itemId: id,
        shownAt: now,
        source: input.source,
      })
      .onConflictDoNothing({ target: [shownItem.threadId, shownItem.itemId] })
  }
  return fresh
}

/** Every item id already shown in this thread, oldest first. */
export async function listShownIds(db: DB, threadId: string): Promise<string[]> {
  const rows = await db
    .select({ itemId: shownItem.itemId })
    .from(shownItem)
    .where(eq(shownItem.threadId, threadId))
    .orderBy(asc(shownItem.shownAt))
  return rows.map((row) => row.itemId)
}

/** Save/pass on a shown item. `recorded: false` = it was never shown here (a stale client, not an error).
 *  The latest reaction wins. A reason is memory: map it to a preference your profile can learn from. */
export async function recordReaction(
  db: DB,
  threadId: string,
  itemId: string,
  reaction: Reaction,
  reason?: string | null,
): Promise<{ recorded: boolean }> {
  const rows = await db
    .select({ id: shownItem.id })
    .from(shownItem)
    .where(and(eq(shownItem.threadId, threadId), eq(shownItem.itemId, itemId)))
    .limit(1)
  if (!rows[0]) return { recorded: false }
  await db
    .update(shownItem)
    .set({
      reaction,
      reactionReason: reason?.trim().slice(0, 80) || null,
      reactedAt: new Date().toISOString(),
    })
    .where(eq(shownItem.id, rows[0].id))
  return { recorded: true }
}
