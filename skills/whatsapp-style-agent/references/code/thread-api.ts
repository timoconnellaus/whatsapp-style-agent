// The session-gated REST API the chat client talks to. Thread ownership always comes from the VERIFIED
// session; every item route re-resolves the thread through getThread(userId, id), so another user's thread
// is a 404, never a leak.
//
//   GET    /api/threads                       → { threads: ThreadListItem[] }         (the inbox)
//   POST   /api/threads        {title?, message?} → { thread, messages }               (new thread)
//   GET    /api/threads/:id/messages[?afterTs=ISO] → { thread, messages }             (incremental poll)
//   POST   /api/threads/:id/messages {text}   → { messages: [userMessage, ...agentMessages] }
//   POST   /api/threads/:id/read              → { ok: true }                            (unread cursor)
//   POST   /api/threads/:id/reactions {itemId, reaction, reason?} → { recorded }
//   POST   /api/push/register {token, platform?} → { ok: true }
//
// Route /reactions BEFORE the general thread routes (or as its own Worker path), so a save/pass tap never
// queues behind a slow chat turn.
//
// POST /messages is SYNCHRONOUS: it returns the user message plus the agent's reply in one response
// (a few seconds). The client shows a typing indicator while it waits. Long work goes through work_on_it.

import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { AgentDomain } from './domain'
import { pushToken, type DB, type ThreadRow } from './schema'
import { createThread, getMessages, getThread, listThreads, markRead, postMessage, recordReaction } from './threads'
import { runTurn } from './turn'

export interface ApiDeps {
  db: DB
  model: LanguageModel
  domain: AgentDomain
  /** Your auth: the verified session's user id, or null. NEVER read a user id from a header or body. */
  getUserId(request: Request): Promise<string | null>
  /** Optional: one line about the user from your profile store, injected into the prompt. */
  profileLine?(userId: string): Promise<string | null>
  /** The first message a brand-new, empty thread shows: one question with answer chips. */
  intro: { question: string; options: string[] }
}

const CreateThread = z.object({ title: z.string().max(120).optional(), message: z.string().max(4000).optional() })
const PostMessage = z.object({ text: z.string().max(4000) })
const React = z.object({ itemId: z.string().min(1).max(200), reaction: z.enum(['saved', 'passed']), reason: z.string().max(80).optional() })
const RegisterPush = z.object({ token: z.string().min(1).max(4096), platform: z.string().max(20).optional() })

const json = (body: unknown, status = 200) => Response.json(body, { status })

async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  try {
    const text = await request.text()
    return schema.parse(text.trim() ? JSON.parse(text) : {})
  } catch (error) {
    return json({ error: error instanceof SyntaxError ? 'invalid JSON body' : 'invalid input', ...(error instanceof z.ZodError ? { issues: error.issues } : {}) }, 400)
  }
}

export async function handleThreadsApi(request: Request, deps: ApiDeps): Promise<Response | null> {
  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || (parts[1] !== 'threads' && parts[1] !== 'push')) return null

  const userId = await deps.getUserId(request)
  if (!userId) return json({ error: 'unauthorized' }, 401)
  const { db } = deps

  if (parts[1] === 'push' && parts[2] === 'register' && request.method === 'POST') {
    const input = await parse(request, RegisterPush)
    if (input instanceof Response) return input
    const now = new Date().toISOString()
    await db
      .insert(pushToken)
      .values({ token: input.token, userId, platform: input.platform ?? 'android', updatedAt: now })
      .onConflictDoUpdate({ target: pushToken.token, set: { userId, updatedAt: now } })
    return json({ ok: true })
  }

  if (parts.length === 2 && parts[1] === 'threads') {
    if (request.method === 'GET') return json({ threads: await listThreads(db, userId) })
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const input = await parse(request, CreateThread)
    if (input instanceof Response) return input
    if (input.message !== undefined && !input.message.trim()) return json({ error: 'message must not be empty' }, 400)
    const thread = await createThread(db, userId, input.title ?? '')
    if (input.message !== undefined) {
      await postMessage(db, { threadId: thread.id, sender: 'user', kind: 'text', body: { text: input.message.trim() } })
      await runTurn(db, deps.model, deps.domain, userId, thread, (await deps.profileLine?.(userId)) ?? null)
    } else {
      await postMessage(db, { threadId: thread.id, sender: 'agent', kind: 'question', body: { text: deps.intro.question, options: deps.intro.options } })
    }
    return json({ thread: (await getThread(db, userId, thread.id)) ?? thread, messages: await getMessages(db, thread.id, { limit: 200 }) })
  }

  if (parts.length !== 4 || parts[1] !== 'threads') return json({ error: 'not found' }, 404)
  let threadId: string
  try {
    threadId = decodeURIComponent(parts[2]!)
  } catch {
    return json({ error: 'invalid thread id' }, 400)
  }
  const thread = await getThread(db, userId, threadId)
  if (!thread) return json({ error: 'thread not found' }, 404)

  switch (parts[3]) {
    case 'messages':
      return handleMessages(request, deps, userId, thread)
    case 'read':
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      await markRead(db, userId, thread.id)
      return json({ ok: true })
    case 'reactions': {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      const input = await parse(request, React)
      if (input instanceof Response) return input
      // recorded:false = never shown in this thread — a stale client, not an error.
      return json(await recordReaction(db, thread.id, input.itemId, input.reaction, input.reason))
    }
    default:
      return json({ error: 'not found' }, 404)
  }
}

async function handleMessages(request: Request, deps: ApiDeps, userId: string, thread: ThreadRow): Promise<Response> {
  const { db } = deps
  if (request.method === 'GET') {
    const afterTs = new URL(request.url).searchParams.get('afterTs')?.trim() || undefined
    if (afterTs && (!Number.isFinite(Date.parse(afterTs)) || afterTs.length > 50)) return json({ error: 'invalid afterTs' }, 400)
    // Title + criteria ride every poll so the client's criteria chips stay live.
    return json({
      thread: { id: thread.id, title: thread.title, criteria: thread.criteria },
      messages: await getMessages(db, thread.id, { afterTs, limit: 200 }),
    })
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const input = await parse(request, PostMessage)
  if (input instanceof Response) return input
  const text = input.text.trim()
  if (!text) return json({ error: 'text must not be empty' }, 400)
  const userMessage = await postMessage(db, { threadId: thread.id, sender: 'user', kind: 'text', body: { text } })
  const agentMessages = await runTurn(db, deps.model, deps.domain, userId, thread, (await deps.profileLine?.(userId)) ?? null)
  return json({ messages: [userMessage, ...agentMessages] })
}
