# Client contract

The client is a messaging app: an inbox of threads and a thread screen. It talks only to `thread-api.ts`, with the session cookie on every call. There is no streaming and no socket: the client polls, and push nudges it to poll now. The original client is Flutter, but nothing here is Flutter-specific.

## Endpoints

| Call | Use |
|---|---|
| `GET /api/threads` | Inbox rows: `title`, `unreadCount`, `lastMessage {sender, kind, preview, createdAt}`, `criteria` |
| `POST /api/threads {title?}` | "Start" button. With no `message`, the reply holds the agent's intro question |
| `GET /api/threads/:id/messages?afterTs=` | Incremental poll; `afterTs` = newest **delivered** `createdAt` (exclusive). Also returns live `title` + `criteria` |
| `POST /api/threads/:id/messages {text}` | Send. Synchronous: returns `[userMessage, ...agentReplies]` |
| `POST /api/threads/:id/read` | Clears unread; call on open and whenever new agent messages arrive while open |
| `POST /api/threads/:id/reactions {itemId, reaction, reason?}` | Save/pass on a card. Optimistic; revert on failure |
| `POST /api/push/register {token, platform}` | After sign-in and on every token refresh |

## Thread screen checklist

**Sending**
- [ ] **Optimistic send.** The bubble appears at once with a `local-…` id and "Sending…". Sends drain through a FIFO queue one at a time, and the composer is never locked. On failure the bubble shows "Not sent · Retry" and the text goes back into the composer.
- [ ] **Typing indicator.** It is the last list item while a send is in flight. The server has no typing state; the synchronous POST is the signal.

**Message kinds**
- [ ] **Question chips.** Each option sends its text as a plain user message. Chips disable once any user message follows the question, or while a send is in flight.
- [ ] **Item cards.** A card is rendered from its id: fetch each item's display data in parallel, show skeletons while they load, and show one Retry row if all of them fail. Under the card, show the `reasons[id].fit` line, the `catch` line and the `scores[id]` chip.
- [ ] **Reactions.** Save and Pass on each card; Pass offers reason chips. Cache reactions locally, because the server doesn't echo them back.
- [ ] **Unknown kinds.** An unknown `kind`, or a malformed body, renders as a text bubble. A newer server must never crash an older client. Treat body fields as additive: ignore what you don't know.
- [ ] **Status kind.** Render `status` quieter than prose.

**Polling and push**
- [ ] **Polling.** Poll every ~30s only while the app is foregrounded and this screen is on top; refresh on resume. Merge by id, so polls and the POST reply never duplicate a message.
- [ ] **Push.** Data `{type:'thread', threadId}`.
  - Foreground: show a local notification. Refresh the open thread only if the push is for that thread; re-list the inbox either way.
  - Tap or cold start: open that thread, waiting for the navigator if it isn't ready yet.

**Inbox**
- [ ] **Criteria chips.** Pin them at the top of the thread, read from each poll's `thread.criteria`. Every filter in play is visible.
- [ ] **Inbox order.** Sort by `lastMessage.createdAt ?? updatedAt`. The badge is the sum of `unreadCount` (cap the display at 9+). Refresh it on launch, on resume and on push, single-flight, keeping the last count on error.

## Known gap

`markRead` stamps the server's *now*. An agent message created between the fetch and `read` counts as read: it still shows up at the next poll, but its unread count is lost. To fix this, send the newest seen `createdAt` as the cursor.
