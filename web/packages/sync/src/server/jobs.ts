// Server jobs of runs (phase 2a): the calls the server's job runner (the
// owned agent loop, "included tokens") makes on a run the effect worker
// started. A device run is driven by its device's `runs.*` calls instead
// (`online.ts`); both write the same records, so the durable state of a run
// is the same whoever ran it (ADR-22):
// - `start` takes a queued run (or a running one, after a restart: a resume)
//   and answers what the agent needs: the question, the exchanges before it
//   on its branch and the ask's skill, read as the run's person reads them,
//   and the turns the run stored already. A run whose person may no longer
//   write in its space ends (`access`), one in an archived space ends
//   (`interrupted`), and one that ended or was cancelled answers `done`.
// - `turn` stores one committed turn (`turn` record); `delta` sends in-flight
//   text to the readers of the run's node (an SSE `run` event, not stored);
//   `finish` writes the answer to the ask's current attempt and ends the run
//   `complete`; `fail` ends it without an answer.
// Each checks that the run is still running at the attempt the job holds:
// a later run of the same ask cancels this one (`cancelled`), and a
// cancelled or ended run takes no more writes. Each also checks, as a
// write in the run's space is checked, that the run's person may still
// write there and that the space is not archived: a run whose person lost
// that ends (`access`), one in an archived space ends (`interrupted`), and
// the call is refused (review round 1 of phase 2, F3). An answer to a
// hidden item counts as an edit of it (`answerWrites`).

import * as pkg from "@session/mutators";
import { isTurn, type Turn } from "@session/shared";

import { answerWrites } from "./limits.js";
import { storeTurn, writesIn, type CallCtx } from "./online.js";
import type { SyncServer } from "./server.js";
import type { StoreTx } from "./store.js";

/** One exchange of a branch: an ask and its answer, as a reader reads them,
 * and the turns of the run that wrote that answer (its tool calls and
 * results; a device's turns may be text), oldest first. */
export interface Exchange {
  q: string;
  a: string;
  turns: unknown[];
}

/** What a job needs to answer a run. */
export interface JobStart {
  run: pkg.RunRec;
  /** The question the run answers (the thread's ask or the follow-up). */
  q: string;
  /** The exchanges before it on its branch, oldest first: the thread's ask
   * and answer, then each follow-up up the `par` chain, an item redacted for
   * the run's person left out. */
  history: Exchange[];
  /** The skill the thread's ask names, as the run's person reads it. */
  skill: { name: string; prompt: string } | null;
  /** The turns this run stored already, by number (a resumed run). */
  turns: unknown[];
  /** True when the run was running already (the server stopped during it). */
  resumed: boolean;
}

export type JobStartAnswer =
  { ok: true; job: JobStart } | { ok: false; why: "gone" | "done" | "access" | "archived" };

/** The turns run `id` stored, by number. */
const turnsOfRun = (tx: StoreTx, id: string): unknown[] =>
  tx
    .scan("turn", "run", id)
    .flatMap((x) => (x.kind === "turn" ? [x] : []))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.body);

const readerOf = (tx: StoreTx): pkg.Reader => ({
  get: <K extends pkg.Kind>(kind: K, id: string) =>
    tx.get(pkg.keyFor(kind, id)) as pkg.RecordOf<K> | undefined,
});

const unredacted = (g: pkg.Reader, x: pkg.StoredRecord, u: string) =>
  pkg.canRead(g, x, u) && pkg.redact(g, x, u) === x;

export class RunJobs {
  constructor(private readonly server: SyncServer) {}

  private ctx(tx: StoreTx, now: number): CallCtx {
    return { tx, now, actor: null, server: this.server };
  }

  /** The run `id` when a server job runs it, it is running at `attempt`,
   * its person may still write in its space and the space is not archived.
   * A run that fails the last two checks is ended here (`access`,
   * `interrupted`), in the transaction of the call. */
  private held(tx: StoreTx, now: number, id: string, attempt: number): pkg.RunRec | null {
    const r = tx.get(`run:${id}`);
    if (
      r?.kind !== "run" ||
      r.executor !== null ||
      r.status !== "running" ||
      r.attempt !== attempt
    )
      return null;
    const g = readerOf(tx);
    if (!pkg.canRead(g, r, r.u) || !writesIn(g, r.s, r.u)) {
      this.end(tx, now, r, "access");
      return null;
    }
    if (pkg.spaceRec(g, r.s)?.archived) {
      this.end(tx, now, r, "interrupted");
      return null;
    }
    return r;
  }

  /** End run `r` without an answer: the thread stops running when the run
   * is its ask's current attempt, and keeps `tok`, the tokens the run used,
   * when given. */
  private end(tx: StoreTx, now: number, r: pkg.RunRec, why: pkg.RunEnd, tok?: number) {
    const writes: pkg.Write[] = [[`run:${r.id}`, { ...r, status: "failed", end: why }]];
    const p = tx.get(`thread:${r.th}`);
    if (r.node === "r" && p?.kind === "thread" && p.att === r.attempt && p.running)
      writes.push([
        `thread:${p.id}`,
        { ...p, running: false, ...(tok !== undefined && p.mod === null ? { tok } : {}) },
      ]);
    this.server.commit(tx, writes, now);
  }

  /** Take run `id`: queued, it starts running; running already, the job
   * resumes it. `pay` is the payer the job chose (`session` or a key id),
   * written on the run. */
  start(id: string, pay: string | null = null): JobStartAnswer {
    return this.server.run((tx): JobStartAnswer => {
      const now = this.server.time(tx);
      const r = tx.get(`run:${id}`);
      if (r?.kind !== "run" || r.executor !== null) return { ok: false, why: "gone" };
      if (r.status !== "queued" && r.status !== "running") return { ok: false, why: "done" };
      const g = readerOf(tx);
      if (!pkg.canRead(g, r, r.u) || !writesIn(g, r.s, r.u)) {
        this.end(tx, now, r, "access");
        return { ok: false, why: "access" };
      }
      if (pkg.spaceRec(g, r.s)?.archived) {
        this.end(tx, now, r, "interrupted");
        return { ok: false, why: "archived" };
      }
      const p = tx.get(`thread:${r.th}`);
      const n = r.node === "r" ? p : tx.get(`followup:${r.node}`);
      if (p?.kind !== "thread" || (n?.kind !== "thread" && n?.kind !== "followup")) {
        this.end(tx, now, r, "interrupted");
        return { ok: false, why: "gone" };
      }
      const resumed = r.status === "running";
      const run: pkg.RunRec = { ...r, status: "running", ...(pay !== null ? { pay } : {}) };
      this.server.commit(tx, [[`run:${r.id}`, run]], now);
      const shown = (x: pkg.ThreadRec | pkg.FollowUpRec) => unredacted(g, x, r.u);
      // the branch from the thread's ask down to the node's parent
      const chain: pkg.FollowUpRec[] = [];
      for (let par = n.kind === "followup" ? n.par : null, k = 0; par !== null && k < 1000; k++) {
        const f = tx.get(`followup:${par}`);
        if (f?.kind !== "followup") break;
        chain.unshift(f);
        par = f.par;
      }
      // the turns of the run that answered an item: the run of its current
      // attempt that completed
      const runTurns = (node: string, att: number) => {
        const done = tx
          .scan("run", "th", p.id)
          .find(
            (x) =>
              x.kind === "run" && x.node === node && x.attempt === att && x.status === "complete",
          );
        return done?.kind === "run" ? turnsOfRun(tx, done.id) : [];
      };
      const history: Exchange[] = [];
      if (n.kind === "followup" && shown(p) && p.mod === null)
        history.push({ q: p.q, a: p.sum ?? "", turns: runTurns("r", p.att) });
      for (const f of chain)
        if (f.mod === null && !f.del && shown(f))
          history.push({ q: f.q, a: f.a ?? "", turns: runTurns(f.id, f.att) });
      const sk = p.skill !== null ? tx.get(`skill:${p.skill}`) : undefined;
      const skill =
        sk?.kind === "skill" && pkg.canRead(g, sk, r.u)
          ? { name: sk.name, prompt: sk.prompt }
          : null;
      const turns = turnsOfRun(tx, r.id);
      return { ok: true, job: { run, q: n.q, history, skill, turns, resumed } };
    });
  }

  /** Whether the job still holds run `id` at `attempt`. */
  holds(id: string, attempt: number): boolean {
    return this.server.run((tx) => this.held(tx, this.server.time(tx), id, attempt) !== null);
  }

  /** Send in-flight text of run `id` to the readers of its node (ADR-22):
   * not stored; `seq` numbers the attempt's events. False when the job no
   * longer holds the run. */
  delta(id: string, attempt: number, seq: number, text: string): boolean {
    return this.server.run((tx) => {
      const r = this.held(tx, this.server.time(tx), id, attempt);
      if (!r) return false;
      this.server.emitRun({ type: "run", run: id, attempt, seq, text }, r);
      return true;
    });
  }

  /** Store one committed turn of run `id`: its number, or null when the job
   * no longer holds the run. `body` is a `Turn` (`@session/shared`'s
   * schema; phase 2a design finding 8): anything else is a fault of the
   * job's, and throws. */
  turn(id: string, attempt: number, body: Turn): number | null {
    if (!isTurn(body)) throw new Error("a server job's turn is not a Turn");
    return this.server.run((tx) => {
      const now = this.server.time(tx);
      const r = this.held(tx, now, id, attempt);
      return r ? storeTurn(this.ctx(tx, now), r, body) : null;
    });
  }

  /** Write the answer of run `id` and end it `complete`. The answer lands on
   * the ask's current attempt only, and not on a removed or deleted item;
   * `tok` is what it used. Answers whether the run was still held. */
  finish(id: string, attempt: number, answer: string, tok = 0): boolean {
    return this.server.run((tx) => {
      const now = this.server.time(tx);
      const r = this.held(tx, now, id, attempt);
      if (!r) return false;
      const writes: pkg.Write[] = [[`run:${r.id}`, { ...r, status: "complete", end: null }]];
      const n = tx.get(r.node === "r" ? `thread:${r.th}` : `followup:${r.node}`);
      if ((n?.kind === "thread" || n?.kind === "followup") && n.mod === null && !n.del) {
        if (n.att === r.attempt)
          writes.push(
            ...answerWrites(
              tx,
              n.kind === "thread"
                ? { ...n, sum: answer, running: false, tok }
                : { ...n, a: answer },
            ),
          );
      }
      this.server.commit(tx, writes, now);
      return true;
    });
  }

  /** End run `id` without an answer (`tokens`, `key`, `rate`, `stopped`,
   * `interrupted`): false when the job no longer holds it. `tok`: the
   * tokens the run used, which its thread keeps (a run its payer could no
   * longer pay for). */
  fail(id: string, attempt: number, why: pkg.RunEnd, tok?: number): boolean {
    return this.server.run((tx) => {
      const now = this.server.time(tx);
      const r = this.held(tx, now, id, attempt);
      if (!r) return false;
      this.end(tx, now, r, why, tok);
      return true;
    });
  }

  /** End run `id` `interrupted` whatever attempt it is at, when a server job
   * runs it and it is queued or running (boot recovery gave up on it). */
  interrupt(id: string): boolean {
    return this.server.run((tx) => {
      const now = this.server.time(tx);
      const r = tx.get(`run:${id}`);
      if (r?.kind !== "run" || r.executor !== null) return false;
      if (r.status !== "queued" && r.status !== "running") return false;
      this.end(tx, now, r, "interrupted");
      return true;
    });
  }

  /** The run `id` as stored (tests, the job runner's checks). */
  get(id: string): pkg.RunRec | null {
    return this.server.run((tx) => {
      const r = tx.get(`run:${id}`);
      return r?.kind === "run" ? r : null;
    });
  }
}
