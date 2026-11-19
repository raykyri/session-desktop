// Helpers of the client tests: a client over a test world's server, a
// transport that forces answers, a SQLite driver over Node's SQLite, and
// waits.

import { DatabaseSync } from "node:sqlite";

import {
  InProcessTransport,
  SyncClient,
  type Answer,
  type ClientOptions,
  type Envelope,
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

/** A transport that answers the next pushes from `queue` (an answer, null
 * for none, or "pass" to the server), and records every envelope. */
export class Forced implements Transport {
  queue: (Answer | null | "pass")[] = [];
  private next(): Answer | null | "pass" {
    return this.queue.length ? (this.queue.shift() as Answer | null | "pass") : "pass";
  }
  pushes: Envelope[] = [];
  constructor(private readonly inner: Transport) {}
  register = () => this.inner.register();
  pull: Transport["pull"] = (l, c, o) => this.inner.pull(l, c, o);
  snapshot: Transport["snapshot"] = (l, o) => this.inner.snapshot(l, o);
  listen: Transport["listen"] = (c, e, s) => this.inner.listen(c, e, s);
  call: Transport["call"] = (n, i) => this.inner.call(n, i);
  async push(es: readonly Envelope[]) {
    const out: (Answer | null)[] = [];
    for (const e of es) {
      this.pushes.push(JSON.parse(JSON.stringify(e)) as Envelope);
      const f = this.next();
      if (f === "pass") out.push(...(await this.inner.push([e])));
      else out.push(f);
      if (out.at(-1) === null) break;
    }
    return out;
  }
}

export const fail = (code: string, serverTime = 0, extra: object = {}): Answer =>
  ({ ok: false, error: { code, message: code, ...extra }, serverTime }) as Answer;

/** `SqliteDriver` over Node's SQLite, as Tauri's plugin is shaped. */
export function nodeSqlite(): SqliteDriver {
  const db = new DatabaseSync(":memory:");
  return {
    execute: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
      return Promise.resolve();
    },
    select: <T>(sql: string, params: unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as never[])) as T[]),
  };
}

/** Let `n` rounds of pending callbacks run. */
export const tick = (n = 20) =>
  new Promise<void>((r) => {
    let k = 0;
    const f = () => (++k >= n ? r() : setImmediate(f));
    f();
  });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
