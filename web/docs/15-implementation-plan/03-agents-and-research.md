# 03 — Agents and research

Status: draft. This file plans how asks, branches, comments and look-ups
become runs; which models and effort levels a run may use, and how a site
admin sets the default model and the default effort (K15); the owned agent
loop, which is the only executor in this build (device CLI runs of ADR-21
and `AGENTS.md` "Desktop" are out of scope: web-only build, `00-overview.md`);
streaming over the sync connection (ADR-22); token accounting, the weekly
allowance, the behaviour when included tokens run out and API keys, as the
mockup's Usage page shows them (`usagePage()`, `meter()`, `keysSection()`,
`charge()` in `docs/mockups/session-web-members.html`); per-run limits; and
how each run failure ends.

Records, the change log, mutators and the HTTP surface are in
`01-architecture-and-data.md`; item ids there (`C3`, `Y7`, …) are referred to
here. Authority is as in `00-overview.md`: `AGENTS.md` and the ADRs win over
the mockup unless the overview records the product decision. References of
the form `04-agent-runtime.md` §n and `05-run-lifecycle-and-streaming.md` §n
are to the existing documents in `web/docs/`, not to the plan files `04-…`
and `05-…` in this directory.

Work items have ids `G` (graph), `E` (executors), `V` (device runs, all
removed: web-only build), `T` (streaming), `K` (tokens, keys and models),
`L` (limits). Items that existed only for device runs keep their ids and are
marked "(removed: web-only build)".

## 1. Records

A run belongs to one ask node. ADR-22 makes committed turns and run state
records in the space log; the prototype's `RunRec`
(`web/packages/replica-proto/src/records.ts`) holds only `queued` and the root
node, so the record set grows:

| kind | key | fields (stored shape) | tier |
|---|---|---|---|
| `node` | `node:<id>` | `th`, `s`, `par` (`null` for the root), `kind` (`ask`, `lookup`), `u`, `q` (the prompt), `tpl?` (look-up template version), `look?`, `quote?`, `b?` (passage: index of the top-level block of the parent's answer that holds `quote`), `model`, `effort`, `run` (current run id), `mod`, `del`, `createdAt`, `rev` | full |
| `run` | `run:<id>` | `th`, `s`, `node`, `u` (asker and payer), `model`, `effort`, `status`, `attempt`, `step`, `fail?`, `tok?`, `bill?`, `createdAt`, `startedAt?`, `finishedAt?`, `rev` | full; status also on the summary of the root's run |
| `turn` | `turn:<run>:<attempt>:<n>` | `role`, `blocks` (text, tool use, tool result, citations), `createdAt` | full |
| `answer` | `answer:<node>` | the final answer as Markdown, cited pages, `tok`, `run`, `attempt` | full |
| `comment` | `comment:<id>` | C4 of 01 | full |

The `executor` and `agent` fields of device runs are not added (removed:
web-only build); every run is an owned run.

`status` is `queued | running | complete | failed | cancelled | interrupted`
(ADR-14), plus `superseded` for an attempt stopped by the attempt fence (E1,
`05-run-lifecycle-and-streaming.md` §7). Because the fence stops every write
of that attempt, `superseded` appears in the server's attempt bookkeeping and
logs, never in a served run record; the client never renders it. `fail.why` keeps the schema's values (`stopped`, `tokens`, `key`,
`rate` with `at`, `access`, `interrupted`; `runFailureSchema` in `spaces.ts`)
and adds:

- `error` with `cls`, the existing provider error class
  (`RunErrorClass` in `web/packages/server/src/runs/errors.ts`: `auth`,
  `content_filter`, `context_too_long`, `provider_unavailable`, `network`,
  `timeout`, `unknown`), shown with that file's copy;
- `device` and `too_large` are not added (removed: web-only build).

`bill` is the payer label of K9: `included`, `key:anthropic`, `key:openai`,
or `included+key:anthropic` for a run that crossed the allowance.

Answers are stored as Markdown, as turns are today, and rendered and
sanitized by the client's Markdown pipeline (`02-client-app.md` §4.4, its
N12). Streamed deltas (§5) are Markdown as well; the server stores no HTML.
Answers are plain Markdown: widgets and artifacts are not rendered
(decision P21; the mockup shows them only as options).

The thread record keeps `tok` and `src` (the root answer's token count and
number of cited pages), `sum` (the root answer's summary line) and `running`.
The thread byline reads "N sources · Nk tokens · #channel" from `src` and
`tok` (`card()` uses the root's `p.tok`); a branch card shows its own
answer's counts. The answer icon's tooltip reads "model · effort"
(`runOf()`, e.g. "Opus 5.5 · high effort").

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
model must be a registry entry (K11, K13, checked in `pre`) and `effort` one
the model accepts
(`ModelEntry.efforts`), else `BAD_REQUEST`, as `research.forkNode` refuses
today. `post` queues a `job` effect with the run id. Acceptance: mutator tests
for each parent rule and each refusal; a convergence-suite generator that adds
random Continue and Branch writes.

**G2. Look up.** `look` must be 1-4 words after trimming leading and
trailing non-letter, non-digit characters (the mockup's `lookPhrase`: the
selection must start and end on word boundaries), at most 80 characters.
`quote` is the passage that holds the phrase, at most 2,000 characters. The
mutator builds `q` from `LOOKUP_PROMPT_V1` in `@session/mutators` ("Look up
"<phrase>" as it is used in this answer. Describe what it refers to in two
or three sentences, with a source.", the mockup's text in `addLookup`) and
stores `tpl: 1`. The client never sends `q` for a look-up, so it cannot store
text that the UI will not display (01 C3). Acceptance: look-up input with `q`
is refused as an extra field; a 5-word phrase and a phrase that starts inside
a word are refused; client prediction and server apply produce the same `q`.

The mockup always parents a look-up on the root (`addLookup(p, …)` passes
`'r'`) and passes no context, because only the root answer is selectable
there. The plan parents it on the node whose answer holds the selection and
sends the passage as `quote`; for a selection in the root answer this is the
mockup's behaviour.

**G3. What the UI shows of a look-up.** Rows and cards show a magnifier and
the phrase (the mockup's `lookh` block, "Look up <phrase>"), never `q`. The
stored prompt is served like other node text; it is not secret, only not
displayed. Look-ups count as branches in the footer count (01 C5). While the
run is pending the row shows the phrase and the pending state of E3.
Acceptance: the 02 W4.4 Playwright test (new row shows the phrase, not the
prompt).

**G4. Comments.** Comment (`branchActs`, tooltip "Comment on this branch.
Does not run an answer.") writes a `comment` record and never a run. It works
while out of tokens and for members without API keys. Mentions in comments
notify (01 C16). Acceptance: a test asserts that `comments.create` queues no
`job` effect and writes no usage row.

**G5. Open as its own thread.** `threads.create` with `from: { th, node }`
(schema already has it) copies the node's question and answer into a new
thread and sets `promoted` on the node. No run starts and no usage is
written; the new thread's `tok` and `src` are copied from the answer. The
server sets the new thread's author from stored state; it does not take an
author from input. Decided (P14): anyone who can read the branch may open it
as its own thread (`who: "member"`; in an open channel a reader joins first,
as for any write), and the new thread is shown with the branch's author, not
with the person who opened it. The new thread is in the same channel.
Acceptance: a test promotes a node and finds no `job` effect and the answer
text equal to the source node's; a test in which a member who is not the
branch's author promotes it and the new thread's `u` is the branch's
author.

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

ADR-10 as amended by ADR-21: the owned loop is the default executor
("included tokens"), and in this build the only one. The existing loop in `web/packages/server/src/runs/`
(`loop.ts`, `service.ts`, `providers.ts`, `errors.ts`, `tools/`) is kept and
re-pointed at the new records.

**E1. Server-originated writes.** Runs write records through a server-only
path in `@session/sync/server` (`serverApply(fn)`, 01 Y13), which commits record
rows, change-log rows and the registry in one transaction like a mutator,
without an envelope or a seq. Every such write is fenced: it checks that the
run's `attempt` is still the node's current attempt and that the thread and
node are not removed or deleted; otherwise it writes nothing, aborts the
provider stream, and the attempt ends `superseded`
(`05-run-lifecycle-and-streaming.md` §7). Acceptance: a test removes a thread
while its run streams and finds no turn written after the removal, the
provider stream aborted, and no text in the database (01 D4).

**E2. Run lifecycle.** The `job` effect queues the run; the dispatcher admits
it under the limits of §7, sets `running`, streams, commits a `turn` at each
step finish, writes `answer` and `complete` at the end, records usage (§6),
and queues title and summary jobs for a new thread. Deploys mark running runs
`interrupted` and resume them on boot, as now: at most two automatic resumes,
then the run stays `interrupted` with Run again
(`05-run-lifecycle-and-streaming.md` §3, §7). Acceptance: the existing run
tests in `web/packages/db/test/runs.test.ts` and `runRecovery.test.ts` are
rewritten against the new records and pass.

**E3. Progress steps.** The mockup shows "Researching · Step n of 4"
(`status()`). The loop maps its activity to four phases: planning (before the
first tool call), searching (`web_search`), reading (`web_fetch`, Gemini
grounding results), writing (text after the last tool call), stored as
`run.step` 0-3 and shown as Step `step + 1`. A queued run shows Step 1. A
model that writes without tools jumps from 0 to 3. `run.step` only increases
within an attempt and is written at most once per phase change. Acceptance:
fixture-provider tests for a tool-using and a tool-free run.

**E4. Cancel and retry.** Cancel aborts the provider stream; partial turns
stay. Run again on `failed`, `cancelled` or `interrupted` increments
`attempt` and starts from the parent's context. It carries the model, effort
and executor the person picks; it does not need `base.rev` because the
attempt number fences it. Acceptance: cancel-then-retry within one
millisecond leaves one live attempt (the existing test for
`05-run-lifecycle-and-streaming.md` §7, ported).

**E5. Failure handling.** Each failure ends the attempt as below; committed
turns are kept in every case, and usage already recorded stays recorded. The
device-run column of this table is removed (web-only build).

| Failure | Owned run |
|---|---|
| Provider `429` | Re-queued with backoff 5 s, 20 s, 60 s (`05-run-lifecycle-and-streaming.md` §8); after the third, `failed { why: "rate", at }` with `at` 60 s ahead |
| Other provider error | `failed { why: "error", cls }` from `classifyRunError` |
| Deployment credential rejected (`401`/`403` on included tokens) | `failed { why: "error", cls: "auth" }`; logged with the class, and a new `session_run_failures_total{cls}` counter alerts on any `auth` |
| Person's key rejected mid-run (`401`/`403`, or key removed) | `failed { why: "key" }` at that step; the key becomes `invalid` (K4) |
| Wall clock (`SESSION_RUN_TIMEOUT_SECONDS`, 900) | `failed { why: "error", cls: "timeout" }`, as now |
| Per-run token cap (L1) | `complete`, with the note "Stopped at the run's token limit." after the answer |
| Allowance exhausted mid-run | K9 |
| Server deploy or crash | `interrupted`, auto-resumed (E2) |
| Thread removed or node deleted | `superseded`, nothing written (E1) |
| Asker lost access before start | `failed { why: "access" }` (G8) |

Acceptance: a fixture-provider test per row.

## 4. Device runs (removed: web-only build)

ADR-21 and `AGENTS.md` "Desktop": a device run is a Claude Code or Codex CLI
process on the user's own Mac. This build has no desktop client, so device
runs are not built: V1-V7 are removed, and no device-run route, lease table,
setting or picker entry exists. The text below is kept for a later desktop
build and is not scheduled (`05` §1.2).

**V1. Choosing a device executor (removed: web-only build).** On the desktop the model picker lists
"Claude Code on this Mac" and "Codex on this Mac" when the CLI is found on
`PATH` (checked at launch and when the picker opens); the Effort submenu is
hidden for them. The ask is written with `executor: "device"`, `agent`, and
no model. The desktop reports which CLIs it found with
`devices.setAgents { agents }` (tRPC, online). Web and phone show the entries
only when a paired desktop has reported the CLI in the past 7 days; the run
then waits for that user's desktop. Acceptance: the picker test in the client
package; the mutator refuses `executor: "device"` with an unknown `agent`.

**V2. Claim (removed: web-only build).** `POST /api/runs/claim { deviceId }` (bearer device token)
returns the oldest queued device run whose asker is the token's user, with
its attempt number and the context built by G7, after the G8 access check.
The claim is a conditional insert into `run_leases` (01 D3) keyed by run and
attempt, so a run is held by at most one device; a claim with nothing to hand
out answers `204`. Acceptance: two desktops of one user claiming at once get
different runs, or one gets the run and the other `204`.

**V3. Lease and heartbeat (removed: web-only build).** The lease is held by `POST /api/runs/heartbeat
{ run, attempt }` every 10 s, separate from progress; it expires after 30 s
without a heartbeat. The heartbeat answers `{ cancel: true }` after
`research.cancelNode`, and `NOT_FOUND` once the thread is removed or the node
deleted; in both cases the desktop kills the CLI and deletes its directory.
An expired lease ends the run `interrupted` (ADR-22). Device runs are not
resumed automatically; "Run again" starts a new attempt, which any of the
user's devices may claim. On server boot every device lease gets a fresh 30 s
expiry, so a deploy does not interrupt device runs whose desktop keeps
sending heartbeats. Acceptance: a test stops heartbeats and finds the run
`interrupted` within 40 s and a late `POST /api/runs/turn` for that attempt refused; a
test restarts the server mid-run and finds the run still `running` after the
next heartbeat.

**V4. Process (removed: web-only build).** The desktop spawns the CLI in a new empty temporary
directory (`mkdtemp`), with the prompt built from the claimed context, in
non-interactive mode (`claude -p` with stream-JSON output; `codex exec` with
JSON output). The CLIs keep their read-only tools for now; locking down local
reads is deferred and there are no local-file attachments (AGENTS.md). The
directory is deleted when the process exits. Parsing lives in the desktop
client's Tauri side, not in the server; it maps the CLI's web search and
fetch tool events to the steps of E3. A CLI missing at spawn finishes
`failed { why: "device", cls: "cli_missing" }`; one that reports it is not
signed in, `cli_auth`; a non-zero exit, `cli_exit`, with the last 500
characters of its error output in the run's failure detail. Acceptance: a
fake-CLI fixture (a script that prints recorded JSONL) drives the parser
tests; a test asserts the working directory is empty at spawn; one test per
`cls`.

**V5. Reporting (removed: web-only build).** `POST /api/runs/turn { run, attempt, seq, turn?, delta? }`
commits a turn and carries in-flight text as `delta` batches, fanned out as
ephemeral events (§5); `POST /api/runs/finish { run, attempt, outcome,
answer?, fail? }` ends it with `complete`, `failed` or `cancelled`. Both
carry the attempt number and are refused with `CONFLICT` for a stale attempt
or an expired lease. The server rejects an answer over 200 KB
(`SESSION_DEVICE_ANSWER_MAX_BYTES`) and ends the run
`failed { why: "too_large" }`. Acceptance: tests for stale attempt, oversized
answer, and a finish without turns.

**V6. Labels, usage and limits (removed: web-only build).** A device answer's meta line carries a
light-text label ("Claude Code" or "Codex") in place of the token count; the
run reports no usage, writes no ledger row and counts toward no allowance or
limit except the device cap: 100 device runs per hour per user
(`SESSION_DEVICE_RUNS_PER_HOUR`), counted at claim. Beyond the cap the claim
answers `TOO_MANY_REQUESTS` with `Retry-After` and the run stays queued.
Acceptance: the 101st claim within an hour is refused and the run is still
`queued`.

**V7. Queued with no device (removed: web-only build).** A device run that no device claims stays
`queued`, shown as "Waiting for your Mac". The asker may cancel it or Run
again on the owned executor. How long it may wait is open question 3.

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

**T5. Device deltas (removed: web-only build).** Device runs post deltas on `POST /api/runs/turn` (V5); the
server assigns nothing and forwards them with the device's `seq`, after
checking that it increases. Owned and device runs are indistinguishable to
the reader except for the label. Acceptance: a non-increasing device `seq`
is refused with `BAD_REQUEST` and not forwarded.

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
  Users may now add keys. This needs a new ADR (ADR-23) amending ADR-10 and
  ADR-16; ADR-21's reasoning (users spend their own subscriptions without the
  server holding credentials) covers device runs only.
- ADR-16 and `04-agent-runtime.md` §1 fix effort at medium and do not expose
  it, but the registry (`ModelEntry.efforts`, `defaultEffort`), the server
  (`effortProviderOptions`, `research.forkNode` effort checks) and the client
  (`QuestionModelPicker` Effort submenu) already expose per-model effort.
  ADR-23 records this; K12 keeps the shipped behaviour.
- The mock API and `spaces.ts` mark keys and usage as `TODO(limits)` stubs
  with keys "not encrypted for now" and a payer "stored as sent". The real
  server encrypts keys (K4) and decides the payer (K8); the mock's stub
  decisions were scoped to the mock.

### 6.1 Accounting

**K1. The ledger.** Extend `usage_events`
(`web/packages/db/src/schema/usage.ts`) with `run_id`, `attempt`, `payer`
(`included`, `key:anthropic`, `key:openai`) and `week` (the ISO date of the
Friday that starts the week). One row per provider call step, written in the
transaction that commits the step's turn. Rows hold ids and numbers, no text;
deleting or removing a thread does not delete its usage. Acceptance: the sum of a run's rows equals the run record's `tok`.

**K2. What counts.** Input plus output tokens, with reasoning tokens inside
output as the AI SDK reports them (`06-auth-and-users.md` §8). Cached input
tokens count at the provider's discount ratio (decision P12): a cached input
token counts as the ratio of the provider's cached-input price to its input
price for that model (for example 0.1 where cached input costs a tenth),
taken from the model registry entry (`ModelEntry.cachedInputRatio`, new), and
the ledger stores both the raw token counts and the counted total. Title and summary jobs
for a thread count toward the asker's allowance
(`05-run-lifecycle-and-streaming.md` §8 bills them to the asker). Tokens paid
by a person's key are recorded but do not count toward the allowance.

**K3. The weekly allowance.** 2,000,000 included tokens per active member per
week (`SESSION_WEEKLY_TOKENS`, overridable per user in `user_limits`), reset
Fridays 00:00 UTC (the mockup's `ALLOWANCE` and `RESET`). Every user is
metered, admins included; a larger allowance is a `user_limits` row, not a
role exemption. An overdraft (K9) counts in the week it happened and does not
carry over. Acceptance: tests at the reset boundary with an injected clock.

### 6.2 What the Usage page shows

**K4. API keys.** tRPC `apiKeys.set { provider, raw }`, `apiKeys.remove
{ provider }` (online-only, ADR-19). One key per provider, Anthropic and
OpenAI (`PROVIDERS`); the schema's labels, multiple keys, monthly caps and
default key (`usage.setDefaultKey`) are dropped. The server checks the format
before storing: Anthropic keys start with `sk-ant-`, OpenAI keys with `sk-`,
both at least 24 characters, and an Anthropic key sent as OpenAI is refused;
each answers `BAD_REQUEST` with the mockup's message. The raw key is
encrypted with AES-256-GCM under `SESSION_SECRET_KEY` (01 S3), decrypted only
inside the provider adapter for the duration of a call, never logged and
never returned; reads return the prefix and last 4 characters (`mask()`). A
new key is `checking` until a `keyCheck` effect lists the provider's models
(a request that uses no tokens), then `valid` ("Valid") or `invalid` with the
provider's reason; a key also becomes `invalid` when a run gets `401`/`403`
with it (E5). The page shows "Not set" with Add key for a missing key.
Removing a key asks "Remove the <provider> key? Asks billed to it will stop."
(`kConfirm`); runs already using it end `failed { why: "key" }` at their next
step. Acceptance: a test greps the database file for a stored raw key and
finds nothing; the check effect retries on network errors and does not retry
on `401`; a test per format refusal.

**K5. Usage read.** tRPC `usage.get` returns `{ allowance, used, resetAt,
billing, keys }`. The page's first line reads "You have N% of usage left this
week. Next reset on Fri, in 2d 5h." (`usageTop()`). `usage.listRuns`
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

**K6. The meter.** The app bar ring (`meter()`): tokens left of the
allowance, tone `ok` below 80% used, `warn` from 80%, `bad` from 95%;
visible text "Nk left", `aria-label` "N of 2M included tokens left this week;
resets in 2 days 5 h". Data comes from `usage.get` (online-only, ADR-19),
with a 30 s stale time, refetched when one of the viewer's run records
reaches a terminal status in the replica (02 W8.1). Offline, the meter shows
the last value with its time. Acceptance: a component test for the three
tones; the meter updates within one second of the run record turning
`complete`.

### 6.3 When included tokens run out

The Usage page offers two settings (`usagePage()`): "Pause my asks until the
reset" (default; "You can still read, post and reply.") and "Continue on my
Anthropic key" ("Asks bill to your Anthropic key until the reset."), enabled
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
for other models `included` while tokens are left, `key:anthropic` when the
allowance is spent, billing is `key` and the model is an Anthropic model, and
`none` otherwise. With `none` the write still applies: the thread or node is
created and its run is written `failed { why: "tokens" }`, so an ask whose
payer changed between the client's check and the server's apply (another
tab spent the allowance) is not lost and can be run again after the reset. Online, the client computes the
same payer from `usage.get` before sending Ask, Continue, Branch, Branch here
and Look up, and on `none` sends nothing and shows the toast "You're out of
tokens until Friday. You can still post, or add an API key in Usage."
(`OUT_MSG`, `outOfTokens()`; the weekday comes from `resetAt`). Posts,
replies and comments are never blocked. The mockup's follow-up composer
blocks even a key-paid model; the plan applies the payer rule to every
action. Acceptance: mutator tests with each payer; a convergence test with a
write queued while tokens were left and applied after they ran out; a client
test per action.

**K9. Crossing the allowance during a run.** A run is admitted while any
included tokens are left, and its cost is known only as it runs. At each
step boundary the loop re-reads the remaining allowance. When it reaches 0:
with billing `key`, a valid Anthropic key and an Anthropic model, the next
steps use the person's key and the run's `bill` is `included+key:anthropic`
("Included + Anthropic key", the split label in `charge()`); otherwise the
run finishes on included tokens and the excess is recorded as an overdraft,
bounded by the per-run token cap (L1). If the key is rejected after the
switch, the run ends `failed { why: "key" }` (E5). Acceptance: a fixture run
crossing the boundary writes ledger rows with both payers; an overdraft never
exceeds L1; a fixture run whose key is rejected after the switch ends `key`
with its earlier turns kept.

**K10. Queued runs at the reset.** A run that failed with `tokens` is not
run again automatically at the reset; the person presses Run again. Runs
waiting in the dispatcher queue are re-checked before they start
(`05-run-lifecycle-and-streaming.md` §8); one whose payer is now `none` ends
`failed { why: "tokens" }`. Acceptance: a queued run admitted after the
allowance is spent ends `tokens` without a provider call.

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
default model and default effort (K15; decision H, which replaces question
P11). ADR-23 records this. Acceptance: a picker test for a key-only model with
and without the key.

**K12. Effort.** The mockup's model menu has an Effort submenu (`modelMenu`,
`EFFORT_OPTS`: low, medium, high, max) and the tooltip shows "· high effort".
The shipped picker already has this submenu, listing Default and the efforts
the chosen model accepts (`ModelEntry.efforts`: low, medium and high for most
models; Fable adds xhigh and max). v1 keeps that: the submenu lists the
chosen model's efforts, `effort` is stored on node and run (null for the
model's `defaultEffort`, medium), and the tooltip shows "model · effort".
Decided (P13): no cost estimate is shown for high efforts and effort is not
capped on included tokens; the per-run token cap (L1) bounds a single run.
Acceptance: a picker test that the submenu
changes with the model; the mutator refuses an effort the model does not
accept.

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
with the provider. The Usage page says so next to each key.

**K15. Default model and default effort (site admin).** Decision H: a site
admin (`users.is_admin`) sets at runtime, on the Site Admin page (`02`
W8.2), exactly two settings: the default model and the default effort for
asks. Members' composers start on both. There is no model availability
setting: every registry entry stays available to every member (K11). There
are no per-member model overrides (`05` §6, Q9 decided: no). Of the
mockup's three variants of the page (a single default-model setting; a
models table with default and availability; a settings page with per-member
overrides), this build ships the first, with the default effort added.
- Storage (non-replicated, `01` D3): `site_settings(key PK, value_json,
  updated_by, updated_at)` holding `default_model` (a registry id) and
  `default_effort` (`low`, `medium`, `high` or `max`). The launch seed sets
  the registry's current default and its `defaultEffort`. If a deploy
  removes the stored default model from the registry, the server uses the
  registry's default and its `defaultEffort` until an admin sets another.
- Rules: the default model must be payable with `included` (K11 `payers`);
  a key-only model, such as the OpenAI one, answers `BAD_REQUEST`. The
  default effort must be one the default model accepts
  (`ModelEntry.efforts`), else `BAD_REQUEST`. When `setDefault` names a
  model that does not accept the current default effort, the server sets
  `default_effort` to that model's `defaultEffort` in the same transaction
  and returns `effortReset: { from, to }`, which the page shows (`02`
  W8.2).
- API (tRPC, online-only, site admins only, ADR-19): `admin.models.list`
  (every registry entry with name, provider, `payers` and efforts, the
  default model and the default effort), `admin.models.setDefault { model }`
  (returns the new default model, the default effort and `effortReset?`),
  `admin.models.setDefaultEffort { effort }`. No prices or descriptions are
  returned. Every change is logged with the admin's id.
- Members read `models.list` (tRPC, online, cached 60 s): every registry
  entry with its payers and efforts, the default model and the default
  effort. The composer starts on the default model and the default effort
  unless the person picked another model or effort in this tab (`02` §5).
  Changes reach open tabs on the next fetch.
- The settings affect only the composer's starting choice; `pre` (K13) and
  `run` do not read them, so prediction is unaffected.
Acceptance: server tests that a non-admin's `admin.models.*` answers
`FORBIDDEN`, that a key-only default is refused, that a default effort the
default model does not accept is refused, that `setDefault` to a model that
does not accept the current default effort resets it to that model's
`defaultEffort` and returns `effortReset`, and that `models.list` returns
every registry entry; a client test of the Site Admin page (`02` W8.2) and
of the composer starting on the default model and default effort.

## 7. Per-run limits

**L1. Owned runs.** 25 steps (`MAX_STEPS` in `runs/loop.ts`), 15 minutes wall
clock (`SESSION_RUN_TIMEOUT_SECONDS`, 900), 20 searches and 20 fetches
(`tools/context.ts`), as now; plus a new per-run token cap of 400,000 tokens
(`SESSION_RUN_MAX_TOKENS`), which also bounds an overdraft (K9). A run at the
token cap ends `complete` with its answer so far and the note of E5.
Concurrency: 2 running owned runs per user (`SESSION_RUNS_PER_USER`) and the
per-provider caps of `04-agent-runtime.md` §10; 20 queued runs per user
(`SESSION_QUEUED_PER_USER`), beyond which the mutator's `pre` stage answers
`TOO_MANY_REQUESTS`. Acceptance: a fixture run that never stops writing ends
at the token cap with the note; the 21st queued ask is refused.

**L2. Look-ups.** 4 steps, 2 searches, 2 fetches, 1,000 output tokens, 2
minutes, because the prompt asks for two or three sentences with a source.
Acceptance: a fixture run that keeps calling tools stops at 2 searches.

**L3. Device runs (removed: web-only build).** 200 KB per answer, 100 runs per hour per user, a 30 s
lease (V3), and a 30-minute wall clock enforced by the desktop (open question
3 for the server side).

**L4. Comments and posts.** No run; the request-level limits of
`06-auth-and-users.md` §8 (60 writes per minute) apply through `apply`
(01 A3).

## 8. Dependencies

```
01 C3, C4 (schema) ─► G1-G6 (mutators) ─► E1 (serverApply) ─► E2-E5
01 Y7 (SSE) ─► T1-T4
K1 (ledger) ─► K3, K5, K8, K9
K4 (keys) ─► K7, K8, K11
K15 (model settings) ─► K11, K13
ADR-23 (keys, models, effort) ─► K4, K11, K12, K15
L1-L2 alongside E2
```

G1-G6 can be written and tested in `@session/mutators` before any executor
exists; the fixture provider (`server/src/runs/fixtureProvider.ts`) drives E2
and T tests without network access.

## 9. Open questions

1. **Which models at launch, and the admin gate.** Decided (H, replacing
   P11): a site admin sets the default model and the default effort at runtime
   (K15); every registry model is available to every member. The allowance
   is 2,000,000 tokens a week per member. Per-member model overrides:
   decided no (`05` §6, Q9).
2. **Cached tokens.** Decided (P12): counted at the provider's discount
   ratio (K2).
3. **Device runs without a device.** Moot: no device runs in this build.
4. **Open as its own thread.** Decided (P14): anyone who can read the branch
   may open it; the new thread is shown with the branch's author (G5).
5. **Out-of-tokens copy on the desktop.** Decided (P15): no "Run on this
   Mac"; there are no device runs.
6. **Effort and the allowance.** Decided (P13): no cost estimate and no
   effort cap (K12).
