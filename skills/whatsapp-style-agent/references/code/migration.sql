-- The four tables behind a WhatsApp-style agent. SQLite / Cloudflare D1. Mirrored in schema.ts — keep in lockstep.
--
-- thread          one conversation per user GOAL (not one per user). Criteria are the goal's structured
--                 state, edited only by the conversation (the agent's update_criteria tool).
-- thread_message  typed JSON bodies, chronological. `origin` = 'proactive' marks a message the AGENT started
--                 (the cadence governor rations those); NULL = a reply inside a turn the user started.
-- shown_item      the never-show-twice LEDGER: every item surfaced in a thread, plus the user's reaction.
-- agent_job       the work QUEUE: "I'll look into it and come back" becomes a row. dedup_key is UNIQUE so
--                 re-queuing the same promise is a no-op.
--
-- No BEGIN/COMMIT wrapper, so it applies with `wrangler d1 execute <db> --remote --file=...`.

CREATE TABLE thread (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  last_read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_thread_user_status ON thread(user_id, status);

CREATE TABLE thread_message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  origin TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_thread_message_thread_created ON thread_message(thread_id, created_at);
CREATE INDEX idx_thread_message_origin_created ON thread_message(origin, created_at);

CREATE TABLE shown_item (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  shown_at TEXT NOT NULL,
  source TEXT NOT NULL,
  reaction TEXT,
  reaction_reason TEXT,
  reacted_at TEXT
);
CREATE UNIQUE INDEX idx_shown_item_thread_item ON shown_item(thread_id, item_id);
CREATE INDEX idx_shown_item_user ON shown_item(user_id, shown_at);

CREATE TABLE agent_job (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  run_at TEXT NOT NULL,
  deliver_by TEXT,
  delivered_at TEXT,
  dedup_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_job_due ON agent_job(status, run_at);
CREATE INDEX idx_agent_job_delivery ON agent_job(deliver_by, delivered_at);

CREATE TABLE push_token (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_push_token_user ON push_token(user_id);
