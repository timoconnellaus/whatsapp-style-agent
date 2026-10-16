// THE TURN AGENT — one user message in, typed thread messages out. Unary (generateText), not streaming:
// the user is reading a chat thread, not watching a stream, so the reply lands as whole messages.
//
// A turn either answers NOW or takes the work AWAY:
//   • now  — search, suggest cards, ask one question, or just reply in a sentence or three
//   • away — work_on_it writes an agent_job row and ends the turn with a one-line ack; the job runner
//            does the digging out-of-band and messages back hours later through the cadence governor.
//            Nothing here waits on that — the promise IS the row.
//
// Three things keep the agent from re-asking or re-sending:
//   • CONTEXT IN THE PROMPT — the thread's criteria (and any profile summary) are injected each turn, so
//     the model knows the user without a tool round-trip
//   • THE LEDGER — every suggested id is recorded; already-shown ids are named in the prompt and flagged
//     `shownBefore` on search results (searches are NOT filtered by it: an explicit ask deserves full results)
//   • DETERMINISTIC SCORES — the model writes the fit/catch words; code computes any score on the card

import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentDomain } from './domain'
import { isTransientError } from './errors'
import { intArg } from './num-arg'
import { findOpenJob, enqueueJob } from './jobs'
import type { Criteria, DB, ItemReason, MessageBody, MessageKind, MessageRow, ThreadRow } from './schema'
import { listShownIds, postMessage, recentMessages, recordShown, updateCriteria } from './threads'

const SEARCH_LIMIT = 8
const HISTORY_LIMIT = 30
const SHOWN_PROMPT_LIMIT = 40
const MAX_STEPS = 8
const MAX_OUTPUT_TOKENS = 600
const TURN_RETRIES = 2
const TURN_RETRY_BACKOFF_MS = 300
/** When a requested job's result should have reached the user. NOT said out loud: the ack never names a time. */
export const WORK_DELIVER_BY_MS = 4 * 60 * 60 * 1000

// Deterministic lines. The model is told to say the ack and nothing else; it is also the fallback text.
export const WORK_ACK_TEXT = 'Leave it with me — I’ll have a proper look and message you when I’ve got something.'
export const WORK_ALREADY_ACK_TEXT = 'I’m already on that one — I’ll come back as soon as I have something worth sending.'
export const FAILURE_TEXT = 'Sorry — I hit a snag just now. Try me again in a moment.'
export const EMPTY_TURN_TEXT = 'I’m still working on that. Send me another detail and I’ll keep going.'

export interface ToolEvent {
  toolName: string
  input: unknown
  output: unknown
}

export interface AgentMessage {
  kind: MessageKind
  body: MessageBody
}

// ── prompt ──────────────────────────────────────────────────────────────────────────────────────

export interface TurnContext {
  thread: ThreadRow
  criteria: Criteria
  /** One compact line about the user from your profile store, or null. */
  profileLine: string | null
  shownIds: readonly string[]
}

/** Retuned for a thread the user reads hours later, on a phone: short, one question at most, plain text. */
export function systemPrompt(domain: AgentDomain, ctx: TurnContext): string {
  const shown = ctx.shownIds.slice(-SHOWN_PROMPT_LIMIT)
  return [
    `You are ${domain.persona}, working ${domain.goalNoun}. Truthful, unconflicted, and you name the catch.`,
    'VOICE — plain words, no jargon. No hype adjectives and no manufactured urgency. No emoji, no markdown, no headings, no lists: the app renders your words as plain chat bubbles. Warm, not chummy.',
    'LENGTH — this is an async thread read on a phone, often hours later. Write 1–3 short sentences. Lead with the answer: no preamble, no restating the question, no summing up.',
    'QUESTIONS — at most ONE question per message, and only when the answer changes what you would do next. Never ask for anything the criteria or profile below already say. Use ask_user so the app shows answer chips.',
    'HONESTY — when the data is thin, say so in a clause. Never invent an item, number or fact: every fact comes from a tool.',
    `CARDS — the app renders each suggested item as a card showing its ${domain.cardShows}. Never restate that; say only what the card cannot — why it fits, and the catch.`,
    'RULES — stay inside THIS thread. When the user states or changes a preference, call update_criteria BEFORE replying. Call search_items before recommending anything, and recommend only ids that search returned THIS turn, via suggest_items, each with a short fit clause and one honest catch. Put the user-facing words in suggest_items\' note, not in final prose. ask_user ends the turn.',
    'HARD RULE — when the ask needs real work rather than one quick search (a broad sweep, "find me something with X", comparing many options), call work_on_it and STOP. It ends the turn: reply with ONE short line saying you are on it — no items, no question, and never a time or deadline.',
    'ALREADY SHOWN — results flagged shownBefore were already sent in this thread. Do not recommend them again unless the user asks about that one.',
    ...(domain.extraRules ?? []),
    `Thread title: ${ctx.thread.title}`,
    `Current criteria: ${JSON.stringify(ctx.criteria)}`,
    ...(ctx.profileLine ? [`About the user: ${ctx.profileLine}`] : []),
    ...(shown.length ? [`Already shown in this thread: ${shown.join(', ')}`] : []),
  ].join('\n')
}

/** Typed messages become compact text for the model — it sees the conversation, not the card payloads. */
function compactBody(message: MessageRow): string {
  const body = message.body
  if (message.kind === 'items' && 'itemIds' in body) {
    return `Items: ${body.itemIds.join(', ')}${body.note ? ` — ${body.note}` : ''}`
  }
  if (message.kind === 'question' && 'options' in body) return `Question: ${body.text} [${body.options.join(' | ')}]`
  return 'text' in body ? body.text : JSON.stringify(body)
}

export function modelHistory(messages: MessageRow[]): ModelMessage[] {
  return messages.slice(-HISTORY_LIMIT).map((m) => ({
    role: m.sender === 'user' ? 'user' : 'assistant',
    content: compactBody(m),
  }))
}

// ── tools ───────────────────────────────────────────────────────────────────────────────────────

export interface ToolContext {
  db: DB
  /** The VERIFIED session owner — the trust boundary is the API layer, never the model. */
  userId: string
  threadId: string
  criteria: Criteria
  shownIds: readonly string[]
}

/** Per-turn toolset. Fresh per attempt: it carries turn state (ids searched this turn, the terminal flag). */
export function agentTools(domain: AgentDomain, ctx: ToolContext): { tools: ToolSet; isTurnEnded: () => boolean } {
  const { db, userId, threadId } = ctx
  let criteria = ctx.criteria
  /** Set by a TERMINAL tool (ask_user, work_on_it): the loop stops as soon as one runs. */
  let turnEnded = false
  const searched = new Set<string>()
  const shown = new Set(ctx.shownIds)
  const SearchOverrides = domain.criteriaPatch.extend({ limit: intArg({ min: 1, max: SEARCH_LIMIT }).optional() })

  const tools: ToolSet = {
    search_items: tool({
      description: `Search current items within this thread's criteria, optionally overriding fields for this search only. Returns up to ${SEARCH_LIMIT} compact matches; one already sent in this thread comes back flagged shownBefore.`,
      inputSchema: SearchOverrides,
      execute: async (input) => {
        const { limit, ...overrides } = input as Criteria & { limit?: number }
        const hits = await domain.search(db, criteria, overrides, limit ?? SEARCH_LIMIT)
        for (const hit of hits) searched.add(hit.id)
        return { count: hits.length, items: hits.map((hit) => (shown.has(hit.id) ? { ...hit, shownBefore: true } : hit)) }
      },
    }),
    update_criteria: tool({
      description: 'Persist preferences the user stated onto THIS thread. Send only fields that changed; null clears a field.',
      inputSchema: domain.criteriaPatch,
      execute: async (patch) => {
        const next = await updateCriteria(db, threadId, patch as Criteria)
        if (!next) throw new Error('thread not found')
        criteria = next
        return { criteria }
      },
    }),
    suggest_items: tool({
      description:
        'Send item recommendations as cards. Every id must have been returned by search_items THIS turn. Give each id a reasons entry: ONE short clause on why it fits, ONE honest clause naming the catch (omit only if there genuinely is none). Never restate what the card shows.',
      inputSchema: z.object({
        itemIds: z.array(z.string().min(1).max(200)).min(1).max(SEARCH_LIMIT),
        note: z.string().min(1).max(500),
        reasons: z
          .array(z.object({ id: z.string().min(1).max(200), fit: z.string().min(1).max(200), catch: z.string().max(200).optional() }))
          .max(SEARCH_LIMIT)
          .optional(),
      }),
      execute: async ({ itemIds, note, reasons }) => {
        const ids = [...new Set(itemIds)]
        // Fail closed: the model can only recommend what this turn's search actually returned.
        if (ids.some((id) => !searched.has(id))) throw new Error('suggest_items contained an id not returned by this turn’s search')
        const scores = domain.scores ? await domain.scores(db, userId, ids).catch(() => ({})) : {}
        // The ledger write is fail-soft: losing it must not lose the user's reply.
        await recordShown(db, { userId, threadId, itemIds: ids, source: 'suggestion' }).catch((err) =>
          console.error('ledger write failed', String(err)),
        )
        for (const id of ids) shown.add(id)
        const cleaned = cleanReasons(reasons, ids)
        return {
          itemIds: ids,
          note: note.trim(),
          ...(cleaned.length ? { reasons: cleaned } : {}),
          ...(Object.keys(scores).length ? { scores } : {}),
        }
      },
    }),
    ask_user: tool({
      description:
        'Ask exactly one clarifying question with 2–4 short answer chips, and finish the turn. Only when the answer changes what you would do next.',
      inputSchema: z.object({
        question: z.string().min(1).max(500),
        options: z.array(z.string().min(1).max(80)).min(2).max(4),
      }),
      execute: async ({ question, options }) => {
        turnEnded = true
        return { question: question.trim(), options: options.map((o) => o.trim()) }
      },
    }),
    work_on_it: tool({
      description:
        'Take the request away as a JOB and come back later. Use it when the ask needs a proper look rather than one quick search. Put what they want in `task`, in their own words; send `criteria` only for filters this job adds on top of the thread\'s. It ENDS the turn: then reply with ONE short line saying you are on it — no items, no questions, never a time.',
      inputSchema: z.object({ task: z.string().min(1).max(500), criteria: domain.criteriaPatch.optional() }),
      execute: async ({ task, criteria: overrides }) => {
        turnEnded = true
        const cleanTask = task.trim().slice(0, 500)
        // Already on it? Catches a REPHRASED ask, which hashes to a different dedup key.
        if (await findOpenJob(db, threadId, 'requested')) {
          return { status: 'already_working' as const, task: cleanTask, ack: WORK_ALREADY_ACK_TEXT }
        }
        const now = Date.now()
        const { created } = await enqueueJob(db, {
          userId,
          threadId,
          kind: 'requested',
          // Facts only — the runner re-reads live criteria at run time.
          payload: { task: cleanTask, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) },
          runAt: new Date(now).toISOString(),
          deliverBy: new Date(now + WORK_DELIVER_BY_MS).toISOString(),
          // The same ask twice (a double-send) is ONE job.
          dedupKey: `requested:${threadId}:${await sha256(cleanTask.toLowerCase().replace(/\s+/g, ' '))}`,
        })
        return { status: created ? ('queued' as const) : ('already_working' as const), task: cleanTask, ack: created ? WORK_ACK_TEXT : WORK_ALREADY_ACK_TEXT }
      },
    }),
    ...(domain.extraTools?.({ db, userId, threadId }) ?? {}),
  }
  return { tools, isTurnEnded: () => turnEnded }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── the seam between the tool loop and persisted messages ───────────────────────────────────────

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}
function cleanString(v: unknown, max = 500): string | undefined {
  if (typeof v !== 'string') return undefined
  return v.trim().slice(0, max) || undefined
}
function cleanStrings(v: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    const s = cleanString(raw, maxLength)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

/** The model's fit/catch clauses, kept only for ids actually in the batch, one per id. */
export function cleanReasons(value: unknown, ids: readonly string[]): ItemReason[] {
  if (!Array.isArray(value)) return []
  const out: ItemReason[] = []
  const used = new Set<string>()
  for (const raw of value) {
    const e = rec(raw)
    const id = cleanString(e?.id, 200)
    const fit = cleanString(e?.fit, 200)
    if (!id || !fit || used.has(id) || !ids.includes(id)) continue
    used.add(id)
    const drawback = cleanString(e?.catch, 200)
    out.push({ id, fit, ...(drawback ? { catch: drawback } : {}) })
  }
  return out
}

/**
 * PURE: final text + tool results → the messages to persist. Typed terminal tools win over prose so the
 * client never gets one recommendation twice (as text AND as a card). Ordering:
 *   question present → [cards…, text?, question]
 *   work ticket      → [cards…, one line] (the model's line, else the ticket's ack — never an empty turn)
 *   cards            → [cards…] (their note carries the words)
 *   text             → [text]
 *   nothing          → [status]
 */
export function messagesFromTurn(finalText: string, events: readonly ToolEvent[]): AgentMessage[] {
  const text = finalText.trim()
  const cards: AgentMessage[] = []
  let question: AgentMessage | null = null
  let workAck: string | null = null

  for (const event of events) {
    const value = rec(event.output) ?? rec(event.input)
    if (!value) continue
    if (event.toolName === 'suggest_items') {
      const itemIds = cleanStrings(value.itemIds, 20, 200)
      if (!itemIds.length) continue
      const note = cleanString(value.note, 500)
      const reasons = cleanReasons(value.reasons, itemIds)
      const scores = rec(value.scores) ?? {}
      const cleanScores = Object.fromEntries(
        itemIds.flatMap((id) => {
          const s = Number(scores[id])
          return Number.isFinite(s) && s >= 0 && s <= 100 ? [[id, Math.trunc(s)]] : []
        }),
      )
      cards.push({
        kind: 'items',
        body: {
          itemIds,
          ...(note ? { note } : {}),
          ...(reasons.length ? { reasons } : {}),
          ...(Object.keys(cleanScores).length ? { scores: cleanScores } : {}),
        },
      })
    }
    if (event.toolName === 'work_on_it' && workAck === null) workAck = cleanString(value.ack, 300) ?? null
    if (event.toolName === 'ask_user' && question === null) {
      const q = cleanString(value.question ?? value.text, 500)
      const options = cleanStrings(value.options, 4, 80)
      if (q && options.length >= 2) question = { kind: 'question', body: { text: q, options } }
    }
  }

  if (question) return [...cards, ...(text ? [{ kind: 'text' as const, body: { text } }] : []), question]
  if (workAck) return [...cards, { kind: 'text', body: { text: text || workAck } }]
  if (cards.length) return cards
  if (text) return [{ kind: 'text', body: { text } }]
  return [{ kind: 'status', body: { text: EMPTY_TURN_TEXT } }]
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

/** A tool threw mid-turn (DB hiccup, upstream timeout). Distinct type so the retry can treat it as transient. */
class TurnToolError extends Error {}

/**
 * Run one turn and persist its messages. Never throws: a turn that cannot finish posts FAILURE_TEXT as a
 * status message, and the real error goes to the log.
 *
 * Retrying a whole unary turn is safe ONLY because every side-effecting tool is idempotent: update_criteria
 * re-applies the same patch, recordShown upserts, work_on_it is dedup-guarded. Keep it that way when you
 * add tools, or drop the retry.
 */
export async function runTurn(
  db: DB,
  model: LanguageModel,
  domain: AgentDomain,
  userId: string,
  thread: ThreadRow,
  profileLine: string | null = null,
): Promise<MessageRow[]> {
  try {
    const [shownIds, history] = await Promise.all([listShownIds(db, thread.id), recentMessages(db, thread.id, HISTORY_LIMIT)])
    const ctx = { thread, criteria: thread.criteria, profileLine, shownIds }
    for (let attempt = 0; ; attempt++) {
      const turn = agentTools(domain, { db, userId, threadId: thread.id, criteria: thread.criteria, shownIds })
      try {
        const result = await generateText({
          model,
          system: systemPrompt(domain, ctx),
          messages: modelHistory(history),
          tools: turn.tools,
          stopWhen: [stepCountIs(MAX_STEPS), () => turn.isTurnEnded()],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        })
        if (result.steps.some((step) => step.content.some((part) => part.type === 'tool-error'))) {
          throw new TurnToolError('tool execution failed')
        }
        const events: ToolEvent[] = result.steps.flatMap((step) =>
          step.toolResults.map((r) => ({ toolName: r.toolName, input: r.input, output: r.output })),
        )
        return persist(db, thread.id, messagesFromTurn(result.text, events))
      } catch (error) {
        if (attempt >= TURN_RETRIES || !(isTransientError(error) || error instanceof TurnToolError)) throw error
        console.warn('turn retrying', { threadId: thread.id, attempt: attempt + 1, error: String(error) })
        await new Promise((r) => setTimeout(r, TURN_RETRY_BACKOFF_MS * (attempt + 1)))
      }
    }
  } catch (error) {
    console.error('turn failed', { threadId: thread.id, error: String(error) })
    return persist(db, thread.id, [{ kind: 'status', body: { text: FAILURE_TEXT } }])
  }
}

async function persist(db: DB, threadId: string, messages: AgentMessage[]): Promise<MessageRow[]> {
  const rows: MessageRow[] = []
  for (const m of messages) rows.push(await postMessage(db, { threadId, sender: 'agent', kind: m.kind, body: m.body }))
  return rows
}
