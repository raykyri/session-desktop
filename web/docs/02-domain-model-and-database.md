# Domain model and database

Source of truth for behavior: `src-tauri/src/research.rs`, `state.rs`,
`persistence.rs`, `journal.rs`, `tweets.rs`, `encyclopedia.rs`, and the
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
      documents.ts  usage.ts  journal.ts  tweets.ts  encyclopedia.ts
      feedItems.ts  drafts.ts  artifacts.ts  index.ts
    repos/
      users.ts  auth.ts  workspaces.ts  folders.ts  trees.ts  nodes.ts
      highlights.ts  snapshots.ts  documents.ts  recaps.ts  feeds.ts
      feedItems.ts  feedgen.ts  journal.ts  encyclopedia.ts  drafts.ts  artifacts.ts
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

## 2. Domain types carried over (from `src/types.ts`)

Kept verbatim in `packages/shared/src/types/research.ts` and friends, with
zod schemas alongside:

`ResearchTree`, `ResearchNode`, `ResearchNodeStatus` (with the new
`interrupted` value), `ResearchNodeKind` (`run | document`; the desktop's
`conversation` kind existed only for terminal exports and is dropped),
`ResearchNodeOrigin` (`imported` only), `ResearchRecap`,
`ResearchRecapCandidate`, `ResearchHighlight`, `ResearchHighlightAnchor`,
`ResearchHighlightFeedItem`, `ResearchTreeSummary`, `ResearchTreeDetail`,
`ResearchNodeCard`, `ResearchNodeContent` (gains `inFlightText`, `seq`, `queuePosition`),
`ResearchBranchRemoval`,
`UpdateResearchDocumentResult`, `RecentResearchQuery`,
`RecentResearchQueryCursor`, `RecentActivityCursor`, `RecentActivityItem`,
`RecentActivityPage`, `ResearchMessageAttachment` / `ResearchTweetAttachment`,
`TweetSnapshot` and its parts (from `src/lib/journalTweets.ts`),
`JournalLinkEntry`, `JournalTweetEntry` (from `src/lib/journal.ts`; the
hidden legacy `note` kind is dropped), `EncyclopediaPage`, `EncyclopediaSource`,
`EncyclopediaPageSummary`, `EncyclopediaPageRequest`, `Turn`, `TurnBlock`,
`ResearchFolder`,
`ResearchFolderState`, `SessionEvent`.

Fields dropped from `ResearchNode` on the wire: `groupId` (renamed
`workspaceId`), `worktreeDir`, `agentId`, `paneId`, `runtime`, `threadId`,
`transcriptPath`, `nativeSessionId`, `promptNativeId`, `effort` (fixed at
medium). `adapter` is renamed `model` and holds a registry id
(`04-agent-runtime.md` §1). New fields: `attempt`, `documentIds`.
`AgentAdapterMetadata` is replaced by `ModelInfo { id, label, provider,
adminOnly, available, supportsFiles, supportsImages }`.

New wire types: `User` (with `isAdmin`), `Workspace` (replaces `GroupInfo`),
`UserSettings`, `DocumentInfo`, `UsageSummary`.

## 3. Tables

Column types are SQLite affinities via Drizzle (`text`, `integer`, `real`).
`PK` = primary key, `FK` = foreign key with `ON DELETE CASCADE` unless noted.
Every user-owned table carries `user_id` even where derivable, so scoping is
one predicate and indexes are simple.

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
  `used_at` null. Sign-up requires a valid unused code when
  `SESSION_REQUIRE_INVITE=1`; codes are distributed manually at first.

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

### 3.2 Organization

`workspaces` (desktop `GroupInfo` with `scope: research`)
- `id` PK, `user_id` FK, `name` text, `position` integer
- `created_at`, `updated_at`

`folders` (desktop `ResearchFolder` + parts of `ResearchFolderState`)
- `id` PK, `user_id` FK, `workspace_id` FK, `name` text
- `collapsed` integer bool, `starred` integer bool, `position` integer
- `created_at`

`tree_folder_membership`: `tree_id` PK FK, `folder_id` FK. One folder per
tree, as in `membership: HashMap<treeId, folderId>`.

### 3.3 Research

`trees`
- `id` PK, `user_id` FK, `workspace_id` FK
- `title` text, `root_node_id` text (FK to nodes, deferred; see §5.1)
- `created_at`, `updated_at`, `archived_at` null, `last_viewed_at` null
- `followed`, `bookmarked`, `starred` integer bool (starred is the folder
  state's `starred` list for trees)
- `position` integer — master sidebar order within (`workspace_id`,
  `archived_at IS NULL`)
- Indexes: (`user_id`, `workspace_id`, `archived_at`, `position`),
  (`user_id`, `updated_at`)

`nodes`
- `id` PK, `user_id` FK, `tree_id` FK, `parent_node_id` text null FK (self,
  `ON DELETE RESTRICT`; subtree removal deletes children first)
- `inline` integer bool
- `prompt` text, `query_anchor_json` text null, `attachments_json` text
  (array, default `[]`)
- `title` text null, `response_preview` text null
- `model` text (registry id)
- `kind` text (`run | document`), `origin` text null (`imported`)
- `status` text (`05-run-lifecycle-and-streaming.md` §3), `error` text null
- `attempt` integer (1; incremented by Retry and auto-resume), `run_seq`
  integer (last persisted sequence number of the current attempt),
  `resume_pending` integer bool
- `response_snapshot_at` integer null
- `created_at`, `started_at` null, `completed_at` null
- `recap_json` text null — `ResearchRecap`
- Indexes: (`tree_id`, `created_at`, `id`); (`user_id`, `status`);
  (`parent_node_id`); partial unique index on (`parent_node_id`) WHERE
  `inline = 1` (one inline child per parent, §5.4)

`highlights`
- `id` PK, `user_id` FK, `node_id` FK
- `anchor_json` text — `ResearchHighlightAnchor` (version 1, projection
  `answer-v1`, UTF-16 `start`/`end`, `exact`, `prefix`, `suffix`,
  `responseRevision`)
- `response_revision` text (denormalized from anchor for the feed query)
- `created_at`; index (`node_id`), (`user_id`, `created_at`)

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
  null; PK (`node_id`, `attempt`)

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

### 3.4 Journal and X posts

`journal_entries`
- `id` PK, `user_id` FK, `kind` text (`link | tweet`)
- `created_at` integer
- `url` text null, `tweet_id` text null, `hydration` text null
  (`pending | ok | failed`), `text` text null
- `entry_json` text — the full entry as the frontend's `journal.ts` defines it
- Index (`user_id`, `created_at`, `id`)

`feed_items`
- `id` text PK, `author_id` FK, `kind` text (`journal | research`)
- `occurred_at`, `source_rank`; nullable source FKs `journal_id`, `node_id`,
  `tree_id`, `workspace_id`
- Indexes (`occurred_at DESC`, `source_rank DESC`, `id DESC`) and
  (`author_id`, `occurred_at DESC`); unique source indexes on `journal_id` and
  `node_id`
- Written synchronously in the same transaction as journal/root changes;
  source deletion or tree archiving removes the row. Backfill
  `2026-09-19-feed-items` materializes existing journal entries and
  non-archived roots once.

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
  included, so a deleted post is not re-asked on every render.

`embed_assets`
- `hash` PK (SHA-256 of `source_url`, hex — the `/embeds/<hash>` a stored
  snapshot carries), `source_url` text, `content_type` text null, `bytes`
  integer, `stored_at` integer null, `last_access_at`, `created_at`
- Index: (`last_access_at`) — the sweep's eviction order
- The mapping from a snapshot's rewritten image URL back to the origin one.
  The row outlives the bytes: the sweep unlinks files and clears `stored_at`,
  and the next request for that hash re-fetches. Also shared across accounts,
  and registered at hydration rather than when the image is first served
  (`13-deployment-fly.md` §6).

### 3.5 Encyclopedia

`encyclopedia_pages`
- `user_id` FK, `workspace_id` FK, `slug` text
- `term`, `title`, `body` text; `status` text; `error` text null
- `model` text (registry id; always `gemini-flash` today), `generated_by` text null
- `links_json` text (slugs), `created_at`, `updated_at`
- PK (`workspace_id`, `slug`)

`encyclopedia_sources`
- `id` PK, `workspace_id`, `slug` (FK composite to pages)
- `node_id` null, `tree_id` null, `page_slug` null, `question` null,
  `excerpt` text, `sibling_terms_json` text, `created_at`
- Index (`workspace_id`, `slug`, `created_at`); cap 50 per page enforced in
  the repo (evict oldest). Prompt-assembly caps from `encyclopedia.rs:40-48`:
  title 160 chars, question 600, excerpt 4,000, 24 sibling terms, 5 sources
  and 120 existing page titles in the prompt.

### 3.6 Documents and artifacts

`documents`
- `id` PK, `user_id` FK, `workspace_id` FK, `name` text, `mime` text,
  `byte_size` integer, `sha256` text, `storage_path` text
  (`/data/documents/<user_id>/<sha256>`), `page_count` integer null,
  `extraction_status` text (`pending | ok | failed`), `created_at`
- Unique (`user_id`, `sha256`)

`document_text`
- `document_id` FK, `page` integer, `text` text; PK (`document_id`, `page`)

`node_documents`: `node_id` FK, `document_id` FK, `position` integer;
PK (`node_id`, `document_id`)

`artifact_tokens` (Phase 7)
- `token` text PK (32 random bytes hex), `user_id` FK, `document_id` FK,
  `created_at`, `expires_at`

### 3.7 Usage

`usage_events`
- `id` PK, `user_id` FK, `node_id` text null, `kind` text (`research |
  metadata | search | fetch`), `provider` text, `model` text null,
  `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_tokens`
  integer, `cost_estimate_micros` integer, `created_at`
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
  Server boot refuses to start if the database reports a migration the code
  does not know (the desktop's "newer version ⇒ abort startup" contract,
  `persistence.rs:403`), by comparing `__drizzle_migrations` against the
  bundled journal.
- Data backfills that cannot be expressed in SQL run as versioned TypeScript
  steps in `src/backfills/` after `migrate()`, recorded in a `backfills`
  table.
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
- Cancel flips status first, then aborts the provider stream (`state.rs:5876`).
- `run_seq` increments in the same transaction as every `run_turns` write
  and every status change, and is returned by `getNodeContent`.

### 5.4 Follow-ups
- Parent must be `complete`; tree not archived (`state.rs:5244`).
- At most one inline child per parent regardless of the child's status; the
  partial unique index makes the check atomic, and the repo maps the
  constraint error to the desktop's message.
- Model: a follow-up defaults to the parent's model and may choose any model
  the user may access; the server enforces `adminOnly` gating. `document`
  parents (imported reports) have no messages, so the child's prompt embeds
  the document markdown (`04-agent-runtime.md` §4).
- The displayed `prompt` is the bare question; the launch messages are
  assembled by the runtime (`04-agent-runtime.md` §5).

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
- `documents.update` performs the 4-way optimistic check: node is the tree's
  root and `kind = document`; tree not archived; `expectedTitle === tree.title`;
  `expectedResponseRevision === snapshot.revision`; and if markdown changed,
  `expectedHighlightIds` equals the current set (`state.rs:4961`). A markdown
  change deletes all highlights, rewrites `response_preview`, writes a new
  snapshot (single `Turn` with one `text` block), and returns
  `{ tree, node, responseRevision, markdownChanged, removedHighlightCount }`.
- Limits: 10,000 words and 10 MiB (`research.rs:17-20`).

### 5.7 Runs and admission
- Insert node as `queued` and a `run_queue` row in one transaction. The
  server claims rows FIFO by user then time under per-user and global limits
  (`05-run-lifecycle-and-streaming.md` §8). The desktop application allowed unbounded concurrency, but the web application enforces concurrency limits because server resources are shared among multiple users.
- On boot: `queued` rows stay queued; `running` nodes (a crash without
  shutdown) become `interrupted` with `resume_pending = 1`; every
  `resume_pending` node is re-queued at the head of the queue
  (`05-run-lifecycle-and-streaming.md` §7). Nodes whose snapshot row already
  has an `outcome` adopt it (the desktop's rule, `state.rs:2405-2506`).

### 5.8 Recaps
- `recaps.save(nodeId, recap, expectedSnapshotAt)` re-checks `status =
  complete`, `response_snapshot_at` unchanged, and the snapshot revision equals
  `recap.responseRevision`; otherwise no-op (`state.rs:8942`).
- `recaps.applyCandidate` additionally requires
  `expectedCurrentRecapId === node.recap?.id` and a non-archived tree
  (`state.rs:8992`). Instructions trimmed, non-empty, ≤ 4000 chars.

### 5.9 Feeds
- `feeds.recentActivity(userId, { scope, workspaceId, limit, cursor })` reads
  `feed_items` under one cursor `(occurredAt DESC, sourceRank DESC, id DESC)`
  with `sourceRank` journal = 0, research = 1. `all` reads public feed rows from
  every account, `mine` filters `author_id` without a workspace predicate, and
  `workspace` filters the caller's research roots by `workspace_id` while
  keeping that caller's journal account-wide. `limit` is clamped to 1..100.
  Source rows are projected after keyset selection; direct research children
  are attached per root in `(created_at, id)` ascending order.
- `feeds.highlights(userId)` returns newest-first items from non-archived
  trees with `nodeLabel` = node title or prompt, or the tree title for
  documents (`research.rs:485`).
- `trees.summaries` computes `runningCount` (`queued | running`),
  `failedCount`, `completedCount`, `cancelledCount` (`interrupted` is not included in summary count totals and does not trigger attention indicators; it is displayed directly in the activity rail), `hasUnseenUpdate` (latest `completed_at` > `last_viewed_at`),
  `hasUnseenFailure` (latest failed `completed_at` > `last_viewed_at`)
  (`state.rs:3770-3776`) via grouped subqueries.

### 5.10 Encyclopedia
- Slug: lowercase alphanumeric runs joined by single dashes, ≤ 80 chars,
  valid iff `slugify(slug) === slug` (`encyclopedia.rs:185`, `:230`); shared
  implementation mirrors `src/lib/encyclopedia.ts`.
- `encyclopedia.requestPage`: existing page → merge source (dedupe by
  `nodeId`, else `pageSlug`, else exact excerpt; evict beyond 50) and set
  `generating` only if `failed`; missing → insert `generating`
  (`encyclopedia.rs:384`, `:765`).
- `links_json` recomputed from the body's wikilinks minus self.
- Listing sorted by (`lower(title)`, `slug`).

### 5.11 Folders
- `folders.setState(workspaceId, state)` applies the desktop's
  `normalize_research_folder_state`: dedupe folders, drop membership and
  collapsed entries pointing at absent folders, dedupe stars; it does not
  prune by tree existence (`research.rs:94`, `state.rs:4142-4149`). Tree
  deletion cascades membership via FK, which is the web equivalent of
  `remove_trees_from_research_folders`.

### 5.12 Journal
- Entries are stored intact in `entry_json`; indexed columns are extracted projections validated with a strict Zod schema, eliminating the need to tolerate unvalidated blobs.

## 6. Data volumes and performance notes

- A heavy user has thousands of nodes and hundreds of snapshots of tens of
  KB, occasionally a 10 MiB document. SQLite handles this comfortably; the
  feed query is keyset-paginated with covering indexes.
- Snapshots are read only for the open node and for recap/highlight checks;
  `nodes` never embeds turns. `run_turns` holds only active attempts and is
  small at any moment.
- `VACUUM` is not scheduled; `PRAGMA optimize` runs on close and daily.
