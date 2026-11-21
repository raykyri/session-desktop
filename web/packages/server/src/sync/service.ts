// The server half of the sync core in this process (`01` §4.2, S5, Y7, Y8):
// `SyncServer` over `SqliteStore`, the event streams it wakes after every
// commit, the hourly retention job (with a WAL checkpoint, `01` D4), the
// heartbeat that tells operator jobs a server has the database open
// (`@session/db` `running.ts`), and the drain.

import {
  HEARTBEAT_INTERVAL_MS,
  auth,
  writeHeartbeat,
  SqliteStore,
  type SessionDatabase,
} from "@session/db";
import { MUTATORS, type AnyMutator, type RunRec } from "@session/mutators";
import { CLIENT_IDLE_TTL, SyncServer, type Clock } from "@session/sync/server";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

import { EventIds } from "./eventIds.js";
import { SyncHub } from "./hub.js";

/** The retention job runs this often (`01` Y8). */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncServiceOptions {
  db: SessionDatabase;
  config: Pick<Config, "sync">;
  logger?: Logger;
  /** The server's clock; `Date.now` when absent. */
  clock?: Clock;
  /** The server's random source; Web Crypto when absent. */
  random?: () => number;
  /** The mutator set; `@session/mutators`' when absent. */
  mutators?: Readonly<Record<string, AnyMutator>>;
  /** As `SyncServerOptions`: the acceptance suite's figures. */
  expireEveryCall?: boolean;
  clients?: { idleTtl?: number; perDay?: number };
  /** Test faults (`main.ts` `testFaults`): the process kills itself inside
   * the commit of a write of this mutator, after its stages ran. */
  killBeforeCommit?: string;
  /** … or after the commit, before the answer is sent. */
  killAfterCommit?: string;
  /** … or at one store write inside the commit of a write of a mutator
   * (`SESSION_TEST_KILL_AT_WRITE`). */
  killAtWrite?: KillAtWrite;
  /** The interval timers of the heartbeat and the retention job; the
   * global ones when absent. A test passes its own, with `clock`, to step
   * time. */
  timers?: IntervalTimers;
}

/** A handle `IntervalTimers.set` returns. */
export interface IntervalHandle {
  unref?(): unknown;
}

/** `setInterval` and `clearInterval`, as the service uses them. */
export interface IntervalTimers {
  set(run: () => void, ms: number): IntervalHandle;
  clear(handle: IntervalHandle): void;
}

const GLOBAL_TIMERS: IntervalTimers = {
  set: (run, ms) => setInterval(run, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A store write to kill the process at: before or after the first call of
 * `method` (with a key that starts with `key`, when given) while a write of
 * `mutator` is applied. */
export interface KillAtWrite {
  mutator: string;
  when: "before" | "after";
  method: (typeof STORE_WRITES)[number];
  key?: string;
}

/** The `SqliteStore` methods that write. */
export const STORE_WRITES = [
  "putRecord",
  "deleteRecord",
  "setLastRev",
  "putTombstone",
  "deleteTombstone",
  "nextVersion",
  "putLogRow",
  "putClient",
  "putAnswer",
  "putSeqAnswer",
] as const;

/** `SESSION_TEST_KILL_AT_WRITE`: `<mutator> <before|after> <method> [key
 * prefix]`, or null when it is not one. */
export function parseKillAtWrite(value: string): KillAtWrite | null {
  const [mutator, when, method, key] = value.trim().split(/\s+/);
  if (!mutator || (when !== "before" && when !== "after")) return null;
  if (!(STORE_WRITES as readonly string[]).includes(method ?? "")) return null;
  return {
    mutator,
    when,
    method: method as KillAtWrite["method"],
    ...(key ? { key } : {}),
  };
}

export class SyncService {
  readonly store: SqliteStore;
  readonly server: SyncServer;
  readonly hub: SyncHub;
  readonly clock: Clock;
  /** How long a client id lives idle (`01` Y3). */
  readonly clientIdleTtl: number;
  /** Set by the drain: every later envelope answers SERVICE_UNAVAILABLE. */
  draining = false;
  #retention: IntervalHandle | null = null;
  #heartbeat: IntervalHandle | null = null;
  readonly #timers: IntervalTimers;
  readonly #logger: Logger | undefined;
  readonly #killAfter: string | undefined;
  readonly #killAt: KillAtWrite | undefined;
  /** Whether a write of `killAtWrite.mutator` is being applied. */
  #armed = false;

  /** Called by the apply route before an envelope is applied: arms the
   * at-write test fault (`killAtWrite`) for a write of its mutator. */
  beforeApply(envelope: unknown): void {
    this.#armed =
      this.#killAt !== undefined &&
      (envelope as { name?: unknown } | null)?.name === this.#killAt.mutator;
  }

  readonly #recordListeners = new Set<(keys: ReadonlySet<string>) => void>();

  /** Called after every commit with the record keys it wrote or deleted:
   * the run store watches its runs being cancelled, retried or removed and
   * new runs being queued (`03` E1, E2, E4). Returns the unsubscribe. */
  onRecords(listener: (keys: ReadonlySet<string>) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /** The after-commit test fault (`killAfterCommit`), called by the apply
   * route once a write is answered and before the answer is sent. */
  afterApply(envelope: unknown): void {
    this.#armed = false;
    if (
      this.#killAfter !== undefined &&
      (envelope as { name?: unknown } | null)?.name === this.#killAfter
    )
      process.kill(process.pid, "SIGKILL");
  }

  constructor(options: SyncServiceOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.#timers = options.timers ?? GLOBAL_TIMERS;
    this.#logger = options.logger;
    this.clientIdleTtl = options.clients?.idleTtl ?? CLIENT_IDLE_TTL;
    this.#killAfter = options.killAfterCommit;
    this.#killAt = options.killAtWrite;
    let mutators = options.mutators ?? MUTATORS;
    const killBefore = options.killBeforeCommit;
    const def = killBefore === undefined ? undefined : mutators[killBefore];
    if (killBefore !== undefined && def) {
      const kill = () => process.kill(process.pid, "SIGKILL");
      mutators = {
        ...mutators,
        [killBefore]: def.notify
          ? {
              ...def,
              notify: (...a: Parameters<NonNullable<AnyMutator["notify"]>>) => (
                def.notify?.(...a),
                kill()
              ),
            }
          : { ...def, run: (...a: Parameters<AnyMutator["run"]>) => (def.run(...a), kill()) },
      };
    }
    // the store wakes the streams after each commit; the hub exists by then
    let hub: SyncHub | null = null;
    this.store = new SqliteStore(options.db, {
      now: () => this.clock.now(),
      onCommit: (logs, keys) => {
        hub?.wake(logs);
        for (const listener of this.#recordListeners) listener(keys);
      },
    });
    this.server = new SyncServer({
      store: this.store,
      clock: this.clock,
      ...(options.random ? { random: options.random } : {}),
      mutators,
      cursorKeys: options.config.sync.cursorKeys,
      window: options.config.sync.window,
      minProtocol: options.config.sync.minProtocol,
      ...(options.expireEveryCall ? { expireEveryCall: true } : {}),
      ...(options.clients ? { clients: options.clients } : {}),
    });
    // the read-only check: `readSession` renews the session's idle time,
    // which a stream left open must not do
    hub = new SyncHub({
      server: this.server,
      ids: new EventIds(options.config.sync.cursorKeys, () => this.clock.now()),
      ...(options.logger ? { logger: options.logger } : {}),
      sessionValid: (token) => auth.sessionIsLive(options.db, auth.hashSessionToken(token)),
      history: () => this.store.history(),
    });
    this.hub = hub;
    if (this.#killAt) this.#trapWrites(this.#killAt);
  }

  /** The at-write test fault: the store's write methods kill the process at
   * the named write while an armed write is applied. */
  #trapWrites(at: KillAtWrite) {
    const store = this.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    const original = store[at.method]?.bind(this.store);
    if (!original) return;
    store[at.method] = (...a: unknown[]) => {
      const hit =
        this.#armed &&
        (at.key === undefined || (typeof a[0] === "string" && a[0].startsWith(at.key)));
      if (hit && at.when === "before") process.kill(process.pid, "SIGKILL");
      const out = original(...a);
      if (hit && at.when === "after") process.kill(process.pid, "SIGKILL");
      return out;
    };
  }

  /** Boot (`01` S5, `03` E2): every run still `running` after a crash
   * becomes `interrupted { why: "interrupted" }`, through `serverApply`, so
   * replicas pull the change. Returns how many. */
  interruptRunning(): number {
    const keys = this.store.sqlite
      .prepare<[], { key: string }>(
        "SELECT key FROM records WHERE kind = 'run' AND json_extract(body, '$.status') = 'running'",
      )
      .all()
      .map((r) => r.key);
    if (!keys.length) return 0;
    const res = this.server.serverApply({ me: "", mutationId: "" }, (tx) => {
      let n = 0;
      for (const key of keys) {
        const r = tx.byKey(key);
        if (r?.kind !== "run" || r.status !== "running") continue;
        const run: RunRec = {
          ...r,
          status: "interrupted",
          fail: { why: "interrupted", at: null, cls: null },
          finishedAt: tx.now,
        };
        tx.put(run);
        // the root thread's `running` follows its run
        const th = run.node === "r" ? tx.byKey(`thread:${run.th}`) : undefined;
        if (th?.kind === "thread" && th.running) tx.put({ ...th, running: false });
        n += 1;
      }
      return n;
    });
    if (!res.ok) throw new Error(`could not mark running runs interrupted: ${res.error.code}`);
    return res.result;
  }

  /** The hourly retention job (`01` Y8), started after boot, then a
   * `wal_checkpoint(TRUNCATE)` (`01` D4): text erased since the last one
   * leaves the WAL. A checkpoint a reader blocks is logged and tried again
   * the next hour. */
  startMaintenance(): void {
    if (this.#retention) return;
    // the heartbeat: an operator job that writes records refuses while it
    // is fresh (`runbooks/delete-account.md`); the shutdown deletes it
    const beat = () => {
      try {
        writeHeartbeat(this.store.sqlite, this.clock.now());
      } catch (error) {
        this.#logger?.error({ error }, "the heartbeat write failed");
      }
    };
    beat();
    this.#heartbeat = this.#timers.set(beat, HEARTBEAT_INTERVAL_MS);
    this.#heartbeat.unref?.();
    const run = () => {
      try {
        this.server.retain();
      } catch (error) {
        this.#logger?.error({ error }, "sync retention failed");
      }
      const checkpoint = this.store.checkpoint();
      if (checkpoint?.busy) this.#logger?.info({ checkpoint }, "the WAL checkpoint was blocked");
    };
    run();
    this.#retention = this.#timers.set(run, RETENTION_INTERVAL_MS);
    this.#retention.unref?.();
  }

  /** `SIGTERM` (`01` S5): later envelopes answer SERVICE_UNAVAILABLE
   * (unrecorded, so outboxes resend them after the restart) and the streams
   * close. Commits are synchronous, so none is open across the signal. */
  drain(): void {
    this.draining = true;
    if (this.#retention) this.#timers.clear(this.#retention);
    this.#retention = null;
    // the row stays until the shutdown deletes it (`main.ts`): the drain
    // still writes records as running attempts end
    if (this.#heartbeat) this.#timers.clear(this.#heartbeat);
    this.#heartbeat = null;
    this.hub.closeAll("draining");
  }
}
