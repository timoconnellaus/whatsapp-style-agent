// The DOMAIN PORT — the only file a new project rewrites. Everything else (threads, jobs, cadence, turn,
// runner) is domain-free and talks to your data through this interface.
//
// "Item" is whatever the agent recommends: a listing, a product, a job ad, a recipe, a flight.
// "Criteria" is the thread's goal state: filters and preferences the conversation sets.

import type { ToolSet } from 'ai'
import type { z } from 'zod'
import type { Criteria, DB } from './schema'

/** One compact search hit the MODEL sees. Keep it lean — the card the client renders carries the rest. */
export interface ItemHit {
  id: string
  [field: string]: unknown
}

/** One candidate a background job found, as FACTS the composer turns into words. */
export interface Candidate {
  id: string
  /** Short factual phrases on why it matches ("3 bedrooms", "under budget"). */
  fits: string[]
  /** Short factual phrases on where it falls short. Empty = no catch. */
  misses: string[]
  /** Deterministic 0–100 match score, or null when unscoreable. Never model-computed. */
  score: number | null
}

export interface ResearchFacts {
  /** What the user asked for (requested jobs), absent for the agent's own sweep. */
  task?: string
  trigger: 'requested' | 'standing_sweep'
  criteria: Criteria
  /** How many items the job looked through (after filtering, before the ledger diff). */
  searched: number
  /** Ranked candidates, NOT yet diffed against the ledger — the runner does that. */
  candidates: Candidate[]
  /** Optional: the single filter squeezing results to zero, for an honest empty-handed reply. */
  tightestFilter?: { filter: string; wouldMatch: number }
}

export interface AgentDomain {
  /** Product name and who the agent works for, e.g. "Acme's travel agent, working for the TRAVELLER". */
  persona: string
  /** What one thread is about, for the prompt: "ONE trip", "ONE property hunt". */
  goalNoun: string
  /** What the client card shows, so the model never restates it: "name, price and photo". */
  cardShows: string
  /** Zod object for a criteria patch. Use intArg/numArg for numbers; `.nullable()` clears a field. */
  criteriaPatch: z.ZodObject<z.ZodRawShape>
  /** A fast search over current items, within the thread's criteria plus one call's overrides. */
  search(db: DB, criteria: Criteria, overrides: Criteria, limit: number): Promise<ItemHit[]>
  /** Deterministic scores for a batch; fail-soft (return {}) — a score is a garnish, never a blocker. */
  scores?(db: DB, userId: string, itemIds: string[]): Promise<Record<string, number>>
  /** The slow, thorough look a background job runs. */
  research(db: DB, input: { userId: string; threadId: string; criteria: Criteria; task?: string; overrides?: Criteria }): Promise<ResearchFacts>
  /** Count items new since `since` that match the criteria — the heartbeat's one fact. */
  countNewSince?(db: DB, criteria: Criteria, since: string): Promise<number>
  /** Extra read-only tools (item history, the user's own notes…). Bound to the verified user. */
  extraTools?(ctx: { db: DB; userId: string; threadId: string }): ToolSet
  /** Extra prompt lines describing when to use extraTools. */
  extraRules?: string[]
}
