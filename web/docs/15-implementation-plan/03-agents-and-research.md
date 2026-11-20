# 03 — Agents and research

Status: draft. This file plans how asks, branches, comments and look-ups
become runs; which models and effort levels a run may use; the two executors
(the owned agent loop and device CLI runs, ADR-21 and `AGENTS.md` "Desktop");
streaming over the sync connection (ADR-22); and token accounting, the weekly
allowance, the behaviour when included tokens run out and API keys, as the
mockup's Usage page shows them (`usagePage()`, `meter()`, `keysSection()` in
`docs/mockups/session-web-members.html`). It also sets per-run limits.

Records, the change log, mutators and the HTTP surface are in
`01-architecture-and-data.md`; item ids there (`C3`, `Y7`, …) are referred to
here. Authority is as in `00-overview.md`: `AGENTS.md` and the ADRs win over
the mockup unless the overview records the product decision.

Work items have ids `G` (graph), `E` (executors), `V` (device runs), `T`
(streaming), `K` (tokens and keys), `L` (limits).

## 1. Records

A run belongs to one ask node. ADR-22 makes committed turns and run state
records in the space log; the prototype's `RunRec`
(`web/packages/replica-proto/src/records.ts`) holds only `queued` and the root
node, so the record set grows:

| kind | key | fields (stored shape) | tier |
|---|---|---|---|
| `node` | `node:<id>` | `th`, `s`, `par` (`null` for the root), `kind` (`ask`, `lookup`), `u`, `q` (the prompt), `look?`, `quote?`, `model`, `executor`, `run` (current run id), `mod`, `del`, `createdAt`, `rev` | full |
| `run` | `run:<id>` | `th`, `s`, `node`, `u` (asker and payer), `executor` (`owned`, `device`), `agent?` (`claude-code`, `codex`), `model`, `status`, `attempt`, `step`, `fail?`, `tok?`, `bill?`, `createdAt`, `startedAt?`, `finishedAt?`, `rev` | full; status also on the summary of the root's run |
| `turn` | `turn:<run>:<attempt>:<n>` | `role`, `blocks` (text, tool use, tool result, citations), `createdAt` | full |
| `answer` | `answer:<node>` | the final answer as sanitized HTML, cited pages, `tok`, `run`, `attempt` | full |
| `comment` | `comment:<id>` | C4 of 01 | full |

`status` is `queued | running | complete | failed | cancelled | interrupted`
(ADR-14). `fail.why` keeps the schema's values (`stopped`, `tokens`, `key`,
`rate`, `access`, `interrupted`) and adds `device_limit` and `too_large` for
device runs. The thread record keeps `tok` (sum of its owned runs), `sum`
(the root answer's summary line) and `running`.

The thread byline reads "N sources · Nk tokens · #channel" (`card()`); the
answer icon's tooltip names the model (`runOf()`). Both come from these
records; a device answer shows its agent label instead of a token count
(ADR-21).

## 2. The ask graph

### 2.1 Asks, Continue, Branch, Branch here, Look up

The mockup has five ways to start a run, all of which create one `node` and
one `run` in a single mutation; the node id is in the input and the run id is
`tx.id(1)`.

| Action | Mockup | Parent | Input |
|---|---|---|---|
| Ask | composer, kind `ask` (`newThread`) | none: thread root | `threads.create { id, space, kind: "ask", q, model, executor }` |
| Continue | `branchActs` "Continue" on a selected node `n` | `n` | `nodes.ask { id, thread, parent: n, q, model, executor }` |
| Branch | `branchActs` "Branch" on `n` | `n.par` (a sibling of `n`) | same, `parent: n.par` |
| Branch here | select text in an answer, "Branch here" | the node whose answer holds the selection | same, plus `quote` |
| Look up | select 1-4 whole words, "Look up" | the node whose answer holds the selection | `nodes.lookup { id, thread, parent, look, context? }` |

Branch on the root has no parent to be a sibling under; the mockup never
offers it there (the root's card has only the follow-up button), and the
mutator refuses `parent: null` with `BAD_REQUEST`.

**G1. `threads.create` and `nodes.ask`.** In `web/packages/mutators/src/nodes.ts`.
`who: "member"`; the parent must exist, be readable, not removed and not
still running (the mockup hides Continue and Branch while `n.pending`).
`q` is 1 to 8,000 characters; `quote` at most 2,000. `post` queues a `job`
effect with the run id. Acceptance: mutator tests for each parent rule, and
a convergence-suite generator that adds random Continue and Branch writes.

**G2. Look up.** `look` must be 1-4 words after trimming leading and
trailing non-letter, non-digit characters (the mockup's `lookPhrase`: the
selection must start and end on word boundaries), at most 80 characters.
`context` is the passage that holds the phrase, at most 2,000 characters,
stored as `quote`. The mutator builds `q` from `LOOKUP_PROMPT_V1` in
`@session/mutators` ("Look up "<phrase>" as it is used in this answer.
Describe what it refers to in two or three sentences, with a source.") and
stores the template version in the node. The client never sends `q` for a
look-up, so it cannot store text that the UI will not display (01 C3).
Acceptance: input with `q` is refused as an extra field; a 5-word phrase is
refused; client prediction and server apply produce the same `q`.

The mockup always parents a look-up on the root (`addLookup(p, …)` with
`'r'`), because only the root answer is selectable there. The plan parents it
on the node whose answer holds the selection, which equals the mockup where
the mockup has a choice and extends naturally to branch answers.

**G3. What the UI shows of a look-up.** Rows and cards show "Look up" and
the phrase (`preview()`'s `lookh` block), never `q`. The stored prompt is
served like other node text; it is not secret, only not displayed. Look-ups
count as branches in the footer count (01 C5).

**G4. Comments.** Comment (`branchActs`, tooltip "Does not run an answer")
writes a `comment` record and never a run. It works while out of tokens and
for members without API keys. Mentions in comments notify (01 C16).
Acceptance: a test asserts that `comments.create` queues no `job` effect and
writes no usage.

**G5. Open as its own thread.** `threads.create` with `from: { th, node }`
(schema already has it) copies the node's question and answer into a new
thread and sets `promoted` on the node. The server sets the new thread's
author from stored state; it does not take an author from input. Who may do
this and who is shown as author is open question 4.

**G6. Delete and stop.** `nodes.delete` erases a node's text when nobody
else has written under it, else leaves a shell (the AGENTS.md rule for
threads applied to nodes). `research.cancelNode` sets the run's status to
`cancelled`; `research.retryNode` starts a new attempt (§3.4).

### 2.2 Context for a run

**G7. Context assembly.** In `web/packages/server/src/runs/context.ts`: the
system prompt (`prompts.ts`), then for each ancestor from the root to the
parent its prompt `q` and its final answer turns, then the new node's `q`.
For Branch here and Look up the `quote` is added to the new user message as a
quoted passage. A Branch's context is its parent's path; it does not include
the sibling it was started beside. Reasoning blocks are dropped across models
(ADR-16). Every run rebuilds context from the thread's stored records; there
is no CLI session resume (ADR-21). Acceptance: snapshot tests of the built
message list for each action in §2.1.

**G8. Access at start.** When a run starts (owned) or is claimed (device), the
server checks that the asker can still read the thread; if not, the run ends
`failed { why: "access" }` without calling a model.

## 3. The owned agent loop

ADR-10 as amended by ADR-21: the owned loop is the default executor
("included tokens"). The existing loop in `web/packages/server/src/runs/`
(`loop.ts`, `service.ts`, `providers.ts`, `tools/`) is kept and re-pointed at
the new records.

**E1. Server-originated writes.** Runs write records through a server-only
path in `@session/sync/server` (`serverApply(kind, fn)`), which commits record
rows, change-log rows and the registry in one transaction like a mutator,
without an envelope or a seq. Every such write is fenced: it checks that the
run's `attempt` is still the node's current attempt and that the thread is
not removed; otherwise it writes nothing and the attempt ends `superseded`
(`05-run-lifecycle-and-streaming.md` §7). Acceptance: a test removes a thread
while its run streams and finds no turn written after the removal and no text
in the database (01 D4).

**E2. Run lifecycle.** The `job` effect queues the run; the dispatcher admits
it under the limits of §7, sets `running`, streams, commits a `turn` at each
step finish, writes `answer` and `complete` at the end, records usage (§6),
and queues title and summary jobs for a new thread. Deploys mark running runs
`interrupted` and resume them on boot, as now (`05-run-lifecycle-and-streaming.md` §7). Acceptance: the
existing run tests in `web/packages/db/test/runs.test.ts` and
`runRecovery.test.ts` are rewritten against the new records and pass.

**E3. Progress steps.** The mockup shows "Researching · Step n of 4". The
loop maps its activity to four phases: planning (before the first tool call),
searching (`web_search`), reading (`web_fetch`, grounding), writing (text
after the last tool call), stored as `run.step` 0-3. A model that writes
without tools jumps from 0 to 3. Acceptance: fixture-provider tests for a
tool-using and a tool-free run.

**E4. Cancel and retry.** Cancel aborts the provider stream; partial turns
stay. Retry on `failed`, `cancelled` or `interrupted` increments `attempt` and
starts from the parent's context. Retry carries the model and executor the
person picks; it does not need `base.rev` because the attempt number fences
it. Acceptance: cancel-then-retry within one millisecond leaves one live
attempt (the existing test for `05-run-lifecycle-and-streaming.md` §7, ported).

## 4. Device runs

ADR-21 and `AGENTS.md` "Desktop": a device run is a Claude Code or Codex CLI
process on the user's own Mac. Grok is dropped.

**V1. Choosing a device executor.** On the desktop the model picker lists
"Claude Code on this Mac" and "Codex on this Mac" when the CLI is found on
`PATH` (checked at launch and when the picker opens). The ask is written with
`executor: "device"` and `agent`. Web and Phone show the entries only when a
paired desktop has reported the CLI in the past 7 days; the run then waits for
that desktop. Acceptance: the picker test in the client package; the mutator
refuses `executor: "device"` with an unknown `agent`.

**V2. Claim.** `POST /api/runs/claim { deviceId }` (bearer device token)
returns the oldest queued device run of the token's user, with its attempt
number and the context built by G7, after the G8 access check. One device
holds a run at a time per run; a second claim answers `CONFLICT`. Acceptance:
two desktops of one user claiming at once get different runs or one
`CONFLICT`.

**V3. Lease and heartbeat.** The lease is held by `POST /api/runs/heartbeat
{ run, attempt }` every 10 s, separate from progress; it expires after 30 s
without a heartbeat. An expired lease ends the run `interrupted` (ADR-22);
"Run again" starts a new attempt, which any of the user's devices may claim.
Acceptance: a test stops heartbeats and finds the run `interrupted` within
40 s and a late `runs.turn` for that attempt refused.

**V4. Process.** The desktop spawns the CLI in a new empty temporary
directory (`mkdtemp`), with the prompt built from the claimed context, in
non-interactive mode (`claude -p` with stream-JSON output; `codex exec` with
JSON output). The CLIs keep their read-only tools for now; locking down local
reads is deferred and there are no local-file attachments (AGENTS.md). The
directory is deleted when the process exits. Parsing lives in the desktop
client's Tauri side, not in the server. Acceptance: a fake-CLI fixture (a
script that prints recorded JSONL) drives the parser tests; a test asserts the
working directory is empty at spawn.

**V5. Reporting.** `POST /api/runs/turn { run, attempt, seq, turn }` commits a
turn; `POST /api/runs/finish { run, attempt, outcome, answer }` ends it. Both
carry the attempt number and are refused for a stale attempt. In-flight text
goes up on the same calls as `delta` batches and is fanned out as ephemeral
events (§5). The server rejects an answer over 200 KB
(`SESSION_DEVICE_ANSWER_MAX_BYTES`) and ends the run
`failed { why: "too_large" }`. Acceptance: tests for stale attempt, oversized
answer, and a finish without turns.

**V6. Labels, usage and limits.** A device answer's meta line carries a
light-text label ("Claude Code" or "Codex") in place of the token count; the
run reports no usage and counts toward no allowance or limit except the
device cap: 100 device runs per hour per user (`SESSION_DEVICE_RUNS_PER_HOUR`),
checked at claim. Beyond the cap the claim answers `TOO_MANY_REQUESTS` and the
run stays queued. Acceptance: the 101st claim within an hour is refused.

**V7. Queued with no device.** A device run that no device claims stays
`queued`, shown as "Waiting for your Mac". The asker may cancel it or Retry on
the owned executor. How long it may wait is open question 3.

## 5. Streaming over the sync connection

ADR-22 replaces ADR-11. One SSE connection per client (01 Y7) carries both
pull batches and run deltas.

**T1. Durable state.** Run status, step, committed turns and the answer are
records in the space log, delivered by `pull`. A client that misses every
delta still converges on the same answer.

**T2. Ephemeral deltas.** `run.delta { run, attempt, seq, text }` events, at
most one per 50 ms per run, keyed by run, attempt and a per-attempt sequence.
They carry no event id and are not replayed. The server sends them only to
connections whose reader may read the thread at send time, using the same
scope check as `pull` (cached per connection and invalidated when the
reader's member records change). Acceptance: a non-member connected to the
same server receives no delta of a private channel's run.

**T3. Client rule.** Apply a delta only when `seq` is the next for that
`(run, attempt)`; drop lower ones; on a gap, or on reconnect, fetch
`GET /api/runs/:id/live`, which returns the attempt's committed turns'
versions and the in-flight checkpoint (`run_live`, at most 1 s or 4 KiB
stale) with its `seq`. A delta of an older attempt is dropped. Acceptance: a
client test injects a gap, a duplicate and an old attempt.

**T4. Checkpoints off the log.** In-flight text is written to `run_live`, not
to `records`, so streaming does not add change-log rows; only step finishes
do. Acceptance: a 25-step run adds at most 25 turn rows and a constant number
of run-record writes per step to the change log.

**T5. Device deltas.** Device runs post deltas on `runs.turn` (V5); the
server assigns nothing and forwards them with the device's `seq`, after
checking that it increases. Owned and device runs are indistinguishable to
the reader except for the label.

## 6. Tokens, the weekly allowance and API keys

The overview records the product decision: a weekly allowance, recent runs,
a choice of what happens when included tokens run out, and Anthropic and
OpenAI keys. This conflicts with existing documents in three places, and the
overview's decision wins in each:

- `06-auth-and-users.md` §8 counts daily tokens and runs
  (`SESSION_DAILY_TOKENS`, `SESSION_DAILY_RUNS`). The allowance becomes
  weekly; the daily run count is dropped and replaced by the per-run limits of
  §7.
- `04-agent-runtime.md` §11 and ADR-10 say users do not provide API keys.
  Users may now add keys. This needs a new ADR (ADR-23) amending ADR-10 and
  ADR-16; ADR-21's reasoning (users spend their own subscriptions without the
  server holding credentials) covers device runs only.
- The mock API and `spaces.ts` mark keys and usage as `TODO(limits)` stubs
  with keys "not encrypted for now". The real server encrypts keys (K4); the
  mock's stub decision was scoped to the mock.

### 6.1 Accounting

**K1. The ledger.** Extend `usage_events`
(`web/packages/db/src/schema/usage.ts`) with `run_id`, `attempt`, `payer`
(`included`, `key:anthropic`, `key:openai`) and `week` (the ISO date of the
week's Friday). One row per provider call step, written in the transaction
that commits the step's turn. Rows hold ids and numbers, no text; deleting or
removing a thread does not delete its usage. Device runs write no rows.
Acceptance: the sum of a run's rows equals the run record's `tok`.

**K2. What counts.** Input plus output tokens, with reasoning tokens inside
output as the AI SDK reports them (`06-auth-and-users.md` §8); cached input tokens count in full
until open question 2 is settled. Title and summary jobs for a thread count
toward the asker's allowance (`05-run-lifecycle-and-streaming.md` §8 bills them to the asker).

**K3. The weekly allowance.** 2,000,000 included tokens per active member per
week (`SESSION_WEEKLY_TOKENS`, overridable per user in `user_limits`), reset
Fridays 00:00 UTC (the mockup's `ALLOWANCE` and `RESET`). Admins are not
exempt from accounting, so their meter is correct, but may be exempt from
enforcement. Acceptance: tests at the reset boundary with an injected clock.

### 6.2 What the Usage page shows

**K4. API keys.** tRPC `apiKeys.set { provider, raw }`, `apiKeys.remove
{ provider }` (online-only, ADR-19). One key per provider, Anthropic and
OpenAI (`PROVIDERS`); the schema's labels, multiple keys, monthly caps and
default key are dropped. The raw key is encrypted with AES-256-GCM under
`SESSION_SECRET_KEY` (01 S3), decrypted only inside the provider adapter for
the duration of a call, never logged and never returned; reads return the
prefix and last 4 characters (`mask()`). A new key is `checking` until a
`keyCheck` effect makes one minimal provider call, then `valid` or `invalid`
with the provider's reason. Removing a key asks "Remove the <provider> key?
Asks billed to it will stop." (`kConfirm`); runs already using it finish
`failed { why: "key" }` at their next step. Acceptance: a test greps the
database file for a stored raw key and finds nothing; the check effect
retries on network errors and does not retry on `401`.

**K5. Usage read.** tRPC `usage.get` returns `{ allowance, used, resetAt,
billing, keys }`; `usage.listRuns` returns the person's recent runs
(question, share of the allowance or the payer label, date), newest first,
paged. A run in a thread the person can no longer read, or whose node was
removed, is listed without its question ("Removed" or "No longer available"),
because the ledger holds ids and the text is read through current scope.
Acceptance: a test removes a thread and finds its run listed without text.

**K6. The meter.** The app bar ring (`meter()`): tokens left of the
allowance, tone `ok` below 80% used, `warn` from 80%, `bad` from 95%, with
"N left this week; resets in …" as its label. Data comes from `usage.get`,
refetched on a `usage.changed` ephemeral event that the server sends on the
user's SSE connection when a run's usage is recorded. Usage stays an
online-only call (ADR-19); offline, the meter shows the last value with its
time. Acceptance: a component test for the three tones; the meter updates
within one second of a run's finish.

### 6.3 When included tokens run out

The Usage page offers two settings (`usagePage()`): "Pause my asks until the
reset" (default; "You can still read, post and reply") and "Continue on my
Anthropic key" (enabled only with a valid Anthropic key).

**K7. Billing setting.** tRPC `usage.setBilling { mode: "pause" | "key" }`.
Acceptance: setting `key` without a valid Anthropic key answers
`PRECONDITION_FAILED`.

**K8. Payer at apply time.** The payer is a server value made in the
mutator's `pre` stage (01 M1), not taken from input: `included` while tokens
are left; `key:anthropic` when the allowance is spent, billing is `key` and
the model is an Anthropic model; `key:openai` for OpenAI models (which run
only on the person's key, §6.4); `none` otherwise. With `none` the write still
applies: the thread or node is created and its run is written
`failed { why: "tokens" }`, so an ask queued offline on the desktop is not
lost and can be retried after the reset. The online composer checks
`usage.get` first and shows the mockup's message instead of sending:
"You're out of tokens until Friday. You can still post, or add an API key in
Usage." Posts, replies and comments are never blocked. Device runs are not
affected (V6). Acceptance: mutator tests with each payer; a convergence test
with a write queued while tokens were left and applied after they ran out.

**K9. Crossing the allowance during a run.** A run is admitted while any
included tokens are left, and its cost is known only as it runs. At each
step boundary the loop re-reads the remaining allowance. When it reaches 0:
with billing `key` and an Anthropic model, the next steps use the person's
key and the run is billed "Included + Anthropic key" (the mockup's split
label in `charge()`); otherwise the run finishes on included tokens and the
excess is recorded as an overdraft, bounded by the per-run token cap (L1).
Acceptance: a fixture run crossing the boundary writes ledger rows with both
payers; an overdraft never exceeds L1.

**K10. Queued runs at the reset.** A run that failed with `tokens` is not
retried automatically at the reset; the person presses Retry. Runs waiting in
the dispatcher queue are re-checked before they start (`05-run-lifecycle-and-streaming.md` §8).

### 6.4 Models and effort

**K11. Model registry.** Models come from
`web/packages/shared/src/models/registry.ts` (ADR-16). The mockup's names
("Opus 5.5", "Gemini 4 Neon", "GPT-6.1 Sol") are placeholders; the picker
shows registry entries the person may use. Each entry gains `payers`:
`included` and/or `key:<provider>`. The mockup's key-only OpenAI model
("GPT-6.1 Sol", "your OpenAI key", "Add a key" when missing) becomes an entry
with `payers: ["key:openai"]`, called with the person's OpenAI key directly,
not through OpenRouter. ADR-16 restricts `claude-fable` to admins "until
per-account usage limits are active"; the weekly allowance is such a limit,
so lifting the gate is a decision for ADR-23 (open question 1).

**K12. Effort.** The mockup's model menu has an Effort submenu (low, medium,
high, max) and the tooltip shows "· high effort". ADR-16 fixes effort at
medium and does not expose it, and the overview does not decide effort, so
ADR-16 wins: no Effort control in v1, and the answer tooltip shows the model
only. The run record keeps an `effort` field (`agents.ts` already carries
one) so that a later ADR can add the control without a record change.

**K13. Model per run.** A follow-up may use a different model than its parent
(`04-agent-runtime.md` §1); device runs record the agent and no model id. The server re-checks
model access and payer on every `threads.create`, `nodes.ask`, `nodes.lookup`
and `research.retryNode` (`04-agent-runtime.md` §1).

**K14. Key-run privacy.** OpenRouter's zero-data-retention routing (`04-agent-runtime.md` §1) does
not apply to calls made with a person's own Anthropic or OpenAI key; those
calls fall under the person's own agreement with the provider. The Usage page
says so next to each key.

## 7. Per-run limits

**L1. Owned runs.** 25 steps (`MAX_STEPS` in `runs/loop.ts`), 15 minutes wall
clock, 20 searches and 20 fetches (`tools/context.ts`), as now; plus a new
per-run token cap of 400,000 tokens (`SESSION_RUN_MAX_TOKENS`), which also
bounds an overdraft (K9). A capped run finishes with what it has and a note
that it hit the limit. Concurrency: 2 running owned runs per user and the
per-provider caps of `04-agent-runtime.md` §10; queued runs per user capped by
`SESSION_QUEUED_PER_USER`.

**L2. Look-ups.** 4 steps, 2 searches, 2 fetches, 1,000 output tokens, 2
minutes, because the prompt asks for two or three sentences with a source.
Acceptance: a fixture run that keeps calling tools stops at 2 searches.

**L3. Device runs.** 200 KB per answer, 100 runs per hour per user, a 30 s
lease (V3), and a 30-minute wall clock enforced by the desktop (open question
3 for the server side).

**L4. Comments and posts.** No run; the request-level limits of `06-auth-and-users.md` §8
(60 writes per minute) apply through `apply` (01 A3).

## 8. Dependencies

```
01 C3, C4 (schema) ─► G1-G6 (mutators) ─► E1 (serverApply) ─► E2-E4
01 Y7 (SSE) ─► T1-T5
01 S2 (device tokens) ─► V2-V5 ─► V6, V7
K1 (ledger) ─► K3, K5, K8, K9
K4 (keys) ─► K7, K8, K11
ADR-23 (keys, models) ─► K4, K11
L1-L2 alongside E2
```

G1-G6 can be written and tested in `@session/mutators` before any executor
exists; the fixture provider (`server/src/runs/fixtureProvider.ts`) drives E2
and T tests without network access.

## 9. Open questions

1. **Which models at launch, and the admin gate.** The mockup implies an
   Anthropic model for everyone as the default and an OpenAI model on the
   person's key. ADR-16's default is `gemini-flash`, and Fable is admin-only.
   Should ADR-23 make an Anthropic model the default for all members now that
   the weekly allowance exists, and is 2,000,000 tokens a week affordable at
   that model's price?
2. **Cached tokens.** Count cached input tokens in full, at the provider's
   discount ratio, or not at all? Long branch chains resend the same context,
   so this changes how fast the allowance runs out.
3. **Device runs without a device.** How long may a device run stay queued
   before it fails, and should the server enforce a wall clock on a claimed
   device run as well as the lease?
4. **Open as its own thread.** Who may promote a branch (the branch's author,
   the thread's author, any member), and is the new thread attributed to the
   branch's author (as the mockup does) or to the person who promoted it?
5. **Out-of-tokens copy on the desktop.** Should the message also offer
   "Run on this Mac" when a CLI is available, given that device runs count
   toward no limit?
6. **Effort.** Is the Effort submenu a product decision that should reopen
   ADR-16, or a mockup exploration?
