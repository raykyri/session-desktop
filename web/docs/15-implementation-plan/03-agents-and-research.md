# 03 — Agents and research

Status: draft. This file plans how asks, branches and look-ups become runs
(comments never do, G4); which models and effort levels a run may use, and
how a site admin sets the default model and the default effort (K15); the
owned agent loop, which runs every ask in this build (web-only build,
`00-overview.md`); streaming over the sync connection (ADR-22); token
accounting at spend time, the weekly allowance, the per-member overdraft
limit, the behaviour when included tokens run out and API keys, as the
mockup's Usage page shows them (`usagePage()`, `meter()`, `keysSection()`,
`charge()` in `docs/mockups/session-web-members.html`); per-run limits; and
how each run ends.

Records, the change log, mutators and the HTTP surface are in
`01-architecture-and-data.md`; item ids there (`C3`, `Y7`, …) are referred to
here. Authority is as in `00-overview.md`: `AGENTS.md` and the ADRs win over
the mockup unless the overview records the product decision. References of
the form `04-agent-runtime.md` §n and `05-run-lifecycle-and-streaming.md` §n
are to the existing documents in `web/docs/`, not to the plan files `04-…`
and `05-…` in this directory.

Work items have ids `G` (graph), `E` (the owned run loop), `V` (device runs,
all removed: web-only build), `T` (streaming), `K` (tokens, keys and models),
`L` (limits). Items that existed only for device runs keep their ids and are
marked "(removed: web-only build)".

## 1. Records

A run belongs to one ask node. ADR-22 makes committed turns and run state
records in the space log; the prototype's `RunRec`
(`web/packages/replica-proto/src/records.ts`) holds only `queued` and the root
node, so the record set grows:

| kind | key | fields (stored shape) | tier |
|---|---|---|---|
| `node` | `node:<id>` | `th`, `s`, `par` (`null` for the root), `kind` (`ask`, `lookup`), `u`, `q` (the prompt), `tpl?` (look-up template version), `look?`, `quote?`, `b?` (passage: index of the top-level block of the parent's answer that holds `quote`), `model`, `effort`, `run` (current run id), `promoted?` (id of the thread the node was opened as, G5), `mod`, `del`, `createdAt`, `rev` | full |
| `run` | `run:<id>` | `th`, `s`, `node`, `u` (asker and payer), `model`, `effort`, `status`, `attempt`, `step`, `fail?`, `tok?`, `bill?`, `note?`, `createdAt`, `startedAt?`, `finishedAt?`, `rev` | full; status also on the summary of the root's run |
| `turn` | `turn:<run>:<attempt>:<n>` | `role`, `blocks` (text, tool use, tool result, citations), `createdAt` | full |
| `answer` | `answer:<node>` | the final answer as Markdown, cited pages, `tok`, `run`, `attempt` | full |
| `comment` | `comment:<id>` | C4 of 01 | full |

`model` and `effort` are always set on node and run (K12); `effort` is never
null. `note` holds the stop note of a run that ends `complete` before the
model finished (E5: the per-run token cap and the overdraft limit).

`status` is `queued | running | complete | failed | cancelled | interrupted`
(ADR-14), plus `superseded` for an attempt stopped by the attempt fence (E1,
`05-run-lifecycle-and-streaming.md` §7). Because the fence stops every record
write of that attempt, `superseded` appears in the server's attempt
bookkeeping and logs, never in a served run record; the client never renders
it. `fail.why` keeps the schema's values (`stopped`, `tokens`, `key`, `rate`
with `at`, `access`, `interrupted`; `runFailureSchema` in `spaces.ts`) and
adds `error` with `cls`, the existing provider error class (`RunErrorClass`
in `web/packages/server/src/runs/errors.ts`: `auth`, `content_filter`,
`context_too_long`, `provider_unavailable`, `network`, `timeout`,
`unknown`), shown with that file's copy. A `key` failure carries `detail`,
one of a fixed set the server writes (`runKeyDetailSchema`: `key_only`,
`key_unset`, `key_changed`, `key_rejected`, `key_forbidden`; never the
provider's text), which the asker's copy follows (02 §3.3).

`bill` is the payer label of K9: `included`, `key:anthropic`, `key:openai`,
or `included+key:anthropic` for a run that crossed the allowance.

Answers are stored as Markdown, as turns are today, and rendered and
sanitized by the client's Markdown pipeline (`02-client-app.md` §4.4, its
N12). Streamed deltas (§5) are Markdown as well; the server stores no HTML.
Answers are plain Markdown: widgets and artifacts are not rendered
(decision P21; the mockup shows them only as options).

The thread record keeps `tok` and `src` (the root answer's token count and
number of cited pages), `sum` (the root answer's summary line) and `running`.
The ask card's footer starts with "N sources · Nk tokens · #channel"
(`fmeta` in `card()`, from `src`, `tok` and the channel; empty parts
omitted), followed by the follow-up button and Save (02 §3.2). There is no
byline row and no agent mark, and branch cards in the side column show no
counts. Model and effort are stored on node and run but are shown nowhere in
the UI: there is no "model · effort" tooltip (`00-overview.md`).

## 2. The ask graph

### 2.1 Asks, Continue, Branch, Branch here, Look up

The mockup has five ways to start a run, all of which create one `node` and
one `run` in a single mutation; the node id is in the input and the run id is
`tx.id(1)`. The mutator names are the ones in `spaces.ts`; `parent: "r"`
names the thread's root as it does there.

| Action | Mockup | Parent | Input |
|---|---|---|---|
| Ask | composer, kind `ask` (`newThread`) | none: thread root | `threads.create { id, space, kind: "ask", q, model, effort }` |
| Continue | `branchActs` "Continue" (`askfrom` with `n.id`) on a selected node `n`; the footer follow-up button is Continue on the root | `n` | `research.forkNode { id, thread, parent: n, kind: "ask", q, model, effort }` |
| Branch | `branchActs` "Branch" (`askfrom` with `n.par`) on `n` | `n.par` (a sibling of `n`) | same, `parent: n.par` |
| Branch here | select text in an answer, "Branch here" | the node whose answer holds the selection | same, plus `quote`, `b` |
| Look up | select 1-4 whole words, "Look up" | the node whose answer holds the selection | `research.forkNode { id, thread, parent, kind: "lookup", look, quote?, b?, model, effort }` |

`forkNodeInputSchema` becomes a union on `kind`; `uses` and `pay` are
dropped (K8). `followups.ask` has no parent and is not used for ask threads;
every ask under a thread goes through `research.forkNode`.

Branch on the root has no parent to be a sibling under; the mockup never
offers it there (the root's card has only the follow-up button), and the
mutator refuses `parent` equal to the root's own `par` (`null`) with
`BAD_REQUEST`.

**G1. `threads.create` and `research.forkNode`.** In
`web/packages/mutators/src/nodes.ts`. `who: "member"`; the parent must exist,
be readable, not removed and not running or queued (the mockup hides Continue
and Branch while `n.pending`). `q` is 1 to 8,000 characters; `quote` at most
2,000; `b` an integer the client takes from the passage index (02 §4.4, W4.4). The
model must be a registry entry (K11, K13, checked in `pre`) and `effort`, which
is required, one the model accepts (`ModelEntry.efforts`), else
`BAD_REQUEST`, as `research.forkNode` refuses today; `pre` also refuses a
21st queued run (L1). `run` writes the `run` record with status `queued`,
which is the queue (E2); there is no `job` effect. For `research.forkNode`
the `notify` stage (01 U1) writes the `branch` notification of 01 C16 to the
parent node's author in the same transaction. Acceptance: mutator tests for
each parent rule and each refusal; a test that a fork writes a `queued` run
record and its `branch` notification in one commit; a convergence-suite
generator that adds random Continue and Branch writes.

**G2. Look up.** `look` must be 1-4 words after trimming leading and
trailing non-letter, non-digit characters (the mockup's `lookPhrase`: the
selection must start and end on word boundaries), at most 80 characters.
`quote` is the passage that holds the phrase, at most 2,000 characters. The
mutator builds `q` from `LOOKUP_PROMPT_V1` in `@session/mutators` ("Look up
"<phrase>" as it is used in this answer. Describe what it refers to in two
or three sentences, with a source.", the mockup's text in `addLookup`) and
stores `tpl: 1`. A look-up opened as its own thread (G5) is titled
`Look up "<phrase>"`, without the instructions to the model. The client never sends `q` for a look-up, so it cannot store
text that the UI will not display (01 C3). Acceptance: look-up input with `q`
is refused as an extra field; a 5-word phrase and a phrase that starts inside
a word are refused; client prediction and server apply produce the same `q`.

As in the mockup, Look up and Branch here are offered only for a selection
in a thread card's answer (`.card .prose`), never in a branch card, so both
are parented on the root (`addLookup(p, …)` passes `'r'`). The plan also
sends the passage that holds the selection as `quote` (02 §4.4).

**G3. What the UI shows of a look-up.** Rows and cards show a magnifier and
the phrase (the mockup's `lookh` block, "Look up <phrase>"), never `q`. The
stored prompt is served like other node text; it is not secret, only not
displayed. Look-ups count as branches in the footer count (01 C5). While the
run is pending the row shows the phrase and the pending state of E3.
Acceptance: the 02 W4.4 Playwright test (new row shows the phrase, not the
prompt).

**G4. Comments.** Comment (`branchActs`, tooltip "Comment on this branch.
Does not run an answer.") writes a `comment` record and never a run. It works
while out of tokens and for members without API keys. The `comment`
notification to the node's author and mention notifications are written by
the `notify` stage in the same transaction (01 U1, C16). Acceptance: a test
asserts that `comments.create` writes no `run` record and no usage row.

**G5. Open as its own thread.** `threads.create` with `from: { th, node }`
(schema already has it) copies the node's question and answer into a new
thread and sets `promoted` on the node (§1). No run starts and no usage is
written; the new thread's `tok` and `src` are copied from the answer. The
server sets the new thread's author from stored state; it does not take an
author from input. Decided (P14): anyone who can read the branch may open it
as its own thread (`who: "member"`; in an open channel a reader joins first,
as for any write), and the new thread is shown with the branch's author, not
with the person who opened it. The new thread is in the same channel.
Acceptance: a test promotes a node and finds no `run` record written, the
node's `promoted` equal to the new thread's id, and the answer text equal to
the source node's; a test in which a member who is not the branch's author
promotes it and the new thread's `u` is the branch's author.

**G6. Delete and stop.** `followups.delete` erases a node's text when nobody
else has written under it, else leaves a shell (the AGENTS.md rule for
threads applied to nodes); a node whose run is queued or running is cancelled
first. `research.cancelNode` sets the run's status to `cancelled` with
`fail.why: "stopped"`; `research.retryNode` starts a new attempt (E4).
Acceptance: delete of a running node ends its run `cancelled` and writes no
turn after the delete.

### 2.2 Context for a run

**G7. Context assembly.** In `web/packages/server/src/runs/context.ts`: the
system prompt (`prompts.ts`), then for each ancestor from the root to the
parent its prompt `q` and its final answer turns, then the new node's `q`.
For Branch here and Look up the `quote` is added to the new user message as a
quoted passage. A Branch's context is its parent's path; it does not include
the sibling it was started beside. Reasoning blocks are dropped across models
(ADR-16). Every run rebuilds context from the thread's stored records; there
is no CLI session resume (ADR-21). Context over the model's window is cut by
the existing budget rules (`04-agent-runtime.md` §4). Acceptance: snapshot
tests of the built message list for each action in §2.1.

**G8. Access at start.** When a run starts, the server checks that the asker
can still read the thread; if not, the run ends `failed { why: "access" }`
without calling a model. Acceptance: a test removes the asker from a private channel while
the run is queued and finds the run `access` with no usage row.

## 3. The owned agent loop

ADR-10 as amended by ADR-21 makes the owned loop ("included tokens") the
default way a run executes; in this build it is the only one. The existing
loop in `web/packages/server/src/runs/` (`loop.ts`, `service.ts`,
`providers.ts`, `errors.ts`, `tools/`) is kept and re-pointed at the new
records.

**E1. Server-originated writes.** Runs write records through a server-only
path in `@session/sync/server` (`serverApply(fn)`, 01 Y13), which commits record
rows, change-log rows and the registry in one transaction like a mutator,
without an envelope or a seq. Every record write of a run is fenced: it
checks that the run's `attempt` is still the node's current attempt and that
the thread and node are not removed or deleted; otherwise it writes nothing,
aborts the provider stream, and the attempt ends `superseded`
(`05-run-lifecycle-and-streaming.md` §7). The fence covers record writes
only: ledger writes (K1) are never fenced and commit in their own short
transactions, so a superseded attempt still closes its open ledger row.
Acceptance: a test removes a thread while its run streams and finds no turn
written after the removal, the provider stream aborted, no text in the
database (01 D4), and the call's ledger row closed with the tokens streamed
before the abort.

**E2. Run lifecycle.** The `run` record that the mutator writes with status
`queued` is the queue; there is no `job` effect. The dispatcher claims the
oldest admissible queued run (the limits of §7, the payer re-check of K10)
with a compare-and-set in one transaction: `queued` → `running` where `id`,
`attempt` and `status = 'queued'` still match, so at most one runner holds an
attempt. The runner then streams, commits a `turn` at each step finish,
writes `answer` and `complete` at the end, and records usage as it is spent
(K1). For a new thread the title and the summary line (`sum`) are the run's
final steps, fenced (E1) and billed (K1) like the other steps, not separate
jobs. A deploy drains running runs to `interrupted`; a crash leaves the
record `running`, and boot marks it `interrupted`. In both cases boot resumes
them, as now: at most two automatic resumes, then the run stays
`interrupted` with Run again (`05-run-lifecycle-and-streaming.md` §3, §7).
Acceptance: the existing run tests in `web/packages/db/test/runs.test.ts` and
`runRecovery.test.ts` are rewritten against the new records and pass; two
dispatchers claiming the same queued run at once leave one runner and one
`running` transition; a run killed mid-stream is `interrupted` after boot.

**E3. Progress steps.** The mockup shows "Researching · Step n of 4"
(`status()`). The loop maps its activity to four phases: planning (before the
first tool call), searching (`web_search`), reading (`web_fetch`, Gemini
grounding results), writing (text after the last tool call), stored as
`run.step` 0-3 and shown as Step `step + 1`. A queued run shows Step 1. A
model that writes without tools jumps from 0 to 3. `run.step` only increases
within an attempt and is written at most once per phase change. Acceptance:
fixture-provider tests for a tool-using and a tool-free run.

**E4. Cancel and retry.** Cancel aborts the provider stream; partial turns
stay. Run again (a plan addition; the mockup has no retry control) on
`failed`, `cancelled` or `interrupted` increments `attempt`, writes the run `queued` again and starts from the parent's
context. It carries the model and effort the person picks; it does not need
`base.rev` because the attempt number fences it. Acceptance:
cancel-then-retry within one millisecond leaves one live attempt (the
existing test for `05-run-lifecycle-and-streaming.md` §7, ported).

**E5. How a run ends.** Each ending closes the attempt as below; committed
turns are kept in every case. Every provider call has one ledger row (K1),
opened when the call starts; the last column says how the row of the call in
progress is closed. "Last counts" means the input tokens counted for the
request and the output tokens of the last usage event the stream delivered;
a call the provider refused before streaming (an HTTP error answer) is closed
at 0.

| Ending | Owned run | Ledger row of the call in progress |
|---|---|---|
| Finish | `complete` with the answer (E2) | closed with the provider's final counts |
| Cancel or delete (G6) | `cancelled { why: "stopped" }` | stream aborted; closed with the last counts |
| Provider `429` | Re-queued with backoff 5 s, 20 s, 60 s (`05-run-lifecycle-and-streaming.md` §8); after the third, `failed { why: "rate", at }` with `at` 60 s ahead | closed at 0; each retry opens a new row |
| Other provider error | `failed { why: "error", cls }` from `classifyRunError` | closed with the last counts (0 if refused before streaming) |
| Deployment credential rejected (`401`/`403` on included tokens) | `failed { why: "error", cls: "auth" }`; logged with the class, and a new `session_run_failures_total{cls}` counter alerts on any `auth` | closed at 0 |
| Person's key rejected mid-run (`401`/`403`, or key removed, replaced, or billing moved from `key` to `pause`) | `failed { why: "key" }` at that step; a rejected key becomes `invalid` (K4) | closed at 0 (key removed, replaced or billing moved: the call in progress finishes and closes normally; the run ends at its next step, K4, K7) |
| Wall clock (`SESSION_RUN_TIMEOUT_SECONDS`, 900) | `failed { why: "error", cls: "timeout" }`, as now | stream aborted; closed with the last counts |
| Per-run token cap (L1) | `complete`, with the note "Stopped: Reached token limit for a single run." after the answer | stream aborted at the checkpoint that reaches the cap; closed with the last counts |
| Allowance reached mid-run | continues: the next step uses the person's Anthropic key, or the run continues on overdraft (K9) | the step's row closes normally; the next step's row carries the new payer |
| Overdraft limit reached (K9) | `complete`; the partial step's text is committed as the last turn, with the note "Stopped: Out of tokens." | stream aborted at the next checkpoint; closed with the last counts |
| Server deploy (drain) | `interrupted`, auto-resumed (E2) | stream aborted; closed with the last counts |
| Server crash | `interrupted` at boot, auto-resumed (E2) | closed at boot with its last checkpoint (K1) |
| Thread removed or node deleted | `superseded`, no record written (E1) | stream aborted; closed with the last counts (ledger writes are not fenced) |
| Asker lost access before start | `failed { why: "access" }` (G8) | no row: no call is made |

Acceptance: a fixture-provider test per row, each checking the run's ending
and the closed ledger row (K1).

## 4. Device runs (removed: web-only build)

This build has no desktop client, so device runs are not built: no
device-run route, lease table, setting or picker entry exists (`05` §1.2).

**V1. Choosing a device executor.** (removed: web-only build)

**V2. Claim.** (removed: web-only build)

**V3. Lease and heartbeat.** (removed: web-only build)

**V4. Process.** (removed: web-only build)

**V5. Turn and finish posts.** (removed: web-only build)

**V6. Labels, usage and limits.** (removed: web-only build)

**V7. Queued with no device.** (removed: web-only build)

## 5. Streaming over the sync connection

ADR-22 replaces ADR-11. One SSE connection per client (01 Y7) carries both
pull batches and run deltas.

**T1. Durable state.** Run status, step, committed turns and the answer are
records in the space log, delivered by `pull`. A client that misses every
delta still converges on the same answer. Acceptance: a client test drops
every delta and ends with the same answer as one that received them.

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
stale) with its `seq`. `/live` applies the `pull` scope check and answers
`NOT_FOUND` to a reader who may not read the thread. A delta of an older
attempt is dropped. Acceptance: a client test injects a gap, a duplicate and
an old attempt; a server test calls `/live` as a non-member.

**T4. Checkpoints off the log.** In-flight text is written to `run_live`, not
to `records`, so streaming does not add change-log rows; only step finishes
do. Acceptance: a 25-step run adds at most 25 turn rows and a constant number
of run-record writes per step to the change log.

**T5. Device deltas.** (removed: web-only build)

## 6. Tokens, the weekly allowance and API keys

The overview records the product decision: a weekly allowance, recent runs,
a choice of what happens when included tokens run out, and Anthropic and
OpenAI keys. This conflicts with existing documents in four places, and the
overview's decision or the shipped code wins in each:

- `06-auth-and-users.md` §8 counts daily tokens and runs
  (`SESSION_DAILY_TOKENS`, `SESSION_DAILY_RUNS`). The allowance becomes
  weekly; the daily run count is dropped and replaced by the per-run limits of
  §7.
- `04-agent-runtime.md` §11 and ADR-10 say users do not provide API keys.
  Users may now add keys. ADR-23 (accepted) amends ADR-10 and ADR-16 for
  this; ADR-21's reasoning (users spend their own subscriptions without the
  server holding credentials) covers device runs only.
- ADR-16 and `04-agent-runtime.md` §1 fix effort at medium and do not expose
  it, but the registry (`ModelEntry.efforts`, `defaultEffort`), the server
  (`effortProviderOptions`, `research.forkNode` effort checks) and the client
  (`QuestionModelPicker` Effort submenu) already expose per-model effort.
  ADR-23 records this; K12 keeps per-model effort and makes it explicit on
  every run.
- The mock API and `spaces.ts` mark keys and usage as `TODO(limits)` stubs
  with keys "not encrypted for now" and a payer "stored as sent". The real
  server encrypts keys (K4) and decides the payer (K8); the mock's stub
  decisions were scoped to the mock.

### 6.1 Accounting

**K1. The ledger.** Extend `usage_events`
(`web/packages/db/src/schema/usage.ts`) with `run_id`, `attempt`, `payer`
(`included`, `key:anthropic`, `key:openai`), `week` (the ISO date of the
Friday that starts the week) and `state` (`open`, `closed`). Tokens are
recorded as they are spent, one row per provider call: the run loop inserts
the row when the call starts (`state: open`, input tokens as counted for the
request), updates its output tokens from the stream's usage events at most
every 2 s, and closes it (`state: closed`, the counts of E5's last column)
when the call ends for any reason: finish, cancel, timeout, error,
superseded, overdraft stop or drain. Ledger writes commit in their own short
transactions, not in the transaction that commits the step's turn, and are
never fenced (E1). On boot, rows still `open` after a crash are closed with
their last checkpoint, so at most 2 s of output per call can go unbilled.
Allowance checks (K3, K8, K9, K10) read the ledger including open rows, so a
member's concurrent runs see each other's spending. Rows hold ids and
numbers, no text; deleting or removing a thread does not delete its usage.
Acceptance: a fixture test for each way a call can end (finish, cancel,
timeout, error, superseded, overdraft stop, process kill) finds a closed row
whose tokens match what the fixture provider streamed (within the 2 s
checkpoint bound for the kill case); the sum of a run's rows equals the run
record's `tok`, and `bill` names the payers of its research rows, both over
every attempt and every claim of the run.

**K2. What counts.** Input plus output tokens, with reasoning tokens inside
output as the AI SDK reports them (`06-auth-and-users.md` §8). Cached input
tokens count at the provider's discount ratio (decision P12): a cached input
token counts as the ratio of the provider's cached-input price to its input
price for that model (for example 0.1 where cached input costs a tenth),
taken from the model registry entry (`ModelEntry.cachedInputRatio`, new), and
the ledger stores both the raw token counts and the counted total. The title
and summary steps of a new thread (E2) count toward the asker's allowance
(`05-run-lifecycle-and-streaming.md` §8 bills them to the asker), and so does
the context summary of a long thread, whoever pays for the run. Once included
usage reaches allowance plus the overdraft limit (K9), none of these calls is
made: the title is the question, clipped as a title with no generated one is
(`defaultTitle`, 72 characters), the thread gets no summary line, and the
context goes without a new summary (a cached one is still used). The run's
`bill` names the payers of its research calls only, so a key-paid thread is
labelled with its key. Tokens paid by a person's key are recorded but do not
count toward the allowance.

**K3. The weekly allowance.** 2,000,000 included tokens per active member per
week (`SESSION_WEEKLY_TOKENS`, overridable per user in `user_limits`), reset
Fridays 00:00 UTC (the mockup's `ALLOWANCE` and `RESET`). Every user is
metered, admins included; a larger allowance is a `user_limits` row, not a
role exemption. An overdraft (K9) is limited per member by
`SESSION_OVERDRAFT_TOKENS`, counts in the week it happened and does not carry
over. Acceptance: tests at the reset boundary with an injected clock.

### 6.2 What the Usage page shows

**K4. API keys.** tRPC `apiKeys.set { provider, raw }`, `apiKeys.remove
{ provider }` (online-only, ADR-19). One key per provider, Anthropic and
OpenAI (`PROVIDERS`); the schema's labels, multiple keys, monthly caps and
default key (`usage.setDefaultKey`) are dropped. The server checks the format
before anything else: Anthropic keys start with `sk-ant-`, OpenAI keys with
`sk-`, both at least 24 characters, and an Anthropic key sent as OpenAI is
refused; each answers `BAD_REQUEST` with the mockup's message. It then checks
the key during the request by listing the provider's models (a call that
uses no tokens, 10 s timeout); there is no `keyCheck` effect. A key the
provider rejects is refused and not saved, `BAD_REQUEST` "That key was
rejected by <Provider>."; a timeout or network error is refused and not
saved, `BAD_GATEWAY` "Couldn't reach <Provider> to check the key. Try
again." An accepted key is encrypted with AES-256-GCM under
`SESSION_SECRET_KEY` (01 S3), saved as `valid`, decrypted only inside the
provider adapter for the duration of a call, never logged and never
returned; reads return the prefix and last 4 characters (`mask()`). The page
shows "Checking…" while the request runs, then the "Valid" chip and the
toast "<Provider> key works." At save, a 401 or a 403 from the provider
refuses the save with "That key was rejected by <Provider>.". During a run,
only a 401 or the provider's `authentication_error` marks the key `invalid`
and returns billing from `key` to `pause` (E5); a 403 (a permission error on
a key that still authenticates) fails the run `failed { why: "key" }` with
the provider's message as its detail and leaves the key `valid`. The page shows "Not set" with Add key for a missing key.
Removing a key asks "Remove the <provider> key? Asks billed to it will stop."
(on the OpenAI row "Remove the OpenAI key?": no model bills to it)
(`kConfirm`); runs already using it end `failed { why: "key" }` at their next
step. Acceptance: a test greps the database file for a stored raw key and
finds nothing; with a fixture provider that rejects the key, one that times
out and one that accepts it, the first two save nothing and answer their
messages and the third saves `valid`; a test per format refusal.

**K5. Usage read.** tRPC `usage.get` returns `{ allowance, used, resetAt,
billing, keys }`, with `used` counting open ledger rows (K1). The page's
first line reads "N% of usage left this week. Next reset Friday, in 2d 5h."
(`usageTop()`; the weekday in full, in the viewer's zone), above a bar of what is left. `usage.listRuns`
returns the person's owned runs of the current week, newest first, paged (the
page shows 6): question (clipped at 90 characters on the client), the share
of the allowance ("<1%" below 0.5%) or, when not `included`, the payer label
("Anthropic key", "OpenAI key", "Included + Anthropic key"), and the date;
"No runs yet this week." when empty. A run in a
thread the person can no longer read, or whose node was removed, is listed
without its question ("No longer available"), because the ledger holds ids
and the text is read through current scope. Acceptance: a test removes a
thread and finds its run listed without text; a test lists a run per payer
label.

**K6. The meter.** The app bar shows a ring only (`meter()`), at every
width: no "Nk left" label and no track. The ring fills with the share of the
allowance used; tone `ok` below 80% used, `warn` from 80%, `bad` from 95%;
`aria-label` "N of 2M included tokens left this week; resets in 2 days 5 h"
(the mockup's text). It links to the Usage page. Data comes from `usage.get`
(online-only, ADR-19), with a 30 s stale time, refetched when one of the
viewer's run records reaches a terminal status in the replica (02 W8.1).
Offline, the ring keeps the last value. Acceptance: a component test for the
three tones, that no label or track is rendered, and the `aria-label`; the
meter updates within one second of the run record turning `complete`.

### 6.3 When included tokens run out

The Usage page offers two settings (`usagePage()`): "Pause my asks until the
reset" (default; "You can still read, post and reply.") and "Continue on my
Anthropic key" ("Asks use your Anthropic key until the reset."), enabled
only with a valid Anthropic key; without one it reads "Add a key below to
turn this on.", or "Needs an Anthropic key. Your OpenAI key only runs GPT-6.1
Sol." when only an OpenAI key is set.

**K7. Billing setting.** tRPC `usage.setBilling { mode: "pause" | "key" }`.
When the Anthropic key is removed or becomes `invalid`, the server sets
billing to `pause`. Acceptance: setting `key` without a valid Anthropic key
answers `PRECONDITION_FAILED`; removing the Anthropic key while billing is
`key` leaves billing `pause`.

**K8. Payer at apply time.** The payer is a server value made in the
mutator's `pre` stage (01 U1); `pay` is removed from `threads.create`,
`research.forkNode`, `followups.update` and `research.retryNode`. The payer
is `key:openai` for OpenAI models (which run only on the person's key, K11);
for other models `included` while included tokens are left (open ledger rows
counted, K1), `key:anthropic` when the allowance is spent, billing is `key`
and the model is an Anthropic model, and `none` otherwise. With `none` the
write still applies: the thread or node is created and its run is written
`failed { why: "tokens" }`, so an ask whose payer changed between the
client's check and the server's apply (another tab spent the allowance) is
not lost and can be run again after the reset. Online, the client computes
the same payer from `usage.get` before sending Ask, Continue, Branch, Branch
here and Look up, and on `none` sends nothing and shows the toast "You're out
of tokens until Friday. You can still post, or add an API key in Usage."
(`OUT_MSG`, `outOfTokens()`; the weekday comes from `resetAt`). Posts,
replies and comments are never blocked. The mockup's follow-up composer
blocks even a key-paid model; the plan applies the payer rule to every
action. Acceptance: mutator tests with each payer; a convergence test with a
write queued while tokens were left and applied after they ran out; a client
test per action.

**K9. Crossing the allowance during a run.** A run on included tokens is
admitted while any included tokens are left, and its cost is known only as it
runs. The loop compares the member's included usage, open ledger rows
counted (K1), with the allowance at each step boundary and at each ledger
checkpoint.
- When included usage reaches the allowance: with billing `key`, a valid
  Anthropic key and an Anthropic model, the next step uses the person's key
  and the run's `bill` is `included+key:anthropic` ("Included + Anthropic
  key", the split label in `charge()`); otherwise the run continues on
  overdraft. If the key is rejected after the switch, the run ends
  `failed { why: "key" }` (E5). While the allowance is not spent (after the
  weekly reset, or a larger allowance), the next step of a run on the
  Anthropic key, on a model included tokens may pay for, moves back to
  included tokens (K8).
- Overdraft is limited per member, not per run:
  `SESSION_OVERDRAFT_TOKENS` (default 200,000 per member per week) is shared
  by all of the member's runs. When included usage reaches allowance plus
  this limit, every included-token run of that member stops at its next
  checkpoint: the stream is aborted, the partial step's text is committed as
  the last turn, and the run ends `complete` with the note "Stopped: out of
  tokens." (E5). Overdraft does not carry into the
  next week.
- The step-boundary check applies the limits of the next step's payer (a
  step that moves to the person's key is not stopped by the overdraft limit)
  and counts the estimated input of the next request: a request whose input
  would reach allowance plus the limit, or the run's token cap, is not made,
  and the run stops there as at a checkpoint. A call
  therefore starts only while its input estimate fits, and each running
  attempt passes the limit by at most one checkpoint interval of output,
  plus the amount by which the provider's input count exceeds the estimate.
- The per-run token cap (L1) still applies to each run.

Acceptance: a fixture run crossing the boundary writes ledger rows with both
payers; two concurrent fixture runs of one member together never exceed
allowance plus overdraft limit by more than one checkpoint interval of
output per run, and both end with the stop note; a fixture run whose next
request's input would pass the limit makes no further call; a fixture run
whose key is rejected after the switch ends `key` with its earlier turns
kept.

**K10. Queued runs at the reset.** A run that failed with `tokens` is not
run again automatically at the reset; the person presses Run again. Runs
waiting in the dispatcher queue are re-checked before they start
(`05-run-lifecycle-and-streaming.md` §8); one whose payer is now `none` ends
`failed { why: "tokens" }`. An attempt that already ran (`startedAt` set, or
ledger rows of its own: a 429 re-queue or a resume) may have crossed into
overdraft (K9), so where the rule answers `none` it is admitted on included
tokens while included usage is below allowance plus the overdraft limit.
Acceptance: a queued run admitted after the allowance is spent ends `tokens`
without a provider call; a run re-queued by 429s after it crossed the
allowance ends `rate`, not `tokens`.

### 6.4 Models and effort

**K11. Model registry.** Models come from
`web/packages/shared/src/models/registry.ts` (ADR-16). The mockup's names
("Opus 5.5", "Gemini 4 Neon", "GPT-6.1 Sol") are placeholders; the picker
shows every registry entry (K15 sets only the default), short names on
the button and full names in the menu. Each entry gains `payers`: `included` and/or
`key:<provider>`. The mockup's key-only OpenAI model ("GPT-6.1 Sol", "your
OpenAI key", "Add a key" linking to Usage when missing) becomes an entry
with `payers: ["key:openai"]`, called with the person's OpenAI key directly,
not through OpenRouter. When that key is removed, a composer that had the
model selected falls back to the default model. ADR-16 restricts
`claude-fable` to admins "until per-account usage limits are active"; the
weekly allowance is such a limit, so the gate is removed and every
registry entry is available to every member; a site admin sets only the
default model and default effort (K15; P11). ADR-23 records this.
Acceptance: a picker test for a key-only model with and without the key.

**K12. Effort.** The mockup's model menu lists the models, then an Effort
submenu (`modelMenu`, `EFFORT_OPTS`: low, medium, high, max) with the
current effort shown beside "Effort". The shipped picker has this submenu
with a Default item; v1 drops Default. The submenu lists exactly the efforts
the chosen model accepts (`ModelEntry.efforts`: low, medium and high for most
models; Fable adds xhigh and max), and every new run carries an explicit
effort: `effort` is required in `threads.create`, `research.forkNode` and
`research.retryNode`, stored on node and run, and never null. The composer
starts on the site default effort (K15). When the person picks a model that
does not accept the current effort, the composer moves to the highest effort
the model accepts that is not above the current one, in the order low <
medium < high < xhigh < max (every registry model accepts low); the same
rule applies when the composer starts on the default model with the default
effort. Model and effort are not shown in the UI after sending (§1).
Decided (P13): no cost estimate is shown for high efforts and effort is not
capped on included tokens; the per-run token cap (L1) bounds a single run.
Acceptance: a picker test that the submenu changes with the model and has no
Default item; a test that switching from max on Fable to a model with low,
medium and high selects high, and that a model accepting the current effort
keeps it; the mutator refuses a missing effort and an effort the model does
not accept.

**K13. Model per run.** A follow-up may use a different model than its parent
(`04-agent-runtime.md` §1). The server re-checks the model (a registry entry), effort and payer in
`pre` on every `threads.create`, `research.forkNode` and
`research.retryNode`; the client predicts with the `models.list` answer it
holds. There is no availability check. A run already queued keeps its model
and effort when a site admin later changes the default model or default
effort. Acceptance: a member's `research.forkNode` with a model id that is
not in the registry, or an effort the model does not accept, answers
`BAD_REQUEST`.

**K14. Key-run privacy.** OpenRouter's zero-data-retention routing
(`04-agent-runtime.md` §1) does not apply to calls made with a person's own
Anthropic or OpenAI key; those calls fall under the person's own agreement
with the provider. The Usage page notes it next to each key, in every state
of the key's row, with "Asks on this key go to <Provider> directly." (for
Anthropic, OpenAI and any other provider listed).

**K15. Default model and default effort (site admin).** Decided (P11): a
site admin (`users.is_admin`) sets at runtime, on the Site Admin page (`02`
W8.2; heading "Site Admin", "Settings for everyone on Session."), exactly two
settings: the default model and the default effort for asks. Members'
composers start on both. There is no model availability setting: every
registry entry stays available to every member (K11). There are no
per-member model overrides (`05` §6, Q9 decided: no).
- Storage (non-replicated, `01` D3): `site_settings(key PK, value_json,
  updated_by, updated_at)` holding `default_model` (a registry id) and
  `default_effort` (`low`, `medium`, `high` or `max`). The launch seed sets
  the registry's current default and its `defaultEffort`. If a deploy
  removes the stored default model from the registry, the server uses the
  registry's default until an admin sets another.
- Rules: the default model must be payable with `included` (K11 `payers`);
  a key-only model, such as the OpenAI one, answers `BAD_REQUEST`, and the
  page lists only models payable with `included` (the mockup's `adminPage()`
  leaves key-only models out). The default effort is one of the four
  efforts the page offers (low, medium, high, max, as the mockup), else
  `BAD_REQUEST`; it is not checked against the default model. A composer
  whose model does not accept the default effort applies K12's rule (the
  highest accepted effort not above it), so changing the default model never
  changes the stored default effort.
- API (tRPC, online-only, site admins only, ADR-19): `admin.models.list`
  (every registry entry with name, provider, `payers` and efforts, the
  default model and the default effort), `admin.models.setDefault { model }`
  (returns the new default model), `admin.models.setDefaultEffort { effort }`
  (returns the new default effort). The page confirms each change with the
  mockup's toasts "Default model set to <model>." and "Default effort set to
  <Effort>." No prices or descriptions are returned. Every change is logged
  with the admin's id.
- Members read `models.list` (tRPC, online, cached 60 s): every registry
  entry with its payers and efforts, the default model and the default
  effort. The composer starts on the default model and the default effort
  (adjusted by K12's rule) unless the person picked another model or effort
  in this tab (`02` §5).
  Changes reach open tabs on the next fetch.
- The settings affect only the composer's starting choice; `pre` (K13) and
  `run` do not read them, so prediction is unaffected.
Acceptance: server tests that a non-admin's `admin.models.*` answers
`FORBIDDEN`, that a key-only default is refused, that `xhigh` or any value
outside the four is refused as a default effort, that `setDefault` leaves
the default effort unchanged, and that `models.list` returns every registry
entry; a client test of the Site Admin page (`02` W8.2) and of the composer
starting on the default model and on the highest effort that model accepts
not above the default effort.

## 7. Per-run limits

**L1. Owned runs.** 25 steps (`MAX_STEPS` in `runs/loop.ts`), 15 minutes wall
clock (`SESSION_RUN_TIMEOUT_SECONDS`, 900), 20 searches and 20 fetches
(`tools/context.ts`), as now; plus a new per-run token cap of 400,000 tokens
(`SESSION_RUN_MAX_TOKENS`). The cap counts one attempt: a 429 re-queue or a
resume continues the attempt's count, and Run again starts a fresh 400,000.
Overdraft is bounded per member, not by this cap (K9). A run at the token cap
ends `complete` with its answer so far and the note of E5. Concurrency: 2
running owned runs per user
(`SESSION_RUNS_PER_USER`) and the per-provider caps of
`04-agent-runtime.md` §10; 20 queued runs per user
(`SESSION_QUEUED_PER_USER`). Beyond that the mutator's `pre` stage refuses
with `PRECONDITION_FAILED` (`reason: "queue_full"`), a recorded refusal that
uses the seq (01 Y2); `TOO_MANY_REQUESTS` stays reserved for transport rate
limits. The client counts its own `queued` runs in the replica before
sending and does not send a 21st; on a refusal it rolls back the prediction,
restores the text to the composer and shows a toast (copy is a plan
addition; the mockup has no queue limit). Acceptance: a fixture run that
never stops writing ends at the token cap with the note; the 21st queued ask
is refused with `PRECONDITION_FAILED` `queue_full`, its answer is replayed
for a resend of the same mutation id, and the next envelope's seq follows
it; a client test restores the text after the refusal.

**L2. Look-ups.** 4 steps, 2 searches, 2 fetches, 1,000 output tokens, 2
minutes, because the prompt asks for two or three sentences with a source.
Acceptance: a fixture run that keeps calling tools stops at 2 searches.

**L3. Device runs.** (removed: web-only build)

**L4. Comments and posts.** No run; the request-level limits of
`06-auth-and-users.md` §8 (60 writes per minute) apply through `apply`
(01 A3).

## 8. Dependencies

```
01 C3, C4 (schema), U1 (notify stage) ─► G1-G6 (mutators) ─► E1 (serverApply) ─► E2-E5
01 Y7 (SSE) ─► T1-T4
K1 (ledger) ─► K3, K5, K8, K9, E5
K4 (keys) ─► K7, K8, K11
K15 (model settings) ─► K11, K12, K13
ADR-23 (keys, models, effort) ─► K4, K11, K12, K15
L1-L2 alongside E2
```

G1-G6 can be written and tested in `@session/mutators` before the run loop
is re-pointed; the fixture provider (`server/src/runs/fixtureProvider.ts`)
drives E2, K1 and T tests without network access.

## 9. Questions (all decided)

Every question of this file is decided; the answers are recorded in
`05-delivery.md` §6.

1. **Which models at launch, and the admin gate.** Decided (P11): a site
   admin sets the default model and the default effort at runtime (K15);
   every registry model is available to every member. The allowance is
   2,000,000 tokens a week per member. Per-member model overrides: decided
   no (`05` §6, Q9).
2. **Cached tokens.** Decided (P12): counted at the provider's discount
   ratio (K2).
3. **Device runs without a device.** Moot: device runs are not built (`05`
   §6, E8).
4. **Open as its own thread.** Decided (P14): anyone who can read the branch
   may open it; the new thread is shown with the branch's author (G5).
5. **Out-of-tokens copy.** Decided (P15): no "Run on this Mac"; there are
   no device runs.
6. **Effort and the allowance.** Decided (P13): no cost estimate and no
   effort cap (K12).
