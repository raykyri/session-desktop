// The suite's only link to an implementation is `makeServer`: the server half
// of `@session/sync` on its in-memory store (M2), or with
// `REPLICA_PROTO_SERVER=proto` the prototype server, kept as the reference,
// or the target a runner installs with `useTarget` before the suite's tests
// run: `@session/server`'s HTTP target over SQLite (`test/conformance/`,
// M3). A target is a `ServerFactory`: the API (`register`, `apply`,
// `snapshot`, `pull`), the clock and random source it is made with, and the
// test access of `TestServer` (the stored records, the storage scan).

import type { ExecutionContext } from "ava";

import {
  PROTOCOL_VERSION,
  ReplicaClient,
  createProtoServer,
  createSyncTestServer,
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

let target: ServerFactory | null = null;

/** Run the suite against another implementation of the server half. */
export function useTarget(factory: ServerFactory): void {
  target = factory;
}

/** The server under test. */
export const makeServer: ServerFactory = (options) =>
  (
    target ??
    (process.env["REPLICA_PROTO_SERVER"] === "proto" ? createProtoServer : createSyncTestServer)
  )(options);

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
      queuedAt: this.clock.now(),
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

  /** The notifications stored for `u`, oldest first. */
  notifs(u: string): Extract<StoredRecord, { kind: "notif" }>[] {
    return [...this.server.dump().values()]
      .filter(
        (r): r is Extract<StoredRecord, { kind: "notif" }> => r.kind === "notif" && r.to === u,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  client(u: string | null): ReplicaClient {
    return new ReplicaClient(this.server, actor(u), { clock: this.clock, random: this.random });
  }

  get(key: string): StoredRecord | undefined {
    return this.server.dump().get(key);
  }

  /** A stored record's rev, or 0 when there is none: what a client that
   * read the record now puts in a write's `base`. */
  rev(key: string): number {
    return this.get(key)?.rev ?? 0;
  }

  /** `base` of a removal of `u` from `sp`: the admission id as it is now
   * ("" for a person who is not a member). */
  admission(sp: string, u: string): { adm: string } {
    const m = this.get(`member:${sp}:${u}`);
    return { adm: m?.kind === "member" ? m.adm : "" };
  }

  /** `base` of a moderation decision on `item`, as the item is now. */
  item(item: string): { rev: number } {
    const [k, th, sub] = item.split(":");
    const key =
      k === "f"
        ? `node:${sub}`
        : k === "r"
          ? `reply:${sub}`
          : k === "c"
            ? `comment:${sub}`
            : `thread:${th ?? ""}`;
    return { rev: this.rev(key) };
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

/** The refusal's error as JSON, without `serverTime`, which every answer
 * carries (`01` Y2): two answers with the same cause compare equal. */
export async function refused(
  t: ExecutionContext,
  res: ApplyResult | Promise<ApplyResult>,
  code: ErrorCode,
): Promise<string> {
  const r = await res;
  if (r.ok) t.fail(`expected ${code}, got ok`);
  else t.is(r.error.code, code, JSON.stringify(r.error));
  const b = bare(r);
  return JSON.stringify(b.ok ? null : b.error);
}

/** An answer without `serverTime`, the time it was given at, and without
 * `replay`: for comparing what answers say. */
export function bare(r: ApplyResult) {
  if (r.ok) return { ok: true as const, result: r.result };
  const error: Partial<typeof r.error> = { ...r.error };
  delete error.serverTime;
  return { ok: false as const, error };
}

/** `serverTime` is present and the server's: every answer carries it. */
export const timed = (r: ApplyResult) => (r.ok ? r.serverTime : r.error.serverTime);

/** A fixed cast of people and spaces most tests start from:
 * - `open` (#lounge, open): owner olga, members mona, mel and otto.
 * - `closed` (#lab, private; its members came in by join requests the owner
 *   approved, which the prototype keeps): owner olga, members ada, mona and
 *   mel.
 * - `vault` (#vault, private): owner olga.
 * A space has one owner and members; nobody else is a member of anything.
 * `eve` is the hostile client. */
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
  await ok(t, w.as("olga", "spaces.create", { id: closed, name: "lab", vis: "private" }));
  await ok(t, w.as("olga", "spaces.create", { id: vault, name: "vault", vis: "private" }));
  for (const u of ["mona", "mel", "otto"]) await ok(t, w.as(u, "spaces.join", { space: open }));
  for (const u of ["ada", "mona", "mel"]) await admit(t, w, closed, u);
  return { w, open, closed, vault };
}

/** Let `u` into a closed space: a request, approved by its owner olga. */
export async function admit(t: ExecutionContext, w: World, space: string, u: string) {
  await ok(t, w.as(u, "joinRequests.create", { space }));
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

/** The model and effort every ask in the suite names: a registry entry
 * (`@session/shared` `MODEL_REGISTRY`) and an effort it accepts. */
export const MODEL = { model: "claude-fable", effort: "medium" } as const;

/** The input of a new thread: an ask carries a model and an effort. */
export const threadInput = (
  id: string,
  space: string,
  kind: "ask" | "post",
  q: string,
): Record<string, unknown> =>
  kind === "ask" ? { id, space, kind, q, ...MODEL } : { id, space, kind, q };

/** A new thread by `u`. An ask's root run is answered at once (`finishJob`:
 * its run `complete`, a summary written), so asks can be continued and
 * branched under it (`03` G1); `pending` leaves it queued. */
export async function thread(
  t: ExecutionContext,
  w: World,
  u: string,
  space: string,
  kind: "ask" | "post" = "ask",
  q = "What changed?",
  pending = false,
): Promise<string> {
  const id = w.id();
  await ok(t, w.as(u, "threads.create", threadInput(id, space, kind, q)));
  if (kind === "ask" && !pending) await answer(w, `thread:${id}`);
  return id;
}

/** A run finishes: a thread's summary or a node's answer, its run
 * `complete`. */
export async function answer(w: World, key: string, text = "An answer.") {
  await w.server.finishJob(key, text);
}

/** An ask node under `parent` (`r`: the thread's root): Continue or Branch,
 * answered at once. */
export async function fork(
  t: ExecutionContext,
  w: World,
  u: string,
  thread: string,
  q = "And then?",
  parent = "r",
): Promise<string> {
  const id = w.id();
  await ok(t, w.as(u, "research.forkNode", { id, thread, parent, kind: "ask", q, ...MODEL }));
  await answer(w, `node:${id}`);
  return id;
}

/** The input of an ask node under `parent`. */
export const forkInput = (id: string, thread: string, q: string, parent = "r") => ({
  id,
  thread,
  parent,
  kind: "ask",
  q,
  ...MODEL,
});

/** The keys and records of a replica or a snapshot, sorted, for comparison. */
export const sorted = (m: ReadonlyMap<string, StoredRecord>) =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
