---
name: whatsapp-style-agent
description: Build a WhatsApp-style AI agent into an app — one chat thread per user goal, typed messages (text, item cards, questions with answer chips), and an agent that answers now or takes the work away and messages back later through a cadence-governed job runner with push. Use when adding an async messaging agent, an agent inbox, proactive agent messages, or "I'll look into it and get back to you" work to a product.
---

# WhatsApp-style agent

An agent that lives in a chat thread like a person on WhatsApp. The user writes; the agent replies in a few short bubbles. Sometimes the reply is cards. Sometimes it's one question with tappable answers. Sometimes it's "leave it with me", and hours later a push arrives with what it found. It also speaks up on its own, rarely and only when it has something real to say.

Stack: Cloudflare Workers + D1 (drizzle), Vercel AI SDK v6, zod v4, FCM for push. The client is any app that can poll JSON. The reference code is portable to Node + SQLite or Postgres: swap `DB` and the cron.

## The shape

- **Thread.** There is one thread per user *goal*, not per user (one trip, one house hunt, one job search). The thread holds `criteria`, the goal's structured state. The conversation sets the criteria, and the client shows them as chips.
- **Two speeds.** A **turn** (`turn.ts`) is one unary `generateText` call that answers *now*. When the ask needs real work, the `work_on_it` tool writes an `agent_job` row and ends the turn with a one-line ack. The **runner** (`runner.ts`, a 10-minute cron) does the work *away* and posts the result back into the thread. The promise *is* the row.
- **Typed messages.** Each message is `text`, `items` (cards by id, plus the model's fit/catch clauses and code-computed scores), `question` (2–4 answer chips) or `status`. Typed tools beat prose, so a recommendation never arrives twice.
- **Code decides, the model writes.** Deterministic code decides whether, when and what to send. The model writes the words, and only from facts a tool or job produced.

## Reference code

Everything is in [`references/code/`](references/code/). It typechecks against ai 6 / zod 4 / drizzle 0.44, and `*.test.ts` runs under vitest. Copy the folder into the new project; the files are ordered here by dependency.

| File | Role |
|---|---|
| `migration.sql`, `schema.ts` | `thread`, `thread_message` (with `origin`), `shown_item` ledger, `agent_job` queue, `push_token` |
| `local-time.ts` | DST-correct local day, hour and week for one app time zone |
| `threads.ts` | Thread and message storage, inbox unread counts, criteria merge, ledger, reactions |
| `jobs.ts` | Idempotent enqueue, claim, reschedule, mark, overdue; period dedup keys |
| `cadence.ts` | The pure cadence governor plus the one read that feeds it |
| `domain.ts` | **The port.** The only file a new project designs: what an item is, how to search, score and research |
| `num-arg.ts`, `errors.ts` | String-tolerant numeric tool args; the transient-error classifier |
| `turn.ts` | Prompt, tools, the `messagesFromTurn` seam, `runTurn` with retry |
| `thread-api.ts` | The REST API the client talks to |
| `compose.ts` | Facts → words for job deliveries, with a deterministic fallback |
| `producers.ts`, `runner.ts` | Proactive producers and the job runner |
| `push.ts` | FCM v1 over WebCrypto, fail-soft |
## Build steps

1. **Domain.** Implement `AgentDomain` (`domain.ts`): persona, goal noun, what the card shows, the criteria patch schema, `search`, `scores` and `research`. Leave every other file untouched.
   - Done when `search` returns lean hits for real criteria and `research` returns ranked candidates with factual `fits`/`misses`.
2. **Storage.** Apply `migration.sql` and wire `getDb`.
   - Done when the schema matches `schema.ts` and the tests pass.
3. **Turn and API.** Mount `handleThreadsApi` with your auth's verified `getUserId`, a tool-calling model and an intro question.
   - Done when a curl session can: create a thread, answer the intro chip, get cards back, and make the agent call `work_on_it` with a broad ask.
4. **Runner.** Add the cron trigger, `scheduled` → `runJobs`, the composer model and the FCM secret.
   - Done when the queued job comes back as an `items` message with `origin = 'proactive'` and a push. Also check that a second tick sends nothing and that a quiet-hours tick reschedules the job.
5. **Client.** Build the inbox and thread screen to [`references/client.md`](references/client.md).
   - Done when every item in its checklist holds on a device.

## Invariants

Keep these true when you change the code. Each one is a bug the original shipped and then fixed.

- **Verified identity.** `userId` comes from the session, never from a header, a body or the model. Every thread route re-resolves the thread via `getThread(userId, id)`.
- **Facts from tools.** The prompt forbids invented facts. `suggest_items` refuses any id this turn's search didn't return, and scores come from code.
- **Typed beats prose.** When cards carry a `note`, final prose is dropped. A `question` is always the last bubble. A turn never ends empty: it falls back to the ack, then to `status`.
- **Idempotent tools.** `runTurn` retries a whole failed turn, which is safe only because every side-effecting tool is idempotent: the criteria merge, the ledger upsert, and `work_on_it`'s dedup key plus its open-job guard. Keep any new tool idempotent, or drop the retry.
- **Ledger.** Every item surfaced in a thread goes into `shown_item`. Turns *flag* repeats (`shownBefore`); jobs *diff them out*.
- **Facts-only payloads.** Job payloads and results hold facts; prose is rendered at delivery. The composer can only use ids from the job's candidate set, and on any failure it falls back to a deterministic note.
- **One governor.** Every proactive message passes `allowProactiveSend`. The rules are quiet hours, one proactive message a day across all of the user's threads, no third unanswered message in a row, and a weekly heartbeat only into a quiet thread. A blocked send is rescheduled, never dropped. Every writer stamps `origin: 'proactive'`, which is how the governor counts.
- **Period keys.** A proactive job's dedup key names its period (day or ISO week). That makes producers safe on every tick, and lets the runner retire a stale job instead of sending it late.
- **Silence is a result.** A digest with nothing new sends nothing. Requested work always answers, even empty-handed, and a promise past `deliver_by` gets an honest fallback line. Only a promise gets an apology.
- **Fail-soft side effects.** Push, the ledger write and scores never fail a delivery. A sent message must never become a failed job, or it gets sent again.
- **One mouth.** Anything that wants to message the user (an alert, a matcher, a webhook) enqueues a job through the runner. It never posts into a thread directly; a second, ungoverned path skips the ledger and the governor.
- **Empty criteria.** A new thread starts with no filters. Facts from the user's profile go in the prompt as an *offer*, and are applied only when the user confirms. Pre-filled chips read as another thread's state leaking in.

## Model notes

- **Turn model.** It must reliably call several tools per turn; the original runs `llama-3.3-70b-versatile` on Groq. Smaller models stringify numbers, so declare every numeric param with `intArg`/`numArg`. `isTransientError` retries Groq's `tool_use_failed` 400.
- **Composer.** Any cheap model at low temperature with JSON output; the original uses Gemini Flash with thinking off. Passing `composer: undefined` acts as a kill switch: deliveries still go out with deterministic notes.
- **Prompt changes.** The voice rules in `systemPrompt` and `composePrompt` carry the product feel (short, plain, no hype, one question). Change the persona and domain lines; keep the shape.
