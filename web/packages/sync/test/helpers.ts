// Test helpers: a server over either store with a manual clock, envelopes,
// and a small cast of people and spaces.

import { ulid, type StoredRecord } from "@session/mutators";
import type { ExecutionContext } from "ava";
import BetterSqlite from "better-sqlite3";

import {
  MemoryServerStore,
  PROTOCOL_VERSION,
  SqliteServerStore,
  SyncServer,
  newCursorKey,
  type Answer,
  type ErrorCode,
  type CursorKeys,
  type Envelope,
  type ServerStore,
  type SyncServerOptions,
} from "../src/server/index.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export class ManualClock {
  constructor(public ms = Date.parse("2026-11-16T10:00:00Z")) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

/** mulberry32: a seeded generator. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type StoreKind = "memory" | "sqlite";
export const STORES: StoreKind[] = ["memory", "sqlite"];

export const makeStore = (kind: StoreKind): ServerStore =>
  kind === "memory" ? new MemoryServerStore() : new SqliteServerStore(new BetterSqlite(":memory:"));

export class World {
  readonly clock = new ManualClock();
  readonly random: () => number;
  readonly server: SyncServer;
  readonly jobs: { kind: string; id: string }[] = [];
  readonly keys: CursorKeys;
  private readonly clients = new Map<string, string>();

  constructor(
    readonly kind: StoreKind = "memory",
    seed = 1,
    o: Partial<SyncServerOptions> = {},
  ) {
    this.random = rng(seed);
    this.keys = o.cursorKeys ?? { current: newCursorKey() };
    this.server = new SyncServer({
      store: makeStore(kind),
      clock: this.clock,
      random: rng(seed ^ 0x5eed),
      cursorKeys: this.keys,
      jobs: { start: (j) => void this.jobs.push(j) },
      ...o,
    });
  }

  id(offset = 0) {
    return ulid(this.clock.now() + offset, this.random);
  }

  clientId(u: string): string {
    let id = this.clients.get(u);
    if (id === undefined) {
      const r = this.server.register({ u });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      this.clients.set(u, (id = r.clientId));
    }
    return id;
  }

  nextSeq(u: string): number {
    const s = this.server.snapshot({ u }, `user:${u}`, { clientId: this.clientId(u) });
    return (s.lastSeq ?? 0) + 1;
  }

  envelope(u: string, name: string, input: unknown, extra: Partial<Envelope> = {}): Envelope {
    const now = this.clock.now();
    return {
      clientId: this.clientId(u),
      seq: this.nextSeq(u),
      mutationId: this.id(),
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
      replaces: [],
      ...extra,
    };
  }

  as(u: string, name: string, input: unknown, extra: Partial<Envelope> = {}): Answer {
    return this.server.apply({ u }, this.envelope(u, name, input, extra));
  }

  get(key: string): StoredRecord | undefined {
    return this.server.records().get(key);
  }

  rev(key: string) {
    return this.get(key)?.rev ?? 0;
  }
}

export function ok(t: ExecutionContext, a: Answer): unknown {
  if (!a.ok) t.fail(`expected ok, got ${JSON.stringify(a.error)}`);
  return a.ok ? a.result : undefined;
}

export function refused(t: ExecutionContext, a: Answer, code: ErrorCode) {
  if (a.ok) t.fail(`expected ${code}, got ok`);
  else t.is(a.error.code, code, JSON.stringify(a.error));
  return a.ok ? null : a.error;
}

/** #lounge (open): owner olga, moderator mona, members mel and otto; #lab
 * (closed, by request): owner olga, member mel. */
export function cast(
  t: ExecutionContext,
  kind: StoreKind = "memory",
  seed = 1,
  o: Partial<SyncServerOptions> = {},
) {
  const w = new World(kind, seed, o);
  const open = w.id();
  const closed = w.id();
  ok(t, w.as("olga", "spaces.create", { id: open, name: "lounge" }));
  ok(
    t,
    w.as("olga", "spaces.create", { id: closed, name: "lab", vis: "listed", policy: "request" }),
  );
  for (const u of ["mona", "mel", "otto"]) ok(t, w.as(u, "spaces.join", { space: open }));
  ok(
    t,
    w.as("olga", "members.setRole", {
      space: open,
      user: "mona",
      role: "mod",
      base: { rev: w.rev(`member:${open}:mona`) },
    }),
  );
  ok(t, w.as("mel", "joinRequests.create", { space: closed, rulesAccepted: true }));
  ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["mel"],
      decision: "approve",
      base: { mel: w.rev(`request:${closed}:mel`) },
    }),
  );
  return { w, open, closed };
}
