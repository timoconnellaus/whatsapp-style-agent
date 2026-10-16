// Which model errors are worth a retry.

/**
 * Prefer the AI SDK's own `isRetryable`; else 408/429/5xx. An error with no structured signal at all (a raw
 * provider body, a network blip) is retried blindly — the attempt cap bounds the waste.
 */
export function isTransientError(err: unknown): boolean {
  // Checked FIRST: the SDK flags this 400 as non-retryable, yet a fresh attempt usually types the args right.
  if (isToolUseFailed(err)) return true
  const e = err as { isRetryable?: unknown; statusCode?: unknown; status?: unknown }
  if (typeof e?.isRetryable === 'boolean') return e.isRetryable
  const code = typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : undefined
  if (code !== undefined) return code === 408 || code === 429 || code >= 500
  return true
}

/** Provider-side tool-call validation failure: HTTP 400 with a `tool_use_failed`-style body (Groq), when
 *  the model emits an argument that doesn't match the schema. A genuinely bad 400 is still not retried. */
export function isToolUseFailed(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown; responseBody?: unknown; message?: unknown }
  const code = typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : undefined
  if (code !== 400) return false
  const hay = `${typeof e?.message === 'string' ? e.message : ''} ${typeof e?.responseBody === 'string' ? e.responseBody : ''}`
  return /tool_use_failed|failed_generation|did not match schema|tool call validation failed|Failed to call a function/i.test(hay)
}
