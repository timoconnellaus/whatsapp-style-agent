import { describe, expect, it } from 'vitest'
import { fallbackNote, parseComposed, type ComposeFacts } from './compose'

const facts: ComposeFacts = {
  trigger: 'standing_sweep',
  criteria: {},
  searched: 40,
  alreadyShown: 3,
  candidates: [
    { id: 'a', fits: ['3 bedrooms'], misses: ['busy road'], score: 80 },
    { id: 'b', fits: ['under budget'], misses: [], score: null },
  ],
}

describe('parseComposed', () => {
  it('keeps only ids from this job, once each', () => {
    const out = parseComposed(
      JSON.stringify({
        note: 'Two new ones.',
        reasons: [
          { id: 'a', fit: 'three bedrooms', catch: 'on a busy road' },
          { id: 'a', fit: 'duplicate' },
          { id: 'invented', fit: 'made up' },
        ],
      }),
      facts,
    )
    expect(out).toEqual({ note: 'Two new ones.', reasons: [{ id: 'a', fit: 'three bedrooms', catch: 'on a busy road' }] })
  })

  it('tolerates prose around the JSON', () => {
    expect(parseComposed('Sure! {"note":"Hi.","reasons":[]} Hope that helps', facts).note).toBe('Hi.')
  })

  it('falls back to the deterministic note, with no invented words, when the reply is unusable', () => {
    expect(parseComposed('not json at all', facts)).toEqual({ note: fallbackNote(facts), reasons: [] })
  })
})
