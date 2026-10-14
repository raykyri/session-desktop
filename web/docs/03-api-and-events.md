# API and events

The desktop frontend talks to Rust through `src/lib/api.ts` (`invoke`) and
listens on one Tauri event channel (`src/hooks/useSessionEvents.ts`). The web
app replaces both with a tRPC router and a tRPC SSE subscription. This
document is the contract frozen at the end of Phase 3.

## 1. Transport

- Base path `/api/trpc`. Queries and mutations share one `httpBatchLink`;
  `events.subscribe` has its own `httpSubscriptionLink` (an `EventSource`, so a
  GET, which the origin check protects and the `X-Requested-With` header does
  not apply to).
- Auth: session cookie (`06-auth-and-users.md`). Every procedure except
  `auth.*`, `system.*` and the public reads requires a user. Per-person rows
  are scoped to the caller; thread content goes through the caller's role in
  the thread (`02-domain-model-and-database.md` §5.16): `NOT_FOUND` for a
  thread they may not read, `FORBIDDEN` for a role too low. Public reads
  (`research.listTrees`, `getTree`, `getNodeContent`, `feed.recentActivity`
  with `scope: all`, `workspaces.list`, `folders.get`) answer guests from
  public threads only (`workspaces.list` and `folders.get` are empty for a
  guest).
- Reconnection: the subscription has no replay cursor. Run events include
  per-node `seq`; clients resynchronize from `research.getNodeContent`
  (`05-run-lifecycle-and-streaming.md` §4).
- CSRF: mutations and subscriptions require `Origin` (or `Sec-Fetch-Site:
  same-origin`) to match `SESSION_PUBLIC_ORIGIN`; the cookie is `SameSite=Lax`.
- Input validation: zod schemas from `shared`; output types inferred.
- Errors: tRPC error codes; `message` contains the desktop's user-facing text
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

`features.artifactOrigin` is the artifact origin that serves widget previews
(`11-artifacts-and-browser.md` §2). Because the origin is configured per
deployment, runtime configuration provides it instead of the client bundle.
The client reads widget page URLs from `artifacts.prepareWidget` instead; no
client code reads this field.

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
| `interfaceDrafts.get` / `interfaceDrafts.set` | Q/M | `{ key }` / `{ key, value }` (an empty value deletes) | `interface_draft_get/set` |
| `usage.summary` | Q | no input → `UsageSummary` (one UTC day of token counts, an estimated cost, and the account's limits; no per-model breakdown) | — (new) |
| `admin.listUsers` | Q (admin) | → `User[]` with usage totals and limits | — (new) |
| `admin.setLimits` | M (admin) | `{ userId, dailyTokens?, dailyRuns? }` | — (new) |
| `admin.createInvites` | M (admin) | `{ count }` → codes | — (new; also grants `invites_remaining` to users later) |

### `drafts`

The saved list of unsent questions in the Drafts place
(`server/src/trpc/routers/drafts.ts`, `repos/researchDrafts.ts`). Drafts are
per person and private: every query is scoped to the caller, and another
account's draft id is `NOT_FOUND`. Each change emits
`research.drafts.changed { workspaceId }` to the caller's own connections.

| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `drafts.list` | Q | `{ workspaceId }` → `ResearchDraft[]`, top of the list first | `list_research_drafts` |
| `drafts.save` | M | `{ id?, workspaceId, prompt, images?: string[] }` → `ResearchDraft` | `save_research_draft` (no `id`: a new draft at the top; with one, the prompt is replaced in place; `images`, ids from `POST /api/images`, replaces the draft's images and absent keeps them) |
| `drafts.remove` | M | `{ draftId }` → `{ ok }` | `delete_research_draft` |
| `drafts.reorder` | M | `{ workspaceId, draftIds }` → `ResearchDraft[]` | `reorder_research_drafts` (`draftIds` must be exactly the workspace's drafts, else `CONFLICT`; an unchanged order emits nothing) |

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
| `folders.get` / `folders.set` | Q/M | `{ workspaceId }` / `{ workspaceId, state: ResearchFolderState }` → the stored state | `list_research_folders`, `set_research_folders`: one state per workspace (the desktop keeps one for all); folders with `trashedAt`, `membership` (folder id or `system:drafts`), `collapsed`, `parents`, `collapsedGroups`. `set` normalizes and validates as the desktop does and answers `BAD_REQUEST` with the desktop's message on an invalid name (`02` §5.11) |

### `research`

The `research` router is assembled in
`server/src/trpc/routers/research/index.ts` from one file per group:
`trees.ts` (listing, ordering, creating, archiving, deleting threads),
`nodes.ts` (follow-ups, retry, cancel, content, document edits, titles),
`posts.ts` (notes and saved links, step 2.3) and `trash.ts` (step 2.4).
`followups.ts` holds the `followups.*` procedures, mounted as their own
router. Outputs are the wire types from `@session/shared` (the desktop's
node envelope); inputs are validated with the zod schemas in
`shared/src/schemas` where they carry wire values.

A thread in the Trash refuses edits with `PRECONDITION_FAILED` and the
desktop's message "restore this research from the Trash before changing it"
(`reject_trashed_research_tree`): renaming the thread or a node, archiving or
unarchiving, retrying, deleting a branch, creating or removing highlights and
applying a recap. Follow-ups and document edits keep their own Trash
refusals. Viewing, reading, Restore and Delete are allowed. Every list, the
Home feed and the highlight feed leave threads in the Trash out.

| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `research.listTrees` | Q | `{ workspaceId?, includeArchived? }` → `ResearchTreeSummary[]` | `list_research_trees`. The caller's threads, and the shared threads they filed in one of that workspace's folders; for a guest, the public catalog (every account's public threads outside their owner's Archive and Trash, newest first) |
| `research.reorderTrees` | M | `{ workspaceId, archived, treeIds }` | `reorder_research_trees` |
| `research.getTree` | Q | `{ treeId }` → `ResearchTreeDetail` (with `queues`, the follow-up queues keyed by chain head, when any item is queued, and `participants`) | `get_research_tree`. Anyone who may read the thread, guests included for a public one |
| `research.createTree` | M | `{ prompt, title?, model, effort?, workspaceId, images?: string[] }` → `ResearchTreeDetail` | `create_research_tree` (`PRECONDITION_FAILED` on a gated or unavailable model; `BAD_REQUEST` on an effort the model does not accept; `TOO_MANY_REQUESTS` when daily limits are enforced and exhausted; resolves the X permalinks in `prompt` into the node's attachments first, as `create_research_tree` does; `images` are ids from `POST /api/images`, checked with `resolveImageAttachments` and refused with `BAD_REQUEST` for a model whose `supportsImages` is false) |
| `research.forkNode` | M | `{ parentNodeId, prompt, agent?: { model, effort? }, anchor?: NodeAnchor, inline?, replacesNodeId?, images?: string[] }` → `ResearchNode` | `fork_research_node`. `agent` is any registry model the account may use and an effort it accepts; absent, the parent's agent; a different model without an effort runs at its default effort. `replacesNodeId` names a failed or stopped childless question under the same parent with the same `inline`, which is deleted in the same transaction (`research.node.removed`, then `research.node.created`). An occupied inline slot is still refused; continuing a busy chain is `followups.ask`. Resolves its own attachments `images` as on `createTree`. |
| `research.retryNode` | M | `{ nodeId, model? }` → `ResearchTreeDetail` | `retry_research_node` (also accepts `interrupted`) |
| `research.rerunNode` | M | `{ nodeId }` → `ResearchTreeDetail` | `rerun_research_node`: a settled exchange, a `complete` one included, is reset in place; the snapshot and recap are deleted, highlights stay. The parent's answer must be complete, except for an inline follow-up of an answer that is active again, which waits in the run queue until that answer settles (`PRECONDITION_FAILED` otherwise) |
| `research.setChainOrder` | M | `{ headNodeId, nodeIds, expectedOrder? }` → `ResearchNode` (the head, with `chainOrder`) | `set_research_chain_order`: `nodeIds` must be exactly the chain, and `expectedOrder`, when given, the column's current display order (`CONFLICT` "The conversation changed; refresh before reordering its messages." otherwise); display only; the owner's |
| `research.cancelNode` | M | `{ nodeId }` → `ResearchNode` | `cancel_research_node` |
| `research.renameTree` | M | `{ treeId, title }` → `ResearchTree` | `rename_research_tree` |
| `research.renameNode` | M | `{ nodeId, title }` → `ResearchNode` | `rename_research_node` |
| `research.getNodeContent` | Q | `{ nodeId }` → `ResearchNodeContent { node, turns, inFlightText?, seq?, responseRevision?, sourceError?, queuePosition? }` | `get_research_node_content` |
| `research.updateDocument` | M | `UpdateResearchDocumentRequest` → `UpdateResearchDocumentResult` | `update_research_document` |
| `research.createPost` | M | `{ body, workspaceId, model, effort?, images?: string[] }` → `ResearchTreeDetail` | `create_research_post` (a note: `format = link` when `body` is one http(s) URL; `model`/`effort` are the default for its AI follow-ups and must be a model the account may use and an effort it takes; X permalinks resolved as for a question; no run, so no admission or daily limit) |
| `research.createPostFollowUp` | M | `{ parentNodeId, body }` → `ResearchNode` | `create_research_post_follow_up` (a follow-up note; the parent must be a post in a thread that is not archived or in the Trash) |
| `research.updatePost` | M | `{ nodeId, text, expectedText }` → `UpdateResearchPostResult { tree, node, removedHighlightCount }` | `update_research_post` (`CONFLICT` when the stored text is not `expectedText`; `BAD_REQUEST` for unchanged text or a missing X post link; `PRECONDITION_FAILED` in an archived thread or one in the Trash; highlights re-anchored; the derived root title follows; `02` §5.14) |
| `research.hydratePostTweet` | M | `{ nodeId }` → `ResearchNode` | — (asks the X providers again for a post's `unavailable` tweet attachments, past a cached failure; `PRECONDITION_FAILED` when none is unavailable; replaces the journal's `hydrateTweet`) |
| `research.markTreeViewed` | M | `{ treeId }` → `ResearchTree` | `mark_research_tree_viewed` |
| `research.archiveTree` / `restoreTree` | M | `{ treeId }` → `ResearchTree` | same; the children listed under the tree go with it (`02` §5.10). `PRECONDITION_FAILED` for a tree in the Trash |
| `research.removeTree` | M | `{ treeId }` → `{ ok, treeIds }` | `remove_research_tree`: Delete now, in or out of the Trash, with the children listed under the tree; `treeIds` are the deleted trees |
| `research.trashTree` / `restoreTreeFromTrash` | M | `{ treeId }` → `ResearchTree` | `trash_research_tree` (`PRECONDITION_FAILED` while the tree or a child going with it has an active run), `restore_research_tree_from_trash`; the children listed under the tree go with it |
| `research.listTrash` | Q | `{ workspaceId }` → `ResearchTreeSummary[]` with `trashedAt`, most recently trashed first | `list_research_trash` (one workspace; folders in the Trash are in `folders.get`) |
| `research.emptyTrash` | M | `{ workspaceId }` → `{ treeIds, folderIds }` | `empty_research_trash`; also deletes the workspace's folders in the Trash, in the same transaction |
| `research.removeBranch` | M | `{ nodeId }` → `ResearchBranchRemoval` | `remove_research_branch`. Refused while a run in the branch is active: `queued`, `running`, or `interrupted` with a resume pending (`run.resumePending`); an interrupted node the server stopped resuming is removable like a failed one. The same rule applies to `removeTree` and `workspaces.remove` |
| `research.generateTitle` | M | `{ nodeId }` → `string` | `generate_research_agent_title` |
| `research.listActivity` | Q | → `ResearchNode[]` (active nodes) | `list_research_activity` |
| `research.importReport` | M | `{ markdown, prompt, workspaceId }` → `ResearchTreeDetail` | `import_research_report` (`read_research_report` dropped; browser supplies bytes; recap on `gemini-flash`) |
| `highlights.create` | M | `{ nodeId, anchor }` → `ResearchHighlight` | `create_research_highlight` |
| `highlights.remove` | M | `{ nodeId, highlightId }` → `ResearchHighlight` | `remove_research_highlight` |
| `highlights.removeMany` | M | `{ nodeId, highlightIds }` → `ResearchHighlight[]` | `remove_research_highlights` |
| `highlights.listFeed` | Q | `{ workspaceId? }` → `ResearchHighlightFeedItem[]` | `list_research_highlights` (`workspaceId` filter is new) |
| `recaps.defaultInstructions` | Q | → `string` | `research_recap_default_instructions` |
| `recaps.generateCandidate` | M | `{ nodeId, expectedResponseRevision, instructions (trimmed, non-empty, ≤ 4,000 chars) }` → `ResearchRecapCandidate` (always `gemini-flash`; the desktop's adapter/model picker is dropped) | `generate_research_recap_candidate` |
| `recaps.applyCandidate` | M | `{ nodeId, expectedResponseRevision, expectedCurrentRecapId?, candidate }` → `ResearchNode` | `apply_research_recap_candidate` |

### Collaboration rules on the `research`, `highlights`, `recaps` and `followups` procedures

Web only (`02-domain-model-and-database.md` §5.16):

- The owner's: `renameTree`, `setChainOrder`, `updateDocument`,
  `removeBranch`/`renameNode`/`generateTitle` of someone else's node,
  `highlights.remove(Many)` of someone else's highlight.
- A commenter's or the owner's: `forkNode`, `followups.ask`,
  `createPostFollowUp`, `highlights.create`, `recaps.generateCandidate`
  (billed to the requester), `recaps.applyCandidate`, and
  `renameNode`/`removeBranch`/`generateTitle` of their own node while
  nobody else has replied under it. `updatePost` and an edited question
  (`forkNode` with `replacesNodeId`) are the author's alone.
- `retryNode` and `rerunNode` are the question's author's (the payer);
  `cancelNode` the author's or the owner's; `followups.cancel` the item's
  author's or the owner's, `followups.retry` the author's.
- Per person: `markTreeViewed`; `archiveTree`/`restoreTree`,
  `trashTree`/`restoreTreeFromTrash` act on the thread (and its group) for
  the owner and on the member's own row for a member; `removeTree` by a
  member leaves the thread; `emptyTrash` also leaves the shared threads in
  the caller's Trash. A reader of a public thread who is not a member has no
  place for it: these are `FORBIDDEN` for them.
- Asker pays: the run is queued and billed to the question's author, and
  the daily limits are checked against the caller (who is the author).
- Stale revisions are `CONFLICT`: `updatePost` (`expectedText`),
  `updateDocument` (`expectedTitle`, `expectedResponseRevision`,
  `expectedHighlightIds`), `recaps.applyCandidate`
  (`expectedResponseRevision`, `expectedCurrentRecapId`), `setChainOrder`
  (`expectedOrder`), `highlights.create` against a replaced answer, and the
  reorder procedures.

### `sharing`, `invites`, `subscriptions`

`server/src/trpc/routers/sharing.ts`, on `repos/sharing.ts`. Members are
`ThreadMember { userId, login, name, avatarUrl, role, invitedBy, joinedAt }`
(owner first); invitations `ThreadInvite { id, treeId, role, githubLogin,
createdBy, createdAt, expiresAt }` (`shared/src/types/sharing.ts`).

| Procedure | Kind | Input → Output | Who |
| --- | --- | --- | --- |
| `sharing.setVisibility` | M | `{ treeId, visibility: "private" \| "public" }` → `ResearchTree` | owner; emits `research.tree.updated`, `research.sharing.changed` to the audience, and the All Users feed's `feed.item.*` |
| `sharing.listMembers` | Q | `{ treeId }` → `ThreadMember[]` | anyone who may read the thread |
| `sharing.setRole` | M | `{ treeId, userId, role: "commenter" \| "viewer" }` → `ThreadMember[]` | owner |
| `sharing.removeMember` | M | `{ treeId, userId }` → `{ ok }` | owner. The member's nodes and highlights stay; their queued follow-ups are deleted and their queued or running questions cancelled; they get `research.tree.removed` |
| `sharing.leave` | M | `{ treeId }` → `{ ok }` | a member (the owner is `FORBIDDEN`); as `removeMember` for oneself |
| `sharing.listShared` | Q | `{ place?: "shared" \| "archive" \| "trash" }` → `ResearchTreeSummary[]` | the threads shared with the caller: outside their Archive and Trash (most recently updated first), in their Archive or archived by the owner, or in their own Trash |
| `invites.create` | M | `{ treeId, role, githubLogin? }` → `CreatedInvite { invite, token, url }` | owner. A login invitation is accepted once, by that GitHub account, which gets a `notification.requested` (`kind: invite`) and `research.invites.changed`; a link invitation by anyone holding `url` (`/invite/<token>`, the client route `routes/invite.tsx`, `10-home-feed-journal.md` §4b). The token is returned once and stored as its SHA-256. 14 days; at most 50 pending per thread |
| `invites.list` | Q | `{ treeId }` → `ThreadInvite[]` (pending) | owner |
| `invites.received` | Q | → `ReceivedInvite[]` (pending login invitations to the caller's login) | signed in |
| `invites.accept` | M | `{ token }` \| `{ inviteId }` → `ResearchTree` (as the caller now sees it) | signed in. `NOT_FOUND` "This invitation was not found, has expired or was revoked." for an unknown, used, expired or revoked one; `FORBIDDEN` for a login invitation to another account; never lowers a role; at most 100 members |
| `invites.revoke` | M | `{ inviteId }` → `ThreadInvite` | owner |
| `subscriptions.set` | M | `{ treeId, value }` → `ResearchTree` (with `followed`) | anyone signed in who may read the thread. Follow: `notification.requested` for new questions and notes in it |

Wire additions (web only, optional, never sent by the desktop):
`ResearchTree.ownerId/visibility/role/trashedBy/followed`,
`ResearchTreeSummary.ownerId/visibility/role`, `ResearchNode*.authorId`,
`ResearchPostNode/ResearchDocumentNode.editedBy`,
`ResearchHighlight.authorId`, `ResearchTreeDetail.participants:
ResearchParticipant[]` (`{ id, login, name, avatarUrl }`),
`ResearchBranchRemoval.removedBy`. A tree's `archivedAt`, `trashedAt`,
`lastViewedAt`, `role` and `followed` are the reader's own.

### `followups`

The server's follow-up queue, which replaces the desktop's client-side queue
(`02-domain-model-and-database.md` §5.13). Items are
`ResearchFollowupQueueItem` (`{ id, treeId, headNodeId, authorId, message,
agent, position, createdAt, failedReason }`).

| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `followups.ask` | M | `{ headNodeId, prompt, model?, effort?, images?: string[] }` → `{ kind: "sent", node } \| { kind: "queued", item }` | `useResearchChainQueue` + `fork_research_node`. `headNodeId` is any node of the chain. Sent at once as the chain tail's inline follow-up when nothing is queued and the tail is complete; queued otherwise. `model`/`effort` default to the chain tail's agent. Checks the model, the effort, the daily limits and the run-queue bound up front; `TOO_MANY_REQUESTS` also when the account already has `SESSION_QUEUED_PER_USER` follow-ups queued `images` are resolved when asked and stored on the queued item, which keeps them attached until it is sent or cancelled; a cancel releases them. |
| `followups.cancel` | M | `{ itemId }` → the chain's queue after the change | the queue's Remove |
| `followups.retry` | M | `{ itemId }` → the chain's queue after the change (without the item when it was sent) | the queue's Retry: clears `failedReason` and dispatches |
| `followups.list` | Q | `{ treeId }` → `Record<headNodeId, ResearchFollowupQueueItem[]>` | — |

The server sends a chain's first item when the chain frees up: after a run
settles, `removeBranch`, `setChainOrder`, `restoreTree`,
`restoreTreeFromTrash`, `followups.cancel` and `followups.retry`, and on boot. Archived threads and threads in the Trash
wait. The send is checked against the item's author (model access, daily
limits, run-queue bound); a refusal sets `failedReason`, and the chain waits
on that item until it is retried or cancelled.

### `feed`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `feed.recentActivity` | Q | `{ scope?: "all" \| "mine" \| "workspace", workspaceId?, limit?, before?: RecentActivityCursor }` → `RecentActivityPage` | `list_recent_activity`; guests may read only `all`; `mine` spans the signed-in account's workspaces; `workspace` filters by `workspaceId` |
| `feed.recentQueries` | Q | `{ limit?, before? }` → `RecentResearchQueryPage` | `list_recent_research_queries` |
| `feed.recentQueriesForTrees` | Q | `{ treeIds: string[] }` (at most 200) → `RecentResearchQuery[]` | web only: the root entries of the caller's own threads among `treeIds`, in that order, without archived or trashed threads and with their children; Home reads its cards' content through it (`10` §1) |

### X posts

The `journal` router (`add`, `restore`, `update`, `remove`, `fetchTweet`,
`hydrateTweet`) was removed with journal entries in phase 2.0.

Hydration (`journal/tweets.ts`) is one cache-first pipeline for research
attachments, with two providers in order:
`cdn.syndication.twimg.com/tweet-result` for the whole post (media, quoted
post, link card, counts), then `publish.twitter.com/oembed` for the author,
text and date when syndication does not serve it. The provider that answered
is stored on the row and on the attachment (`xSyndication | xOembed`), so a
reduced card is recognizable as one. A resolved snapshot is stored with its
image URLs rewritten to `/embeds/<hash>` (§5). The same pipeline resolves the
X posts of questions (`createTree`, `forkNode`) and notes (`createPost`,
`createPostFollowUp`). A failure is cached for `TWEET_CACHE_TTL_MS` like a
success; `research.hydratePostTweet` passes `retryUnavailable` to ask again
inside that window.

### `artifacts`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `artifacts.prepareWidget` | M | `{ nodeId, sha256 }` (a block of a stored answer) or `{ treeId, artifactId, revision }` (a stored revision) → `{ staticUrl, runUrl \| null, expiresAt }`; `runUrl` is null while widget scripts are off | `research_widget_prepare` |
| `artifacts.register` | M | `{ nodeId, slot, html, meta }` → `ResearchArtifactRevision`; the block must be a complete widget with that fence metadata in the node's stored answer | `research_artifact_register` |
| `artifacts.history` | Q | `{ treeId, artifactId }` → `{ revisions: ResearchArtifactRevision[], unresolved }`, lineage order, after recording the thread's named revisions of the artifact | `research_artifact_history` |
| `artifacts.getState` | Q | `{ treeId, artifactId, revision }` → `ResearchArtifactState { enabled, value }`, the caller's own | `research_artifact_state_get` |
| `artifacts.updateState` | M | `{ reference, action: "enable" \| "disable" \| "save" \| "reset" \| "migrate", value? }` → `ResearchArtifactState`; per person, JSON of at most 16 KiB | `research_artifact_state_update` |

The `artifacts.*` procedures share a budget of 600 calls a minute per account
(`RATE_LIMITS.widgets`) in place of the mutation budget. Semantics are in
`11-artifacts-and-browser.md` §3–§5.

`documents.*` and `artifacts.mintToken` were removed with uploaded documents
in phase 2.0.

### `events`
| Procedure | Kind | Input → Output | Desktop |
| --- | --- | --- | --- |
| `events.subscribe` | subscription | → stream of `SessionEvent` | `listen("session-event")` |
| `events.setInterest` | M | `{ connectionId, nodeIds, treeIds? }` → `{ applied }` (false when the connection has expired or been terminated on the server) | — (which active nodes this connection wants turn deltas for; with `treeIds`, at most 20, which threads it has open: a public thread's events reach a non-member through this, and it is presence. Ids the caller may not read are dropped. Send again to renew; a declaration lapses after 90 s) |
| `events.presence` | Q | `{ treeId }` → `ThreadViewer[]` (`{ userId, login, name, avatarUrl }`) | — (who has the thread open now) |

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
events are delivered only to connections interested in that node.

A thread's events go to its audience (`EventBus.emitToTree`): every
connection of its owner and members, plus, for a public thread, the
connections of other signed-in readers that declared it open
(`setInterest` `treeIds`), and always the caller. This covers the run events
(`runs/loop.ts`, `runs/service.ts`, `runs/metadata.ts`), node, highlight,
recap, document and queue events. Tree-level events (`research.tree.updated`
on a rename, `archived`/`restored` by the owner) reach the others without
the caller's per-person fields (`role`, `lastViewedAt`, `followed`); a client
merges them over its cached tree. Per-person state stays with the person:
drafts, folders, the Trash and Archive of a member, `markTreeViewed`, Follow.
A change that takes a thread away (its owner's Trash, Delete, removing or
leaving a member) sends `research.tree.removed { treeId, removedBy }` to the
people who lose it, read before the change. `feed.item.*` for a public
thread fans out to every signed-in connection; for a private one to its
owner only. Guests have no event subscription and get no live updates.

Presence is in memory: a connection's open threads with when it last said
so, dropped when the connection closes or after 90 s without a renewal
(swept every 15 s), announced as `research.presence.changed` to the
thread's audience when the set of people changes.

Event types, payloads identical to the desktop (`ParsedResearchEvent` in
`packages/shared/src/wire/events.ts`)
unless noted:

| Type | Payload | Emitted by |
| --- | --- | --- |
| `research.tree.created` | `{ tree, node }` | createTree, createPost, importReport |
| `research.tree.updated` | `{ tree }` | rename, viewed, updatePost when the root title followed the text |
| `research.tree.archived` / `restored` | `{ tree }` | archive/restore, once per tree of the group; `restored` also by restoreTreeFromTrash |
| `research.tree.removed` | `{ treeId }` (web: also `removedBy`) | removeTree, trashTree, emptyTrash (once per tree), workspace remove; web: to every member who loses the thread, and to a member who leaves or is removed |
| `research.trash.changed` | `{ workspaceId }` (web only; the desktop's is `{}`) | trashTree, restoreTreeFromTrash, emptyTrash, removeTree of a tree in the Trash; only when something changed |
| `research.folders.changed` | `{ workspaceId }` (web only; the desktop's is `{}`) | folders.set when the stored state changed, emptyTrash when it deleted folders, workspace remove. Carries no state: clients refetch `folders.get` |
| `research.node.created` | `{ node }` | forkNode, followups.ask, follow-up dispatch, createPostFollowUp |
| `research.node.updated` | `{ node, queuePosition? }` | status transitions, rename, retry/rerun/resume reset, chain order stored, recap saved, snapshot stamped, preview (≤ 2/s), updatePost, hydratePostTweet |
| `research.node.removed` | `{ treeId, parentNodeId, removedNodeIds }` (web: also `removedBy`) | removeBranch, forkNode with `replacesNodeId` |
| `research.queue.changed` | `{ treeId, headNodeId, items }` | new (web only): a chain's follow-up queue changed (queued, sent, cancelled, retried, refused); `items` is the chain's whole queue after the change, empty once drained |
| `research.document.updated` | `{ tree, node, responseRevision, markdownChanged, removedHighlightCount }` | updateDocument |
| `research.highlight.created` | `{ nodeId, highlight }` | |
| `research.highlights.removed` | `{ nodeId, highlightIds }` | |
| `research.recap.pending` | `{ nodeId, pending }` | recap job start/end, every exit path |
| `research.drafts.changed` | `{ workspaceId }` | drafts.save, drafts.remove, drafts.reorder (when the order changed); to the draft owner's connections only |
| `workspace.created` / `updated` / `removed` | `{ workspace }` / `{ workspaceId }` | replaces `group.*` |
| `feed.item.upserted` | `{ id, kind, authorId, occurredAt, sourceRank, workspaceId, item }` | public feed source create/update/restore |
| `feed.item.removed` | `{ id, kind, authorId, occurredAt, sourceRank, workspaceId }` | source delete or archive |
| `settings.updated` | `{ settings }` | another tab changed settings |
| `models.updated` | `{ models }` | provider availability change |
| `notification.requested` | `{ id, title, body, tone, timeoutMs, createdAt, href?, kind?, treeId? }` | web only, to one person's connections (`research/notifications.ts`; no inbox): `runFinished` to the asker when their run completes or fails; `followUp` to a thread's followers for a new question or note by someone else; `branch` to the parent's author for a follow-up that is not inline (in place of `followUp`); `invite` to the account a login invitation names (`href` `/shared`). `href` is the in-app path the toast opens when clicked (the thread, at the node, for the others). The client shows it as a toast unless `showNotifications` is off |
| `research.presence.changed` | `{ treeId, viewers: ThreadViewer[] }` | web only: who has the thread open changed |
| `research.sharing.changed` | `{ treeId }` | web only: the receiver's access to the thread, its members or its visibility changed (invitation accepted, role changed, member removed or left, visibility changed, restored from the owner's Trash); lists and the thread refetch |
| `research.invites.changed` | `{ treeId }` | web only: a login invitation to the receiver was created |
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
| `GET /embeds/:hash` | one cached image of an embedded post (public, `immutable`); the hash is SHA-256 of the origin URL and names an `embed_assets` row, whose bytes are fetched on the first request and may be swept back off the volume (`13-deployment-fly.md` §6) |
| `POST /api/images` | uploads one image attachment (multipart, one `file` field) and answers `201` with its `ResearchImageAttachment`; signed in, CSRF-guarded, 120 uploads an hour per account (`RATE_LIMITS.uploads`), 512 MiB of images per account. The type is read from the bytes (PNG, JPEG, GIF, WebP; else `415`); files over 20 MB are `413`; a PNG or JPEG over 5 MB or 8000 px on a side is downscaled to 2048 px and stored as JPEG, a GIF or WebP must already fit (`413`). The image is pending until a message or draft names its id (`02` §5.15) |
| `GET /images/:id[?thumb]` | an image attachment, to its uploader and to anyone who may read a thread whose node or queued follow-up names it, guests included for a public thread (`images.readable`; `401` signed out otherwise, `404` signed in otherwise); `?thumb`
 serves the 256 px JPEG thumbnail of a PNG or JPEG image, written again when missing, and a GIF or WebP image whole. `Cache-Control: private, immutable` |
| `GET /w/:token` | a widget page (static or run), on the artifact host only and only as a frame document (`Sec-Fetch-Dest: iframe`); `11-artifacts-and-browser.md` §2–§3 |
| `GET /*` | built client `index.html` (SPA fallback) and hashed assets |

Security headers on every response: `Content-Security-Policy` (see
`07-client-architecture.md` §9), `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `Strict-Transport-Security` behind Fly's
TLS, `Permissions-Policy` minimal. `SESSION_PUBLIC_ORIGIN` validated as the
landing server did (`web/server.tsx:106-119`, reused).
