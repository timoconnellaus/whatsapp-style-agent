import { describe, expect, it } from 'vitest'
import { EMPTY_TURN_TEXT, WORK_ACK_TEXT, messagesFromTurn } from './turn'

describe('messagesFromTurn', () => {
  it('puts cards first, then prose, then the question last', () => {
    expect(
      messagesFromTurn('One detail will help.', [
        { toolName: 'suggest_items', input: {}, output: { itemIds: ['a'], note: 'Two good fits.' } },
        { toolName: 'ask_user', input: {}, output: { question: 'Weekend or weekday?', options: ['Weekend', 'Weekday'] } },
      ]),
    ).toEqual([
      { kind: 'items', body: { itemIds: ['a'], note: 'Two good fits.' } },
      { kind: 'text', body: { text: 'One detail will help.' } },
      { kind: 'question', body: { text: 'Weekend or weekday?', options: ['Weekend', 'Weekday'] } },
    ])
  })

  it('drops final prose when cards carry the words, so nothing is said twice', () => {
    expect(
      messagesFromTurn('Here are two good fits.', [{ toolName: 'suggest_items', input: {}, output: { itemIds: ['a', 'b'], note: 'Two good fits.' } }]),
    ).toEqual([{ kind: 'items', body: { itemIds: ['a', 'b'], note: 'Two good fits.' } }])
  })

  it('keeps reasons and scores only for ids in the batch', () => {
    const [msg] = messagesFromTurn('', [
      {
        toolName: 'suggest_items',
        input: {},
        output: {
          itemIds: ['a'],
          reasons: [{ id: 'a', fit: 'quiet street', catch: 'small yard' }, { id: 'zzz', fit: 'invented' }],
          scores: { a: 82, zzz: 99 },
        },
      },
    ])
    expect(msg!.body).toEqual({ itemIds: ['a'], reasons: [{ id: 'a', fit: 'quiet street', catch: 'small yard' }], scores: { a: 82 } })
  })

  it('answers a work ticket with exactly one line — the model’s, else the ack', () => {
    const ticket = { toolName: 'work_on_it', input: {}, output: { status: 'queued', ack: WORK_ACK_TEXT } }
    expect(messagesFromTurn('On it.', [ticket])).toEqual([{ kind: 'text', body: { text: 'On it.' } }])
    expect(messagesFromTurn('', [ticket])).toEqual([{ kind: 'text', body: { text: WORK_ACK_TEXT } }])
  })

  it('never returns an empty turn', () => {
    expect(messagesFromTurn('  ', [])).toEqual([{ kind: 'status', body: { text: EMPTY_TURN_TEXT } }])
  })

  it('ignores a question with fewer than two options', () => {
    expect(messagesFromTurn('Hmm.', [{ toolName: 'ask_user', input: {}, output: { question: 'Sure?', options: ['Yes'] } }])).toEqual([
      { kind: 'text', body: { text: 'Hmm.' } },
    ])
  })
})
