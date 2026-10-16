import { describe, expect, it } from 'vitest'
import { allowProactiveSend, type CadenceInput } from './cadence'

// Australia/Sydney: AEST = UTC+10 in winter. 2026-07-15T02:00Z = 12:00 local.
const NOON = new Date('2026-07-15T02:00:00Z')
const DAY = 86_400_000

function input(over: Partial<CadenceInput> = {}): CadenceInput {
  return {
    now: NOON,
    kind: 'digest',
    lastUserMessageAt: null,
    recentAgentMessages: [],
    proactiveSendsToday: 0,
    lastHeartbeatAt: null,
    ...over,
  }
}

describe('allowProactiveSend', () => {
  it('blocks every kind in quiet hours and retries at 08:00 local', () => {
    const late = new Date('2026-07-15T12:00:00Z') // 22:00 local
    const verdict = allowProactiveSend(input({ now: late, kind: 'work_delivery' }))
    expect(verdict).toEqual({ allow: false, reason: 'quiet_hours', retryAt: new Date('2026-07-15T22:00:00Z') })
  })

  it('allows one proactive a day, but requested work is exempt', () => {
    expect(allowProactiveSend(input({ proactiveSendsToday: 1 }))).toMatchObject({ allow: false, reason: 'daily_budget' })
    expect(allowProactiveSend(input({ proactiveSendsToday: 1, kind: 'work_delivery' }))).toEqual({ allow: true })
  })

  it('never sends a third unanswered proactive in a row', () => {
    const two = [
      { at: new Date(NOON.getTime() - 2 * DAY), proactive: true },
      { at: new Date(NOON.getTime() - DAY), proactive: true },
    ]
    expect(allowProactiveSend(input({ recentAgentMessages: two }))).toEqual({ allow: false, reason: 'unanswered' })
    // A reply after the older one re-opens the door.
    const replied = new Date(NOON.getTime() - 1.5 * DAY)
    expect(allowProactiveSend(input({ recentAgentMessages: two, lastUserMessageAt: replied }))).toEqual({ allow: true })
  })

  it('sends a heartbeat only into a quiet thread, at most weekly', () => {
    const active = new Date(NOON.getTime() - 2 * DAY)
    const quiet = new Date(NOON.getTime() - 8 * DAY)
    expect(allowProactiveSend(input({ kind: 'heartbeat', lastUserMessageAt: active }))).toEqual({ allow: false, reason: 'thread_active' })
    expect(allowProactiveSend(input({ kind: 'heartbeat', lastUserMessageAt: quiet, lastHeartbeatAt: active }))).toEqual({
      allow: false,
      reason: 'heartbeat_too_soon',
    })
    expect(allowProactiveSend(input({ kind: 'heartbeat', lastUserMessageAt: quiet }))).toEqual({ allow: true })
  })

  it('resolves quiet hours across a DST switch (AEDT = UTC+11 from October)', () => {
    // 2026-10-15T10:30Z = 21:30 AEDT → quiet; retry is 08:00 AEDT = 21:00Z.
    const verdict = allowProactiveSend(input({ now: new Date('2026-10-15T10:30:00Z') }))
    expect(verdict).toEqual({ allow: false, reason: 'quiet_hours', retryAt: new Date('2026-10-15T21:00:00Z') })
  })
})
