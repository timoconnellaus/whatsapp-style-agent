// The COMPOSER — the one place a background job's delivery is turned into words.
//
// Deterministic code decides WHETHER, WHEN and ABOUT WHAT to send; the model only writes the prose, and only
// from the facts the job produced. One call in, `{note, reasons}` out, parsed defensively. A missing model,
// a transport error or an off-schema reply all fall back to a deterministic sentence from the same facts:
// the delivery never fails because the words did. Swap the model at the call site and nothing else moves.

import { generateText, type LanguageModel } from 'ai'
import type { Candidate, ResearchFacts } from './domain'
import type { ItemReason } from './schema'

const MAX_NOTE = 400
const MAX_CLAUSE = 200

export interface Composed {
  note: string
  reasons: ItemReason[]
}

/** Facts in, after the ledger diff: only the candidates actually being sent. */
export type ComposeFacts = Omit<ResearchFacts, 'candidates'> & { candidates: Candidate[]; alreadyShown: number }

export function composePrompt(persona: string, cardShows: string): string {
  return `You are ${persona}. The JSON below is everything one piece of work turned up. Write the ONE message you send the user back.

WHY YOU ARE WRITING: when "task" is present, the user asked you to go away and do exactly that. When "trigger" is "standing_sweep", nobody asked — this is your own watch on their goal, so open with what has come up.

RELAY ONLY WHAT IS IN THE JSON. Every number and phrase you use must appear in it. Never invent or estimate a fact, never predict, and never judge value ("a bargain", "a good deal"). If something is missing, leave it out.

VOICE — plain words. No hype, no urgency, no emoji, no markdown, no lists, no greeting, no sign-off. Do not promise when you will next report back.

WRITE TWO THINGS:
- "note": 1 to 3 short sentences opening the message: what you went through and what you are sending. The app renders each item as a card showing its ${cardShows}, so never restate those.
- "reasons": one entry per id in "candidates", same order. "fit" = one short clause drawn from that candidate's "fits". "catch" = one short clause drawn from its "misses"; omit it only when it has none.

Return ONLY a JSON object: {"note": "...", "reasons": [{"id": "...", "fit": "...", "catch": "..."}]}`
}

export function fallbackNote(facts: ComposeFacts): string {
  return `Found ${facts.candidates.length} worth a look after going through ${facts.searched}.`
}

/** Drop anything the model made up: ids outside this job's candidates, empty clauses, duplicates. An
 *  unparseable reply yields the deterministic note with NO reasons — a card with no words beats invented ones. */
export function parseComposed(text: string, facts: ComposeFacts): Composed {
  const fallback: Composed = { note: fallbackNote(facts), reasons: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return fallback
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      return fallback
    }
  }
  if (!parsed || typeof parsed !== 'object') return fallback
  const obj = parsed as Record<string, unknown>
  const note = typeof obj.note === 'string' ? obj.note.trim().slice(0, MAX_NOTE) : ''
  const allowed = new Set(facts.candidates.map((c) => c.id))
  const used = new Set<string>()
  const reasons: ItemReason[] = []
  for (const raw of Array.isArray(obj.reasons) ? obj.reasons : []) {
    const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const fit = typeof e.fit === 'string' ? e.fit.trim().slice(0, MAX_CLAUSE) : ''
    if (!id || !fit || used.has(id) || !allowed.has(id)) continue
    used.add(id)
    const drawback = typeof e.catch === 'string' ? e.catch.trim().slice(0, MAX_CLAUSE) : ''
    reasons.push({ id, fit, ...(drawback ? { catch: drawback } : {}) })
  }
  return { note: note || fallbackNote(facts), reasons }
}

/** NEVER throws and never blocks a send. Low temperature; ask your provider for JSON output if it supports it. */
export async function composeDelivery(
  model: LanguageModel | undefined,
  facts: ComposeFacts,
  voice: { persona: string; cardShows: string },
): Promise<Composed> {
  if (!model) return { note: fallbackNote(facts), reasons: [] }
  try {
    const { text } = await generateText({
      model,
      prompt: `${composePrompt(voice.persona, voice.cardShows)}\n\nJSON:\n${JSON.stringify(facts)}`,
      temperature: 0.2,
      maxOutputTokens: 800,
    })
    return parseComposed(text, facts)
  } catch (err) {
    console.error('compose failed', String(err))
    return { note: fallbackNote(facts), reasons: [] }
  }
}
