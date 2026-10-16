// Drizzle mirror of migration.sql — keep in lockstep.

import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

export type DB = DrizzleD1Database<Record<string, never>>

/** The goal's structured state (filters, preferences). App-defined; the agent edits it via update_criteria. */
export type Criteria = Record<string, unknown>

export const thread = sqliteTable(
  'thread',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    criteria: text('criteria', { mode: 'json' }).$type<Criteria>().notNull().default({}),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    /** The user's unread cursor: agent messages newer than this are unread. */
    lastReadAt: text('last_read_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_thread_user_status').on(t.userId, t.status)],
)
export type ThreadRow = typeof thread.$inferSelect

/** The model's per-item words: one clause on why it fits, one honest clause naming the catch. */
export interface ItemReason {
  id: string
  fit: string
  catch?: string
}

/**
 * The typed message bodies. Add fields ADDITIVELY (old clients render what they know); add a new kind only
 * with a client fallback (unknown kinds render as a text bubble).
 *   text      — plain prose
 *   items     — a card batch: ids only (the client fetches each card), plus the model's reasons and the
 *               server's deterministic scores
 *   question  — one question with 2–4 answer chips; tapping a chip sends it as the user's next message
 *   status    — a system-ish line ("I hit a snag…") styled quieter than prose
 */
export type MessageKind = 'text' | 'items' | 'question' | 'status'
export type MessageBody =
  | { text: string }
  | { itemIds: string[]; note?: string; reasons?: ItemReason[]; scores?: Record<string, number> }
  | { text: string; options: string[] }

export const threadMessage = sqliteTable(
  'thread_message',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    sender: text('sender').$type<'user' | 'agent'>().notNull(),
    kind: text('kind').$type<MessageKind>().notNull(),
    body: text('body', { mode: 'json' }).$type<MessageBody>().notNull(),
    /** null = part of a user-started turn; 'proactive' = the agent started it (cadence counts these). */
    origin: text('origin').$type<'proactive'>(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_thread_message_thread_created').on(t.threadId, t.createdAt),
    index('idx_thread_message_origin_created').on(t.origin, t.createdAt),
  ],
)
export type MessageRow = typeof threadMessage.$inferSelect

export type ShownSource = 'suggestion' | 'digest'
export type Reaction = 'saved' | 'passed'

export const shownItem = sqliteTable(
  'shown_item',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    threadId: text('thread_id').notNull(),
    itemId: text('item_id').notNull(),
    /** FIRST time it was shown in this thread — a re-record never moves it. */
    shownAt: text('shown_at').notNull(),
    source: text('source').$type<ShownSource>().notNull(),
    reaction: text('reaction').$type<Reaction>(),
    reactionReason: text('reaction_reason'),
    reactedAt: text('reacted_at'),
  },
  (t) => [
    uniqueIndex('idx_shown_item_thread_item').on(t.threadId, t.itemId),
    index('idx_shown_item_user').on(t.userId, t.shownAt),
  ],
)

/**
 * The units of async work.
 *   requested — the user asked ("find me something with X"); a PROMISE: always answered, never expires
 *   digest    — the agent's own daily sweep of the goal; silent when there is nothing new
 *   checkin   — an event-driven question tied to something real that happened today
 *   heartbeat — a weekly line into a thread the user has gone quiet on
 */
export type JobKind = 'requested' | 'digest' | 'checkin' | 'heartbeat'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export const agentJob = sqliteTable(
  'agent_job',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    threadId: text('thread_id').notNull(),
    kind: text('kind').$type<JobKind>().notNull(),
    /** Job input + (once run) its structured result. FACTS ONLY — prose is rendered at delivery. */
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    /** When a worker may START it. */
    runAt: text('run_at').notNull(),
    /** When the RESULT should have reached the user (null = no promise made). */
    deliverBy: text('deliver_by'),
    /** Stamped once the result is actually in the thread (null = still owed). */
    deliveredAt: text('delivered_at'),
    dedupKey: text('dedup_key').notNull().unique(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_agent_job_due').on(t.status, t.runAt),
    index('idx_agent_job_delivery').on(t.deliverBy, t.deliveredAt),
  ],
)
export type JobRow = typeof agentJob.$inferSelect

export const pushToken = sqliteTable(
  'push_token',
  {
    token: text('token').primaryKey(),
    userId: text('user_id').notNull(),
    platform: text('platform').notNull().default('android'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_push_token_user').on(t.userId)],
)
