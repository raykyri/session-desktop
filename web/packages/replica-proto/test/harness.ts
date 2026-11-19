// The suite's only link to an implementation is `makeServer`. A later server
// half runs this suite by exporting a `ServerFactory` here instead.

import type { ExecutionContext } from "ava";

import {
  PROTOCOL_VERSION,
  ReplicaClient,
  createProtoServer,
  ulid,
  type Actor,
  type ApplyResult,
  type Clock,
  type Envelope,
  type ErrorCode,
  type ServerFactory,
  type ServerOptions,
  type StoredRecord,
  type TestServer,
} from "../src/index.js";
import { USE_PACKAGE } from "../src/switch.js";

import { modOf } from "./oracle.js";
import { syncFactory } from "./sync-server.js";

/** The server under test: the prototype's, or with REPLICA_PROTO_SERVER
 * set `@session/sync`'s server half over its memory or SQLite store (with
 * the package's mutators, REPLICA_PROTO_MUTATORS=package). */
const SERVER = process.env["REPLICA_PROTO_SERVER"];
if (SERVER !== undefined && !USE_PACKAGE)
  throw new Error("REPLICA_PROTO_SERVER needs REPLICA_PROTO_MUTATORS=package");
/** Whether the server under test is `@session/sync`'s. */
export const SYNC_SERVER = SERVER === "sync-memory" || SERVER === "sync-sqlite";
export const makeServer: ServerFactory =
  SERVER === "sync-memory"
    ? syncFactory("memory")
    : SERVER === "sync-sqlite"
      ? syncFactory("sqlite")
      : createProtoServer;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export class ManualClock implements Clock {
  constructor(public ms = Date.parse("2026-11-16T10:00:00Z")) {}
  now() {
    return this.ms;
  }
  advance(ms: number) {
    this.ms += ms;
  }
}

/** mulberry32: a seeded generator for fixed-seed runs. */
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

export const actor = (u: string | null): Actor | null => (u === null ? null : { u });

export class World {
  readonly clock = new ManualClock();
  readonly random: () => number;
  readonly server: TestServer;

  /** `options` replaces server options: a random source that fails, or a set
   * of mutators with a faulty one. */
  constructor(seed = 1, options: Partial<Omit<ServerOptions, "clock">> = {}) {
    this.random = rng(seed);
    this.server = makeServer({ clock: this.clock, random: rng(seed ^ 0x5eed), ...options });
  }

  /** A client-made ULID at the current time, or `offset` ms from it. */
  id(offset = 0): string {
    return ulid(this.clock.now() + offset, this.random);
  }

  /** The client id each person writes with in `as` and `envelope`. */
  private readonly clientIds = new Map<string, string>();

  /** `u`'s default client id, registered on first use; "" when the server
   * registers none (a signed-out caller, a reserved handle). */
  async clientId(u: string | null): Promise<string> {
    if (u === null) return "";
    const known = this.clientIds.get(u);
    if (known !== undefined) return known;
    const r = await this.server.register(actor(u));
    const id = r.ok ? r.clientId : "";
    if (r.ok) this.clientIds.set(u, id);
    return id;
  }

  /** The next seq of `u`'s default client, as the server reports it, so a
   * test may also send that client's envelopes with `server.apply`. */
  async nextSeq(u: string | null, clientId: string): Promise<number> {
    if (u === null || clientId === "") return 1;
    const s = await this.server.snapshot(actor(u), `user:${u}`, { clientId });
    return (s.lastSeq ?? 0) + 1;
  }

  /** An envelope from `u`'s default client, with its next seq, sent now
   * from a device whose clock is the server's. */
  async envelope(
    u: string | null,
    name: string,
    input: unknown,
    mutationId = this.id(),
  ): Promise<Envelope> {
    const clientId = await this.clientId(u);
    const seq = await this.nextSeq(u, clientId);
    return {
      clientId,
      seq,
      mutationId,
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: this.clock.now(),
    };
  }

  /** Apply one write as `u` now, from `u`'s default client. */
  async as(
    u: string | null,
    name: string,
    input: unknown,
    mutationId?: string,
  ): Promise<ApplyResult> {
    return this.server.apply(actor(u), await this.envelope(u, name, input, mutationId));
  }

  /** Send an envelope again as `u` (a replay keeps its seq; `fresh` gives it
   * the client's next one instead), from a device whose clock is the
   * server's now. */
  async resend(u: string | null, e: Envelope, fresh = false): Promise<ApplyResult> {
    const seq = fresh ? await this.nextSeq(u, e.clientId) : e.seq;
    return this.server.apply(actor(u), { ...e, seq, clientTime: this.clock.now() });
  }

  /** One pass of the server's effect worker. */
  async work(): Promise<number> {
    return this.server.work();
  }

  client(u: string | null): ReplicaClient {
    return new ReplicaClient(this.server, actor(u), { clock: this.clock, random: this.random });
  }

  get(key: string): StoredRecord | undefined {
    return this.server.dump().get(key);
  }

  /** An item's moderation state as the server stores it: its `mod`, or with
   * the switch on "hidden" when a hide record names it. */
  mod(key: string): "hidden" | "removed" | null {
    const r = this.get(key) as { kind: string; id: string; mod: string | null } | undefined;
    return r ? modOf(this.server.dump(), r) : null;
  }

  /** A stored record's rev, or 0 when there is none: what a client that
   * read the record now puts in a write's `base`. */
  rev(key: string): number {
    return this.get(key)?.rev ?? 0;
  }

  /** `base` of a role change of `u` in `sp`, as the member record is now. */
  member(sp: string, u: string): { rev: number } {
    return { rev: this.rev(`member:${sp}:${u}`) };
  }

  /** `base` of a removal of `u` from `sp`: the admission id as it is now
   * ("" for a person who is not a member). */
  admission(sp: string, u: string): { adm: string } {
    const m = this.get(`member:${sp}:${u}`);
    return { adm: m?.kind === "member" ? m.adm : "" };
  }

  /** `base` of a moderation decision on `item`, as the item is now: its
   * rev, or with the switch on its hide record's (phase 1b, Part 0 item 3). */
  item(item: string): { rev: number } {
    const [k, th, sub] = item.split(":");
    const key = k === "f" ? `followup:${sub}` : k === "r" ? `reply:${sub}` : `thread:${th ?? ""}`;
    return { rev: this.rev(USE_PACKAGE ? `hide:${key}` : key) };
  }

  /** `base` of a decision on the join requests of `users` in `sp`, as they are now. */
  requests(sp: string, users: string[]): Record<string, number> {
    return Object.fromEntries(users.map((u) => [u, this.rev(`request:${sp}:${u}`)]));
  }
}

export async function ok(
  t: ExecutionContext,
  res: ApplyResult | Promise<ApplyResult>,
): Promise<unknown> {
  const r = await res;
  if (!r.ok) t.fail(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.ok ? r.result : undefined;
}

export async function refused(
  t: ExecutionContext,
  res: ApplyResult | Promise<ApplyResult>,
  code: ErrorCode,
): Promise<string> {
  const r = await res;
  if (r.ok) t.fail(`expected ${code}, got ok`);
  else t.is(r.error.code, code, JSON.stringify(r.error));
  return JSON.stringify(r.ok ? null : r.error);
}

/** A fixed cast of people and spaces most tests start from:
 * - `open` (#lounge): owner olga, moderator mona, members mel and otto.
 * - `closed` (#lab, listed, join by request, members may make invite links):
 *   owner olga, admin ada, moderator mona, member mel.
 * - `vault` (#vault, unlisted, invite only): owner olga.
 * Nobody else is a member of anything. `eve` is the hostile client. */
export interface Cast {
  w: World;
  open: string;
  closed: string;
  vault: string;
}

export async function cast(
  t: ExecutionContext,
  seed = 1,
  options: Partial<Omit<ServerOptions, "clock">> = {},
): Promise<Cast> {
  const w = new World(seed, options);
  const open = w.id();
  const closed = w.id();
  const vault = w.id();
  await ok(t, w.as("olga", "spaces.create", { id: open, name: "lounge" }));
  await ok(
    t,
    w.as("olga", "spaces.create", {
      id: closed,
      name: "lab",
      vis: "listed",
      policy: "request",
      invite: "members",
    }),
  );
  await ok(
    t,
    w.as("olga", "spaces.create", { id: vault, name: "vault", vis: "unlisted", policy: "invite" }),
  );
  for (const u of ["mona", "mel", "otto"]) await ok(t, w.as(u, "spaces.join", { space: open }));
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: open,
      user: "mona",
      role: "mod",
      base: w.member(open, "mona"),
    }),
  );
  for (const u of ["ada", "mona", "mel"]) await admit(t, w, closed, u);
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "ada",
      role: "admin",
      base: w.member(closed, "ada"),
    }),
  );
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "mona",
      role: "mod",
      base: w.member(closed, "mona"),
    }),
  );
  return { w, open, closed, vault };
}

/** Let `u` into a closed space: a request, approved by its owner olga. */
export async function admit(t: ExecutionContext, w: World, space: string, u: string) {
  await ok(t, w.as(u, "joinRequests.create", { space, rulesAccepted: true }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space,
      users: [u],
      decision: "approve",
      base: w.requests(space, [u]),
    }),
  );
}

export async function thread(
  t: ExecutionContext,
  w: World,
  u: string,
  space: string,
  kind: "ask" | "post" = "ask",
  q = "What changed?",
): Promise<string> {
  const id = w.id();
  await ok(t, w.as(u, "threads.create", { id, space, kind, q }));
  return id;
}

/** The keys and records of a replica or a snapshot, sorted, for comparison. */
export const sorted = (m: ReadonlyMap<string, StoredRecord>) =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
