# API and events

The desktop frontend talks to Rust through `src/lib/api.ts` (`invoke`) and
listens on one Tauri event channel (`src/hooks/useSessionEvents.ts`). The web
app replaces both with a tRPC router and a tRPC SSE subscription. This
document is the contract frozen at the end of Phase 3.

## 1. Transport

- Base path `/api/trpc`. Queries and mutations share one `httpBatchLink`;
  `events.subscribe` has its own `httpSubscriptionLink` (an `EventSource`, so a
  GET, which the origin check guards and the `X-Requested-With` header does
  not apply to).
- Auth: session cookie (`06-auth-and-users.md`). Every procedure except
  `auth.*` and `system.health` requires a user; `ctx.userId` scopes all repos.
- Reconnection: the subscription carries no replay cursor. Run events carry
  per-node `seq`; clients resynchronize from `research.getNodeContent`
  (`05-run-lifecycle-and-streaming.md` §4).
- CSRF: mutations and subscriptions require `Origin` (or `Sec-Fetch-Site:
  same-origin`) to match `SESSION_PUBLIC_ORIGIN`; the cookie is `SameSite=Lax`.
- Input validation: zod schemas from `shared`; output types inferred.
- Errors: tRPC error codes; `message` carries the desktop's user-facing text
  (for example "The research response has been updated; please reselect the text.").
  Codes used: `BAD_REQUEST` (validation), `NOT_FOUND`, `CONFLICT`
  (optimistic-concurrency and slot conflicts), `PRECONDITION_FAILED`
  (adapter not ready, credentials missing), `FORBIDDEN`, `UNAUTHORIZED`,
  `TOO_MANY_REQUESTS` (admission), `INTERNAL_SERVER_ERROR`.
- Client module `packages/client/src/api/api.ts` re-exports functions named
  exactly as the desktop's `api.ts` for the research subset, implemented on
  the tRPC proxy, so ported components keep `import { createResearchTree }
  from "../api/api"`.

## 2. Procedure inventory

Grouped by router. `Q` query, `M` mutation. "Desktop" gives the Tauri command
each replaces; "—" means new.

### `system`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `system.health` | Q | → `{ ok, version }` | — (`/healthz` also served plainly) |
| `system.runtimeConfig` | Q | → `RuntimeConfig { version, models: ModelInfo[], limits, features: { webSearch: boolean, searchVendor?: "parallel" \| "tavily", artifactOrigin: string } }` (gated models omitted for non-admins) | `get_runtime_config`, `probe_agent_adapters` |

`features.artifactOrigin` is the origin the preview panel frames
(`11-artifacts-and-browser.md` §3). The client needs it to validate
`event.origin` on the `session-preview-scroll` bridge. Because the origin is
configured per deployment, runtime configuration provides it instead of the
client bundle.

### `auth`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `auth.me` | Q | → `User \| null` | `github_account_get` |
| `auth.logout` | M | → void | `github_logout` |

Login start/callback are plain Hono routes (`/auth/github`,
`/auth/github/callback`), not tRPC (`06-auth-and-users.md`).

### `settings`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `settings.get` | Q | → `UserSettings & { researchLaunchInstruction, defaultWorkspaceId, defaultModel }` | localStorage `session.settings.v1`, `research_launch_instruction_get` |
| `settings.update` | M | partial → full | `research_launch_instruction_set` |
| `drafts.get` / `drafts.set` | Q/M | `{ key }` / `{ key, value }` | `interface_draft_get/set` |
| `usage.summary` | Q | no input → `UsageSummary` (one UTC day of token counts, an estimated cost, and the account's limits; no per-model breakdown) | — (new) |
| `admin.listUsers` | Q (admin) | → `User[]` with usage totals and limits | — (new) |
| `admin.setLimits` | M (admin) | `{ userId, dailyTokens?, dailyRuns? }` | — (new) |
| `admin.createInvites` | M (admin) | `{ count }` → codes | — (new; also grants `invites_remaining` to users later) |

### `workspaces`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `workspaces.list` | Q | → `Workspace[]` (with `treeCount`) | `list_research_workspaces`, `list_groups` |
| `workspaces.ensureDefault` | M | → `Workspace` | `ensure_default_research_workspace_command` |
| `workspaces.create` | M | `{ name }` → `Workspace` | `research_workspace_create_pick` |
| `workspaces.rename` | M | `{ workspaceId, name }` | `research_workspace_rename`, `group_rename` |
| `workspaces.remove` | M | `{ workspaceId }` → `{ removedTreeIds }` | `research_workspace_remove` (blocked while runs are active; deletes trees) |
| `workspaces.setDefault` | M | `{ workspaceId }` | — |
| `workspaces.reorder` | M | `{ workspaceIds }` | `group_reorder` |
| `folders.get` / `folders.set` | Q/M | `{ workspaceId }` / `ResearchFolderState` → normalized | `list_research_folders`, `set_research_folders` |

### `research`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `research.listTrees` | Q | `{ workspaceId?, includeArchived? }` → `ResearchTreeSummary[]` | `list_research_trees` |
| `research.reorderTrees` | M | `{ workspaceId, archived, treeIds }` | `reorder_research_trees` |
| `research.getTree` | Q | `{ treeId }` → `ResearchTreeDetail` | `get_research_tree` |
| `research.createTree` | M | `{ prompt, title?, model, workspaceId, documentIds? }` → `ResearchTreeDetail` | `create_research_tree` (`PRECONDITION_FAILED` on a gated or unavailable model; `TOO_MANY_REQUESTS` when daily limits are enforced and exhausted; resolves the X permalinks in `prompt` into the node's attachments first, as `create_research_tree` does) |
| `research.forkNode` | M | `{ parentNodeId, prompt, model?, queryAnchor?, inline?, documentIds? }` → `ResearchNode` | `fork_research_node` (`model` defaults to the parent's; resolves its own attachments) |
| `research.retryNode` | M | `{ nodeId, model? }` → `ResearchTreeDetail` | `retry_research_node` (also accepts `interrupted`) |
| `research.cancelNode` | M | `{ nodeId }` → `ResearchNode` | `cancel_research_node` |
| `research.renameTree` | M | `{ treeId, title }` → `ResearchTree` | `rename_research_tree` |
| `research.renameNode` | M | `{ nodeId, title }` → `ResearchNode` | `rename_research_node` |
| `research.getNodeContent` | Q | `{ nodeId }` → `ResearchNodeContent { node, turns, inFlightText, seq, children, responseRevision?, sourceError?, queuePosition? }` | `get_research_node_content` |
| `research.updateDocument` | M | `UpdateResearchDocumentRequest` → `UpdateResearchDocumentResult` | `update_research_document` |
| `research.markTreeViewed` | M | `{ treeId }` → `ResearchTree` | `mark_research_tree_viewed` |
| `research.setTreeFollowed` / `setTreeBookmarked` | M | `{ treeId, value }` → `ResearchTree` | same |
| `research.archiveTree` / `restoreTree` | M | `{ treeId }` → `ResearchTree` | same |
| `research.removeTree` | M | `{ treeId }` → void | `remove_research_tree` |
| `research.removeBranch` | M | `{ nodeId }` → `ResearchBranchRemoval` | `remove_research_branch` |
| `research.generateTitle` | M | `{ nodeId }` → `string` | `generate_research_agent_title` |
| `research.listActivity` | Q | → `ResearchNode[]` (active nodes) | `list_research_activity` |
| `research.importReport` | M | `{ markdown, prompt, workspaceId }` → `ResearchTreeDetail` | `import_research_report` (`read_research_report` dropped; browser supplies bytes; recap on `gemini-flash`) |
| `documents.list` | Q | `{ workspaceId }` → `DocumentInfo[]` | — (new) |
| `documents.remove` | M | `{ documentId }` → void (refused while referenced by a node) | — (new) |
| `highlights.create` | M | `{ nodeId, anchor }` → `ResearchHighlight` | `create_research_highlight` |
| `highlights.remove` | M | `{ nodeId, highlightId }` → `ResearchHighlight` | `remove_research_highlight` |
| `highlights.removeMany` | M | `{ nodeId, highlightIds }` → `ResearchHighlight[]` | `remove_research_highlights` |
| `highlights.listFeed` | Q | `{ workspaceId? }` → `ResearchHighlightFeedItem[]` | `list_research_highlights` (`workspaceId` filter is new) |
| `recaps.defaultInstructions` | Q | → `string` | `research_recap_default_instructions` |
| `recaps.generateCandidate` | M | `{ nodeId, expectedResponseRevision, instructions (trimmed, non-empty, ≤ 4,000 chars) }` → `ResearchRecapCandidate` (always `gemini-flash`; the desktop's adapter/model picker is dropped) | `generate_research_recap_candidate` |
| `recaps.applyCandidate` | M | `{ nodeId, expectedResponseRevision, expectedCurrentRecapId?, candidate }` → `ResearchNode` | `apply_research_recap_candidate` |

### `feed`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `feed.recentActivity` | Q | `{ scope?: "all" \| "mine" \| "workspace", workspaceId?, limit?, before?: RecentActivityCursor, bookmarkedOnly? }` → `RecentActivityPage` | `list_recent_activity`; guests may read only `all`; `mine` spans the signed-in account's workspaces; `workspace` keeps journal account-wide and filters research by `workspaceId`; `bookmarkedOnly` is refused for `all` because bookmark state is private |
| `feed.recentQueries` | Q | `{ limit?, before? }` → `RecentResearchQueryPage` | `list_recent_research_queries` |

### `journal`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `journal.add` | M | `{ url }` → entry (server classifies link vs tweet, schedules hydration) | — (new; the desktop has no creation UI, entries exist only from legacy data) |
| `journal.restore` | M | `{ entry }` → boolean | `journal_restore` |
| `journal.update` | M | `{ id, entry }` → boolean | `journal_update` |
| `journal.remove` | M | `{ id }` → boolean | `journal_remove` |
| `journal.fetchTweet` | M | `{ id, token }` → `string` (raw JSON) | `journal_fetch_tweet` |
| `journal.hydrateTweet` | M | `{ entryId }` → entry | client loop over `journal_fetch_tweet` |

Hydration (`journal/tweets.ts`) is one cache-first pipeline shared by journal
entries and research attachments, with two providers in order:
`cdn.syndication.twimg.com/tweet-result` for the whole post (media, quoted
post, link card, counts), then `publish.twitter.com/oembed` for the author,
text and date when syndication does not serve it. The provider that answered
is stored on the row and on the attachment (`xSyndication | xOembed`), so a
reduced card is recognizable as one. A resolved snapshot is stored with its
image URLs rewritten to `/embeds/<hash>` (§5).

### `artifacts` (Phase 7)
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `artifacts.mintToken` | M | `{ documentId }` → `{ url }` | `browser_open_local_path` |

### `events`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `events.subscribe` | subscription | → stream of `SessionEvent` | `listen("session-event")` |
| `events.setInterest` | M | `{ connectionId, nodeIds }` → `{ applied }` (false when the connection has expired or been terminated on the server) | — (which active nodes this connection wants turn deltas for) |

Dropped without replacement (legacy or native-only): every pane, split,
group-as-terminal, agent queue, remote, worktree, prompt library, artifact
tray, human browser, browser automation (including
`browser_open_codex_inline_visualization` and
`browser_open_codex_visualization_reference`; the Codex visualization buttons
in the Markdown renderer are dropped with them), native support, show/hide
shortcut, app window, exit confirmation, prevent sleep, external URL, reveal,
transcript image, pasted image, thread graph, conversation history, home turn
history, `active_tab_set` (replaced by the URL), and
`mark_events_listener_ready` (native shortcut handshake) commands. `14-legacy-inventory.md` lists them.

## 3. Event stream

Envelope, from `events.rs:7` without the desktop's `paneId` and `agentId`
fields (no panes or agent records exist on the web) and with `seq` on run
events:

```ts
interface SessionEvent {
  type: string;
  payload: Record<string, unknown>;   // run events include nodeId and seq
  timestamp: number;                  // ms
}
```

On the server, `EventBus` maintains per-user subscriber sets. Every server
call that mutates repository data emits through the bus after its transaction
commits. The server has no event buffer or replay mechanism, so reconnecting
clients invalidate list queries and refetch snapshots for displayed active nodes.
Each connection has an interest set (`events.setInterest`); `research.turn.*`
events are delivered only to connections interested in that node, while
`research.node.updated` goes to every connection of the user. Materialized
`feed.item.*` events fan out to every signed-in connection because an `all`
cache includes other authors; guests have no event subscription.

Event types, payloads identical to the desktop (`src/lib/researchEvents.ts:90`)
unless noted:

| Type | Payload | Emitted by |
| --- | --- | --- |
| `research.tree.created` | `{ tree, node }` | createTree, importReport |
| `research.tree.updated` | `{ tree }` | rename, followed, bookmarked, viewed |
| `research.tree.archived` / `restored` | `{ tree }` | archive/restore |
| `research.tree.removed` | `{ treeId }` | removeTree, workspace remove |
| `research.node.created` | `{ node }` | forkNode |
| `research.node.updated` | `{ node, queuePosition? }` | status transitions, rename, retry/resume reset, recap saved, snapshot stamped, preview (≤ 2/s) |
| `research.node.removed` | `{ treeId, parentNodeId, removedNodeIds }` | removeBranch |
| `research.document.updated` | `{ tree, node, responseRevision, markdownChanged, removedHighlightCount }` | updateDocument |
| `research.highlight.created` | `{ nodeId, highlight }` | |
| `research.highlight.removed` | `{ nodeId, highlightId }` | |
| `research.highlights.removed` | `{ nodeId, highlightIds }` | |
| `research.recap.pending` | `{ nodeId, pending }` | recap job start/end, every exit path |
| `workspace.created` / `updated` / `removed` | `{ workspace }` / `{ workspaceId }` | replaces `group.*` |
| `folders.updated` | `{ workspaceId, state }` | new (desktop kept folders client-side) |
| `journal.entry.updated` | `{ entry }` | add, hydrate, update, restore |
| `journal.entry.removed` | `{ id }` | remove |
| `feed.item.upserted` | `{ id, kind, authorId, occurredAt, sourceRank, workspaceId, bookmarked, item }` | public feed source create/update/restore |
| `feed.item.removed` | `{ id, kind, authorId, occurredAt, sourceRank, workspaceId, bookmarked }` | source delete or archive |
| `settings.updated` | `{ settings }` | another tab changed settings |
| `models.updated` | `{ models }` | provider availability change |
| `notification.requested` | `{ id, title, body, tone, timeoutMs, createdAt }` | server-originated toasts |
| `connection.ready` | `{ connectionId }` | the initial event of every connection; supplies the connection ID for `events.setInterest`, and subsequent emissions indicate that the link has reconnected (`07-client-architecture.md` §4.2) |

Run events (new; `05-run-lifecycle-and-streaming.md` §4):

| Type | Payload |
| --- | --- |
| `research.run.started` | `{ nodeId, attempt, seq, model }` |
| `research.run.thinking` | `{ nodeId, seq, active: boolean }` — reasoning is streaming (no content is sent) |
| `research.turn.delta` | `{ nodeId, seq, turnId, text }` — appended text; coalesced ≤ 1 per 50 ms per node; interest-filtered |
| `research.turn.committed` | `{ nodeId, seq, turn: Turn }` — replaces any live turn with the same id; interest-filtered |
| `research.run.finished` | `{ nodeId, attempt, seq, status, error? }` — precedes the terminal `research.node.updated` |

The client's `researchEvents.ts` union grows by these five run events plus
`models.updated`. Unknown types are categorized as `unsupported` and trigger a scoped refetch, matching the behavior of the desktop client.

## 4. Live content protocol

Specified in `05-run-lifecycle-and-streaming.md` §4. Summary: fetch
`getNodeContent` (turns, in-flight text, `seq`); apply run events with
`seq === lastSeq + 1`; drop replays; refetch on gaps, mount, visibility, and
reconnect; on `research.run.finished` plus a terminal `node.updated` with
`responseSnapshotAt`, fetch once more and switch to the durable snapshot.
Server preference order for `getNodeContent` follows `main.rs:1843`: durable
snapshot → `run_turns` → `sourceError` for finished nodes without a snapshot.

## 5. Non-tRPC HTTP routes (Hono)

| Route | Purpose |
| --- | --- |
| `GET /healthz` | `ok\n`, `Cache-Control: no-store` (Fly check) |
| `GET /auth/github`, `GET /auth/github/callback`, `POST /auth/logout` | OAuth flow |
| `POST /uploads` | multipart document upload (auth; `workspaceId` field; returns `DocumentInfo[]`); 20 MiB per file, 10 files |
| `GET /embeds/:hash` | one cached image of an embedded post (public, `immutable`); the hash is SHA-256 of the origin URL and names an `embed_assets` row, whose bytes are fetched on the first request and may be swept back off the volume (`13-deployment-fly.md` §6) |
| `GET /a/:token` | attached document bytes, on `artifacts.session.dev` only (Phase 7) |
| `GET /*` | built client `index.html` (SPA fallback) and hashed assets |

Security headers on every response: `Content-Security-Policy` (see
`07-client-architecture.md` §9), `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `Strict-Transport-Security` behind Fly's
TLS, `Permissions-Policy` minimal. `SESSION_PUBLIC_ORIGIN` validated as the
landing server did (`web/server.tsx:106-119`, reused).
