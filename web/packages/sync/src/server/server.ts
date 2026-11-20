// The server half: `register`, `apply` (in order per client, idempotent by
// user and mutation id), `snapshot` and `pull` filtered by the reader's
// scope at the time of the read, the effect worker, and the online-only
// calls (`online.ts`). It is the production shape of replica-proto's
// `server.ts`, whose protocol it follows, over a `ServerStore`.
//
// Apply, in order. "Unrecorded" answers use up nothing. Everything runs
// inside one error handler (INTERNAL_SERVER_ERROR, unrecorded, nothing kept)
// and, from the client check on, inside one store transaction:
//   larger than 256 KB as JSON (TOO_LARGE), nested more than 32 deep
//     (BAD_REQUEST): unrecorded, before anything hashes or parses the input
//   protocol version (UPDATE_REQUIRED), shape (BAD_REQUEST), signed in
//     (UNAUTHORIZED): unrecorded
//   the client id is the caller's, not expired, and its device not revoked
//     (WRONG_CLIENT): unrecorded
//   an answer stored for (user, mutation id) with the same payload, or stored
//     for it as a mutation id a later write replaced: replayed, no seq used
//   an answer stored for an id in `replaces`: this write was processed under
//     that id; replayed, and stored under the mutation id too, no seq used
//   an answer stored for (client, seq) with the same mutation id and payload
//   `seq` is the client's next one (OUT_OF_ORDER, with expectedSeq): unrecorded
//   a malformed or reused mutation id (BAD_REQUEST): uses the seq, stored for
//     (client, seq)
//   `clientTime` within a minute of the server's time (CLOCK_SKEW, with
//     serverTime): unrecorded
//   the mutation id's and `queuedAt`'s age on the device's clock (EXPIRED;
//     CONFLICT in its place when an input id exists, here and for an input
//     id's age: review round 2 of phase 1)
//   `@session/mutators`' apply: the name, the input, the new ids' age, an
//     online-only write's age, can, pre, run, effects
// A recorded answer is committed with the write's changes, its queued
// effects and the client's seq, under the mutation id and each id it
// replaces. A STALE answer is stored with the keys it is about and answered
// with them as they read now (`current`, `changes`); no record text is
// stored with an answer.

import { createHash, randomBytes } from "node:crypto";

import * as pkg from "@session/mutators";
import { z } from "zod";

import {
  ANSWER_TTL,
  CLIENT_IDLE_TTL,
  OPENED_MAX,
  CLOCK_MAX_SKEW,
  DAY,
  HOUR,
  MAX_ENVELOPE_BYTES,
  MAX_INPUT_DEPTH,
  MAX_REPLACES,
  MIN_PROTOCOL_VERSION,
  REGISTRATIONS_PER_DAY,
  TOMBSTONE_TTL,
  UNRECORDED,
  timeOk,
  type Actor,
  type Answer,
  type AnswerError,
  type CallAnswer,
  type Change,
  type Cursor,
  type LastSeq,
  type LogId,
  type MembershipEnd,
  type Pull,
  type PullAnswer,
  type ReadError,
  type ReadOptions,
  type RegisterAnswer,
  type Snapshot,
  type SnapshotAnswer,
  type SseEvent,
} from "../protocol.js";

import { RunJobs } from "./jobs.js";
import { answerWrites, bounds } from "./limits.js";
import { OnlineCalls, type CallMeta, type KeyVault, type OnlineHandlers } from "./online.js";
import type {
  LogRow,
  ServerStore,
  StoreTx,
  StoredAnswer,
  StoredResult,
  Tombstone,
} from "./store.js";
import { chooseTiers, inSummary, threadOf } from "./tiers.js";
import { Tokens, type CursorKeys, type CursorState } from "./tokens.js";

type RunEvent = Extract<SseEvent, { type: "run" }>;

export const EFFECT_MAX_ATTEMPTS = 10;

/** `SyncServerOptions.writeBudget`. */
export interface WriteBudget {
  /** The most writes and calls at once (the bucket's size). */
  burst: number;
  /** How many the bucket refills a minute. */
  perMinute: number;
}

/** The buckets kept before full ones are dropped. */
const BUDGET_KEYS_MAX = 10_000;
export const EFFECT_BACKOFF_MIN = 1000;
export const EFFECT_BACKOFF_MAX = 600_000;
/** How many expired rows of each table one housekeeping pass removes. */
export const HOUSEKEEP_BATCH = 200;

export interface Clock {
  now(): number;
}

/** Where `job` effects go: the server's job runner (the owned agent loop,
 * the domain checker). A device run is claimed by its device instead. */
export interface JobRunner {
  start(job: { kind: pkg.JobKind; id: string }): void;
  /** A run was stopped (`research.cancelNode`), once that was stored: the
   * runner stops its loop (phase 2a). */
  cancel?(run: string): void;
}

export interface SyncServerOptions {
  store: ServerStore;
  clock: Clock;
  /** The cursor token keys (configured; see `tokens.ts`). */
  cursorKeys: CursorKeys;
  /** The server's random source for client ids, invite codes, device codes
   * and server-made ids: a number in [0, 1). Default: `crypto.randomBytes`. */
  random?: () => number;
  /** The mutators (default `MUTATORS`). */
  registry?: pkg.Registry;
  jobs?: JobRunner;
  /** Handlers for the online-only calls; the default ones serve `runs.*` and
   * `devices.*` and answer the rest METHOD_NOT_SUPPORTED (phase 2). */
  online?: Partial<OnlineHandlers>;
  /** Where API keys' raw values are stored (default: in memory). */
  keys?: KeyVault;
  /** The lowest protocol version the server takes (a deployment setting;
   * default MIN_PROTOCOL_VERSION): a write or a read below it answers
   * UPDATE_REQUIRED (phase 2a). */
  minProtocol?: number;
  /** A per-account budget of writes and online calls (review round 1 of
   * phase 2, F6): a bucket of `burst` that refills at `perMinute`. A write
   * or call past it answers TOO_MANY_REQUESTS with `retryAt`, unrecorded,
   * before anything else is read. A call with no actor is counted by its
   * network address (`CallMeta.ip`, by `addressKey`) when known; a device's
   * calls on a run it holds and `devices.token` for a sign-in the server
   * holds are not counted by person or address (`OnlineCalls`, review
   * round 2 of phase 2). Default: no budget. */
  writeBudget?: WriteBudget | null;
  /** The most queued and running server runs one person may have (a
   * deployment setting: the HTTP server passes `SESSION_QUEUED_PER_USER`;
   * default no limit). A write that would start one more answers
   * TOO_MANY_REQUESTS, unrecorded (review round 1 of phase 2, F5). */
  queuedRunsPerUser?: number;
  /** Whether `u` may run an admin-only model on the included tokens (the
   * HTTP server's `canUseModel`). Without it, nobody may (review round 1 of
   * phase 2, F1). */
  includedModel?: (u: string, model: string) => boolean;
  /** Test only: an effect for which this answers true fails on that attempt. */
  failEffect?: (effect: pkg.Effect, attempt: number) => boolean;
  /** Hears each fault of a housekeeping pass (counted in
   * `housekeepingFaults`); the pass's request still answers (review round 2
   * of phase 1). The HTTP server (phase 2) logs it. */
  onError?: (error: unknown, where: "housekeeping") => void;
}

/** A number in [0, 1) from `crypto.randomBytes`. */
export const cryptoRandom = () => randomBytes(4).readUInt32BE(0) / 4294967296;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted, so equal values print equally. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

const envelopeS = z.strictObject({
  clientId: z.string(),
  seq: z.number().int().positive(),
  mutationId: z.string(),
  name: z.string(),
  input: z.unknown(),
  protocolVersion: z.number().int(),
  clientTime: z.number().int().nonnegative(),
  queuedAt: z.number().int().nonnegative(),
  replaces: z.array(z.string().regex(pkg.ULID_RE)).max(MAX_REPLACES),
});
type Env = z.infer<typeof envelopeS>;

const logS = z
  .string()
  .max(200)
  .regex(/^(space:[^:]+|user:[^:]+|catalog)$/);

const ID_TAKEN = pkg.ID_TAKEN;
const isoAt = pkg.isoAt;
const err = (code: pkg.ErrorCode, message?: string, issues?: string[]): AnswerError =>
  pkg.refuse(code, message, issues).toError();

/** The logs a record with this audience is in. */
function logsOfAudience(a: pkg.Audience): LogId[] {
  if (a.kind === "source") return ["catalog"];
  const out: LogId[] = [];
  if (a.sp !== null && !pkg.NO_SPACE_LOG.has(a.kind)) out.push(`space:${a.sp}`);
  if (a.person !== null) out.push(`user:${a.person}`);
  return out;
}

const same = (a: pkg.StoredRecord, b: pkg.Draft) =>
  JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });

/** A stream's read of one log (`SyncServer.streamPulls`): its reader, the
 * log, the cursor token it holds, and the keys of the rows the commit wrote
 * in the log (none: every row may have changed). */
export interface StreamPull {
  actor: Actor | null;
  log: LogId;
  cursor: Cursor;
  keys?: ReadonlySet<string> | null;
}

export type StreamPullAnswer =
  { resync: true } | { skip: true } | { cursor: Cursor; changed: boolean };

/** A read-only view of a transaction that reads each record, log row,
 * tombstone and epoch once (`streamPulls`: many readers of one commit). */
function memoTx(tx: StoreTx): StoreTx {
  const cache = new Map<string, unknown>();
  const memo =
    <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
    (...a: A): R => {
      const k = `${name}\u0000${a.join("\u0000")}`;
      if (cache.has(k)) return cache.get(k) as R;
      const v = f(...a);
      cache.set(k, v);
      return v;
    };
  const get = memo("get", (key: string) => tx.get(key));
  const logGet = memo("logGet", (log: LogId, key: string) => tx.logGet(log, key));
  const logAfter = memo("logAfter", (log: LogId, after: number) => tx.logAfter(log, after));
  const tombGet = memo("tombGet", (key: string) => tx.tombGet(key));
  const epoch = memo("epoch", (log: LogId) => tx.epoch(log));
  return new Proxy(tx, {
    get(target, p, receiver) {
      if (p === "get") return get;
      if (p === "logGet") return logGet;
      if (p === "logAfter") return logAfter;
      if (p === "tombGet") return tombGet;
      if (p === "epoch") return epoch;
      const v = Reflect.get(target, p, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A `Reader` (by kind and id) over a transaction. */
const readerOf = (tx: StoreTx): pkg.Reader => ({
  get: <K extends pkg.Kind>(kind: K, id: string) =>
    tx.get(pkg.keyFor(kind, id)) as pkg.RecordOf<K> | undefined,
});

/** `@session/mutators`' reads over a transaction: it answers every read. */
class TxSource implements pkg.RecordSource {
  constructor(private readonly tx: StoreTx) {}
  get(kind: pkg.Kind, id: string) {
    const r = this.tx.get(pkg.keyFor(kind, id));
    return r && r.kind === kind ? r : undefined;
  }
  scan(index: pkg.IndexName, value: string) {
    const [kind, field] = pkg.INDEXES[index];
    return this.tx.scan(kind, field, value);
  }
  idUsed(id: string) {
    return this.tx.registryGet(id) !== undefined;
  }
}

/** What a read of one row serves the reader: the record's view, true for a
 * `del` the reader may read, or null. */
type RowView = pkg.StoredRecord | true | null;

/** A read's options, with the protocol version the caller speaks (the HTTP
 * layer passes its header's): below the minimum, the read is
 * UPDATE_REQUIRED. */
export type ReadOpts = ReadOptions & { protocolVersion?: number };

/** The spaces a person may find, and the stats of those they read
 * (`SyncServer.directory`). */
export interface Directory {
  spaces: pkg.SpaceRec[];
  stats: pkg.StatsRec[];
  serverTime: number;
}

/** An invite link as the person who opens it sees it (phase 2b): the space
 * it admits to, who made it, and whether it still admits. */
export interface InviteView {
  space: pkg.SpaceRec;
  by: string;
  expiresAt: string | null;
  /** "live": joining with the code admits; "expired": it no longer does
   * (used, revoked, past its date, or its maker may no longer invite). */
  state: "live" | "expired";
  serverTime: number;
}

export class SyncServer {
  readonly store: ServerStore;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly registry: pkg.Registry;
  private readonly jobRunner: JobRunner;
  private readonly tokens: Tokens;
  private readonly failEffect: SyncServerOptions["failEffect"];
  /** `SyncServerOptions.includedModel`. */
  readonly includedModel: (u: string, model: string) => boolean;
  /** `SyncServerOptions.queuedRunsPerUser`. */
  readonly queuedRunsPerUser: number;
  private readonly writeBudget: WriteBudget | null;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly onError: SyncServerOptions["onError"];
  readonly online: OnlineCalls;
  /** The lowest protocol version taken (`SyncServerOptions.minProtocol`). */
  readonly minProtocol: number;
  /** The calls a server job makes on its run (phase 2a, `jobs.ts`). */
  readonly runJobs: RunJobs;
  /** Housekeeping passes that failed since the server started. */
  housekeepingFaults = 0;
  /** Logs written by the transaction in progress; listeners hear them after
   * it commits. */
  private changed = new Set<LogId>();
  /** The keys of the rows the transaction in progress wrote, by log; null
   * for a log whose history it replaced (every reader must pull it). */
  private changedKeys = new Map<LogId, Set<string> | null>();
  private readonly listeners = new Set<
    (logs: ReadonlySet<LogId>, keys: ReadonlyMap<LogId, ReadonlySet<string> | null>) => void
  >();
  private lastHousekeep = -Infinity;

  constructor(o: SyncServerOptions) {
    this.store = o.store;
    this.clock = o.clock;
    this.random = o.random ?? cryptoRandom;
    this.registry = o.registry ?? pkg.MUTATORS;
    this.jobRunner = o.jobs ?? { start: () => {} };
    this.tokens = new Tokens(o.cursorKeys);
    this.failEffect = o.failEffect;
    this.includedModel = o.includedModel ?? (() => false);
    this.queuedRunsPerUser = o.queuedRunsPerUser ?? Infinity;
    this.writeBudget = o.writeBudget ?? null;
    this.onError = o.onError;
    this.minProtocol = Math.max(MIN_PROTOCOL_VERSION, o.minProtocol ?? MIN_PROTOCOL_VERSION);
    this.online = new OnlineCalls(this, o.online, o.keys, {
      cancelled: (run) => this.jobRunner.cancel?.(run),
    });
    this.runJobs = new RunJobs(this);
  }

  // ---- time, transactions, commit ----

  /** The clock in whole milliseconds (the stores keep integers; review
   * round 1 of phase 1). */
  clockNow(): number {
    return Math.floor(this.clock.now());
  }

  /** The server's time: the clock, never earlier than a time used before. */
  time(tx: StoreTx): number {
    const now = Math.max(this.clockNow(), tx.lastTime());
    if (now !== tx.lastTime()) tx.setLastTime(now);
    return now;
  }

  /** Set the stored server time back to the clock (an operator's reset,
   * phase 2). Server time never goes back on its own: after the clock once
   * jumped ahead, every write answers CLOCK_SKEW and no lease ends until the
   * clock catches up. Once the clock is right again, an operator calls this
   * to let server time follow it (review round 2 of phase 1). Times stored
   * before stay as they are, so ids and times made after the reset can be
   * earlier than ones made before it. Answers the new server time. */
  resetTime(): number {
    return this.run((tx) => {
      const now = this.clockNow();
      tx.setLastTime(now);
      return now;
    });
  }

  /** Run `fn` in a store transaction, then tell the listeners which logs it
   * wrote and send the run events it made, only once it committed. A
   * listener that throws changes neither the answer nor what the other
   * listeners hear (review round 1 of phase 1, E16). */
  run<T>(fn: (tx: StoreTx) => T): T {
    this.changed = new Set();
    this.changedKeys = new Map();
    this.runEvents = [];
    this.revoked = [];
    this.after = [];
    let out: T;
    try {
      out = this.store.transaction(fn);
    } catch (e) {
      this.changed = new Set();
      this.changedKeys = new Map();
      this.runEvents = [];
      this.revoked = [];
      this.after = [];
      throw e;
    }
    const logs = this.changed;
    const keys = this.changedKeys;
    const events = this.runEvents;
    const revoked = this.revoked;
    const after = this.after;
    this.changed = new Set();
    this.changedKeys = new Map();
    this.runEvents = [];
    this.revoked = [];
    this.after = [];
    for (const f of after)
      try {
        f();
      } catch {
        // a hook that throws changes no answer
      }
    for (const device of revoked)
      for (const l of [...this.revokeListeners])
        try {
          l(device);
        } catch {
          // as below
        }
    if (logs.size)
      for (const l of [...this.listeners])
        try {
          l(logs, keys);
        } catch {
          // a stream that closed; the others still hear the commit
        }
    for (const [e, sp] of events)
      for (const l of [...this.runListeners])
        try {
          l(e, sp);
        } catch {
          // as above
        }
    return out;
  }

  private readonly runListeners = new Set<(e: RunEvent, sp: string) => void>();
  /** Calls to make once the transaction in progress is stored. */
  private after: (() => void)[] = [];

  /** Call `f` once the transaction in progress is stored (not at all when
   * it rolls back). */
  afterCommit(f: () => void) {
    this.after.push(f);
  }
  /** Run events made by the transaction in progress; sent after it commits. */
  private runEvents: [RunEvent, string][] = [];
  private readonly revokeListeners = new Set<(device: string) => void>();
  /** Devices revoked by the transaction in progress. */
  private revoked: string[] = [];

  /** Tell the revocation listeners, once the transaction in progress
   * commits, that `device` was signed out: its streams close (review round 2
   * of phase 1). */
  emitRevoke(device: string) {
    this.revoked.push(device);
  }

  /** Hear the devices signed out by each committed transaction (the SSE
   * handler closes their streams). */
  subscribeRevocations(listener: (device: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  /** The server's random source (online calls). */
  randomNumber(): number {
    return this.random();
  }

  /** Send a run's in-flight text to the readers of its space (ADR-22) once
   * the transaction in progress commits (review round 1 of phase 1, W3): it
   * is not stored; a reader that misses it gets the committed answer by
   * pull. */
  emitRun(e: RunEvent, run: pkg.RunRec) {
    this.runEvents.push([e, run.s]);
  }

  /** Hear in-flight run events, with the run's space (the SSE handler). */
  subscribeRuns(listener: (e: RunEvent, sp: string) => void): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  /** Hear the logs each committed transaction wrote (the SSE handler), and
   * the keys of the rows it wrote in each (null: the log's history was
   * replaced). */
  subscribe(
    listener: (
      logs: ReadonlySet<LogId>,
      keys: ReadonlyMap<LogId, ReadonlySet<string> | null>,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A server-made id: a ULID at `now` from the server's random source,
   * never one the registry holds. */
  newId(tx: StoreTx, now: number, taken?: (id: string) => boolean): string {
    let id: string;
    do id = pkg.ulid(now, this.random);
    while (tx.registryGet(id) !== undefined || taken?.(id));
    return id;
  }

  private row(tx: StoreTx, log: LogId, key: string, op: "put" | "del", version: number) {
    tx.logPut(log, { key, op, version });
    this.changed.add(log);
    const keys = this.changedKeys.get(log);
    if (keys === undefined) this.changedKeys.set(log, new Set([key]));
    else keys?.add(key);
  }

  /** Write staged records under one new version: revs, the registry, log
   * rows, tombstones, and the rows of the records whose view a change
   * changes. Answers the version, or null when nothing changed. */
  commit(tx: StoreTx, writes: readonly pkg.Write[], now: number): number | null {
    const real: [string, pkg.Draft | null, pkg.StoredRecord | undefined][] = [];
    const last = new Map<string, pkg.Draft | null>();
    for (const [key, next] of writes) last.set(key, next);
    for (const [key, next] of last) {
      const prev = tx.get(key);
      if (next === null ? !prev : prev && same(prev, next)) continue;
      real.push([key, next, prev]);
    }
    if (!real.length) return null;
    const version = tx.head() + 1;
    tx.setHead(version);
    const at = this.time(tx);
    const g = readerOf(tx);
    for (const [key, next, prev] of real) {
      if (next === null) {
        const old = prev as pkg.StoredRecord;
        const tomb: Tombstone = { key, ...pkg.audience(g, old), at };
        tx.del(key);
        tx.tombPut(tomb);
        for (const log of logsOfAudience(tomb)) this.row(tx, log, key, "del", version);
        this.touchDependents(tx, old, version);
        continue;
      }
      const reg = pkg.registryKey(next);
      const rev = (prev?.rev ?? tx.registryGet(reg) ?? 0) + 1;
      const rec = { ...next, rev };
      tx.put(key, rec, prev ? (tx.born(key) ?? version) : version);
      tx.registrySet(reg, rev);
      if (!prev) tx.tombDelete(key);
      for (const log of pkg.logsOf(rec)) this.row(tx, log, key, "put", version);
      this.touchDependents(tx, rec, version);
      // who may read a space's content depends on whether it is closed: a
      // change replaces the log's history (every cursor of it resyncs)
      if (
        rec.kind === "space" &&
        prev?.kind === "space" &&
        pkg.isClosed(prev) !== pkg.isClosed(rec)
      ) {
        const log: LogId = `space:${rec.id}`;
        tx.setEpoch(log, { n: tx.epoch(log).n + 1, start: version });
        this.changed.add(log);
        this.changedKeys.set(log, null);
      }
    }
    void now;
    return version;
  }

  private touchDependents(tx: StoreTx, r: pkg.StoredRecord, version: number) {
    const src: pkg.DependentSource = {
      get: (key) => tx.get(key),
      runsOf: (th) => tx.scan("run", "th", th),
      turnsOf: (run) => tx.scan("turn", "run", run),
    };
    for (const key of pkg.viewDependents(r, src)) {
      const dep = tx.get(key);
      if (dep) for (const log of pkg.logsOf(dep)) this.row(tx, log, key, "put", version);
    }
  }

  /** Take one write or call from `key`'s budget (`writeBudget`): null when
   * it is within it, else the TOO_MANY_REQUESTS refusal, with `retryAt` when
   * the next one is taken. The clock going back refills nothing and takes
   * nothing away. */
  overBudget(key: string | null): AnswerError | null {
    const b = this.writeBudget;
    if (!b || key === null) return null;
    const now = this.clockNow();
    const prev = this.buckets.get(key) ?? { tokens: b.burst, at: now };
    const tokens = Math.min(
      b.burst,
      prev.tokens + (Math.max(0, now - prev.at) * b.perMinute) / 60_000,
    );
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: Math.max(now, prev.at) });
      const wait = Math.ceil(((1 - tokens) * 60_000) / b.perMinute);
      return {
        ...err(
          "TOO_MANY_REQUESTS",
          "You made too many changes in a short time. Try again in a minute.",
        ),
        // whole seconds, rounded up: a retry at it is taken
        retryAt: isoAt(Math.ceil((now + wait) / 1000) * 1000),
      };
    }
    if (this.buckets.size >= BUDGET_KEYS_MAX)
      for (const [k, v] of this.buckets)
        if (v.tokens + ((now - v.at) * b.perMinute) / 60_000 >= b.burst) this.buckets.delete(k);
    this.buckets.set(key, { tokens: tokens - 1, at: Math.max(now, prev.at) });
    return null;
  }

  /** Housekeeping before a request: at most once a second of server time, in
   * its own transaction, so a request that is refused (and rolls back) does
   * not undo it (review round 1 of phase 1, W1). A fault in it fails no
   * request; the next one tries again. Each fault is counted
   * (`housekeepingFaults`) and passed to `onError` (review round 2 of phase
   * 1). */
  housekeepDue() {
    if (this.clockNow() - this.lastHousekeep < 1000) return;
    try {
      this.run((tx) => {
        const now = this.time(tx);
        this.housekeep(tx, now);
        this.lastHousekeep = now;
      });
    } catch (e) {
      // the next request runs it again
      this.housekeepingFaults++;
      try {
        this.onError?.(e, "housekeeping");
      } catch {
        // a hook that throws changes no answer
      }
    }
  }

  /** Run housekeeping every `everyMs` (default 5 s) on a timer, so leases and
   * device sign-ins also expire on a server no request reaches. The HTTP
   * server (phase 2) starts it once with the server; it answers a function
   * that stops it. */
  startHousekeeping(
    o: {
      everyMs?: number;
      setInterval?: (f: () => void, ms: number) => unknown;
      clearInterval?: (h: unknown) => void;
    } = {},
  ): () => void {
    const set = o.setInterval ?? ((f, ms) => setInterval(f, ms));
    const clear = o.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    const h = set(() => {
      this.lastHousekeep = -Infinity;
      this.housekeepDue();
    }, o.everyMs ?? 5000);
    return () => clear(h);
  }

  /** Expire what is past its lifetime: a bounded batch of each table, or
   * everything when `force`. */
  housekeep(tx: StoreTx, now: number, force = false) {
    const limit = force ? Number.MAX_SAFE_INTEGER : HOUSEKEEP_BATCH;
    const cutoff = now - TOMBSTONE_TTL;
    for (const t of tx.tombsBefore(cutoff, limit)) {
      tx.tombDelete(t.key);
      for (const log of logsOfAudience(t))
        if (tx.logGet(log, t.key)?.op === "del") tx.logDelete(log, t.key);
    }
    // an answer, a client and a registration expire at their lifetime's
    // end (inclusive); a tombstone is kept through its 30th day's last ms
    tx.answersPrune(now - ANSWER_TTL + 1, limit);
    tx.clientsPrune(now - CLIENT_IDLE_TTL + 1, limit);
    tx.registrationsPrune(now - DAY + 1, limit);
    tx.deviceRunsPrune(now - HOUR + 1, limit);
    this.online.housekeep(tx, now, limit);
  }

  // ---- writes ----

  /** A new client id, bound to the caller and its device. */
  register(actor: Actor | null): RegisterAnswer {
    const serverTime = this.clockNow();
    if (!actor || !pkg.isHandle(actor.u))
      return { ok: false, error: err("UNAUTHORIZED"), serverTime };
    try {
      this.housekeepDue();
      return this.run((tx) => {
        const now = this.time(tx);
        if (actor.device && !this.online.deviceLive(tx, actor.u, actor.device))
          return { ok: false as const, error: err("WRONG_CLIENT"), serverTime: now };
        if (tx.registrations(actor.u, now - DAY + 1) >= REGISTRATIONS_PER_DAY)
          return { ok: false as const, error: err("TOO_MANY_REQUESTS"), serverTime: now };
        let id: string;
        do id = pkg.ulid(now, this.random);
        while (tx.clientGet(id));
        tx.registrationAdd(actor.u, now);
        tx.clientPut(id, { u: actor.u, device: actor.device ?? null, last: 0, seen: now });
        return { ok: true as const, clientId: id, serverTime: now };
      });
    } catch {
      return { ok: false, error: err("INTERNAL_SERVER_ERROR"), serverTime };
    }
  }

  /** Apply one write. `size`: the request body's length, when the HTTP layer
   * knows it. */
  apply(actor: Actor | null, envelope: unknown, size?: number): Answer {
    const t0 = this.clockNow();
    try {
      return this.applyEnvelope(actor, envelope, size);
    } catch {
      // nothing was committed (the transaction rolled back), or the commit
      // and its stored answer were, and a resend gets that answer
      return { ok: false, error: err("INTERNAL_SERVER_ERROR"), serverTime: t0 };
    }
  }

  private applyEnvelope(actor: Actor | null, envelope: unknown, size?: number): Answer {
    const t0 = this.clockNow();
    const no = (e: AnswerError): Answer => ({ ok: false, error: e, serverTime: t0 });
    const large = () =>
      no(
        err("TOO_LARGE", undefined, [
          `envelope: expected at most ${MAX_ENVELOPE_BYTES} bytes as JSON`,
        ]),
      );
    if (size !== undefined && size > MAX_ENVELOPE_BYTES) return large();
    const b = bounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);
    if (b === "large") return large();
    if (b === "deep")
      return no(
        err("BAD_REQUEST", undefined, [
          `envelope: expected input nested at most ${MAX_INPUT_DEPTH} deep`,
        ]),
      );
    if (Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES) return large();
    const version =
      envelope !== null && typeof envelope === "object"
        ? (envelope as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    if (typeof version === "number" && Number.isInteger(version) && version < this.minProtocol)
      return no(
        err("UPDATE_REQUIRED", undefined, [
          `protocolVersion: expected at least ${this.minProtocol}`,
        ]),
      );
    const parsed = envelopeS.safeParse(envelope);
    if (!parsed.success)
      return no(
        err("BAD_REQUEST", undefined, [
          "envelope: expected { clientId, seq, mutationId, name, input, protocolVersion, clientTime, queuedAt, replaces }",
        ]),
      );
    const m = parsed.data;
    if (!actor || !pkg.isHandle(actor.u)) return no(err("UNAUTHORIZED"));
    const u = actor.u;
    const spent = this.overBudget(`u:${u}`);
    if (spent) return no(spent);
    this.housekeepDue();
    return this.run((tx) => {
      const now = this.time(tx);
      const out = (e: AnswerError, seq?: number): Answer => ({
        ok: false,
        error: e,
        serverTime: now,
        ...(seq !== undefined ? { seq } : {}),
      });
      const client = tx.clientGet(m.clientId);
      if (
        !client ||
        client.u !== u ||
        client.seen <= now - CLIENT_IDLE_TTL ||
        (client.device !== null && !this.online.deviceLive(tx, u, client.device))
      )
        return out(err("WRONG_CLIENT"));
      tx.clientPut(m.clientId, { ...client, seen: now });
      const wellFormed = pkg.isUlid(m.mutationId);
      const payload = sha256(canonical([m.name, m.input]));
      const replaced = `replaced:${payload}`;
      const live = (a: StoredAnswer | undefined) => (a && a.at > now - ANSWER_TTL ? a : undefined);
      const hit = wellFormed ? live(tx.answerGet(u, m.mutationId)) : undefined;
      // a write this user's devices sent before, under any client id or seq
      if (hit && (hit.digest === payload || hit.digest.startsWith("replaced:")))
        return this.withCreated(tx, m.name, this.replay(tx, u, hit.answer, now));
      // a reminted write: processed already under an id it replaces
      if (wellFormed && !hit)
        for (const old of m.replaces) {
          const prior = live(tx.answerGet(u, old));
          if (!prior) continue;
          tx.answerPut(u, m.mutationId, { digest: payload, answer: prior.answer, at: now });
          return this.withCreated(tx, m.name, this.replay(tx, u, prior.answer, now));
        }
      const sent = sha256(canonical([m.mutationId, m.name, m.input]));
      const kept = live(tx.seqAnswerGet(m.clientId, m.seq));
      if (kept && kept.digest === sent)
        return this.withCreated(tx, m.name, this.replay(tx, u, kept.answer, now));
      if (m.seq !== client.last + 1)
        return out({
          ...err("OUT_OF_ORDER", undefined, [`seq: expected ${client.last + 1}`]),
          expectedSeq: client.last + 1,
        });
      const use = () => tx.clientPut(m.clientId, { ...client, seen: now, last: m.seq });
      if (!wellFormed || hit) {
        const e = err("BAD_REQUEST", undefined, [
          wellFormed
            ? "mutationId: already used for a different change"
            : "mutationId: expected a ULID",
        ]);
        tx.seqAnswerPut(m.clientId, m.seq, {
          digest: sent,
          answer: { ok: false, error: e, seq: m.seq },
          at: now,
        });
        use();
        return out(e, m.seq);
      }
      if (Math.abs(m.clientTime - now) > CLOCK_MAX_SKEW)
        return {
          ...out(
            err("CLOCK_SKEW", undefined, [
              "clientTime: expected the server's time to within a minute",
            ]),
          ),
        };
      const record = (answer: StoredResult) => {
        // `as`: the mutation id the write was processed under; a replay
        // carries it as `recordedAs` (review round 2 of phase 1, finding 1)
        const a: StoredAnswer = {
          digest: payload,
          answer: { ...answer, as: m.mutationId },
          at: now,
        };
        tx.answerPut(u, m.mutationId, a);
        for (const old of m.replaces)
          if (!live(tx.answerGet(u, old))) tx.answerPut(u, old, { ...a, digest: replaced });
        use();
      };
      const taken = () => this.inputIdTaken(tx, m);
      const expired = (path: string) => {
        const e = taken()
          ? err("CONFLICT", ID_TAKEN)
          : err("EXPIRED", undefined, [
              `${path}: expected a time from the 4 days before clientTime to 1 minute after`,
            ]);
        record({ ok: false, error: e, seq: m.seq });
        return out(e, m.seq);
      };
      if (!timeOk(pkg.ulidTime(m.mutationId), m.clientTime)) return expired("mutationId");
      if (!timeOk(m.queuedAt, m.clientTime)) return expired("queuedAt");
      return this.execute(tx, u, m, now, record, out);
    });
  }

  private execute(
    tx: StoreTx,
    u: string,
    m: Env,
    now: number,
    record: (a: StoredResult) => void,
    out: (e: AnswerError, seq?: number) => Answer,
  ): Answer {
    const res = pkg.apply(this.registry, new TxSource(tx), { u }, m, {
      now,
      server: {
        random: this.random,
        deviceRunStarts: (who, since) => tx.deviceRunsSince(who, since),
        includedModel: (who, model) => this.includedModel(who, model),
      },
    });
    if (res.status === "unknown") return out(err("INTERNAL_SERVER_ERROR"));
    if (res.status === "refused") {
      const { current, reads, ...refusal } = res.error;
      void current;
      // an input id's age: CONFLICT in place of EXPIRED when the id exists
      const e =
        refusal.code === "EXPIRED" && this.inputIdTaken(tx, m)
          ? err("CONFLICT", ID_TAKEN)
          : refusal;
      if (UNRECORDED.has(e.code)) return out(e);
      record({ ok: false, error: e, ...(reads ? { reads } : {}), seq: m.seq });
      return this.withReads(tx, u, out(e, m.seq), reads);
    }
    const many = this.tooManyRuns(tx, u, res.writes);
    if (many) return out(many);
    const started = pkg.deviceRunsStarted(res.writes, (key) => tx.get(key) !== undefined);
    // spaces this write archives (review round 2 of phase 1)
    const archived = res.writes.flatMap(([key, d]) => {
      const prev = d?.kind === "space" ? tx.get(key) : undefined;
      return d?.kind === "space" && d.archived && prev?.kind === "space" && !prev.archived
        ? [d.id]
        : [];
    });
    this.commit(tx, res.writes, now);
    for (let k = 0; k < started; k++) tx.deviceRunAdd(u, now);
    // a person whose membership ended, or who was banned, runs nothing more
    // there: their queued and running device runs end in the same commit
    for (const [, d] of res.writes)
      if (d?.kind === "exit" || d?.kind === "ban") this.online.accessChanged(tx, now, d.sp, d.u);
    // nobody asks in an archived space: its device runs end (`interrupted`)
    for (const sp of archived) this.online.spaceArchived(tx, now, sp);
    for (const effect of res.effects) tx.effectAdd(effect, now);
    record({ ok: true, result: res.result ?? null, seq: m.seq });
    return this.withCreated(tx, m.name, {
      ok: true,
      result: res.result ?? null,
      serverTime: now,
      seq: m.seq,
    });
  }

  /** `spaces.create`'s answer with the new space as it is stored now
   * (`space`: the record `directory` serves), so a client that holds no log
   * of it shows it at once (review round 1 of phase 2, 2b design finding 6).
   * The stored answer keeps only the id (no record text is stored with an
   * answer): a replay reads the space again, and has no `space` once it was
   * deleted. */
  private withCreated(tx: StoreTx, name: string, a: Answer): Answer {
    if (name !== "spaces.create" || !a.ok) return a;
    const id = (a.result as { id?: unknown } | null)?.id;
    const s = typeof id === "string" ? tx.get(pkg.spaceKey(id)) : undefined;
    if (s?.kind !== "space" || s.deleted) return a;
    return { ...a, result: { ...(a.result as object), space: s } };
  }

  /** The refusal of staged `writes` that start a server run of `u`'s and
   * leave them more than `queuedRunsPerUser` queued and running server runs
   * (TOO_MANY_REQUESTS, unrecorded: it can be sent again once one ends), or
   * null. Device runs have their own limit. */
  tooManyRuns(tx: StoreTx, u: string, writes: readonly pkg.Write[]): AnswerError | null {
    const mine = (d: pkg.Draft | null): boolean =>
      d?.kind === "run" &&
      d.u === u &&
      d.executor === null &&
      (d.status === "queued" || d.status === "running");
    if (!writes.some(([key, d]) => mine(d) && tx.get(key) === undefined)) return null;
    // the actor's runs (`run.u`), not every queued and running run on the
    // server (review round 2 of phase 2, finding 8)
    const live = new Set<string>();
    for (const r of tx.scan("run", "u", u))
      if (r.kind === "run" && mine(r)) live.add(`run:${r.id}`);
    for (const [key, d] of writes)
      if (mine(d)) live.add(key);
      else if (d === null || d.kind === "run") live.delete(key);
    if (live.size <= this.queuedRunsPerUser) return null;
    return err(
      "TOO_MANY_REQUESTS",
      `You have ${this.queuedRunsPerUser} asks waiting or running. Ask again once one of them finishes.`,
    );
  }

  /** Whether an input id of the write (the mutator's `ids`) is in the id
   * registry. An answer that would be EXPIRED for an age is CONFLICT then
   * (review round 2 of phase 1, findings 2 and 8a): to a client sending a
   * write again after its recorded answer expired, CONFLICT on an id it
   * minted means the write applied, and EXPIRED that its ids were never
   * used. Other answers keep their order. */
  private inputIdTaken(tx: StoreTx, m: Env): boolean {
    const def = this.registry.get(m.name);
    const parsed = def?.input.safeParse(m.input);
    if (!def || !parsed?.success) return false;
    return def.ids(parsed.data).some((id) => tx.registryGet(id) !== undefined);
  }

  /** A STALE answer with the records it is about, as `u` reads them now. */
  private withReads(
    tx: StoreTx,
    u: string,
    a: Answer,
    reads: readonly string[] | undefined,
  ): Answer {
    if (a.ok || !reads?.length) return a;
    const g = readerOf(tx);
    const changes: Change[] = reads.map((key) => {
      const r = tx.get(key);
      const v = r ? pkg.view(g, r, u) : null;
      return v ? { key, op: "put", record: v } : { key, op: "del" };
    });
    const first = changes[0];
    return {
      ...a,
      error: { ...a.error, current: first?.op === "put" ? first.record : null, changes },
    };
  }

  private replay(tx: StoreTx, u: string, a: StoredResult, now: number): Answer {
    const as = a.as !== undefined ? { recordedAs: a.as } : {};
    if (a.ok)
      return {
        ok: true,
        result: structuredClone(a.result),
        serverTime: now,
        replayed: true,
        ...as,
      };
    const e = structuredClone(a.error) as AnswerError;
    return this.withReads(
      tx,
      u,
      { ok: false, error: e, serverTime: now, replayed: true, ...as },
      a.reads,
    );
  }

  // ---- the online-only calls ----

  /** An online call; `meta`: what the HTTP layer knows of the request (the
   * caller's network address, for a device sign-in). */
  call(actor: Actor | null, name: string, input: unknown, meta?: CallMeta): CallAnswer {
    return this.online.call(actor, name, input, meta);
  }

  // ---- the effect worker ----

  /** One pass of the effect worker: runs each queued effect that is due, each
   * in its own transaction with its writes. A `job` starts after that
   * transaction, outside any: its queue entry is deleted only once the job
   * runner took it, so a crash in between starts it again (at least once;
   * the runner keys jobs by their id). Answers how many ran. */
  work(limit = 100): number {
    let ran = 0;
    const due = this.run((tx) => tx.effectsDue(this.time(tx), limit));
    for (const q of due) {
      const attempts = q.attempts + 1;
      try {
        const job = this.run((tx) => {
          const now = this.time(tx);
          if (this.failEffect?.(q.effect, attempts)) throw new Error("the effect's service failed");
          const start = this.runEffect(tx, q.effect, now);
          if (!start) tx.effectDelete(q.id);
          return start;
        });
        if (job) {
          this.jobRunner.start(job);
          this.run((tx) => tx.effectDelete(q.id));
        }
        ran++;
      } catch {
        // its write's answer is recorded already and does not change
        this.run((tx) => {
          const now = this.time(tx);
          if (attempts >= EFFECT_MAX_ATTEMPTS) {
            tx.effectDelete(q.id);
            tx.deadLetterAdd({ effect: q.effect, at: q.at, attempts, failedAt: now });
            // a run whose job never started ends, and its thread stops
            // running (review round 2 of phase 1)
            if (q.effect.type === "job" && q.effect.kind === "run")
              this.online.jobDead(tx, now, q.effect.id);
          } else
            tx.effectUpdate(
              q.id,
              attempts,
              now + Math.min(EFFECT_BACKOFF_MAX, EFFECT_BACKOFF_MIN * 2 ** (attempts - 1)),
            );
        });
      }
    }
    return ran;
  }

  private notif(
    tx: StoreTx,
    now: number,
    staged: pkg.Write[],
    n: Pick<pkg.NotifRec, "to" | "type" | "sp" | "report" | "item"> & Partial<pkg.NotifRec>,
  ) {
    const taken = new Set(staged.map(([k]) => k));
    const id = this.newId(tx, now, (x) => taken.has(`notif:${x}`));
    staged.push([
      `notif:${id}`,
      {
        kind: "notif",
        id,
        outcome: null,
        response: null,
        actor: null,
        thread: null,
        node: null,
        invite: null,
        read: false,
        createdAt: isoAt(now),
        ...n,
      },
    ]);
  }

  /** Run an effect's writes; for a `job`, the job to start once they commit,
   * else null. */
  private runEffect(
    tx: StoreTx,
    effect: pkg.Effect,
    now: number,
  ): { kind: pkg.JobKind; id: string } | null {
    const staged: pkg.Write[] = [];
    if (effect.type === "job") {
      // a device run is claimed by its device (runs.claim), not started here
      if (effect.kind === "run") {
        const r = tx.get(`run:${effect.id}`);
        if (r?.kind === "run" && r.executor !== null) return null;
      }
      return { kind: effect.kind, id: effect.id };
    }
    if (effect.type === "reportResolved") {
      const r = tx.get(`report:${effect.report}`);
      if (r?.kind !== "report") return null;
      for (const n of tx.scan("notif", "to", r.by))
        if (n.kind === "notif" && n.type === "report_resolved" && n.report === r.id)
          staged.push([`notif:${n.id}`, null]);
      if (effect.outcome !== null)
        this.notif(tx, now, staged, {
          to: r.by,
          type: "report_resolved",
          sp: r.sp,
          report: r.id,
          item: r.key,
          outcome: effect.outcome,
        });
      this.commit(tx, staged, now);
      return null;
    }
    // notifyStaff: the space's staff as they are now, and their reports
    // notice comes back on
    const s = tx.get(`space:${effect.sp}`);
    for (const [to, role] of s?.kind === "space" ? s.mods : []) {
      if (role === "member") continue;
      this.notif(tx, now, staged, {
        to,
        type: "report",
        sp: effect.sp,
        report: effect.report,
        item: effect.item,
      });
      const seen = tx.get(`seen:${to}`);
      if (seen?.kind === "seen" && seen.reps) staged.push([`seen:${to}`, { ...seen, reps: false }]);
    }
    this.commit(tx, staged, now);
    return null;
  }

  /** A job's answer (the job runner calls it): `text` as a thread's summary
   * (`thread:<id>`) or a follow-up's answer (`followup:<id>`). False, and
   * nothing written, for a removed item, a deleted thread or another key.
   * An answer to a hidden item counts as an edit of it (`answerWrites`). */
  finishJob(key: string, text: string): boolean {
    return this.run((tx) => {
      const now = this.time(tx);
      const r = tx.get(key);
      if (!r || !("mod" in r) || r.mod === "removed") return false;
      if (r.kind === "thread" && !r.del)
        return this.commit(tx, answerWrites(tx, { ...r, sum: text, running: false }), now) !== null;
      if (r.kind === "followup" && !r.del)
        return this.commit(tx, answerWrites(tx, { ...r, a: text }), now) !== null;
      return false;
    });
  }

  /** A key check's verdict (the job runner calls it, phase 2a): the key
   * reads "valid" or "invalid". False when the key is gone or no longer
   * waits for a check. */
  keyChecked(id: string, valid: boolean): boolean {
    return this.run((tx) => {
      const now = this.time(tx);
      const k = tx.get(`apikey:${id}`);
      if (k?.kind !== "apikey" || k.status !== "checking") return false;
      this.commit(tx, [[`apikey:${id}`, { ...k, status: valid ? "valid" : "invalid" }]], now);
      return true;
    });
  }

  /** A domain check's verdict (the job runner calls it, phase 2a): the
   * space's domain reads "ok" (verified now) or "failed". False when the
   * space no longer waits for a check of `domain`. */
  domainChecked(space: string, domain: string, verified: boolean): boolean {
    return this.run((tx) => {
      const now = this.time(tx);
      const s = tx.get(`space:${space}`);
      if (s?.kind !== "space" || s.dom?.state !== "checking" || s.dom.domain !== domain)
        return false;
      const dom: pkg.SpaceDomain = verified
        ? { ...s.dom, state: "ok", verifiedAt: isoAt(now) }
        : { ...s.dom, state: "failed" };
      this.commit(tx, [[`space:${space}`, { ...s, dom }]], now);
      return true;
    });
  }

  // ---- reads ----

  private userOf(actor: Actor | null): string | null {
    return actor !== null && typeof actor.u === "string" && pkg.isHandle(actor.u) ? actor.u : null;
  }

  /** A user log is read by its user only. */
  private closedTo(log: LogId, u: string | null) {
    return log.startsWith("user:") && (u === null || log !== `user:${u}`);
  }

  private lastSeq(
    tx: StoreTx,
    u: string | null,
    clientId: string | undefined,
    now: number,
  ): LastSeq {
    if (u === null || clientId === undefined) return null;
    const c = tx.clientGet(clientId);
    if (!c || c.u !== u || c.seen <= now - CLIENT_IDLE_TTL) return null;
    tx.clientPut(clientId, { ...c, seen: now });
    return c.last;
  }

  private readRow(tx: StoreTx, row: LogRow, u: string | null): RowView {
    const g = readerOf(tx);
    if (row.op === "put") {
      const rec = tx.get(row.key);
      return rec ? pkg.view(g, rec, u) : null;
    }
    const t = tx.tombGet(row.key);
    return t && pkg.readsAudience(g, t, u) ? true : null;
  }

  private serve(tx: StoreTx, log: LogId, u: string | null, version: number, now: number): Cursor {
    const i = this.instance(tx);
    return this.tokens.seal({ log, u, n: tx.epoch(log).n, v: version, h: tx.head(), at: now, i });
  }

  /** The database's instance id, made on first use (crypto random, never
   * 0). */
  private instance(tx: StoreTx): number {
    let i = tx.instance();
    if (i === 0) {
      i = randomBytes(6).readUIntBE(0, 6) || 1;
      tx.setInstance(i);
    }
    return i;
  }

  /** Give the database a new instance id: every cursor served before
   * answers resync. An operator calls it after restoring the database from a
   * backup, whose cursors' versions the restored history reuses (review
   * round 1 of phase 1, E22). A token served at a head the database has not
   * reached answers resync without it. */
  resetInstance() {
    this.run((tx) => tx.setInstance(randomBytes(6).readUIntBE(0, 6) || 1));
  }

  /** The tiers of a space log's threads for a read, or null (not a space log,
   * or every thread in full). */
  private tiers(tx: StoreTx, log: LogId, u: string | null, now: number, o: ReadOptions) {
    if (!log.startsWith("space:")) return null;
    const window = o.tier?.window ?? "full";
    if (window === "full" && !o.threads) return null;
    const sp = log.slice(6);
    const g = readerOf(tx);
    const threads = tx
      .scan("thread", "s", sp)
      .filter((p): p is pkg.ThreadRec => p.kind === "thread" && pkg.canRead(g, p, u));
    if (o.threads) {
      const want = new Set(o.threads);
      return { full: want, summary: new Set<string>() };
    }
    // a client pins at most OPENED_MAX threads in full (review round 2 of
    // phase 1)
    const pinned = new Set((o.tier?.opened ?? []).slice(0, OPENED_MAX));
    if (u !== null)
      for (const p of threads) if (p.u === u || tx.get(pkg.saveKey(u, p.id))) pinned.add(p.id);
    return chooseTiers(threads, now, { ...o.tier, window }, pinned);
  }

  /** Whether a tiered read serves a record. */
  private served(
    tx: StoreTx,
    rec: pkg.StoredRecord,
    tiers: { full: ReadonlySet<string>; summary: ReadonlySet<string> } | null,
    only: boolean,
  ) {
    if (!tiers) return true;
    const th = threadOf(rec, (k) => tx.get(k));
    if (th === null) return !only;
    if (tiers.full.has(th)) return true;
    return tiers.summary.has(th) && inSummary(rec);
  }

  /** A read the server does not serve (review round 1 of phase 1): below
   * the minimum protocol version (UPDATE_REQUIRED, when the caller passes
   * the version it speaks), an actor whose handle is not one
   * (UNAUTHORIZED), or a user log read signed out (UNAUTHORIZED, in place of
   * the empty projection a client would replace its log with). Signed out,
   * space logs and the catalog are served. */
  private readError(actor: Actor | null, log: LogId, o: ReadOpts, now: number): ReadError | null {
    const no = (code: pkg.ErrorCode): ReadError => ({
      ok: false,
      error: err(code),
      serverTime: now,
    });
    if (o.protocolVersion !== undefined && !(o.protocolVersion >= this.minProtocol))
      return no("UPDATE_REQUIRED");
    if (actor !== null && !pkg.isHandle(actor.u)) return no("UNAUTHORIZED");
    if (actor === null && typeof log === "string" && log.startsWith("user:"))
      return no("UNAUTHORIZED");
    return null;
  }

  /** How `u`'s memberships ended, by space: their exit records, read by an
   * index, not by a scan of the user log (review round 2 of phase 1). */
  private ended(tx: StoreTx, u: string): Record<string, MembershipEnd> {
    const out: Record<string, MembershipEnd> = {};
    for (const r of tx.scan("exit", "u", u)) if (r.kind === "exit") out[r.sp] = r.ended;
    return out;
  }

  /** The fields a read of `log` by `u` adds: `ended` on their own user log. */
  private extras(tx: StoreTx, log: LogId, u: string | null) {
    return u !== null && log === `user:${u}` ? { ended: this.ended(tx, u) } : {};
  }

  /** A snapshot of `log` for `actor`. A signed-in reader, and a signed-out
   * reader of a space log or the catalog, always get one; otherwise the
   * answer may be a `ReadError`. */
  snapshot(actor: Actor, log: LogId, options?: ReadOptions): Snapshot;
  snapshot(actor: null, log: `space:${string}` | "catalog", options?: ReadOptions): Snapshot;
  snapshot(actor: Actor | null, log: LogId, options?: ReadOpts): SnapshotAnswer;
  snapshot(actor: Actor | null, log: LogId, options: ReadOpts = {}): SnapshotAnswer {
    this.housekeepDue();
    return this.run((tx): SnapshotAnswer => {
      const now = this.time(tx);
      const no = this.readError(actor, log, options, now);
      if (no) return no;
      const u = this.userOf(actor);
      const lastSeq = this.lastSeq(tx, u, options.clientId, now);
      if (!logS.safeParse(log).success)
        return { records: [], cursor: "", lastSeq, serverTime: now };
      if (this.closedTo(log, u))
        return { records: [], cursor: this.serve(tx, log, u, 0, now), lastSeq, serverTime: now };
      const tiers = this.tiers(tx, log, u, now, options);
      const records: Snapshot["records"] = [];
      let version = 0;
      for (const row of tx.logAfter(log, 0)) {
        const v = this.readRow(tx, row, u);
        if (v === null) continue;
        version = Math.max(version, row.version);
        if (v === true) continue;
        if (!this.served(tx, v, tiers, options.threads !== undefined)) continue;
        records.push({ key: row.key, record: v });
      }
      const born = (key: string) => tx.born(key) ?? 0;
      records.sort((a, b) => {
        const x = pkg.createdOf(a.record);
        const y = pkg.createdOf(b.record);
        return x < y ? -1 : x > y ? 1 : born(a.key) - born(b.key);
      });
      // a hydration (`threads`) does not move the log's cursor
      const cursor = this.serve(tx, log, u, version, now);
      // the threads served as summaries (review round 1 of phase 1)
      const summaries =
        tiers && options.threads === undefined ? { summaries: [...tiers.summary].sort() } : {};
      return {
        records,
        cursor,
        lastSeq,
        serverTime: now,
        ...summaries,
        ...this.extras(tx, log, u),
      };
    });
  }

  /** The changes of `log` for `actor` since `cursor`, as `snapshot` answers
   * which readers. */
  pull(actor: Actor, log: LogId, cursor: Cursor, options?: ReadOptions): Pull;
  pull(
    actor: null,
    log: `space:${string}` | "catalog",
    cursor: Cursor,
    options?: ReadOptions,
  ): Pull;
  pull(actor: Actor | null, log: LogId, cursor: Cursor, options?: ReadOpts): PullAnswer;
  pull(actor: Actor | null, log: LogId, cursor: Cursor, options: ReadOpts = {}): PullAnswer {
    this.housekeepDue();
    return this.run((tx): PullAnswer => {
      const now = this.time(tx);
      const o = this.openCursor(tx, actor, log, cursor, now, options);
      if ("error" in o) return o.error;
      // (a pull is never skipped: it passes no `before`)
      if (!("c" in o)) return { resync: true, serverTime: now };
      const { u, c } = o;
      const lastSeq = this.lastSeq(tx, u, options.clientId, now);
      if (o.closed)
        return { changes: [], cursor: this.serve(tx, log, u, 0, now), lastSeq, serverTime: now };
      const tiers = this.tiers(tx, log, u, now, options);
      const changes: Change[] = [];
      const summaries = new Set<string>();
      let to = c.v;
      for (const row of tx.logAfter(log, c.v)) {
        const v = this.readRow(tx, row, u);
        if (v === null) continue;
        to = row.version;
        if (v === true) changes.push({ key: row.key, op: "del" });
        else {
          if (this.served(tx, v, tiers, false))
            changes.push({ key: row.key, op: "put", record: v });
          // a summary thread with a row after the cursor, served or withheld
          // (review round 2 of phase 1, finding 6)
          const th = tiers ? threadOf(v, (k) => tx.get(k)) : null;
          if (th !== null && tiers?.summary.has(th)) summaries.add(th);
        }
      }
      return {
        changes,
        cursor: this.serve(tx, log, u, to, now),
        lastSeq,
        serverTime: now,
        ...(tiers ? { summaries: [...summaries].sort() } : {}),
        ...this.extras(tx, log, u),
      };
    });
  }

  /** The checks that open `cursor` for a read of `log` by `actor`, shared
   * by `pull` and the streams' `streamPull` (review round 2 of phase 2,
   * finding 4): a read the server does not serve (`error`: `pull` answers
   * it, a stream resyncs); a log that is not one, or a token that does not
   * open, is another reader's or log's, is of another epoch, is older than
   * the tombstones, was served by another database or by this one before a
   * restore (its instance id), or names a head the database has not
   * reached, or a reader whose scope changed since it was served (`resync`);
   * else the reader, the token's state and whether the log is closed to
   * the reader (another person's user log: served empty). `before`, when
   * given, runs after the first two checks and before the token is opened:
   * a stream's `skip`. */
  private openCursor(
    tx: StoreTx,
    actor: Actor | null,
    log: LogId,
    cursor: Cursor,
    now: number,
    options: ReadOpts,
    before?: (u: string | null) => boolean,
  ):
    | { error: ReadError }
    | { resync: true }
    | { skip: true }
    | { u: string | null; c: CursorState; closed: boolean } {
    const error = this.readError(actor, log, options, now);
    if (error) return { error };
    const u = this.userOf(actor);
    if (!logS.safeParse(log).success) return { resync: true };
    if (before?.(u)) return { skip: true };
    const c = this.tokens.open(cursor, now);
    if (
      c === null ||
      c.log !== log ||
      c.u !== u ||
      c.n !== tx.epoch(log).n ||
      c.at < now - TOMBSTONE_TTL ||
      // served by another database, or by this one before a restore
      c.i !== this.instance(tx) ||
      c.h > tx.head()
    )
      return { resync: true };
    if (this.closedTo(log, u)) return { u, c, closed: true };
    if (u !== null && this.scopeChanged(tx, log, u, c.v, c.h)) return { resync: true };
    return { u, c, closed: false };
  }

  /** Whether what `u` may read of `log` changed after the token at `version`
   * was served (the head then `head`) in a way the log's rows do not carry:
   * `u`'s own membership or role in the space; for `u`'s user log, `u`'s
   * membership or role in any space, or a space opening or closing that a
   * record of the log is about. */
  private scopeChanged(tx: StoreTx, log: LogId, u: string, version: number, head: number): boolean {
    if (log.startsWith("space:")) {
      const mine = tx.logGet(log, pkg.memberKey(log.slice(6), u));
      return mine !== undefined && mine.version > version;
    }
    if (!log.startsWith("user:")) return false;
    for (const row of tx.logAfter(log, version)) if (row.key.startsWith("member:")) return true;
    if (tx.head() === head) return false;
    // the whole log is read only when a space opened or closed since the
    // token was served (review round 2 of phase 1: the cost of every pull)
    const moved = new Set(tx.epochsAfter(head));
    if (!moved.size) return false;
    const g = readerOf(tx);
    for (const row of tx.logAfter(log, 0)) {
      const rec = tx.get(row.key);
      const a = rec ? pkg.audience(g, rec) : tx.tombGet(row.key);
      if (a && a.sp !== null && moved.has(`space:${a.sp}`)) return true;
    }
    return false;
  }

  /** Whether `u` may read the in-flight text of run `run` now: they read the
   * run, and its node (the thread, or the follow-up) reads unredacted for
   * them, as `runs.claim` decides a turn (review round 2 of phase 1, H1). */
  readsRunText(run: string, u: string | null): boolean {
    return this.run((tx) => {
      const r = tx.get(`run:${run}`);
      return r?.kind === "run" && this.online.textShown(tx, r, u);
    });
  }

  /** What `pull` would answer each stream (`StreamPull`), reduced to what
   * a stream uses: resync (the token does not open, or the reader's scope
   * changed), or its new cursor and whether anything changed; or nothing
   * to do (`skip`), when the reader may read none of the commit's rows of
   * the log (`keys`). The read check is part of the pull (phase 2a design
   * finding 1), and all the streams of a commit are served in one
   * transaction, in which each log row, record and tombstone is read once
   * however many streams read it (design finding 2): what differs by
   * reader is only the view of a record and the token. */
  streamPulls(reqs: readonly StreamPull[]): StreamPullAnswer[] {
    if (!reqs.length) return [];
    this.housekeepDue();
    return this.run((tx) => {
      const now = this.time(tx);
      const m = memoTx(tx);
      return reqs.map((q) => this.streamPull(m, q, now));
    });
  }

  private streamPull(tx: StoreTx, q: StreamPull, now: number): StreamPullAnswer {
    const { actor, log, keys } = q;
    // a commit whose rows of this log the reader may not read: no pull
    // (report-1b finding 1). A change of the reader's own scope writes a row
    // they read, and a replaced history names no keys, so neither is skipped.
    const unread = (u: string | null) =>
      !!keys &&
      !(actor !== null && u === null) &&
      ![...keys].some((key) => {
        const row = tx.logGet(log, key);
        return row !== undefined && this.readRow(tx, row, u) !== null;
      });
    const o = this.openCursor(tx, actor, log, q.cursor, now, {}, unread);
    if ("skip" in o) return o;
    if ("error" in o || "resync" in o) return { resync: true };
    const { u, c } = o;
    if (o.closed) return { cursor: this.serve(tx, log, u, 0, now), changed: false };
    let to = c.v;
    let changed = false;
    for (const row of tx.logAfter(log, c.v)) {
      if (this.readRow(tx, row, u) === null) continue;
      to = row.version;
      changed = true;
    }
    return { cursor: this.serve(tx, log, u, to, now), changed };
  }

  /** How many spaces each of `handles` wrote a thread in, for a profile
   * (`/api/users`): over the `thread.u` index; a removed thread's
   * placeholder and an erased one are not counted (phase 2a design finding
   * 7, review round 1 of phase 2). Counts closed spaces too, as the mock's
   * profile does. */
  authorSpaces(handles: readonly string[]): Record<string, number> {
    return this.run((tx) => {
      const out: Record<string, number> = {};
      for (const u of handles) {
        const spaces = new Set<string>();
        for (const r of tx.scan("thread", "u", u))
          if (r.kind === "thread" && r.u === u && r.mod !== "removed" && !r.gone) spaces.add(r.s);
        out[u] = spaces.size;
      }
      return out;
    });
  }

  /** The spaces `actor` may find (phase 2b: the web's space directory, `GET
   * /api/spaces`): every open and listed space that is not deleted, and the
   * unlisted ones they are a member of, by name; with the stats record of
   * each space whose content they read. A space record is public
   * (`readsAudience`); an unlisted one is found only through a link or a
   * membership, so it is listed to its members only. */
  directory(actor: Actor | null): Directory {
    const u = this.userOf(actor);
    return this.run((tx) => {
      const g = readerOf(tx);
      const found = new Map<string, pkg.SpaceRec>();
      const add = (r: pkg.StoredRecord | undefined) => {
        if (r?.kind === "space" && !r.deleted) found.set(r.id, r);
      };
      for (const vis of ["open", "listed"]) for (const r of tx.scan("space", "vis", vis)) add(r);
      if (u !== null)
        for (const m of tx.scan("member", "u", u))
          if (m.kind === "member") add(tx.get(pkg.spaceKey(m.sp)));
      const spaces = [...found.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      const stats: pkg.StatsRec[] = [];
      for (const s of spaces) {
        if (!pkg.readsSpace(g, s.id, u)) continue;
        const st = tx.get(pkg.statsKey(s.id));
        if (st?.kind === "stats") stats.push(st);
      }
      return { spaces, stats, serverTime: this.clockNow() };
    });
  }

  /** A space found by its name, as a link to it (`/s/<name>`) shows it: an
   * open or listed space's record, which the directory lists too; an
   * unlisted space's name only, unless the reader is a member (the mockup:
   * "an unlisted space opened without access shows its name and nothing
   * else"). Null: no such space, or deleted. */
  spaceNamed(
    name: string,
    actor: Actor | null,
  ): pkg.SpaceRec | Pick<pkg.SpaceRec, "kind" | "id" | "name" | "vis" | "av"> | null {
    const u = this.userOf(actor);
    return this.run((tx) => {
      const s = tx.scan("space", "name", name).find((r) => r.kind === "space" && !r.deleted);
      if (s?.kind !== "space") return null;
      if (s.vis !== "unlisted") return s;
      const m = u === null ? undefined : tx.get(pkg.memberKey(s.id, u));
      if (m?.kind === "member") return s;
      return { kind: "space", id: s.id, name: s.name, vis: s.vis, av: s.av };
    });
  }

  /** The invite link with this code, for its landing page: anyone who has
   * the code may see the space's public record (its name, description,
   * rules), as a closed space's join card shows them. Null: no such link. */
  invite(code: string): InviteView | null {
    return this.run((tx) => {
      const link = tx.scan("invite", "code", code)[0];
      if (link?.kind !== "invite") return null;
      const s = tx.get(pkg.spaceKey(link.sp));
      if (s?.kind !== "space" || s.deleted) return null;
      const role = (u: string) => {
        const m = tx.get(pkg.memberKey(s.id, u));
        return m?.kind === "member" ? m.role : null;
      };
      const r = role(link.by);
      // who may invite: moderators and up; in a closed space whose invite
      // setting is "members", its members (the mutators' mayInvite)
      const mayInvite =
        (r !== null && r !== "member") ||
        (s.vis !== "open" && s.invite === "members" && r !== null);
      const now = this.clockNow();
      const live =
        link.dead === null &&
        link.revokedAt === null &&
        (link.expiresAt === null || Date.parse(link.expiresAt) > now) &&
        mayInvite;
      return {
        space: s,
        by: link.by,
        expiresAt: link.expiresAt,
        state: live ? "live" : "expired",
        serverTime: now,
      };
    });
  }

  /** A stored record as `u` may read it now, or null. */
  viewOf(key: string, u: string | null): pkg.StoredRecord | null {
    return this.run((tx) => {
      const r = tx.get(key);
      return r ? pkg.view(readerOf(tx), r, u) : null;
    });
  }

  // ---- inspection (tests and operators) ----

  /** The stored records, by key. */
  records(): Map<string, pkg.StoredRecord> {
    return this.store.records();
  }

  logRows(log: LogId): LogRow[] {
    this.housekeepDue();
    return this.run((tx) => tx.logAfter(log, 0));
  }

  /** Expire everything past its lifetime now (tests: the storage scan). */
  housekeepAll() {
    this.run((tx) => this.housekeep(tx, this.time(tx), true));
  }
}

export { ID_TAKEN };
