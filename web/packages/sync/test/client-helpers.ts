// Helpers of the client tests: a client over a test world's server, a
// transport that forces answers, a SQLite driver over Node's SQLite, and
// waits.

import { DatabaseSync } from "node:sqlite";

import {
  InProcessTransport,
  MemoryStorage,
  SyncClient,
  type LogId,
  type Answer,
  type ClientOptions,
  type Envelope,
  type PushResult,
  type SqliteDriver,
  type StorageAdapter,
  type Transport,
} from "../src/client/index.js";
import { openStream } from "../src/server/index.js";

import type { World } from "./helpers.js";
import { rng } from "./helpers.js";

/** A client of `u` on `w`'s server, in process, with the server's clock
 * (and its monotonic clock) unless `clock` gives the device's. No timer
 * unless `timer` gives one. */
export function client(
  w: World,
  u: string,
  o: {
    storage?: StorageAdapter;
    transport?: Transport;
    seed?: number;
    clock?: { now(): number };
  } & Partial<Pick<ClientOptions, "timer" | "persist" | "tier">> = {},
) {
  return new SyncClient({
    user: u,
    transport:
      o.transport ??
      new InProcessTransport(
        w.server,
        { u },
        {
          stream: (a, c, s) =>
            openStream(w.server, a, c, s, { setInterval: () => 0, clearInterval: () => {} }),
        },
      ),
    clock: o.clock ?? w.clock,
    monotonic: w.clock.now,
    random: rng(o.seed ?? 7),
    timer: o.timer ?? null,
    ...(o.storage ? { storage: o.storage } : {}),
    ...(o.persist !== undefined ? { persist: o.persist } : {}),
    ...(o.tier ? { tier: o.tier } : {}),
  });
}

/** A client of `u` in a later process whose clock is `skew` off, before
 * it heard from the server: an earlier process (with a right clock)
 * registered and stored `logs`, and this one opens them from storage
 * without a read. */
export async function laterProcess(
  w: World,
  u: string,
  logs: LogId[],
  skew: number,
  o: { storage?: StorageAdapter; transport?: Transport; persist?: boolean; seed?: number } = {},
) {
  const storage = o.storage ?? new MemoryStorage();
  const first = client(w, u, { storage });
  await first.init();
  for (const l of logs) await first.open(l);
  first.stop();
  const c = client(w, u, {
    storage,
    clock: { now: () => w.clock.now() + skew },
    seed: o.seed ?? 11,
    ...(o.transport ? { transport: o.transport } : {}),
    ...(o.persist !== undefined ? { persist: o.persist } : {}),
  });
  await c.init();
  for (const l of logs) await c.open(l);
  return c;
}

/** The in-process transport of `u` with the server's SSE stream. */
export const inProcess = (w: World, u: string) =>
  new InProcessTransport(
    w.server,
    { u },
    {
      stream: (a, c, s) =>
        openStream(w.server, a, c, s, { setInterval: () => 0, clearInterval: () => {} }),
    },
  );

/** A transport over `inner` whose pushes and reads can be watched. */
export function watched(
  inner: Transport,
  o: {
    push?: (es: readonly Envelope[], next: () => Promise<PushResult[]>) => Promise<PushResult[]>;
    pull?: Transport["pull"];
    snapshot?: Transport["snapshot"];
    listen?: Transport["listen"];
  } = {},
): Transport {
  return {
    register: () => inner.register(),
    push: (es) => (o.push ? o.push(es, () => inner.push(es)) : inner.push(es)),
    pull: o.pull ?? ((l, c, x) => inner.pull(l, c, x)),
    snapshot: o.snapshot ?? ((l, x) => inner.snapshot(l, x)),
    listen: o.listen ?? ((c, e, s) => inner.listen(c, e, s)),
    call: (n, i) => inner.call(n, i),
  };
}

/** A transport that answers the next pushes from `queue` (an answer, null
 * for a response that is not one, NO_RESPONSE for none, or "pass" to the
 * server), and records every envelope. */
export class Forced implements Transport {
  queue: (PushResult | "pass")[] = [];
  private next(): PushResult | "pass" {
    return this.queue.length ? (this.queue.shift() as PushResult | "pass") : "pass";
  }
  pushes: Envelope[] = [];
  constructor(private readonly inner: Transport) {}
  register = () => this.inner.register();
  pull: Transport["pull"] = (l, c, o) => this.inner.pull(l, c, o);
  snapshot: Transport["snapshot"] = (l, o) => this.inner.snapshot(l, o);
  listen: Transport["listen"] = (c, e, s) => this.inner.listen(c, e, s);
  call: Transport["call"] = (n, i) => this.inner.call(n, i);
  async push(es: readonly Envelope[]) {
    const out: PushResult[] = [];
    for (const e of es) {
      this.pushes.push(JSON.parse(JSON.stringify(e)) as Envelope);
      const f = this.next();
      if (f === "pass") out.push(...(await this.inner.push([e])));
      else out.push(f);
      const last = out.at(-1);
      if (last === null || typeof last === "string") break;
    }
    return out;
  }
}

/** A forced error answer; without `serverTime`, one the transport made up (NaN: no server time). */
export const fail = (code: string, serverTime = NaN, extra: object = {}): Answer =>
  ({ ok: false, error: { code, message: code, ...extra }, serverTime }) as Answer;

/** `SqliteDriver` over Node's SQLite, as Tauri's plugin is shaped, with
 * `batch` in one transaction; `batches` counts the calls of `batch`. */
export function nodeSqlite(): SqliteDriver & { db: DatabaseSync; batches: number } {
  const db = new DatabaseSync(":memory:");
  const d = {
    db,
    batches: 0,
    execute: (sql: string, params: unknown[] = []) => {
      db.prepare(sql).run(...(params as never[]));
      return Promise.resolve();
    },
    select: <T>(sql: string, params: unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as never[])) as T[]),
    batch: (statements: readonly (readonly [string, (readonly unknown[])?])[]) => {
      d.batches++;
      db.exec("BEGIN");
      try {
        for (const [sql, params = []] of statements) db.prepare(sql).run(...(params as never[]));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return Promise.resolve();
    },
  };
  return d;
}

/** Let `n` rounds of pending callbacks run. */
export const tick = (n = 20) =>
  new Promise<void>((r) => {
    let k = 0;
    const f = () => (++k >= n ? r() : setImmediate(f));
    f();
  });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
