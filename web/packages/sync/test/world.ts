// A server on the in-memory store, a manual clock, and helpers to write as a
// person, for the package's tests. (`@session/replica-proto`'s suite also
// runs on this package; these tests cover what the plan adds to it.)

import { MUTATORS, type AnyMutator, type ErrorCode, type StoredRecord } from "@session/mutators";
import type { ExecutionContext } from "ava";

import {
  MemoryStore,
  PROTOCOL_VERSION,
  SyncServer,
  transportFor,
  ulid,
  type ApplyResult,
  type Clock,
  type CursorKeys,
  type Envelope,
  type SyncServerOptions,
} from "../src/server/index.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MODEL = { model: "claude-fable", effort: "medium" } as const;

export class ManualClock implements Clock {
  constructor(public ms = Date.parse("2026-11-16T10:00:00Z")) {}
  now() {
    return this.ms;
  }
  advance(ms: number) {
    this.ms += ms;
  }
}

/** mulberry32. */
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

export const actor = (u: string | null) => (u === null ? null : { u });

export class World {
  readonly clock = new ManualClock();
  readonly random = rng(1);
  readonly store = new MemoryStore();
  readonly server: SyncServer;
  private readonly clientIds = new Map<string, string>();

  constructor(
    o: {
      mutators?: Readonly<Record<string, AnyMutator>>;
      cursorKeys?: CursorKeys;
      expireEveryCall?: boolean;
      window?: SyncServerOptions["window"];
    } = {},
  ) {
    this.server = new SyncServer({
      store: this.store,
      clock: this.clock,
      random: rng(2),
      mutators: o.mutators ?? MUTATORS,
      ...(o.cursorKeys ? { cursorKeys: o.cursorKeys } : {}),
      ...(o.window ? { window: o.window } : {}),
      expireEveryCall: o.expireEveryCall ?? true,
    });
  }

  id(offset = 0): string {
    return ulid(this.clock.now() + offset, this.random);
  }

  transport(u: string | null) {
    return transportFor(this.server, actor(u));
  }

  clientId(u: string): string {
    const known = this.clientIds.get(u);
    const c = known === undefined ? undefined : this.store.client(known);
    // a client idle 7 days has expired: register again
    if (known && c && c.seen > this.clock.now() - 7 * DAY) return known;
    const r = this.server.register(actor(u));
    if (!r.ok) throw new Error(`register ${u}: ${r.error.code}`);
    this.clientIds.set(u, r.clientId);
    return r.clientId;
  }

  envelope(u: string, name: string, input: unknown, mutationId = this.id()): Envelope {
    const clientId = this.clientId(u);
    const seq = (this.store.client(clientId)?.last ?? 0) + 1;
    const now = this.clock.now();
    return {
      clientId,
      seq,
      mutationId,
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
    };
  }

  as(u: string, name: string, input: unknown, mutationId?: string): ApplyResult {
    return this.server.apply(actor(u), this.envelope(u, name, input, mutationId));
  }

  get(key: string): StoredRecord | undefined {
    return this.store.records.get(key);
  }
}

export function ok(t: ExecutionContext, r: ApplyResult): unknown {
  if (!r.ok) t.fail(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.ok ? r.result : undefined;
}

export function refused(t: ExecutionContext, r: ApplyResult, code: ErrorCode) {
  if (r.ok) t.fail(`expected ${code}, got ok`);
  else t.is(r.error.code, code, JSON.stringify(r.error));
  return r.ok ? undefined : r.error;
}

/** olga's open #lounge (members mona, mel, otto) and private #lab (ada, by
 * an invite link). */
export function cast(t: ExecutionContext, w = new World()) {
  const open = w.id();
  const closed = w.id();
  ok(t, w.as("olga", "spaces.create", { id: open, name: "lounge" }));
  ok(t, w.as("olga", "spaces.create", { id: closed, name: "lab", vis: "private" }));
  for (const u of ["mona", "mel", "otto"]) ok(t, w.as(u, "spaces.join", { space: open }));
  const link = ok(t, w.as("olga", "invites.create", { id: w.id(), space: closed, days: 7 })) as {
    code: string;
  };
  ok(t, w.as("ada", "spaces.join", { space: closed, invite: link.code }));
  return { w, open, closed };
}

export function post(t: ExecutionContext, w: World, u: string, space: string, q = "A post") {
  const id = w.id();
  ok(t, w.as(u, "threads.create", { id, space, kind: "post", q }));
  return id;
}
