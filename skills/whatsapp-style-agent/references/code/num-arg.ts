// Numeric TOOL params that tolerate the model sending the number as a STRING.
//
// Smaller tool-calling models (llama-3.3-70b on Groq, for one) intermittently emit `"5"` for `5`. A bare
// z.number() renders as {type:number}, the provider validates the call server-side, returns 400
// `tool_use_failed`, and the whole turn dies. Rendering as anyOf[number, numeric-string] lets the provider
// accept either; the transform coerces and CLAMPS so an out-of-range value can't re-introduce an error.
// When you render declarations yourself, use z.toJSONSchema(schema, { io: 'input' }) — transforms are
// unrepresentable in output mode.

import { z } from 'zod'

function clamp(n: number, min?: number, max?: number): number {
  if (min !== undefined) n = Math.max(min, n)
  if (max !== undefined) n = Math.min(max, n)
  return n
}

export function intArg(opts: { min?: number; max?: number } = {}) {
  return z
    .union([z.number(), z.string().regex(/^-?\d+$/)])
    .transform((v) => clamp(Math.trunc(Number(v)), opts.min, opts.max))
}

export function numArg(opts: { min?: number; max?: number } = {}) {
  return z
    .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
    .transform((v) => clamp(Number(v), opts.min, opts.max))
}
