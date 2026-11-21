// The `RunStore` over the run records (`03-agents-and-research.md` §1-§3,
// E1-E5, G8, T1-T4).
//
// Every record write of a run goes through `serverApply` (`01` Y13), which
// commits the records, their change-log rows and the registry in one
// transaction, and every one is fenced (E1): it reads the run record and
// writes only while the request's attempt is still the run's attempt and
// neither the thread nor the ask is removed or deleted. The fence's read and
// the write are in one synchronous transaction, so a cancel or a retry cannot
// land between them.
//
// What a run writes:
// - the claim: `queued` → `running` by compare-and-set on the id, the
//   attempt and the status (E2), with the access check of G8;
// - `run.step` when the phase moves forward (E3);
// - a `turn` record at each step finish (T1, T4);
// - the new thread's title and the root's summary line, as final steps (E2);
// - at the end: the run's status, `fail`, `tok`, `bill` and `note`, the
//   `answer` record of a completed run, and the root thread's `running`,
//   `tok` and `src`.
//
// In-flight text is not a record (T4): each delta goes to the readers of the
// run's space as an ephemeral `run.delta` event (T2), and the text is
// checkpointed to `run_live` at most once a second or every 4 KiB. The text
// of an attempt this process is streaming is kept in memory too, so
// `GET /api/runs/:id/live` (T3) answers the exact text and sequence number.
//
// The store watches every commit (`SyncService.onRecords`): a write that
// cancels, retries or removes a run this process is streaming stops its
// attempt at once (`stopped`), and a write that queues a run wakes the
// dispatcher (`queued`).

import type { SessionDatabase } from "@session/db";
import { RunTables, preferences, users } from "@session/db";
import {
  bannedFrom,
  canRead,
  firstPayer,
  nodeKey,
  threadKey,
  turnKey,
  view,
  type AnswerRec,
  type NodeRec,
  type RunRec,
  type StoredRecord,
  type ThreadRec,
  type TurnRec,
  type Tx,
} from "@session/mutators";
import type { Spaces, Turn } from "@session/shared";

import type { SyncService } from "../sync/service.js";

import { runBill } from "./allowance.js";
import { roleOf, runContext, turnsOf } from "./context.js";
import type { Ledger, Payer } from "./ledger.js";
import type {
  AttemptSummary,
  BillLabel,
  CompletedAnswer,
  InterruptedRun,
  QueuedRun,
  RunFailure,
  RunRequest,
  RunStep,
  RunStore,
} from "./store.js";

/** The sync event a delta travels as (`03` T2). */
export const RUN_DELTA_EVENT = "run.delta";

/** A delta's sequence number jumps by this much when an attempt is resumed
 * in a new process, past any delta the crashed one sent after its last
 * checkpoint: a client sees a gap and reads `/live` again (`03` T3). */
export const RESUME_SEQ_GAP = 100_000;

/** A `run.delta` event: `n` is the number of the turn the text belongs to
 * (its `turn` record's, once it commits). */
export type RunDelta = Spaces.SpaceRunDelta & { n: number };

/** What `GET /api/runs/:id/live` answers (`03` T3). */
export interface RunLive {
  run: string;
  attempt: number;
  /** The attempt's committed turns: their keys and revs. */
  turns: { key: string; rev: number }[];
  /** The turn still streaming, or null. */
  live: { n: number; text: string; seq: number } | null;
}

interface Reader {
  byKey(key: string): StoredRecord | undefined;
}

/** What the fence of `03` E1 read: the run, its thread and its ask. */
interface Fence {
  run: RunRec;
  th: ThreadRec;
  ask: ThreadRec | NodeRec;
}

interface Live {
  attempt: number;
  th: string;
  s: string;
  /** The number the streaming turn's record will have. */
  n: number;
  turnId: string;
  text: string;
  seq: number;
}

export interface RunWatchers {
  /** A write stopped an attempt this process runs: abort its stream. */
  stopped(runId: string): void;
  /** A write queued a run. */
  queued(): void;
}

export interface RecordRunStoreDeps {
  sync: SyncService;
  db: SessionDatabase;
  /** The account id of a handle; the users table when absent. */
  accountOf?: (handle: string) => string | null;
  /** The asker's research instruction; the stored preference when absent. */
  instructionOf?: (userId: string) => string | null;
  /** The run record's `tok` and `bill`, written from the ledger whenever a
   * write ends or re-queues an attempt: the attempt's end (`finish`), a 429
   * re-queue, a claim refused, an interrupt at boot, an attempt the fence
   * stopped (`03` K1, K9). Both cover every row of the run, every attempt.
   * Absent, `finish` writes the summary's and the other writes leave both
   * as they are. */
  ledger?: Pick<Ledger, "runTokens" | "runPayers">;
  /** A run ended `failed`: the counter `session_run_failures_total{cls}`
   * (`03` E5), labelled with the error class or, for a failure that is not
   * a provider error, its `why`. */
  onFailure?: (cls: string) => void;
}

const SERVER = { me: "", mutationId: "" };

function failOf(fail: RunFailure | undefined): RunRec["fail"] {
  if (!fail) return null;
  return {
    why: fail.why,
    at: fail.why === "rate" ? fail.at : null,
    cls: fail.why === "error" ? fail.cls : null,
    ...(fail.why === "key" ? { detail: fail.detail } : {}),
  };
}

/** The payer a queued run was written with (`03` K8): `pay`, decided in
 * `pre`; for a record written before runs carried one, its model's first
 * payer. The dispatcher decides it again at the claim (K10). */
export function queuedPayer(run: RunRec): Payer {
  return (run as Partial<Pick<RunRec, "pay">>).pay ?? firstPayer(run.model);
}

/** Whether `results` answers tool calls of the stored step `step`, which
 * holds none of their results yet. */
function answers(step: { blocks: { type: string }[] }, results: Turn): boolean {
  const calls = new Set<string>();
  for (const b of step.blocks as unknown as Turn["blocks"]) {
    if (b.type === "toolUse" && b.id) calls.add(b.id);
    if (b.type === "toolResult") return false;
  }
  return results.blocks.some(
    (b) => b.type === "toolResult" && b.toolUseId && calls.has(b.toolUseId),
  );
}

const textOf = (turn: Pick<Turn, "blocks">) =>
  turn.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

/** The answer of a completed attempt as stored (`03` §1): the assistant text
 * written after the last tool call (the text of every assistant turn when no
 * tool was called, or when nothing followed the last call), and the pages
 * the tools read. */
export function answerOf(turns: readonly Turn[]): Pick<AnswerRec, "md" | "pages"> {
  const assistant = turns.filter((t) => t.role === "assistant");
  let lastTool = -1;
  assistant.forEach((t, i) => {
    if (t.blocks.some((b) => b.type === "toolUse")) lastTool = i;
  });
  const after = assistant.slice(lastTool + 1).map(textOf);
  const chosen = after.join("\n\n").trim() || assistant.map(textOf).join("\n\n").trim();
  const pages: AnswerRec["pages"] = [];
  const seen = new Set<string>();
  const titles = new Map<string, string>();
  for (const turn of turns)
    for (const b of turn.blocks)
      if (b.type === "toolResult" && b.toolUseId && typeof b.content === "object" && b.content) {
        const title = (b.content as { title?: unknown }).title;
        if (typeof title === "string") titles.set(b.toolUseId, title);
      }
  for (const turn of assistant)
    for (const b of turn.blocks) {
      if (b.type !== "toolUse" || b.name !== "web_fetch") continue;
      const url = (b.input as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || seen.has(url)) continue;
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        continue;
      }
      seen.add(url);
      pages.push([titles.get(b.id ?? "") ?? host, host, ""]);
    }
  return { md: chosen, pages: pages.slice(0, 20) };
}

export class RecordRunStore implements RunStore {
  readonly #sync: SyncService;
  readonly #tables: RunTables;
  readonly #accountOf: (handle: string) => string | null;
  readonly #instructionOf: (userId: string) => string | null;
  readonly #onFailure: ((cls: string) => void) | undefined;
  readonly #ledger: Pick<Ledger, "runTokens" | "runPayers"> | undefined;
  /** The admission place of attempts this process claimed: the version of
   * the commit that queued the attempt, kept when a 429 re-queues it
   * (`03` E2, E5). */
  readonly #places = new Map<string, { attempt: number; v: number }>();
  /** The attempts this process runs: run id → the request. */
  readonly #attempts = new Map<string, RunRequest>();
  /** The streaming text of the attempts this process runs. */
  readonly #live = new Map<string, Live>();
  #watchers: RunWatchers | null = null;
  readonly #unsubscribe: () => void;

  constructor(deps: RecordRunStoreDeps) {
    this.#sync = deps.sync;
    this.#tables = new RunTables(deps.db);
    this.#accountOf = deps.accountOf ?? ((h) => users.findByHandle(deps.db, h)?.id ?? null);
    this.#instructionOf =
      deps.instructionOf ??
      ((id) => preferences.ensure(deps.db, id).researchLaunchInstruction ?? null);
    this.#onFailure = deps.onFailure;
    this.#ledger = deps.ledger;
    this.#unsubscribe = deps.sync.onRecords((keys) => this.#committed(keys));
  }

  /** Who is told of a stopped attempt and of a queued run. */
  watch(watchers: RunWatchers): void {
    this.#watchers = watchers;
  }

  /** Stop watching commits. */
  close(): void {
    this.#unsubscribe();
  }

  /** The account id of a handle, or null. */
  accountOf(handle: string): string | null {
    return this.#accountOf(handle);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  get #store() {
    return this.#sync.store;
  }

  #apply<T>(fn: (tx: Tx) => T): T {
    const res = this.#sync.server.serverApply(SERVER, fn);
    if (!res.ok) throw new Error(`a run write was refused: ${res.error.code}`);
    return res.result;
  }

  /** The thread and the ask of a run, if neither is removed or deleted and
   * the asker is not banned from the space. A thread its author deleted
   * while others wrote under it stays as a shell (`del`): that ends the
   * root's run, not the runs of the asks under it (`threads.delete`). A ban
   * stops every write in its space, the asker's own runs included
   * (AGENTS.md). */
  #alive(g: Reader, run: RunRec): Omit<Fence, "run"> | null {
    const th = g.byKey(threadKey(run.th));
    if (th?.kind !== "thread" || th.mod === "removed" || th.gone) return null;
    if (bannedFrom(g, run.s, run.u)) return null;
    if (run.node === "r") return th.del ? null : { th, ask: th };
    const n = g.byKey(nodeKey(run.node));
    if (n?.kind !== "node" || n.mod === "removed" || n.del) return null;
    return { th, ask: n };
  }

  /** The run record's `tok` and `bill` from the ledger, or nothing without
   * one: the counted tokens of every row of the run and the payers of its
   * research rows, every attempt (`runBill`), so both describe the same
   * rows. */
  #spent(run: RunRec): { tok: number; bill: BillLabel | null } | Record<string, never> {
    if (!this.#ledger) return {};
    return {
      tok: this.#ledger.runTokens(run.id),
      bill: runBill(this.#ledger, run.id),
    };
  }

  /** The committed turns of one attempt of a run, by number: the keys from
   * the records table, each record through `g`. */
  #turns(g: Reader, run: Pick<RunRec, "id" | "th">, attempt: number): TurnRec[] {
    const runId = run.id;
    return this.#store.sqlite
      .prepare<[string, string], { key: string }>(
        "SELECT key FROM records WHERE th = ? AND kind = 'turn' AND key LIKE ?",
      )
      .all(run.th, `turn:${runId}:${attempt}:%`)
      .flatMap(({ key }) => {
        const t = g.byKey(key);
        return t?.kind === "turn" && t.run === runId && t.attempt === attempt ? [t] : [];
      })
      .sort((a, b) => a.n - b.n);
  }

  /** The fence of `03` E1: the run record, while `request` is its attempt
   * and its thread and ask stand. */
  #fenced(g: Reader, request: RunRequest): Fence | null {
    const run = g.byKey(`run:${request.runId}`);
    if (run?.kind !== "run" || run.attempt !== request.attempt) return null;
    const alive = this.#alive(g, run);
    return alive ? { run, ...alive } : null;
  }

  /** A fenced write: `fn` runs only while the attempt is current. */
  #write(request: RunRequest, fn: (tx: Tx, f: Fence) => void) {
    this.#apply((tx) => {
      const f = this.#fenced(tx, request);
      if (f) fn(tx, f);
    });
  }

  /** The root thread's `running` follows its run (`thread.running`). */
  #rootRunning(tx: Tx, run: RunRec, running: boolean) {
    if (run.node !== "r") return;
    const th = tx.byKey(threadKey(run.th));
    if (th?.kind === "thread" && th.mod !== "removed" && th.running !== running)
      tx.put({ ...th, running });
  }

  #committed(keys: ReadonlySet<string>) {
    const watchers = this.#watchers;
    if (!watchers) return;
    let queued = false;
    for (const key of keys) {
      if (!key.startsWith("run:")) continue;
      const r = this.#store.byKey(key);
      if (r?.kind === "run" && r.status === "queued") queued = true;
      // `01` D4: no streamed text outlives its run record, or the attempt it
      // belongs to; a run stopped while queued (a Stop during a 429 backoff)
      // has no attempt running here to drop its checkpoint
      const runId = key.slice("run:".length);
      if (r?.kind !== "run") {
        this.#live.delete(runId);
        this.#tables.dropLive(runId);
      } else {
        this.#tables.dropOtherAttempts(runId, r.attempt);
        if (r.status === "cancelled") this.#tables.dropLive(runId, r.attempt);
      }
    }
    for (const [runId, request] of this.#attempts) {
      const run = this.#store.byKey(`run:${runId}`);
      const current = this.isCurrent(request);
      if (!current || run?.kind !== "run" || run.status !== "running") {
        this.#attempts.delete(runId);
        // a superseded attempt writes nothing more, so its checkpoint goes
        // now: no text of a removed ask stays behind (`01` D4)
        if (!current) this.#dropLive(request);
        watchers.stopped(runId);
      }
    }
    if (queued) watchers.queued();
  }

  #dropLive(request: RunRequest) {
    if (this.#live.get(request.runId)?.attempt === request.attempt)
      this.#live.delete(request.runId);
    this.#tables.dropLive(request.runId, request.attempt);
  }

  /** May `u` read the text of `runId`'s turns now: the run's space, and for
   * a hidden ask its author and the space's owner (`redact`). */
  #mayRead(runId: string, u: string | null): boolean {
    const run = this.#store.byKey(`run:${runId}`);
    if (run?.kind !== "run") return false;
    const probe: StoredRecord = {
      kind: "turn",
      run: run.id,
      attempt: run.attempt,
      n: 0,
      th: run.th,
      s: run.s,
      role: "assistant",
      blocks: [{ type: "text" }],
      createdAt: run.createdAt,
      rev: 1,
    };
    const seen = view(this.#store, probe, u);
    return seen?.kind === "turn" && seen.blocks.length > 0;
  }

  // ── the loop ───────────────────────────────────────────────────────────

  isCurrent(request: RunRequest): boolean {
    return this.#fenced(this.#store, request) !== null;
  }

  isCancelled(request: RunRequest): boolean {
    const run = this.#store.byKey(`run:${request.runId}`);
    return run?.kind === "run" && run.attempt === request.attempt && run.status === "cancelled";
  }

  committedTurns(request: RunRequest): Turn[] {
    const run = this.#store.byKey(`run:${request.runId}`);
    if (run?.kind !== "run") return [];
    return this.#turns(this.#store, run, request.attempt).flatMap(turnsOf);
  }

  /** The claim already wrote `running` and `startedAt` (E2). */
  markRunning(): void {}

  step(request: RunRequest, step: RunStep): void {
    this.#write(request, (tx, { run }) => {
      if (step > run.step) tx.put({ ...run, step });
    });
  }

  commitTurn(request: RunRequest, turn: Turn): void {
    let committed = false;
    this.#write(request, (tx, { run }) => {
      const stored = this.#turns(tx, run, run.attempt);
      const role = roleOf(turn);
      // the results of a step's tool calls join the step's record, so a
      // step is one turn record and one change-log row (`03` T4)
      const last = stored.at(-1);
      if (role === "tool" && last?.role === "assistant" && answers(last, turn)) {
        tx.put({
          ...last,
          blocks: [...last.blocks, ...(turn.blocks as unknown as { type: string }[])],
        });
        return;
      }
      const n = stored.length;
      tx.create({
        kind: "turn",
        run: run.id,
        attempt: run.attempt,
        n,
        th: run.th,
        s: run.s,
        role,
        blocks: turn.blocks as unknown as { type: string }[],
        createdAt: tx.now,
      });
      committed = true;
    });
    // a new record: the next text belongs to the next one
    const live = this.#live.get(request.runId);
    if (!committed || live?.attempt !== request.attempt) return;
    live.n += 1;
    live.text = "";
    live.turnId = "";
    this.#tables.putLive({
      runId: request.runId,
      attempt: request.attempt,
      turnId: "",
      n: live.n,
      md: "",
      seq: live.seq,
      updatedAt: Date.now(),
    });
  }

  checkpoint(request: RunRequest): void {
    const live = this.#live.get(request.runId);
    if (live?.attempt !== request.attempt || !this.isCurrent(request)) return;
    this.#tables.putLive({
      runId: request.runId,
      attempt: request.attempt,
      turnId: live.turnId,
      n: live.n,
      md: live.text,
      seq: live.seq,
      updatedAt: Date.now(),
    });
  }

  delta(request: RunRequest, turnId: string, text: string): void {
    const live = this.#live.get(request.runId);
    if (live?.attempt !== request.attempt) return;
    live.seq += 1;
    live.turnId = turnId;
    live.text += text;
    const event: RunDelta = {
      type: "run.delta",
      run: request.runId,
      attempt: request.attempt,
      seq: live.seq,
      n: live.n,
      text,
    };
    this.#sync.hub.ephemeral(`space:${live.s}`, RUN_DELTA_EVENT, event, (u) =>
      this.#mayRead(request.runId, u),
    );
  }

  thinking(): void {}

  writeTitle(request: RunRequest, title: string): void {
    this.#write(request, (tx, { th }) => {
      if (th.t === null) tx.put({ ...th, t: title });
    });
  }

  writeSummary(request: RunRequest, summary: string): void {
    this.#write(request, (tx, { th }) => {
      tx.put({ ...th, sum: summary });
    });
  }

  finish(request: RunRequest, summary: AttemptSummary, answer?: CompletedAnswer): void {
    this.#attempts.delete(request.runId);
    this.#places.delete(request.runId);
    const interrupted = summary.outcome === "interrupted";
    const failed: { fail: RunRec["fail"] }[] = [];
    this.#write(request, (tx, { run, th, ask }) => {
      const now = tx.now;
      // a cancel the person made keeps its own record of it (`stopped`)
      const cancelled = run.status === "cancelled";
      const fail = cancelled ? run.fail : failOf(summary.fail);
      const complete = summary.outcome === "complete" && answer !== undefined;
      const stored = complete ? answerOf(answer.turns) : null;
      // the ledger's, when there is one: the loop's summary knows only the
      // calls of this claim, and the dispatcher's and a thrown write's none
      const spent: { tok?: number; bill?: BillLabel | null } = this.#spent(run);
      const tok = spent.tok ?? summary.tok;
      const bill = spent.bill === undefined ? summary.bill : spent.bill;
      tx.put({
        ...run,
        status: cancelled ? "cancelled" : summary.outcome,
        fail,
        tok,
        bill,
        note: summary.note ?? null,
        step: complete ? 3 : run.step,
        finishedAt: cancelled ? (run.finishedAt ?? now) : now,
      });
      if (stored) {
        tx.put({
          kind: "answer",
          node: run.node,
          th: run.th,
          s: run.s,
          u: run.u,
          md: stored.md,
          pages: stored.pages,
          tok,
          run: run.id,
          attempt: run.attempt,
          mod: ask.mod,
        });
      }
      if (run.node === "r") {
        tx.put({
          ...th,
          running: false,
          ...(stored ? { tok, src: stored.pages.length } : {}),
        });
      }
      if (!cancelled && summary.outcome === "failed") failed.push({ fail });
    });
    for (const { fail } of failed) if (fail) this.#onFailure?.(fail.cls ?? fail.why);
    if (!interrupted) this.#dropLive(request);
  }

  /** The fence stopped the attempt (`03` E1). Where the run record still
   * holds this attempt (the asker was banned from the space, or the ask was
   * deleted while someone else had written under it), the record gets the
   * attempt's `tok` and `bill`, and a run still `running` ends
   * `failed { why: "access" }`, so no run stays `running` without a runner. */
  superseded(request: RunRequest): void {
    this.#attempts.delete(request.runId);
    this.#places.delete(request.runId);
    this.#apply((tx) => {
      const run = tx.byKey(`run:${request.runId}`);
      if (run?.kind !== "run" || run.attempt !== request.attempt) return;
      const running = run.status === "running";
      tx.put({
        ...run,
        ...this.#spent(run),
        ...(running
          ? {
              status: "failed" as const,
              fail: { why: "access" as const, at: null, cls: null },
              finishedAt: tx.now,
            }
          : {}),
      });
      if (running) this.#rootRunning(tx, run, false);
    });
  }

  // ── the dispatcher ─────────────────────────────────────────────────────

  /** The admission place of a queued run (`03` E2): the version of the
   * commit that queued its attempt. A run Run again queued is placed by that
   * write, after the runs queued before it; a 429 re-queue keeps the place
   * the claim recorded. */
  #place(run: RunRec): number {
    const kept = this.#places.get(run.id);
    if (kept?.attempt === run.attempt) return kept.v;
    return this.#store.logRow(`space:${run.s}`, `run:${run.id}`)?.version ?? 0;
  }

  #runsWith(status: RunRec["status"]): RunRec[] {
    return this.#store.sqlite
      .prepare<[string], { key: string }>(
        `SELECT key FROM records WHERE kind = 'run' AND json_extract(body, '$.status') = ?
         ORDER BY created_v, key`,
      )
      .all(status)
      .flatMap(({ key }) => {
        const r = this.#store.byKey(key);
        return r?.kind === "run" ? [r] : [];
      });
  }

  queued(): QueuedRun[] {
    return this.#runsWith("queued")
      .map((run) => ({
        runId: run.id,
        attempt: run.attempt,
        userId: this.#accountOf(run.u) ?? "",
        model: run.model,
        effort: run.effort,
        payer: queuedPayer(run),
        queuedAt: this.#place(run),
        // Run again writes `startedAt: null`; a 429 re-queue and a resume
        // keep the first claim's
        ran: run.startedAt !== null,
      }))
      .sort((a, b) => a.queuedAt - b.queuedAt);
  }

  claim(queued: QueuedRun): RunRequest | null {
    const userId = this.#accountOf(
      (this.#store.byKey(`run:${queued.runId}`) as RunRec | undefined)?.u ?? "",
    );
    let refused = false;
    const claimed = this.#apply((tx) => {
      const run = tx.byKey(`run:${queued.runId}`);
      if (run?.kind !== "run" || run.status !== "queued" || run.attempt !== queued.attempt)
        return null;
      const alive = this.#alive(tx, run);
      const context = alive ? runContext(tx, run) : null;
      // `03` G7, G8: an asker who can no longer read the thread or a record
      // on its path, or who is banned from the space, gets no model call
      if (!alive || !context || userId === null || !canRead(tx, alive.th, run.u)) {
        tx.put({
          ...run,
          ...this.#spent(run),
          status: "failed",
          fail: { why: "access", at: null, cls: null },
          finishedAt: tx.now,
        });
        this.#rootRunning(tx, run, false);
        refused = true;
        return null;
      }
      const place = this.#place(run);
      const startedAt = run.startedAt ?? tx.now;
      tx.put({
        ...run,
        // the payer of the dispatcher's re-check (`03` K10)
        pay: queued.payer,
        status: "running",
        fail: null,
        startedAt,
        finishedAt: null,
      });
      const committed = this.#turns(tx, run, run.attempt).length;
      return { run, context, committed, place, startedAt };
    });
    // the attempt ended at its claim: its checkpoint goes (`01` D4)
    if (refused) this.#tables.dropLive(queued.runId, queued.attempt);
    if (claimed === null || userId === null) return null;
    const { run, context, committed, place, startedAt } = claimed;
    this.#places.set(run.id, { attempt: run.attempt, v: place });
    const request: RunRequest = {
      runId: run.id,
      userId,
      model: run.model,
      effort: run.effort,
      attempt: run.attempt,
      kind: committed > 0 ? "resume" : "fresh",
      node: context.node,
      payer: queued.payer,
      instruction: this.#instructionOf(userId),
      userText: context.userText,
      history: context.history,
      // the first claim's own time, not the stored one, which is to the second
      startedAt: run.startedAt === null ? Date.now() : Date.parse(startedAt),
      ...(context.finalSteps ? { finalSteps: context.finalSteps } : {}),
    };
    this.#attempts.set(run.id, request);
    // The attempt's delta sequence (`03` T3). A claim of an attempt claimed
    // before (a resume in a new process, or a 429 re-queue in this one)
    // jumps past any delta sent before it, so a client holding text of the
    // earlier claim sees a gap and reads `/live`, which answers the empty
    // turn the attempt continues with.
    const held = this.#live.get(run.id);
    const mem = held?.attempt === run.attempt ? held : null;
    const stored = this.#tables.live(run.id, run.attempt);
    const resumed =
      mem !== null || stored !== null || this.#tables.resumes(run.id, run.attempt) > 0;
    const seq = Math.max(mem?.seq ?? 0, stored?.seq ?? 0) + (resumed ? RESUME_SEQ_GAP : 0);
    this.#live.set(run.id, {
      attempt: run.attempt,
      th: run.th,
      s: run.s,
      n: committed,
      turnId: "",
      text: "",
      seq,
    });
    if (resumed)
      this.#tables.putLive({
        runId: run.id,
        attempt: run.attempt,
        turnId: "",
        n: committed,
        md: "",
        seq,
        updatedAt: Date.now(),
      });
    return request;
  }

  settleQueued(queued: QueuedRun, summary: AttemptSummary): boolean {
    const settled = this.#apply((tx) => {
      const run = tx.byKey(`run:${queued.runId}`);
      if (run?.kind !== "run" || run.status !== "queued" || run.attempt !== queued.attempt)
        return false;
      tx.put({
        ...run,
        ...this.#spent(run),
        status: summary.outcome,
        fail: failOf(summary.fail),
        tok: summary.tok,
        note: summary.note ?? null,
        finishedAt: tx.now,
      });
      this.#rootRunning(tx, run, false);
      return true;
    });
    // the attempt ended before it was claimed again: its checkpoint goes
    if (settled) this.#tables.dropLive(queued.runId, queued.attempt);
    this.#places.delete(queued.runId);
    if (settled && summary.outcome === "failed" && summary.fail)
      this.#onFailure?.(failOf(summary.fail)?.cls ?? summary.fail.why);
    return settled;
  }

  requeue(request: RunRequest): boolean {
    this.#attempts.delete(request.runId);
    return this.#apply((tx) => {
      const f = this.#fenced(tx, request);
      if (!f || f.run.status !== "running") return false;
      tx.put({ ...f.run, ...this.#spent(f.run), status: "queued" });
      return true;
    });
  }

  interruptRunning(): number {
    const running = this.#runsWith("running");
    if (!running.length) return 0;
    return this.#apply((tx) => {
      let n = 0;
      for (const r of running) {
        const run = tx.byKey(`run:${r.id}`);
        if (run?.kind !== "run" || run.status !== "running") continue;
        tx.put({
          ...run,
          ...this.#spent(run),
          status: "interrupted",
          fail: { why: "interrupted", at: null, cls: null },
          finishedAt: tx.now,
        });
        this.#rootRunning(tx, run, false);
        n += 1;
      }
      return n;
    });
  }

  interrupted(): InterruptedRun[] {
    return this.#runsWith("interrupted").map((run) => ({
      runId: run.id,
      attempt: run.attempt,
      userId: this.#accountOf(run.u) ?? "",
      resumes: this.#tables.resumes(run.id, run.attempt),
    }));
  }

  resume(interrupted: InterruptedRun): boolean {
    return this.#apply((tx) => {
      const run = tx.byKey(`run:${interrupted.runId}`);
      if (
        run?.kind !== "run" ||
        run.status !== "interrupted" ||
        run.attempt !== interrupted.attempt ||
        this.#tables.resumes(run.id, run.attempt) !== interrupted.resumes
      )
        return false;
      tx.put({ ...run, status: "queued", fail: null, finishedAt: null });
      this.#rootRunning(tx, run, true);
      // in the record write's transaction: a crash cannot leave the resume
      // written and not counted (`03` E2: at most two)
      this.#tables.setResumes(interrupted.runId, interrupted.attempt, interrupted.resumes + 1);
      return true;
    });
  }

  /** Boot (`01` D4): deletes every checkpoint whose run is gone, whose
   * attempt is not the run's current one, or whose run ended, and returns
   * how many it deleted. */
  sweepLive(): number {
    let n = 0;
    for (const { runId, attempt } of this.#tables.liveAttempts()) {
      const run = this.#store.byKey(`run:${runId}`);
      if (
        run?.kind === "run" &&
        run.attempt === attempt &&
        (run.status === "queued" || run.status === "running" || run.status === "interrupted")
      )
        continue;
      this.#tables.dropLive(runId, attempt);
      n += 1;
    }
    return n;
  }

  // ── reads ──────────────────────────────────────────────────────────────

  /** `GET /api/runs/:id/live` (`03` T3): the current attempt's committed
   * turns' versions and the turn still streaming, for a reader who may read
   * the run's text; null otherwise (NOT_FOUND, as for a run that does not
   * exist). A plain read: it opens no transaction. Nothing streams while the
   * run is queued, so `live` is null then. */
  live(runId: string, u: string | null): RunLive | null {
    const run = this.#store.byKey(`run:${runId}`);
    if (run?.kind !== "run" || !this.#mayRead(runId, u)) return null;
    const turns = this.#turns(this.#store, run, run.attempt).map((t) => ({
      key: turnKey(t.run, t.attempt, t.n),
      rev: t.rev,
    }));
    const mem = this.#live.get(runId);
    let live: RunLive["live"] = null;
    if (mem?.attempt === run.attempt && run.status === "running")
      live = { n: mem.n, text: mem.text, seq: mem.seq };
    else if (run.status === "running") {
      const stored = this.#tables.live(runId, run.attempt);
      if (stored) live = { n: stored.n, text: stored.md, seq: stored.seq };
    }
    return { run: run.id, attempt: run.attempt, turns, live };
  }
}
