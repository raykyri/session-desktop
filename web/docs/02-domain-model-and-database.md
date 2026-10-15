# Domain model and database

Source of truth for behavior: `src-tauri/src/research.rs`, `state.rs`,
`persistence.rs`, `journal.rs`, `tweets.rs`, and the
frontend `src/types.ts`. This document maps that model onto SQLite tables
managed by Drizzle in `packages/db`, and lists the invariants the repository
layer must enforce.

## 1. Package layout (`packages/db`)

```
packages/db/
  drizzle.config.ts          # schema path, out dir, dialect sqlite
  migrations/                # generated SQL + meta/_journal.json, committed
  src/
    connection.ts            # openDatabase(path): applies pragmas, runs migrate()
    schema/
      users.ts  sessions.ts  preferences.ts
      workspaces.ts  folders.ts  trees.ts  nodes.ts  highlights.ts
      snapshots.ts  runs.ts (run_turns, run_attempts, run_queue, node_messages, node_summaries)
      usage.ts  tweets.ts  embeds.ts  feedItems.ts  drafts.ts
      followups.ts  images.ts  widgets.ts  collaboration.ts  index.ts
    repos/
      users.ts  auth.ts  workspaces.ts  folders.ts  trees.ts  nodes.ts
      highlights.ts  snapshots.ts  recaps.ts  feeds.ts  feedItems.ts
      feedgen.ts  drafts.ts  posts.ts  trash.ts  followups.ts
      researchDrafts.ts  images.ts  researchDocuments.ts
      mappers.ts             # rows to the wire ResearchNode envelope
      access.ts              # who may read a thread (its owner, for now)
    ids.ts                   # ulid(), validateId()
    time.ts                  # now(): number (ms)
    index.ts                 # public surface: openDatabase, repos, types
  test/                      # repository tests against a temp file DB
```

Rules

- Functions in `repos/*` accept `(db, userId, ...)`. They do not handle HTTP
  or emit events; the server layer wraps repository calls and emits events.
- Multi-step invariants run inside `db.transaction()`. better-sqlite3
  transactions are synchronous, so a repository function is synchronous too;
  the server calls them from tRPC resolvers directly (SQLite work is
  sub-millisecond; no worker thread is needed).
- JSON columns are `text` with `{ mode: "json" }` and a zod schema from
  `shared` applied at the boundary (`parseJsonColumn(schema, value)`), never
  trusted raw.
- All timestamps are `integer` milliseconds.

## 2. Domain types: the desktop's wire model

The web sends the desktop's wire types, from `packages/shared/src/wire/`
(plain types, also imported by the desktop) with zod schemas in
`packages/shared/src/schemas/` that `test/wireSchemas.test.ts` keeps in
sync. There is no separate web node type.

A `ResearchNode` is an envelope (`id`, `treeId`, `parentNodeId`, `inline`,
`anchor`, `title`, `groupId`, `createdAt`, `highlights`, `chainOrder`) plus a
body tagged by `type`:

- `post`: `message`, `format` (`text | link`), `followUpAgent`, `editedAt`.
- `exchange`: `message`, `agent`, `run` (`status`, `error`, `startedAt`,
  `completedAt`, `responseSnapshotAt`, `sessionReady`), `recap`.
- `document`: optional `message`, `source` (`imported | authored |
transcript`), optional `followUpAgent`, `responseSnapshotAt`, `recap`,
  `editedAt`.

The web's differences, all within the wire types:

- `groupId` carries the web workspace id; the field keeps the desktop's name.
- `AgentSpec` names a registry entry: `adapter` is the entry's model family
  (`ModelEntry.adapter`: `gemini`, `deepseek`, `openai`, `claude`), `model`
  the registry id, `effort` the requested reasoning effort (null: the model's
  `defaultEffort`). `models/agents.ts` builds and reads it.
- `ResearchNodeStatus` adds `interrupted`: a deploy or crash stopped an
  admitted run that the server resumes. The shared helpers treat it as active.
  The web loop never writes `starting`.
- `RunState` adds `attempt`, `responsePreview` and, on an `interrupted` run,
  `resumePending` (§5.3); `ResearchNodeContent` adds `inFlightText`, `seq`
  and `queuePosition`; `research.node.updated` may carry `queuePosition`.
  `ResearchTreeDetail` adds `queues`, the thread's follow-up queues keyed by
  chain head (`ResearchFollowupQueueItem[]`, §5.13). All are optional, so the
  desktop never sends them.
- A tweet attachment's `provider` is `xSyndication | xOembed`; `xOembed` is
  the reduced snapshot the server falls back to (`journal/oembed.ts`).
- `sessionReady` is true once an exchange is `complete`: a web follow-up
  starts a new run with the parent's stored conversation as context.

Web-only types: `User`, `Workspace`, `UserSettings`, `ModelInfo`,
`UsageSummary`, and the feed page and cursor shapes in `types/activity.ts`
(`RecentActivityItem` wraps the wire `RecentResearchQuery` with
`occurredAt` and `workspaceId`).

## 3. Tables

Column types are SQLite affinities via Drizzle (`text`, `integer`, `real`).
`PK` = primary key, `FK` = foreign key with `ON DELETE CASCADE` unless noted.
Rows a person owns name them in `owner_id` (`trees`, `folders`,
`research_images`) or `user_id` (per-person state). Rows inside a thread
(`nodes`, `highlights`, `followup_queue`) name who wrote them in `author_id`;
access goes through the thread's owner (`repos/access.ts`), not through the
author column, so phase 5 can add members without touching those rows.
Author foreign keys are `ON DELETE SET NULL` where content in other people's
threads must survive an account deletion.

### 3.1 Accounts

`users`

- `id` text PK (ULID)
- `github_id` integer unique, `login` text, `name` text null, `avatar_url` text
- `is_admin` integer bool (default 0; set manually with `npm run db:admin -- <login>`)
- `github_created_at` integer (account age, for sign-up throttling)
- `signup_ip_hash` text (salted hash), `invited_by` text null FK,
  `invites_remaining` integer (default 0)
- `created_at`, `last_login_at` integer

`invites`

- `code` text PK, `created_by` FK, `created_at`, `used_by` text null FK,
  `used_at` null. These are sign-up codes (the UI's name; thread
  invitations are `tree_invites`, §3.5). Sign-up requires a valid unused code
  when `SESSION_REQUIRE_INVITE=1`; codes are distributed manually at first.

`signup_attempts`

- `ip_hash` text, `attempted_at` integer, `outcome` text; index
  (`ip_hash`, `attempted_at`). Feeds per-IP sign-up throttling.

`user_limits`

- `user_id` PK FK, `daily_tokens` integer null, `daily_runs` integer null
  (null = deployment default from `SESSION_DAILY_TOKENS` = 1,000,000 and
  `SESSION_DAILY_RUNS` = 10), `updated_at`

`sessions`

- `id` text PK (32 random bytes, base64url) — stored as SHA-256 of the cookie value
- `user_id` FK, `created_at`, `expires_at`, `last_seen_at` integer, `user_agent` text

`oauth_states` (short-lived): `state` text PK, `code_verifier` text,
`created_at`, `return_to` text.

`user_preferences`

- `user_id` PK FK
- `settings_json` text — `UserSettings` (appearance, theme, font, text size,
  hints, motion, cmd-enter, notifications, defaultModel)
- `research_launch_instruction` text (≤ 4096 bytes, enforced in shared)
- `default_workspace_id` text null
- `updated_at`

`interface_drafts`

- `user_id` FK, `key` text (≤128 B), `value` text (≤ 1 MiB on the web; the
  desktop allowed 12 MiB in memory), `updated_at`; PK (`user_id`, `key`)

`research_drafts` (the desktop's `ResearchDraft`; private to the person)

- `id` PK, `user_id` FK, `workspace_id` FK, `prompt` text,
  `attachments_json` text (image attachments, default `[]`), `position`,
  `created_at`, `updated_at`
- Index (`user_id`, `workspace_id`, `position`)
- `repos/researchDrafts.ts` (§5.14)

### 3.2 Organization

`workspaces` (desktop `GroupInfo` with `scope: research`)

- `id` PK, `user_id` FK, `name` text, `position` integer
- `created_at`, `updated_at`, `deleted_at` null (a removed workspace whose
  threads the deletion job has not finished; hidden from every workspace
  query, §5.18)

The desktop's `ResearchFolderState` is spread over four tables: `folders`,
`tree_folder_membership` (`membership`), `collapsed_places` (`collapsed`),
`collapsed_groups` (`collapsedGroups`), plus `trees.parent_tree_id`
(`parents`).

`folders`

- `id` PK, `owner_id` FK, `workspace_id` FK, `name` text, `position`
  integer, `created_at`, `trashed_at` null
- Index (`owner_id`, `workspace_id`, `position`)

`tree_folder_membership`

- `tree_id` PK FK, `folder_id` null FK, `system_place` null (`drafts`, the
  desktop's `system:drafts`)
- Check: exactly one of `folder_id` and `system_place` is set. A tree with no
  row is Unfiled.

`collapsed_places`: `user_id` FK, `workspace_id` FK, `place_id` text (a
folder id or a `system:*` tray id); PK over all three. Per person.

`collapsed_groups`: `user_id` FK, `tree_id` FK; PK (`user_id`, `tree_id`).
The parent trees whose nested children a person has hidden. Per person.

### 3.3 Research

`trees`

- `id` PK, `owner_id` FK, `workspace_id` FK
- `title` text, `root_node_id` text (no FK; see §5.1)
- `created_at`, `updated_at`, `archived_at` null, `trashed_at` null
- `parent_tree_id` null FK (`trees`, `ON DELETE SET NULL`): the tree this one
  is listed under on Home, one level deep (enforced by the repository)
- `visibility` text (`private | public`, default `private`)
- `position` integer — sidebar order within (`workspace_id`,
  `archived_at IS NULL`). A tree in the Trash keeps its position and moves
  down with the others when a tree is inserted above it; reordering rewrites
  only the trees outside the Trash (§5.10)
- `deleted_at` null: set by Delete now, Empty Trash and removing the
  workspace. From then on no query or access check sees the tree, and the
  deletion job removes its rows (§5.18)
- Indexes: (`owner_id`, `workspace_id`, `archived_at`, `trashed_at`,
  `position`), (`owner_id`, `trashed_at`), (`parent_tree_id`),
  (`visibility`, `updated_at`), (`deleted_at`)

`tree_views`

- `user_id` FK, `tree_id` FK, `last_viewed_at`; PK (`user_id`, `tree_id`)
- When each person last opened each thread; the summary's unseen flags
  compare against it, so they are per person.

`nodes` (the wire envelope; `repos/mappers.ts` builds `ResearchNode`)

- `id` PK, `tree_id` FK, `parent_node_id` text null FK (self,
  `ON DELETE RESTRICT`; subtree removal deletes children first)
- `author_id` null FK (`ON DELETE SET NULL`)
- `inline` integer bool
- `type` text (`post | exchange | document`)
- `message_json` text null — `UserMessage` `{ text, attachments? }`; null
  only for a document without a message
- `anchor_json` text null — `NodeAnchor` (`{ kind: "passage", anchor }`)
- `format` text null (`text | link`; posts only), `source` text null
  (`imported | authored | transcript`; documents only)
- `model` text null, `effort` text null — the AgentSpec: an exchange's agent,
  or the follow-up default of a post or document; required on exchanges
- `title` text null, `response_preview` text null
- `status` text null (`ResearchNodeStatus`), `error` text null — exchanges
  only
- `attempt` integer (1; incremented by Retry and auto-resume), `run_seq`
  integer (last persisted sequence number of the current attempt),
  `resume_pending` integer bool
- `response_snapshot_at` integer null
- `created_at`, `started_at` null, `completed_at` null, `edited_at` null
- `edited_by` null FK — unused until phase 5
- `chain_order_json` text null — `string[]`, on the head of an inline chain
- `recap_json` text null — `ResearchRecap`
- Checks: `status` is set exactly on exchanges, `format` exactly on posts,
  `source` exactly on documents; `message_json` is set except on documents;
  `model` is set on exchanges
- Indexes: (`tree_id`, `created_at`, `id`); (`status`); (`parent_node_id`);
  (`author_id`); partial unique index on (`parent_node_id`) WHERE
  `inline = 1` (one inline child per parent, §5.4)

`highlights`

- `id` PK, `author_id` null FK (`ON DELETE SET NULL`; charged against the
  author's storage quota), `node_id` FK
- `anchor_json` text — `ResearchHighlightAnchor` (version 1, projection
  `answer-v1`, UTF-16 `start`/`end`, `exact`, `prefix`, `suffix`,
  `responseRevision`)
- `response_revision` text (denormalized from anchor for the feed query)
- `created_at`; index (`node_id`), (`author_id`, `created_at`)
- Highlights belong to the node: everyone who can read a thread sees them.

`followup_queue` (the desktop backend keeps the same queue in `state.json`, `researchFollowups`; §5.13)

- `id` PK, `tree_id` FK, `head_node_id` FK (the inline chain's head; the
  items go with it), `author_id` FK (who is billed when the item is sent)
- `message_json` text (attachments resolved when queued), `model`, `effort`
  null (the agent the follow-up runs on), `position` (send order within the
  chain), `created_at`, `failed_reason` null (why the last send was refused)
- Indexes (`head_node_id`, `position`), (`tree_id`), (`author_id`)

`response_snapshots`

- `node_id` PK FK
- `revision` text — lowercase sha256 hex of the canonical JSON of `turns`
  (§5.2)
- `turns_json` text — `Turn[]`
- `outcome_json` text null — `{ status, error, completedAt }`
- `byte_size` integer, `version` integer (1), `updated_at`

`run_turns` (live output of an active attempt; `05-run-lifecycle-and-streaming.md` §5)

- `node_id` FK, `attempt` integer, `turn_id` text, `position` integer
- `turn_json` text — `Turn`
- `committed` integer bool (0 for the in-flight checkpoint row)
- `seq` integer (node sequence number at which this row was written)
- `updated_at`; PK (`node_id`, `attempt`, `turn_id`); deleted when the final
  snapshot commits

`run_attempts`

- `node_id` FK, `attempt` integer, `kind` text (`fresh | resume`), `model`
  text, `started_at`, `ended_at` null, `outcome` text null, `error_class`
  text null, `steps` integer, `tool_calls` integer, `usage_json` text null
  (input, output, reasoning, cached tokens), `cost_estimate_micros` integer
  null; PK (`node_id`, `attempt`). Deleted with the node, so the daily run
  limit does not count these (§3.7)

`node_messages` (canonical conversation; `04-agent-runtime.md` §4)

- `node_id` FK, `position` integer, `message_json` text (AI SDK
  `ModelMessage` including tool calls/results and provider metadata),
  `model` text (which model produced assistant messages), `created_at`;
  PK (`node_id`, `position`). Written once when a node completes; never
  updated.

`node_summaries` (context compaction cache)

- `node_id` PK FK, `summary` text, `covers_through_node_id` text,
  `created_at`

`run_queue` (admission control; §5.7)

- `node_id` PK FK, `user_id` FK, `pool` text (`research | metadata`),
  `provider` text, `enqueued_at`, `claimed_at` null, `not_before` integer
  null (backoff)

### 3.4 Feed items and X posts

`journal_entries` was removed with journal entries in phase 2.0.

`feed_items`

- `id` text PK, `author_id` FK
- `occurred_at`, `source_rank`; nullable source FKs `node_id`, `tree_id`,
  `workspace_id`
- Indexes (`occurred_at DESC`, `source_rank DESC`, `id DESC`) and
  (`author_id`, `occurred_at DESC`) and (`tree_id`); unique source index on
  `node_id`
- Written synchronously in the same transaction as root changes; source
  deletion, archiving or moving the tree to the Trash removes the row.
- The All Users feed is to read only rows whose tree has
  `visibility = 'public'`. Nothing sets `visibility` yet, so the query does not
  filter on it until phase 5 adds the setting.

`tweet_cache`

- `tweet_id` PK, `payload_json` text (raw provider body, ≤ 1 MiB),
  `snapshot_json` text null (`TweetSnapshot`, ≤ 128 KiB; source URLs ≤ 8 KiB,
  `tweets.rs:18-19`), `fetched_at`, `status` text (`resolved |
unavailable`), `provider` text null (`xSyndication | xOembed`; which
  pipeline produced the snapshot — null on an unavailable row and on rows
  written before the fallback existed), `failure` text null
- Shared across accounts: a post's public payload is the same for everyone and
  the row records nothing about who asked. A row this side of
  `TWEET_CACHE_TTL_MS` (6 h) is reused rather than refetched, failures
  about the post included (not found, withheld, over the size cap), so a
  deleted post is not re-asked on every render. A timeout or network failure
  says nothing about the post and is reused for
  `TWEET_TRANSIENT_FAILURE_TTL_MS` (1 min) only.

`embed_assets`

- `hash` PK (SHA-256 of `source_url`, hex — the `/embeds/<hash>` a stored
  snapshot includes), `source_url` text, `content_type` text null, `bytes`
  integer, `stored_at` integer null, `last_access_at`, `created_at`
- Index: (`last_access_at`) — the sweep's eviction order
- The mapping from a snapshot's rewritten image URL back to the origin one.
  The row outlives the bytes: the sweep unlinks files and clears `stored_at`,
  and the next request for that hash re-fetches. Also shared across accounts,
  and registered at hydration rather than when the image is first served
  (`13-deployment-fly.md` §6).

### 3.5 Sharing (phase 5)

Web only; the desktop has one person. Rules in §5.16.

- `tree_members` (`tree_id`, `user_id`, `role` `commenter | viewer`,
  `invited_by`, `created_at`, and the member's own `archived_at`,
  `trashed_at`, `trash_workspace_id` (the member's workspace whose Trash
  lists the thread: the one they trashed it from; null, or a workspace since
  deleted, `ON DELETE SET NULL`, is their default workspace) and
  `folder_id`, one of their own folders, `ON DELETE SET NULL`). The owner is
  `trees.owner_id` and has no row. Indexes (`user_id`) and (`folder_id`).
- `tree_invites` (`token_hash` = SHA-256 of the token, which is never
  stored; `role`; `github_login` for an invitation to one account, null for
  a link; `created_by`, `expires_at` (14 days), `accepted_by/at`,
  `revoked_at`). Indexes (`tree_id`), (`created_by`, `created_at`) for the
  daily cap, and the partial unique `tree_invites_login_pending_uq` on
  (`tree_id`, `lower(github_login)`) where the invitation is a login one,
  not accepted and not revoked: one pending login invitation per account
  and thread (§5.16).
- `tree_subscriptions` (`user_id`, `tree_id`, `created_at`): Follow. A row
  is created for the owner with the thread (`trees.admitRoot`) and for a new
  member when they accept an invitation (`sharing.acceptInvite`); unfollowing
  deletes it, and only `setFollowing` creates it again (§5.16).
- `notifications` (`id` = the `notification.requested` event's id,
  `user_id` FK cascade, `kind` `runFinished | followUp | branch | invite`,
  `tone`, `tree_id` null FK cascade, `title`, `body`, `href` null,
  `created_at`, `read_at` null): the inbox, one row per recipient (§5.17).
  Indexes (`user_id`, `created_at`, `id`) for paging, a partial
  (`user_id`) where `read_at IS NULL` for the unread count, and (`tree_id`)
  for the cascade.
- `tree_member_removals` (`tree_id`, `user_id`, `removed_by`, `removed_at`):
  people the owner removed. A link invitation created at or before
  `removed_at` does not admit them again (§5.16).
- `trees.visibility` (`private | public`) and `trees.trashed_by` (who moved
  the thread to its owner's Trash).
- `nodes.author_id` and `highlights.author_id` are `ON DELETE SET NULL`;
  `nodes.edited_by` records who last replaced a note's or document's text.

All of these are in `0000_initial`; the collaboration schema has never been
deployed with an earlier history.

### 3.6 Images and widgets

`research_images` (step 2.9; the desktop's research image store,
`research_images.rs`)

- `id` PK (ULID), `owner_id` FK, `sha256` (of the stored bytes), `mime`
  (`image/png | image/jpeg | image/gif | image/webp`), `byte_size`, `width`
  null, `height` null (as displayed, after EXIF orientation), `file_name`
  null (the last path component of the uploaded name, control characters
  removed, at most 255 code points), `storage_path`, `created_at`,
  `attached_at` null (set when a node, queued follow-up or draft uses the
  image; null means pending)
- Indexes (`owner_id`, `sha256`), (`attached_at`, `created_at`)
- `image_refs`: one row per image a node, draft or queued follow-up names:
  `image_id` FK (cascade), `holder_kind` (`node | draft | queue`),
  `holder_id` (the node, draft or queue item id; no foreign key, since it
  names a row of one of three tables), `tree_id` null FK (cascade; the
  thread of a node or queued item, null for a draft), `created_at`; PK
  (`image_id`, `holder_kind`, `holder_id`), indexes (`holder_kind`,
  `holder_id`) and (`tree_id`). §5.15 has who writes it.
- The bytes are at `${SESSION_DATA_DIR}/documents/<owner_id>/<sha256>`, with
  a 256 px JPEG thumbnail beside a PNG or JPEG image as
  `<sha256>.thumb.jpg`. Two rows of one owner with the same bytes share the
  file. §5.15 has the lifecycle.

`widget_revisions` (the desktop's research artifact store)

- `tree_id` FK, `artifact_id`, `revision` (the desktop's revision id: the
  SHA-256 of `[artifact_id, node_id, content_hash, parent]`), `node_id` FK,
  `slot`, `title`, `content_hash`, `parent_revision` null, `html`,
  `created_at`; PK (`tree_id`, `artifact_id`, `revision`)
- `parent_revision` is the fence's declared `parent=` as written (at most 128
  characters). A value that is not a 64-hex revision id is the desktop's
  `invalidParent`: the wire revision has no parent and `unresolvedParent`.
- Rows are immutable; they go with their node or tree (`repos/widgets.ts`).
  Index (`node_id`), which the cascade from `nodes` follows: without it every
  node delete scans the table.

`widget_state`: saved widget inputs per person and revision; `state_json`
(`{ enabled, value? }`, the value JSON of at most 16 KiB), `updated_at`; PK
(`tree_id`, `artifact_id`, `revision`, `user_id`), FK to `widget_revisions`.

`documents`, `document_text`, `node_documents` and `artifact_tokens` were
removed with the uploaded-documents feature in phase 2.0.

### 3.7 Usage

`usage_events`

- `id` PK, `user_id` FK, `node_id` text null, `kind` text (`research |
metadata | search | fetch | run`), `provider` text, `model` text null,
  `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_tokens`
  integer, `cost_estimate_micros` integer, `created_at`
- `node_id` has no foreign key: deleting research keeps the account's usage.
- `run` rows carry no tokens: `runs.startAttempt` writes one per attempt
  started, for the person who pays for it, with the id
  `run:<node_id>:<attempt>` so starting the same attempt again does not count
  twice. They are what the daily run limit counts, so deleting a thread does
  not give its runs back.
- Index (`user_id`, `created_at`). Admission sums the current UTC day per
  user for the daily token and run limits (`06-auth-and-users.md` §8);
  rollups are materialized only if that query becomes slow.

## 4. Drizzle and migrations

- `drizzle.config.ts`: `dialect: "sqlite"`, `schema: "./src/schema/index.ts"`,
  `out: "./migrations"`.
- Developers change `schema/*.ts`, run `npm run db:generate` (drizzle-kit),
  review the SQL, commit both. CI fails if `db:generate` would produce a diff
  (`drizzle-kit check` plus a generate-and-git-diff step).
- `openDatabase()` runs `migrate(db, { migrationsFolder })` before returning.
  Server boot stops if the database reports a migration the code
  does not know (the desktop's "newer version ⇒ abort startup" contract,
  `persistence.rs:403`), by comparing `__drizzle_migrations` against the
  bundled journal.
- Data backfills that cannot be expressed in SQL run as versioned TypeScript
  steps in `src/backfills/` after `migrate()`, recorded in a `backfills`
  table. The list is empty since the reset below.
- Phase 2.0 of the desktop parity plan squashed the history into one
  `0000_initial.sql` generated from the schema, and phase 5 folded the
  collaboration migration into it again before the first deploy. A database created by the
  earlier migrations is not upgraded; it is replaced
  (`runbooks/reset-database.md`).
- Test databases: `openDatabase(":memory:")` for unit tests of repos where
  file semantics do not matter; a temp file for tests exercising WAL and
  concurrent readers.

## 5. Invariants the repository layer enforces

Each item names the desktop source and the enforcing function.

### 5.1 Structure

- A tree's `root_node_id` refers to a node in the same tree with
  `parent_node_id IS NULL`; a node's parent is in the same tree
  (`state.rs:2367-2404`). Enforced by `trees.admitRoot` creating both rows in
  one transaction and by `nodes.admitChild` checking the parent's `tree_id`.
- Node ordering within a tree is `(created_at, id)` ascending everywhere
  (`state.rs:4300`).
- Sidebar order: `position` within a (`workspace`, archived) section. New
  roots insert at position 0 (`admit_research_root`, `state.rs:4415`).
  `trees.reorder(workspaceId, archived, treeIds)` replaces exactly one visible
  subsequence and rejects count mismatch, duplicates, and out-of-section ids
  (`state.rs:3792`).
- `touchTree` bumps `updated_at` on every node mutation, including failure
  (`state.rs:11431`); document edits force strictly increasing `updated_at`
  and `response_snapshot_at` (`now.max(prev+1)`, `state.rs:5074`).

### 5.2 Response snapshots and revisions

- `revision = sha256(canonicalJson(turns))` lowercase hex, where
  `canonicalJson` is `JSON.stringify` of the `Turn[]` with the key order the
  shared serializer emits (`shared/src/research/revision.ts`). Only the web
  app ever computes it.
- `snapshots.commit(nodeId, turns, outcome)` requires an assistant turn with
  text and is called by the runtime only after two consecutive identical reads
  of the live turns (`state.rs:8870`). It writes the snapshot row, sets
  `response_snapshot_at`, `status`, `completed_at`, `error`, and touches the
  tree in one transaction with `synchronous=FULL`.
- Snapshot size cap 64 MiB (`MAX_RESPONSE_SNAPSHOT_BYTES`); exceeding it
  fails the node with the desktop's message "research finished, but its
  response could not be preserved".

### 5.3 Status

- `queued → running → complete | failed | cancelled | interrupted`.
  Terminal statuses are monotonic: `nodes.setStatus` prevents transitions from
  a terminal status except via `nodes.resetForRetry` (requires `failed`,
  `cancelled`, or `interrupted`; increments `attempt`; puts the node back to
  `queued`; clears `error`, `started_at`, `completed_at`, `run_seq`; deletes
  `run_turns`, partial `node_messages`, and the snapshot row) and
  `nodes.resumeAttempt` (requires `interrupted`; increments `attempt`; keeps
  committed `run_turns` and their messages as context; drops the in-flight
  checkpoint).
- `nodes.resetForRerun` (`rerun_research_node`) is `resetForRetry` for any
  settled exchange, a `complete` one included: the snapshot and the recap
  are deleted, highlights stay and the client re-anchors them by quote. It
  refuses posts and documents, archived threads and threads in the Trash, and
  needs the parent's answer to be `complete`, except for an inline follow-up
  whose parent is itself active again (rerun or retried): that rerun is
  admitted and waits in the run queue (§5.7).
- An exchange's run is _active_ while it is `queued` or `running`, or
  `interrupted` with `resume_pending = 1` (`subtrees.activeRun`). An
  `interrupted` node whose resume is no longer pending
  (`nodes.clearResumePending`, after `MAX_AUTO_RESUMES`; the server then
  publishes `research.node.updated` and runs what follows a settled run) is
  settled: it can
  be retried, rerun, replaced, or deleted (`removeBranch`, `trees.remove`,
  `workspaces.remove`) like a failed node. The wire node carries the flag as
  `run.resumePending`. Deleting a node with a pending resume is refused, as
  its `run_queue` row is about to be claimed.
- Cancel flips status first, then aborts the provider stream (`state.rs:5876`).
- `run_seq` increments in the same transaction as every `run_turns` write
  and every status change, and is returned by `getNodeContent`.

### 5.4 Follow-ups

- An exchange parent must be `complete`; posts and documents take
  follow-ups at once. The tree must be neither archived nor in the Trash
  (`state.rs:5244`). Only a post takes a follow-up note (a `post` child).
- At most one inline child per parent regardless of the child's status; the
  partial unique index makes the check atomic, and the repo maps the
  constraint error to the desktop's message.
- Model: a follow-up defaults to the parent's model and may choose any model
  the user may access; the server enforces `adminOnly` gating. `document`
  parents (imported reports) have no messages, so the child's prompt embeds
  the document markdown (`04-agent-runtime.md` §4).
- The displayed `message.text` is the bare question; the launch messages are
  assembled by the runtime (`04-agent-runtime.md` §5).
- Effort: a follow-up names a registry model and an effort that model
  accepts (`ModelEntry.efforts`; the server refuses others). Without one it
  keeps the parent's agent; a different model without an effort runs at the
  model's `defaultEffort`.
- An edited question replaces a failed, cancelled, or no-longer-resuming
  interrupted question (`replacesNodeId`, the desktop's
  `create_research_child_replacing`): the replaced node must be a childless
  exchange under the same parent with the same `inline`. In one transaction
  the new node is admitted and the replaced one deleted (an inline one
  first, since the partial unique index holds one inline child); the new
  node takes the replaced one's place in the head's `chain_order_json`, and a
  replaced branch head's queued follow-ups move to the new node.
- `nodes.setChainOrder(headNodeId, nodeIds)` (`set_research_chain_order`)
  stores a messages column's display order on the chain head. `headNodeId`
  must start its chain, `nodeIds` must be exactly the chain's current nodes
  (no duplicates, nothing missing or extra), and the thread must be neither
  archived nor in the Trash. The order is display only: a follow-up still
  continues the chain's last node.

### 5.5 Highlights

- Anchor validation follows `research.rs:1522-1546`, which groups the checks
  so one message covers each class of malformed anchor. The grouping defines
  the validation rules; callers cannot observe the order within a group:
  1. `version !== 1` or `projection !== "answer-v1"` → "unsupported research
     highlight anchor".
  2. `start >= end` or `exact.trim()` empty → "Invalid highlight anchor:
     selection cannot be empty."
  3. `end > 64 MiB` or `end - start !== exact.length` in UTF-16 code units →
     "Invalid highlight anchor: selection offsets do not match text length."
  4. `exact > 64 KiB` or `prefix > 512 B` or `suffix > 512 B` → "Highlight
     selection exceeds maximum allowed byte limit."
  5. `responseRevision` is not 64 lowercase hex digits → "Invalid highlight
     anchor: response revision format is invalid."

  Consequently, an anchor that is both empty and exceeds the length limit fails
  with the selection-empty error. Unlike the desktop Rust implementation, which
  accepted case-insensitive revisions because it evaluated only server-generated
  hashes, the web server requires lowercase hexadecimal revisions from clients.
  The Zod schema additionally requires integer,
  non-negative offsets at the tRPC boundary, and the shared
  `validateHighlightAnchor` is the single implementation.

- The node must have a snapshot whose `revision` equals
  `anchor.responseRevision`; otherwise it returns "The research response has
  been updated; please reselect the text."
- Caps: 500 per node, 512 KiB per node, 4 MiB per user (desktop: per
  state file), estimated per highlight as `160 + id.length +
projection.length + revision.length + 6 × (exact + prefix + suffix)`
  (`research.rs:1548-1561`); the 160-byte base overhead causes the per-node byte limit to be reached before the count limit.
- Highlight IDs must be unique per user; while ULID generation makes collisions virtually impossible, the database constraint remains enforced.

### 5.6 Documents

- `researchDocuments.update` performs the 4-way optimistic check: node is the
  tree's root and `type = document`; tree not archived; `expectedTitle === tree.title`;
  `expectedResponseRevision === snapshot.revision`; and if markdown changed,
  `expectedHighlightIds` equals the current set (`state.rs:4961`). The stored
  body is trimmed before it is compared with the trimmed request, so a
  title-only save is not a body change. A markdown change writes a new
  snapshot (single `Turn` with one `text` block) and `response_preview`,
  moves each highlight and each passage branch's anchor to its quote in the
  new body (`reanchorResearchQuote`, the desktop's `reanchor_highlights`; a
  moved anchor takes the new revision), deletes the highlights whose quote
  is gone (a branch whose quote is gone keeps its anchor and is counted in
  `unmatchedBranchCount`), and clears the recap. It returns
  `{ tree, node, responseRevision, markdownChanged, removedHighlightCount,
unmatchedBranchCount }` and, for the server, the moved branches (each
  announced as `research.node.updated`). The server then schedules a new
  recap for an imported report (§5.8), as the desktop does.
- Limits: 10,000 words and 10 MiB (`research.rs:17-20`), checked only for a
  new body, so an imported report over the word limit keeps an editable
  title.

### 5.7 Runs and admission

- Insert node as `queued` and a `run_queue` row in one transaction. The
  server claims rows FIFO by user then time under per-user and global limits
  (`05-run-lifecycle-and-streaming.md` §8). The desktop application allowed unbounded concurrency, but the web application enforces concurrency limits because server resources are shared among multiple users.
- On boot: `queued` rows stay queued; `running` nodes (a crash without
  shutdown) become `interrupted` with `resume_pending = 1`; every
  `resume_pending` node is re-queued at the head of the queue
  (`05-run-lifecycle-and-streaming.md` §7). Nodes whose snapshot row already
  has an `outcome` adopt it (the desktop's rule, `state.rs:2405-2506`). A
  node whose payer can no longer read its thread (a member who left or was
  removed before their interrupted run was stopped) is stopped instead of
  re-queued (`stoppedNodeIds`, "Stopped: the person who asked no longer has
  access to this thread."). Each node is reconciled in a savepoint of its
  own: one that fails is left as it was and reported (`failures`), and the
  boot goes on.
- `nodes.stopRun(nodeId, error?)` stops a run the server still owns
  (`queued`, `starting`, `running`, or `interrupted` with a resume pending)
  in one transaction: status `cancelled`, `resume_pending` cleared, the
  `run_queue` row deleted. `setStatus` refuses `interrupted` → `cancelled`;
  this is the path out. `research.cancelNode`, a departed member's questions
  (`afterDeparture`), a claimed row whose payer can no longer read the
  thread, and boot use it.
- A claimed node whose parent's answer is not `complete` does not start: its
  parent's conversation is its context. While the parent is active the row
  goes back to the queue with `not_before` up to `PARENT_WAIT_MS` (60 s)
  ahead, and the parent's settlement clears it (`queue.wakeChildrenOf`); a
  parent that settled without an answer fails the node with "The answer this
  question follows did not complete." This is how a rerun waits behind the
  answer it follows (§5.3).

### 5.8 Recaps

- A recap belongs to a completed exchange or an imported report
  (`recapEligible` in `shared/src/research/recap.ts`, the desktop's
  `recap_eligible`); posts, authored documents and transcripts take none.
  An automatic recap is scheduled when an exchange completes, when a report
  is imported, and when an imported report's body is edited
  (`shouldScheduleRecap`; `research_recap::schedule` on the desktop).
- `recaps.save(nodeId, recap, expectedSnapshotAt)` re-checks that the node
  can carry a recap, `response_snapshot_at` unchanged, and the snapshot revision equals
  `recap.responseRevision`; otherwise no-op (`state.rs:8942`).
- `recaps.applyCandidate` additionally requires
  `expectedCurrentRecapId === node.recap?.id` and a non-archived tree
  (`state.rs:8992`). Instructions trimmed, non-empty, ≤ 4000 chars. The
  server stores only a candidate it generated for the caller and still holds
  (`recallRecapCandidate`); otherwise it answers `CONFLICT` "This recap is no
  longer available; generate it again." and never stores text the client
  sent.

### 5.9 Feeds

- `feeds.recentActivity(userId, { scope, workspaceId, limit, cursor })` reads
  `feed_items` under one cursor `(occurredAt DESC, sourceRank DESC, id DESC)`
  with `sourceRank` research = 1. `all` reads the feed rows of public threads
  (`trees.visibility = 'public'`) from every account, `mine` filters `author_id` without a workspace predicate, and
  `workspace` filters the caller's research roots by `workspace_id`. `limit`
  is clamped to 1..100.
  Source rows are projected after keyset selection; direct research children
  are attached per root in `(created_at, id)` ascending order.
- `highlights.feed(userId)` returns newest-first items from the trees the
  reader owns or is a member of (`treeJoinedBy`, not public threads they
  only read), outside the reader's Archive and Trash: for a shared thread,
  the member's own and the owner's. Each item carries the highlight's
  `authorId` and the reader's `role`. `nodeLabel` = node title or prompt, or the tree title for
  documents (`research.rs:485`). `workspaceId` narrows the reader's own
  threads; shared threads are listed in every workspace.
- `feeds.recentQueries` is driven from the owner's `trees` rows
  (`CROSS JOIN` keeps that order), each joined to its root by primary key.
- `trees.summaries` computes `runningCount` (`queued | running`),
  `failedCount`, `completedCount`, `cancelledCount` (`interrupted` is not included in summary count totals and does not trigger attention indicators; it is displayed directly in the activity rail), `hasUnseenUpdate` (latest `completed_at` > the caller's
  `tree_views.last_viewed_at`), `hasUnseenFailure` (latest failed
  `completed_at` > the same)
  (`state.rs:3770-3776`) via grouped subqueries.

### 5.10 Trash

- `trash.trashTree` sets `trees.trashed_at` (`trash_research_tree`). Nothing
  is deleted: nodes, snapshots, membership, parent, archive state and
  position stay. It deletes the tree's `feed_items` row. Refused while a node
  of the tree has an active run (`queued`, `running`, or `interrupted` with
  a resume pending; §5.3), with the desktop's message. Trashing a tree already in the Trash changes nothing.
- `trash.restoreTree` clears `trashed_at`
  (`restore_research_tree_from_trash`). The trees in the tree's section
  (`workspace_id`, archived or not) at or after its position move down one,
  so it returns to its place; an archived tree returns to the Archive. The
  feed row is restored for an unarchived tree.
- `trash.list(workspaceId)` is `trees.summaries` with `trashed: true`: the
  workspace's trees in the Trash, archived or not, with counts and flags,
  ordered `trashed_at DESC, id`.
- `trash.empty(workspaceId)` deletes, in one transaction, the workspace's
  trees in the Trash (as `trees.remove` does: marked deleted, §5.18) and its
  folders in the Trash
  (their memberships cascade, so their trees become Unfiled; `collapsed_places`
  rows naming them are deleted). A tree that somehow has an active run is
  left in the Trash. Returns `{ treeIds, folderIds }`.
- `trees.remove` is Delete now, in or out of the Trash. It marks the trees
  deleted (§5.18).
- Groups: a parent (`trees.parent_tree_id`, §5.11) is archived, unarchived,
  moved to and out of the Trash, and deleted together with the children
  listed under it: the trees whose parent it is and that are listed in the
  same place (the Trash, the Archive, Drafts, the same folder outside the
  Trash, or Unfiled). This is the desktop's `groupChildren`
  (`useResearchGroupActions.tsx`), which the desktop applies from the client
  one call per tree; the web applies it in the repository, in one
  transaction, so the active-run refusal covers the whole group. A child's
  own operations do not reach its parent, and a child listed elsewhere stays
  when its parent is deleted (`ON DELETE SET NULL`).
- Every list leaves the Trash out: `trees.summaries`, `trees.reorder`,
  `feeds.recentQueries`, the Home feed (`feedgen` drops and skips the row),
  `highlights.feed` and `workspaces.treeCounts`.
- User edits to a tree in the Trash are refused with "restore this research
  from the Trash before changing it" (`access.rejectTrashed`, the desktop's
  `reject_trashed_research_tree`): `trees.rename`, `archive`, `restore`,
  `nodes.rename`, `resetForRetry`, `resetForRerun`, `setChainOrder`,
  `removeBranch`, `followups.ask`, `followups.retry`, `highlights.create`,
  `remove`, `removeMany` and `recaps.applyCandidate`. `nodes.admitChild` and
  `researchDocuments.update` keep their own Trash messages. Run bookkeeping
  is not refused, and `markViewed` is not an edit.
- The Trash is per person. With a single owner per thread, the owner's Trash
  is `trees.trashed_at`; phase 5 adds per-member hiding, and only the
  owner's Trash will set `trashed_at` (comment in `repos/trash.ts`).

### 5.11 Folders

- `folders.replaceState(userId, workspaceId, state)` stores the desktop's
  `ResearchFolderState` for one workspace across the tables in §3.2 and
  returns the stored state with `changed`, which `folders.set` uses to decide
  whether to emit `research.folders.changed`. It applies:
  - `normalizeFolderState`, the desktop's `normalize_research_folder_state`
    (`research.rs`): dedupe folder ids (the first wins), drop membership
    naming a folder not in the state (`system:drafts` excepted), keep only
    collapsed entries naming a folder in the state or `system:drafts`,
    `system:archive` or `system:unfiled`, and keep nesting one level deep
    (drop self links and every link whose parent is itself a child; dedupe
    `collapsedGroups`). It does not prune by tree existence.
  - `validateFolders`, the desktop's `validate_research_folders`: names are
    trimmed; empty names, names over 40 code points, the reserved names
    (`home`, `unfiled`, `drafts`, `archive`, `trash`, `highlights`, any case),
    ids starting with `system:` and empty ids are refused; names are unique
    per workspace ignoring case among folders outside the Trash. A folder
    whose id and trimmed name are unchanged is not checked again, except that
    restoring it from the Trash fails while another folder has its name. The
    messages are the desktop's.
  - Folders of another workspace and folder ids already used by another
    person or workspace are dropped. Membership, `parents` and
    `collapsedGroups` naming a tree outside the person's workspace are
    dropped, and nesting is normalized again.
  - A child whose membership the write changes to a place other than its
    parent's leaves the group (the desktop's `moveTree` does this from the
    client). Nesting writes the child's membership equal to its parent's
    (`researchFolderStateWithParent`), and a child whose membership the write
    leaves unchanged keeps its link, so an archived child can rejoin.
- `trashedAt` on a folder is taken from the state: a folder enters and leaves
  the Trash through `folders.set`, as on the desktop. Its trees keep their
  membership and are listed as Unfiled meanwhile (`researchTreePlace`).
- Any tree type can be a parent (questions, documents and posts:
  `researchTreeHoldsChildren`).
- `collapsed` and `collapsedGroups` are per person (`collapsed_places`,
  `collapsed_groups`): a write replaces only the caller's rows.
- Tree deletion cascades membership and collapsed groups via FK and clears
  children's `parent_tree_id`, the web equivalent of
  `remove_trees_from_research_folders`.

### 5.12 Journal (removed)

- Journal entries were removed in phase 2.0.

### 5.13 Follow-up queue

- `followups.ask(headNodeId, message, agent)` runs in one transaction: when
  the chain has nothing queued and `researchQueueAction` (shared
  `researchBranchView`) would send, the follow-up
  is admitted as the chain tail's inline child and its run enqueued;
  otherwise it is appended at the next `position`. `headNodeId` may be any
  node of the chain; the queue is kept under the chain's head. Archived and
  trashed threads refuse. With nothing queued, a chain whose last answer
  stopped (failed, cancelled, or interrupted with no resume pending) refuses
  with the desktop's ask-box notes ("The last answer stopped with an error.
  Retry it or edit its question to continue." / "The last answer was
  stopped. Run it again to continue.", `PRECONDITION_FAILED`); behind queued
  items it queues, as the desktop does. Queueing (not sending) is bounded per
  author by `SESSION_QUEUED_PER_USER`.
- `followups.nextStep` is `researchQueueAction` over the stored queue: send
  the first item when the tail is `complete` (and, for an exchange, its
  session is ready) and has no inline child; wait while the tail is active,
  while the first item carries `failed_reason`, and while the thread is
  archived or in the Trash (dispatch skips those threads, and restoring
  from the Archive or the Trash dispatches them); a tail that settled without an answer stalls the
  queue until it is retried, rerun, or removed.
- The queue's rules read one chain, not the thread: `nodes.chainNodes`
  returns the node's inline ancestors up to the chain's head and every
  inline descendant of them, with one recursive query over
  `nodes_parent_idx`, mapped without highlights. That is every node
  `inlineChainFor`, `researchQueueAction` and the stalled-tail note look at.
  `followups.chainTail` (the node a follow-up would continue, whose agent an
  unspecified one inherits) uses it too; neither `ask` nor dispatch builds
  the thread's detail.
- `followups.send(itemId, tailId)` re-checks `nextStep` inside its
  transaction, admits the item as the tail's inline child (authored by the
  item's author), enqueues the run, and deletes the item.
- The server (`server/src/research/followups.ts`) dispatches every chain of
  a thread after a run settles, `removeBranch`, `setChainOrder`, a restore
  from the Archive or the Trash, and a cancel or retry of a queue item; and
  every chain on boot; also after a member leaves or is removed. Before
  sending it checks the item's author, not the thread's owner: that they
  may still ask there (owner or commenter, `followups.authorMayAsk`), model
  access, daily limits, and the run-queue bound. A refusal is stored as
  `failed_reason`; the chain waits on that item until `followups.retry`
  clears it or `followups.cancel` removes it. `followups.retry` is the
  author's and is refused once they are a viewer.
- A branch question replaced by an edited one (`nodes.admitChildDetailed`
  with `replacesNodeId`) hands its queue to the new node (`movedQueue`); the
  server announces `research.queue.changed` under both heads.

### 5.14 Posts and drafts

- `posts.admitPost` (`create_research_post`, `state.rs:1912`): the text is
  trimmed, non-empty ("note cannot be empty") and at most 64 KiB of UTF-8
  (`MAX_POST_TEXT_BYTES`, "notes are limited to 65536 bytes"). The root is a
  `post` node with `format = link` when the whole text is one http(s) URL
  (`postFormatOf`), `model`/`effort` as the follow-up agent, and the X posts
  and images resolved by the caller as attachments. The thread title is the
  first non-empty line cut to 80 code points (`postDefaultTitle`, the
  desktop's `post_default_title`), not the question title rule.
- `posts.admitFollowUpNote` (`create_research_post_follow_up`): a `post`
  child of a post, same text rules, the parent's follow-up agent, refused in
  an archived thread (`nodes.admitChild`) or one in the Trash
  (`access.rejectTrashedNode`, §5.10).
- `posts.updatePost` (`update_research_post`, `state.rs:2053`), in one
  transaction: the node must be a post in a thread that is neither in the
  Trash (`access.rejectTrashed`) nor archived; `expectedText` must equal
  the stored text ("the note changed while you were editing; …",
  `CONFLICT`); the trimmed new text must differ from the trimmed old one
  ("the note's text is unchanged"); every attached X post's `sourceUrl` must still be in the text. Each highlight is
  re-anchored with `reanchorResearchQuote` (`lib/researchAnchors`): kept,
  moved (new `start`/`end`, revision unchanged) or deleted when its quote is
  gone. The node gets the text, `format` from the text and `edited_at`; the
  thread title follows the text only for the root and only while it still
  equals `postDefaultTitle(old text)`; `trees.updated_at` moves strictly
  forward. Returns `{ tree, node, removedHighlightCount, titleChanged }`.
- `posts.replaceTweetAttachments`: swaps a post's tweet attachments for fresh
  resolutions of the same tweet ids (`research.hydratePostTweet`).
- `researchDrafts.save` (`save_research_draft_with_images`, `state.rs:3726`):
  the prompt is trimmed, non-empty and at most 1 MiB; the workspace must be
  the caller's. No `id` inserts at position 0 and moves the workspace's other
  drafts down; an `id` updates that draft's prompt and `updated_at` in place,
  and an id from another workspace or account is not found (a draft does not
  change workspace). `images` replaces `attachments_json` when given and is
  left alone when absent; only image attachments are accepted.
- `researchDrafts.reorder` (`reorder_research_drafts`): `draftIds` must be
  exactly the workspace's drafts, each once, or it fails with "Research draft
  order is stale. Refresh before reordering." (`CONFLICT`); it reports
  whether the order changed so an unchanged order emits nothing.
- `researchDrafts.remove` deletes one draft and returns its workspace id.

### 5.15 Images

- `images.resolveAttachments(userId, ids)` (`attachments_for_inputs`): ids
  are deduplicated in order; at most 8 (`MAX_IMAGES_PER_MESSAGE`) and 20 MB
  in total (`MAX_MESSAGE_IMAGE_BYTES`); each must be a row the caller owns.
  A missing and a foreign id get the same message ("An attached image is no
  longer available. Remove it and attach it again."). The server wraps it as
  `resolveImageAttachments` (`server/src/research/images.ts`).
- What keeps an image is a row of `image_refs`, written in the same
  transaction as what names the image (`repos/imageRefs.ts`):
  `images.setRefs` when a node is admitted (`trees.admitRoot`,
  `nodes.admitChildDetailed`), a follow-up is queued (`followups.ask`) and a
  draft is saved with images (`researchDrafts.save`, replacing the draft's
  rows); `images.dropRefs` when a queued item is sent, cancelled, cleared or
  dropped with a departing member, and when a draft is removed;
  `images.dropNodeRefs` wherever nodes are deleted (`subtrees.ts`: branch
  removal, an edited question's replaced node, the deletion job), which also
  drops the rows of the queued items that go with a deleted chain head.
  Removing a workspace drops its drafts' rows with them. Writing a row marks
  the image attached; dropping an image's last row returns it to pending
  (the desktop's `release`). No message JSON is read for any of this.
- `images.readable(userId, imageId)`: the uploader, or anyone who may read
  a thread a node or queued item naming the image is in (a join of
  `image_refs.tree_id` with `access.treeReadableBy`, so a deleted thread
  gives no one access). An image in a draft is its owner's alone.
- `images.sweep(at)`, run every maintenance interval: rows whose holder no
  longer exists are dropped (a cascade the repositories did not see, such as
  an account's deletion); a referenced pending image is marked attached; an
  unreferenced image older than 24 h (`PENDING_IMAGE_LIFETIME_MS`) is
  deleted, pending or not; an unreferenced attached image younger than that
  returns to pending. Each is an indexed lookup per row. This is the
  desktop's pending lifetime and `release`. The server then unlinks
  every file under the documents directory that no remaining row names,
  thumbnails included (`uploads/storage.ts` `sweepImages`), except files
  modified within `ORPHAN_GRACE_MS` (1 h): the upload route writes the file
  before it inserts the row, and touches a file it finds already stored.

### 5.16 Access and sharing

Every repository resolves what it is given (a tree, node, highlight, queued
follow-up, image or widget) to its thread and asks `repos/access.ts` for the
caller's role there, instead of comparing an owner column. Repository
functions take the caller's id as `userId` (the actor); `null` is a guest.

- `access.treeAccess(db, userId | null, treeId)` → `{ role, tree, member } |
null`. `owner` when `trees.owner_id` is the caller; a member's role from
  `tree_members`; `viewer` for anyone, guests included, on a public thread;
  null otherwise. A thread in its owner's Trash (`trees.trashed_at`) is the
  owner's alone: every other caller gets null.
- `requireTreeAccess` / `requireNodeAccess(db, userId, id, minimum)`: a
  thread the caller may not read throws "research tree/node … was not
  found" (`NOT_FOUND`, no existence oracle); a role below `minimum` throws
  `TreeAccessError` (`FORBIDDEN`). `nodeTreeId`, `highlightTreeId`,
  `queueItemTreeId` resolve ids; `treeReadableBy`, `nodeReadableBy`,
  `highlightReadableBy` and `treeJoinedBy` are the same rules as `WHERE`
  predicates for lists.
- Roles: `viewer` reads. `commenter` also asks (forkNode, followups.ask),
  adds follow-up notes, creates highlights and generates and applies
  recaps. `owner` does everything else: rename, visibility, members,
  invitations, chain order, editing the root document, deleting anyone's
  branch or highlight.
- Own content (`assertMayChangeNode`): a commenter renames, deletes or
  titles only nodes they wrote, and only while every node under them is
  theirs too ("Someone else has replied under this; only the owner of this
  thread can change it now."). Text edits (`assertMayEditText`: updatePost,
  an edited question through `replacesNodeId`) are the author's alone, the
  owner included; the owner edits a node whose author's account is gone.
  A commenter removes only their own highlights.
- Asker pays (`payerOf` = `nodes.author_id`, else the owner): the run
  queue's `user_id`, usage events and the daily run count (`nodePaidBy`)
  follow the question's author, also when a queued follow-up is sent by
  dispatch or a run resumes after boot. Retry and Rerun are the payer's
  alone (`assertMayRelaunch`), so nobody can spend another account's
  budget; Cancel is the asker's or the owner's. Queued follow-ups are
  cancelled by their author or the owner and retried by their author.
- Per person: `tree_views` (unseen flags), Follow, drafts, folders and
  collapsed state. A member's Archive and Trash are flags on their member
  row: `trees.archiveGroup`/`restoreGroup`, `trash.trashTree`/`restoreTree`
  act on the member row for a member, on the thread (with its group) for the
  owner. The owner's Archive also shows the thread as archived to its members
  (`ResearchTree.archivedAt` = the member's own or the owner's) and keeps the
  thread's own write refusals; a member's Archive or Trash locks nothing.
  `trees.remove` by a member is leaving (`trees.leave`). A member's Trash is
  per workspace (`tree_members.trash_workspace_id`): `trash.trashTree` files
  the entry under the workspace named (else the default),
  `trees.sharedSummaries(…, "trash", { workspaceId })` lists one
  workspace's, and `trash.empty(workspaceId)` leaves the shared threads in
  that workspace's Trash (`leftTreeIds`), including one the owner has since
  moved to their own Trash, whose member row it deletes directly
  (`trees.removeMembership`). A member's Unarchive of a thread its owner
  archived is refused (`OWNER_ARCHIVED_MESSAGE`); `archivedBy` (`owner` |
  `me`) on trees and summaries says who archived it for the reader.
- Filing: `folders.setState` files a shared thread in one of the caller's
  own folders (`tree_members.folder_id`); `folders.getState` reports it in
  `membership`, and `trees.summaries({ workspaceId })` lists such threads with
  the workspace. The owner's folder, nesting and order are the owner's.
- Lists: `trees.summaries` (the caller's own, plus shared threads they
  filed in that workspace), `trees.sharedSummaries(userId, "shared" |
"archive" | "trash")` (the Shared place), `trees.publicSummaries(userId |
null)` (the guest catalog: public threads outside their owner's Archive and
  Trash, newest first, at most 200). Summaries and trees carry `ownerId`,
  `visibility` and the reader's `role`; `trees.detail` adds `participants`
  (owner, members, then every node and highlight author). A reader who is
  neither the owner nor a member (a public reader, a guest) is shown only
  the owner and the authors, in `participants` and in
  `sharing.listMembers` (`trees.seesMembers`).
- Feeds: the All Users feed (`scope: all`) reads public threads only;
  `recentQueriesForTrees` reads any thread the caller may read.
- Images: `images.readable(userId | null, id)` is the uploader, or anyone who
  may read a thread whose node or queued follow-up names the image. Widget
  revisions follow the thread; saved inputs stay per person.
- `repos/sharing.ts`: `setVisibility`, `listMembers`, `setRole` (making a
  member a viewer deletes their queued follow-ups, `dropQueuedFollowups`;
  their questions already sent run on), `removeMember` and `leave` (both
  return the member's queued follow-ups, which are deleted, and their active
  questions, which the server cancels, `trees.depart`; a member's Delete,
  `trees.remove`, and Empty Trash, `trash.empty`, leave the same way and
  return the same `Departure`; `removeMember` also records the removal in
  `tree_member_removals` and revokes the pending login invitations addressed
  to the member),
  `createInvite` (token returned once; at most 50 pending per thread;
  inviting a member is refused, "@login already has access to this
  thread."; one pending login invitation per account and thread, renewed
  with a new token, role and expiry when the login is invited again
  (`renewed`); at most `MAX_LOGIN_INVITES_PER_DAY` (100) login invitations
  a day per inviter),
  `listInvites` (usable ones: a used link stays listed so it can be revoked), `receivedInvites(login)`, `revokeInvite`, `acceptInvite`
  (by token, or by id for a login invitation addressed to the caller; a
  login invitation is used once, a link until it expires or is revoked;
  a person the owner removed is refused, "You were removed from this
  thread." (`FORBIDDEN`), a link created at or before the removal, while a
  later link or a later login invitation to them admits them and deletes
  the removal; leaving records nothing; joining never lowers a role; at most
  100 members; a member who accepts again gets the thread back from their
  own Archive and Trash, `restored`; a new member follows the thread, while
  a member who accepts again keeps their Follow choice), `setFollowing`,
  `followers` (those who may still read the thread), `audience` (owner,
  members, public) and `workspaceMembers`.

### 5.17 Notification inbox

`repos/notifications.ts` (web only): `record(rows)` stores what the server's
`notify` sends, one row per recipient, before the event goes out; a
notification about a thread that no longer exists is stored without
`tree_id`. `list(userId, { cursor, limit })` pages newest first by
(`created_at`, `id`) with an opaque cursor; `unreadCount`, `markRead(id)`
(only the recipient's own, only when unread) and `markAllRead`. Retention:
`record` keeps each recipient within `MAX_NOTIFICATIONS_PER_USER` (500,
oldest first, read or not), and `prune(at)`, run by the server's
maintenance tick (`sweepExpired`), deletes read notifications 30 days after
they were read (`READ_NOTIFICATION_RETENTION_MS`) and trims any account
above the cap. Deleting a thread deletes its notifications.

### 5.18 Deleting threads in the background

- Delete now (`trees.remove`), Empty Trash (`trash.empty`) and removing a
  workspace (`workspaces.remove`) answer and publish as before, but only mark
  the threads (`deletion.markTreesDeleted`), inside their transaction:
  `trees.deleted_at` is set, a thread listed under one of them elsewhere
  loses its parent, and the rows that tie a thread to people are deleted at
  once (`MARK_DELETED_TABLES`: members, invitations, member removals,
  follows, views, collapsed groups, filing, the Home feed row, inbox
  notifications about the thread, and queued follow-ups with their image
  references).
- From then on the thread is hidden: `access.roleFor` gives nobody a role,
  `treeReadableBy` and `treeJoinedBy` exclude it, and every query on
  `trees` outside them includes `access.treeLive()` (`deleted_at IS NULL`):
  the sidebar sections, summaries, the public catalog, Shared with me,
  group children, folders, recent queries, the follow-up dispatch, boot
  reconciliation, the audience the event bus reads, followers, invitations
  and workspace counts.
- Removing a workspace deletes its folders, collapsed trays, drafts (with
  their image references) and feed rows at once, and points members' Trash
  entries filed under it to their default workspace
  (`deletion.markWorkspaceDeleted`). The row itself is deleted then when no
  thread names it, else marked (`workspaces.deleted_at`, hidden from every
  workspace query) and deleted by the job after its last thread.
- `deletion.step(limits)` deletes the next bounded batch, in one
  transaction: for the oldest marked thread, the next `limits.nodes` nodes
  deepest first (computed from the remaining `(id, parent)` pairs each
  step), first their rows in the tables that can hold many per node
  (`NODE_DEPENDENT_TABLES`: run turns, messages, widget revisions,
  highlights, attempts, snapshots, summaries) up to `limits.rows`, then the
  nodes with their image references; when no node is left, the thread row.
  Then marked workspaces no thread names. Null when nothing is left. The
  default (`DEFAULT_STEP_LIMITS`) is 250 nodes and 2000 rows, a step of a few
  to a few tens of milliseconds.
- Nothing is kept between steps, so a restart resumes from what is left:
  the server's job (`server/src/research/deletion.ts`) is kicked at boot and
  after each procedure that marks threads, runs one step per `setImmediate`
  so requests interleave, and after a step that throws waits 30 s before
  trying again. `deletion.drain` runs every step at once (tests).
- A test checks the three table lists against SQLite's foreign keys, so a
  new table that references `trees`, `nodes` or `workspaces` has to be
  placed in one of them.

## 6. Data volumes and performance notes

- A heavy user has thousands of nodes and hundreds of snapshots of tens of
  KB, occasionally a 10 MiB document. SQLite handles this comfortably; the
  feed query is keyset-paginated with covering indexes.
- Snapshots are read only for the open node and for recap/highlight checks;
  `nodes` never embeds turns. `run_turns` holds only active attempts and is
  small at any moment.
- `VACUUM` is not scheduled; `PRAGMA optimize` runs on close and daily.

## Retired tables

The encyclopedia tables (`encyclopedia_pages`, `encyclopedia_sources`) were
dropped when the migration history was regenerated for the node-model
rewrite; the database is reset (`runbooks/reset-database.md`).
