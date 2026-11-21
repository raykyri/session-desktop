// The server half of the sync core in this process (`01` §4.2, S5, Y7, Y8):
// `SyncServer` over `SqliteStore`, the event streams it wakes after every
// commit, the hourly retention job, and the drain.

import { auth, SqliteStore, type SessionDatabase } from "@session/db";
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
  #retention: ReturnType<typeof setInterval> | null = null;
  readonly #logger: Logger | undefined;
  readonly #killAfter: string | undefined;
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
    if (
      this.#killAfter !== undefined &&
      (envelope as { name?: unknown } | null)?.name === this.#killAfter
    )
      process.kill(process.pid, "SIGKILL");
  }

  constructor(options: SyncServiceOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.#logger = options.logger;
    this.clientIdleTtl = options.clients?.idleTtl ?? CLIENT_IDLE_TTL;
    this.#killAfter = options.killAfterCommit;
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
      ...(options.expireEveryCall ? { expireEveryCall: true } : {}),
      ...(options.clients ? { clients: options.clients } : {}),
    });
    hub = new SyncHub({
      server: this.server,
      ids: new EventIds(options.config.sync.cursorKeys, () => this.clock.now()),
      ...(options.logger ? { logger: options.logger } : {}),
      sessionValid: (token) => auth.readSession(options.db, token) !== null,
    });
    this.hub = hub;
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

  /** The hourly retention job (`01` Y8), started after boot. */
  startMaintenance(): void {
    if (this.#retention) return;
    const run = () => {
      try {
        this.server.retain();
      } catch (error) {
        this.#logger?.error({ error }, "sync retention failed");
      }
    };
    run();
    this.#retention = setInterval(run, RETENTION_INTERVAL_MS);
    this.#retention.unref?.();
  }

  /** `SIGTERM` (`01` S5): later envelopes answer SERVICE_UNAVAILABLE
   * (unrecorded, so outboxes resend them after the restart) and the streams
   * close. Commits are synchronous, so none is open across the signal. */
  drain(): void {
    this.draining = true;
    if (this.#retention) clearInterval(this.#retention);
    this.#retention = null;
    this.hub.closeAll("draining");
  }
}
