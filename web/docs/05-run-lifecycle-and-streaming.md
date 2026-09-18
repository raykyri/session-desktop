# Run lifecycle, streaming, and state ownership

Where a research run executes, what happens to its output while it runs and
after failures, and how clients observe it.

## 1. What users need from a run

| Situation | Expected behavior |
| --- | --- |
| Submit a question | The node appears immediately as `queued`, then `running`, then text streams in |
| Navigate away and come back | The document shows everything produced so far and continues streaming |
| Close the tab, sleep the laptop, open the app on a phone | The run kept going on the server |
| Two tabs open on the same thread | Both show the same content and progress |
| The server is deployed while a run is in progress | The run resumes automatically; the user sees at most a pause |
| The network drops for a while | On reconnect the document catches up without duplicated or missing text |
| Cancel | The stream stops within a second; the partial answer remains readable |
| Many users at once | Nobody's run is starved silently; queued runs show their position |

Two properties follow: run state is server-authoritative and reconstructable
from one request, and a run is resumable from persisted state because the
app owns the conversation (`04-agent-runtime.md` §4).

## 2. Where state lives

| State | Storage | Lifetime |
| --- | --- | --- |
| Node metadata (status, timestamps, error, model, attempt) | SQLite `nodes` | durable |
| Canonical messages of completed nodes | SQLite `node_messages` | durable |
| Committed turns of an active attempt | SQLite `run_turns` | until the final snapshot replaces them |
| In-flight assistant text | memory + `run_turns` checkpoint ≤ 1 s stale | until committed |
| Per-node sequence counter `seq` | SQLite `nodes.run_seq` | durable |
| Final answer | SQLite `response_snapshots` | durable |
| Open provider stream, `AbortController`, tool budgets | server memory | while the attempt runs |
| Attached documents | volume `/data/documents` + SQLite | durable |
| Which node is open, scroll offsets, drafts | client: URL, stores, `interface_drafts` | per user |
| Live turn buffer for visible nodes and `lastSeq` | client memory | while mounted |

The client persists nothing about runs.

## 3. Run state machine

```
queued ──► running ──► complete
   │          ├──────► failed
   │          ├──────► cancelled
   │          └──────► interrupted ──► (auto-resume) ──► running
   └────────────────► cancelled
```

- `queued`: waiting for an admission slot; payload carries `queuePosition`.
- `running`: the provider stream is open (the desktop's `starting` state is
  unnecessary; there is no process to spawn).
- `complete`, `failed`, `cancelled`: terminal, monotonic.
- `interrupted`: the server stopped mid-attempt (deploy, crash). Partial
  output is kept and displayed. The server auto-resumes on boot (§7); after
  two failed auto-resumes the node stays `interrupted` with Retry.

Every transition writes the node row and emits `research.node.updated`.
Every run-scoped event carries `seq`, per node, incremented for every event
the server persists or forwards.

## 4. Streaming protocol: snapshot plus ordered deltas

1. Snapshot. `research.getNodeContent(nodeId)` returns
   `{ node, turns, inFlightText, seq, responseRevision?, queuePosition? }`.
   For an active node, `turns` are committed turns from `run_turns` and
   `inFlightText` the latest checkpoint.
2. Deltas over the SSE subscription: `research.run.started`,
   `research.turn.delta` (≤ 1 per 50 ms per node), `research.turn.committed`,
   `research.run.finished`, plus `research.node.updated`.
3. Client rule: apply only `seq === lastSeq + 1`; drop lower; on a gap
   refetch the snapshot. Refetch also on mount, `visibilitychange`, and SSE
   reconnect.
4. Completion: after `research.run.finished` and a terminal `node.updated`
   with `responseSnapshotAt`, fetch the durable snapshot once and drop the
   live buffer. Live and durable paths produce the same `Turn[]`, so the
   timeline reconciles without a flash.
5. Non-run events are not replayed; on reconnect the client invalidates list
   queries.

Deltas are delivered only to connections that declared interest in the node
(`events.setInterest`); `research.node.updated` goes to all of the user's
connections.

## 5. Durability of run output

- Committed turns are inserted into `run_turns` in the same transaction that
  increments `nodes.run_seq`.
- In-flight text is checkpointed at most once per second or every 4 KiB.
- The final answer is written to `response_snapshots` with the desktop's
  two-guard rule (an assistant text turn exists and two consecutive reads of
  the live turns agree, `state.rs:8870`), the attempt's messages are appended
  to `node_messages`, and `run_turns` for the node are deleted, in one
  transaction with `synchronous=FULL`.

## 6. Execution topology: one process

Runs are open HTTPS streams to provider APIs plus a few KB of state; there
are no child processes. They execute inside the single web server process on
the single Fly machine. The earlier plan's separate runner app was justified
by CLI processes dying on deploy; with owned conversation state a deploy is
handled by resuming (§7), so one app suffices. If provider streams ever need
to outlive the web process, the run loop module has no dependency on HTTP
request context and can move behind a queue later.

## 7. Interruption and resume

On `SIGTERM` the server stops admitting, aborts open provider streams after
persisting their last checkpoint, marks their nodes `interrupted` with
`resume_pending = 1`, closes SSE connections, and exits. On boot, after
migrations, the server re-queues every `resume_pending` node at the head of
the queue. Resume re-issues the attempt from the node's persisted context:
the interrupted attempt's committed tool exchanges are kept as context (they
are real messages), the in-flight partial assistant text is discarded, and
the model continues from the last committed step. `attempt` increments and
`resume_kind = "auto"` is recorded. The user sees the status flip to
`running` and text resume; the discarded partial is replaced.

Retry (user action) on `failed`, `cancelled`, or `interrupted` starts a
fresh attempt from the parent's context, discarding the node's own partial
messages, as the desktop's retry did.

## 8. Admission and queueing

Owned by the server: 2 concurrent research runs per user, per-provider caps
(`04-agent-runtime.md` §10), FIFO by user then time, metadata pool separate.
`queuePosition` is included in `research.node.updated` while `queued`.
Provider `429` responses re-queue with exponential backoff (5 s, 20 s, 60 s)
rather than failing.

## 9. Client implementation summary

- `liveTurns` store: `Map<nodeId, { turns, inFlightText, inFlightTurnId,
  lastSeq, status }>`.
- `useNodeContent(nodeId)` seeds from the snapshot, applies ordered deltas,
  refetches on gaps; exposes `{ turns, inFlightText, source, error }`. The
  buffer exists only for a node a view has seeded, so the run events that reach
  every connection do not accumulate buffers for nodes nobody is watching. The
  durable read waits for the terminal `research.node.updated` rather than
  firing on `research.run.finished`, which precedes the snapshot transaction,
  and the buffer is dropped only once that read has landed.
- The event bridge applies run events to `liveTurns` and everything else to
  the query cache in one 16 ms batch, and publishes the interest set.
- If SSE cannot connect for 10 s, a 2 s snapshot poll runs for displayed
  active nodes.

## 10. Failure matrix

| Failure | Effect | Recovery |
| --- | --- | --- |
| Client disconnects | Deltas missed | Snapshot refetch per displayed active node on reconnect |
| Server deploy or crash | Streams cut | `interrupted` → auto-resume on boot from persisted context; ≤ 1 s of text re-sent |
| Provider stream error mid-answer | Attempt ends | Classified: `rate_limited` re-queues with backoff; others `failed` with copy; partial text kept |
| Provider refusal (Fable) | `failed` with category | User retries or picks another model |
| Context too long | `failed` | Context budget rules (`04` §4) make this rare; message suggests a new thread |
| Tool vendor outage | Tool returns error results | Model continues without; run completes with fewer sources; vendor errors logged |
| SQLite write error | `failed` ("response could not be preserved") | Live turns retained in memory for the process lifetime |

## 11. Decisions recorded

- Runs execute in the web server process; one Fly app.
- Run state is server-authoritative with per-node sequence numbers; clients
  hold no durable run state.
- Output is durable at one-second granularity while streaming and exact at
  completion; conversation history is owned by the app.
- Deploys interrupt and auto-resume; `interrupted` is a first-class status.
- No event replay buffer; reconnect means refetch.
