// The phase 0 suite's `ServerFactory` over `@session/sync`'s server half
// (phase 1b), with its memory or its SQLite store. The suite runs against it
// with REPLICA_PROTO_SERVER=sync-memory or sync-sqlite, always with the
// package's mutators (`npm run test:sync`, `npm run test:sync-sqlite`).
//
// Where the production shape differs from the prototype's contract, this
// adapter maps it, and nothing else:
// - Envelopes: the production protocol is version 4 and its envelope adds
//   `queuedAt` and `replaces`. The suite's version-3 envelopes are sent as
//   version 4 (an old version stays old: 2 becomes 3, below the minimum),
//   with `queuedAt` the envelope's `clientTime` and `replaces` [] when the
//   envelope has neither (a hand-made envelope with other fields keeps them,
//   and is refused for them).
// - Answers carry `serverTime`, `seq` and `replayed`; the suite's
//   `ApplyResult` has `serverTime` on CLOCK_SKEW's error only. STALE's
//   `current` and `changes`, and a limit's `retryAt`, are left out of the
//   error (the prototype has no such fields).
// - Reads: the prototype's tiers are `full` (its default) and `summary`.
// - Storage: the production tables, named as `StorageScan` names them.
// - Online calls and the SSE stream (`online`, review round 1 of phase 1):
//   the server's own `call` and `openStream`; answers keep code, message
//   and issues; the stream's events are parsed from its bytes.
// - A read the server does not serve (`ReadError`: a user log read signed
//   out): the prototype's empty projection, an empty snapshot whose cursor
//   gives empty pulls; any other token resyncs.

import type * as pkg from "@session/mutators";
import {
  MemoryServerStore,
  SqliteServerStore,
  SyncServer,
  newCursorKey,
  isReadError,
  openStream,
  type Answer,
  type PullAnswer,
  type SnapshotAnswer,
  type ServerStore,
} from "@session/sync/server";
import BetterSqlite from "better-sqlite3";

import type {
  Actor,
  ApplyResult,
  ApiError,
  ReadOptions,
  ServerFactory,
  ServerOptions,
  StorageScan,
  StoredRecord,
  StreamEvent,
  TestServer,
} from "../src/index.js";
import { ACTIVE_MUTATORS, packageRegistry } from "../src/switch.js";

/** The production protocol's version for one of the prototype's. */
const PROTOCOL_STEP = 1;

/** The cursor of a snapshot the server answered with a `ReadError`: a pull
 * of that log with it is an empty pull, and one with any other token
 * resyncs. */
const noLog = (log: string) => `no-log:${log}`;

function toProduction(e: unknown): unknown {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return e;
  const x = { ...(e as Record<string, unknown>) };
  if (typeof x["protocolVersion"] === "number" && Number.isInteger(x["protocolVersion"]))
    x["protocolVersion"] = x["protocolVersion"] + PROTOCOL_STEP;
  if (!("queuedAt" in x) && typeof x["clientTime"] === "number") x["queuedAt"] = x["clientTime"];
  if (!("replaces" in x)) x["replaces"] = [];
  return x;
}

/** An envelope's input getter may throw (a hostile client): keep it a
 * getter on the copy, so the server meets it as the prototype did. */
function copyEnvelope(e: unknown): unknown {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return e;
  const ds = Object.getOwnPropertyDescriptors(e);
  const input = ds["input"];
  if (input?.get) {
    delete ds["input"];
    const out = toProduction(Object.defineProperties({}, ds)) as Record<string, unknown>;
    Object.defineProperty(out, "input", { ...input, enumerable: true });
    return out;
  }
  return toProduction(e);
}

function toProto(a: Answer): ApplyResult {
  if (a.ok) return { ok: true, result: a.result };
  const e: ApiError = { code: a.error.code, message: a.error.message };
  if (a.error.issues) e.issues = [...a.error.issues];
  if (a.error.code === "CLOCK_SKEW") e.serverTime = a.serverTime;
  if (a.error.expectedSeq !== undefined) e.expectedSeq = a.error.expectedSeq;
  return { ok: false, error: e };
}

const readOptions = (o: ReadOptions = {}) => ({
  ...(o.clientId !== undefined ? { clientId: o.clientId } : {}),
  tier: { window: o.tier === "summary" ? ("summary" as const) : ("full" as const) },
});

export function syncFactory(kind: "memory" | "sqlite"): ServerFactory {
  return (o: ServerOptions): TestServer => {
    const store: ServerStore =
      kind === "memory"
        ? new MemoryServerStore()
        : new SqliteServerStore(new BetterSqlite(":memory:"));
    const jobs: { kind: string; id: string }[] = [];
    const server = new SyncServer({
      store,
      clock: o.clock,
      cursorKeys: { current: newCursorKey() },
      ...(o.random ? { random: o.random } : {}),
      registry: packageRegistry(o.mutators ?? ACTIVE_MUTATORS),
      jobs: { start: (j) => void jobs.push({ kind: j.kind, id: j.id }) },
      ...(o.failEffect
        ? {
            failEffect: (e: pkg.Effect, n: number) =>
              (o.failEffect as NonNullable<typeof o.failEffect>)(e as never, n),
          }
        : {}),
    });
    const actorOf = (a: Actor | null) => (a === null ? null : { u: a.u });
    return {
      register(a) {
        const r = server.register(actorOf(a));
        return r.ok ? { ok: true, clientId: r.clientId } : { ok: false, error: { ...r.error } };
      },
      apply: (a, e) => toProto(server.apply(actorOf(a), copyEnvelope(e))),
      snapshot(a, log, opts) {
        const s: SnapshotAnswer = server.snapshot(actorOf(a), log, readOptions(opts));
        // a read the server does not serve (a user log signed out): the
        // prototype's empty projection
        if (isReadError(s)) return { records: [], cursor: noLog(log), lastSeq: null };
        return { records: s.records as never, cursor: s.cursor, lastSeq: s.lastSeq };
      },
      pull(a, log, cursor, opts) {
        const p: PullAnswer = server.pull(actorOf(a), log, cursor, readOptions(opts));
        if (isReadError(p))
          return cursor === noLog(log) ? { changes: [], cursor, lastSeq: null } : { resync: true };
        if ("resync" in p) return { resync: true };
        return { changes: p.changes as never, cursor: p.cursor, lastSeq: p.lastSeq };
      },
      dump: () => server.records() as unknown as ReadonlyMap<string, StoredRecord>,
      logRows: (log) => server.logRows(log),
      jobs: () => jobs,
      work: () => server.work(),
      finishJob: (key, text) => server.finishJob(key, text),
      online: {
        call(a, name, input) {
          const actor = a === null ? null : { u: a.u, ...(a.device ? { device: a.device } : {}) };
          const r = server.call(actor, name, input);
          if (r.ok) return { ok: true, result: r.result };
          const e: ApiError = { code: r.error.code, message: r.error.message };
          if (r.error.issues) e.issues = [...r.error.issues];
          return { ok: false, error: e };
        },
        stream(a, cursors) {
          const ac = new AbortController();
          const s = openStream(server, actorOf(a), cursors, ac.signal, {
            setInterval: () => 0,
            clearInterval: () => {},
          });
          const reader = s.getReader();
          const dec = new TextDecoder();
          let text = "";
          const pump = (async () => {
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              text += dec.decode(r.value);
            }
          })();
          const settle = () => new Promise((r) => setTimeout(r, 0));
          const parse = (): StreamEvent[] =>
            [...text.matchAll(/event: (poke|run)\n(?:id: .*\n)?data: (.*)\n\n/g)].map(
              (m) => JSON.parse(m[2] ?? "{}") as StreamEvent,
            );
          return {
            events: async () => {
              await settle();
              return parse();
            },
            close: async () => {
              ac.abort();
              await pump;
            },
          };
        },
        tick() {
          let f = () => {};
          const stop = server.startHousekeeping({
            setInterval: (g) => (f = g),
            clearInterval: () => {},
          });
          f();
          stop();
        },
      },
      scanStorage(): StorageScan {
        server.housekeepAll();
        const d = store.dump();
        const regs = new Map<string, number[]>();
        for (const r of d.registrations) regs.set(r.u, [...(regs.get(r.u) ?? []), r.at]);
        const clientOf = new Map(d.clients.map((c) => [c.clientId, c.u]));
        return {
          records: d.records.map((r) => r.record) as unknown as StoredRecord[],
          // every stored field but a notification's `type` (the prototype's
          // audience has none), so a tombstone that keeps more is visible
          tombstones: d.tombstones.map((t) => {
            const out: Partial<typeof t> = { ...t };
            delete out.type;
            return out as StorageScan["tombstones"][number];
          }),
          logRows: d.logRows as StorageScan["logRows"],
          answers: d.answers.map((a) => ({
            u: a.u ?? clientOf.get(a.clientId ?? "") ?? "",
            ...(a.mutationId !== undefined ? { mutationId: a.mutationId } : {}),
            ...(a.clientId !== undefined ? { clientId: a.clientId } : {}),
            ...(a.seq !== undefined ? { seq: a.seq } : {}),
            digest: a.digest,
            result: (a.answer.ok
              ? { ok: true, result: a.answer.result }
              : { ok: false, error: a.answer.error, reads: a.answer.reads }) as ApplyResult,
            at: a.at,
          })),
          clients: d.clients.map((c) => ({
            clientId: c.clientId,
            u: c.u,
            last: c.last,
            seen: c.seen,
          })),
          registrations: [...regs].map(([u, at]) => ({ u, at })),
          registry: d.registry,
          born: d.records.map((r) => ({ key: r.key, version: r.born })),
          epochs: d.epochs as StorageScan["epochs"],
          effects: d.effects.map((q) => ({
            effect: q.effect,
            at: q.at,
            attempts: q.attempts,
            next: q.next,
          })),
          deadLetters: d.deadLetters.map((q) => ({
            effect: q.effect,
            at: q.at,
            attempts: q.attempts,
            failedAt: q.failedAt,
          })),
          jobs: [...jobs],
        };
      },
    };
  };
}
