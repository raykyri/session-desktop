// The suite's target on `@session/sync`: the server half of the build on its
// in-memory store, with the test access the suite needs (`TestServer`). The
// harness runs every test file against it (M2); `REPLICA_PROTO_SERVER=proto`
// runs them against the prototype server (`server.ts`), kept as the
// reference (decision E5).
//
// The prototype expires what is past its lifetime at every call, and the
// suite reads that through `scanStorage`; this target does the same
// (`expireEveryCall`). Its clients keep an outbox for days, so client ids
// live 90 days idle and 20 are registered a day, the prototype's figures;
// the web's 7 days and 50 (`01` Y3) are tested in `@session/sync`. The moderation log's 180-day retention is a
// replicated delete the hourly job makes (`retain`), not run here, so the
// effect model sees no deletes a write did not make.

import { DAY, type LogId, type RunRec, type StoredRecord } from "@session/mutators";
import type { RegisterOptions } from "@session/sync/client";
import { MemoryStore, SyncServer } from "@session/sync/server";

import type {
  Actor,
  ApplyResult,
  Cursor,
  Envelope,
  LogRow,
  Pull,
  ReadOptions,
  RegisterResult,
  ServerOptions,
  Snapshot,
  StorageScan,
  TestServer,
} from "./contract.js";
import { PROTO_MUTATORS } from "./join-requests.js";

export class SyncTestServer implements TestServer {
  readonly store = new MemoryStore();
  readonly server: SyncServer;

  constructor(options: ServerOptions) {
    this.server = new SyncServer({
      store: this.store,
      clock: options.clock,
      ...(options.random ? { random: options.random } : {}),
      mutators: options.mutators ?? PROTO_MUTATORS,
      ...(options.window ? { window: options.window } : {}),
      expireEveryCall: true,
      // the suite's clients keep an outbox for days: the prototype's figures
      clients: { idleTtl: 90 * DAY, perDay: 20 },
    });
  }

  register(actor: Actor | null, options?: RegisterOptions): RegisterResult {
    return this.server.register(actor, options);
  }

  apply(actor: Actor | null, envelope: Envelope): ApplyResult {
    return this.server.apply(actor, envelope);
  }

  snapshot(actor: Actor | null, log: LogId, options?: ReadOptions): Snapshot {
    return this.server.snapshot(actor, log, options);
  }

  pull(actor: Actor | null, log: LogId, cursor: Cursor, options?: ReadOptions): Pull {
    return this.server.pull(actor, log, cursor, options);
  }

  // ---- test access ----

  dump(): ReadonlyMap<string, StoredRecord> {
    return this.store.records;
  }

  logRows(log: LogId): LogRow[] {
    this.server.expire();
    return this.store.logRows(log, 0);
  }

  jobs() {
    const out: { kind: string; id: string }[] = [];
    for (const key of this.store.byKind.get("run") ?? []) {
      const r = this.store.byKey(key) as RunRec;
      if (r.status === "queued") out.push({ kind: "run", id: r.id });
    }
    return out;
  }

  replaceHistory(log: LogId): void {
    this.server.replaceHistory(log);
  }

  scanStorage(): StorageScan {
    this.server.expire();
    const s = this.store;
    const answers: StorageScan["answers"] = [];
    for (const a of s.answers.values())
      answers.push({
        u: a.u,
        mutationId: a.mutationId,
        digest: a.digest,
        result: a.result,
        at: a.at,
      });
    for (const a of s.seqAnswers.values())
      answers.push({
        u: s.clients.get(a.clientId)?.u ?? "",
        clientId: a.clientId,
        seq: a.seq,
        digest: a.digest,
        result: a.result,
        at: a.at,
      });
    return structuredClone({
      records: [...s.records.values()],
      tombstones: [...s.tombs.values()],
      logRows: [...s.logs].flatMap(([log, rows]) => [...rows.values()].map((r) => ({ log, ...r }))),
      answers,
      clients: [...s.clients.values()].map((c) => ({
        clientId: c.clientId,
        u: c.u,
        last: c.last,
        seen: c.seen,
      })),
      registrations: [...s.registrations].map(([u, at]) => ({ u, at })),
      registry: [...s.registry].map(([id, rev]) => ({ id, rev })),
      born: [...s.born].map(([key, b]) => ({ key, version: b.version })),
      epochs: [...s.epochs].map(([log, e]) => ({ log, ...e })),
    });
  }

  /** What a run writes when it finishes, through `serverApply` (`01` Y13). */
  finishJob(key: string, text: string): boolean {
    const r = this.store.byKey(key);
    if (!r || !("mod" in r) || r.mod === "removed") return false;
    // a run's writes make no ids: no mutation id from the random source
    const res = this.server.serverApply({ me: "", mutationId: "" }, (tx) => {
      const at = tx.now;
      /** The ask's run, `complete` if it had not ended. */
      const done = (th: string, node: string) => {
        const run = tx.list("run", { th }).find((x) => x.node === node);
        if (!run || (run.status !== "queued" && run.status !== "running")) return;
        tx.put({
          ...run,
          status: "complete",
          step: 3,
          startedAt: run.startedAt ?? at,
          finishedAt: at,
        });
      };
      if (r.kind === "thread" && !r.del) {
        tx.put({ ...r, sum: text, running: false });
        done(r.id, "r");
        return true;
      }
      if (r.kind === "node" && r.u !== null) {
        tx.put({
          kind: "answer",
          node: r.id,
          th: r.th,
          s: r.s,
          u: r.u,
          md: text,
          pages: [],
          tok: 0,
          run: r.run,
          attempt: 1,
          mod: r.mod,
        });
        done(r.th, r.id);
        return true;
      }
      return false;
    });
    return res.ok && res.result && res.version !== null;
  }

  freeze(space: string): boolean {
    const s = this.store.byKey(`space:${space}`);
    if (s?.kind !== "space") return false;
    return this.server.serverApply({ me: "", mutationId: "" }, (tx) =>
      tx.put({ ...s, frozen: true }),
    ).ok;
  }
}

export const createSyncTestServer = (options: ServerOptions): TestServer =>
  new SyncTestServer(options);
