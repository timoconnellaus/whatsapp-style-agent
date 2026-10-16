# whatsapp-style-agent

A [Claude Code](https://claude.com/claude-code) skill for building a WhatsApp-style AI agent into an app.

The agent lives in a chat thread, one thread per user goal. It replies in short bubbles, item cards, or a single question with tappable answers. When an ask needs real work it says "leave it with me", queues a job, and messages back hours later with a push notification. It also speaks up on its own, under a cadence governor: quiet hours, one proactive message a day, and never three unanswered messages in a row.

The skill teaches Claude the architecture and its invariants, and ships working reference code:

- **Two-speed turns.** A synchronous tool-calling turn answers now, and a `work_on_it` tool hands the request to a background job runner.
- **Typed messages:** `text`, `items` (cards with fit/catch reasons and deterministic scores), `question` (answer chips) and `status`.
- **A never-show-twice ledger** and save/pass reactions.
- **An idempotent job queue** with period dedup keys, perishable proactive jobs, and an overdue-promise sweep.
- **A pure, DST-correct cadence governor.**
- **A facts-to-words composer** with a deterministic fallback.
- **FCM v1 push** from Workers with WebCrypto, so no firebase-admin.
- **A client contract and checklist** for the inbox and thread screen.

Stack: Cloudflare Workers + D1 (drizzle), Vercel AI SDK v6, zod v4. The reference code typechecks and its tests pass. Everything domain-specific sits behind one interface (`domain.ts`), so the same code serves a travel agent, a shopping assistant or a job-search agent.

## Install

As a plugin:

```
/plugin marketplace add timoconnellaus/whatsapp-style-agent
/plugin install whatsapp-style-agent@whatsapp-style-agent
```

Or copy `skills/whatsapp-style-agent/` into `~/.claude/skills/` (personal) or `.claude/skills/` (one project).

Then ask Claude something like "add a WhatsApp-style agent to this app that helps users find X".

## Layout

```
skills/whatsapp-style-agent/
  SKILL.md                 the architecture, build steps and invariants
  references/client.md     the client contract and checklist
  references/code/         reference implementation (TypeScript) + tests
```

## License

MIT
