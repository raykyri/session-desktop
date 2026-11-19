// A server over an in-memory store for the package's tests: every write goes
// through `apply` with the server's hooks and is committed to a
// `MemoryStore`, as a server half would do after its envelope checks.

import type { ExecutionContext } from "ava";

import {
  MUTATORS,
  MemoryStore,
  apply,
  ulid,
  type ApiError,
  type Effect,
  type ErrorCode,
  type Outcome,
  type Registry,
  type StoredRecord,
} from "../src/index.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

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

/** One applied write, with the store as it was before it. */
export interface Step {
  u: string;
  envelope: { mutationId: string; name: string; input: unknown; clientTime: number };
  now: number;
  before: MemoryStore;
  out: Outcome;
  /** Ids the writer minted for this write (its input's new ids). */
  minted: Set<string>;
}

export class World {
  now = Date.UTC(2026, 10, 16, 10, 0, 0);
  readonly store = new MemoryStore();
  readonly random: () => number;
  readonly serverRandom: () => number;
  /** Every effect committed, in order. */
  readonly effects: Effect[] = [];
  /** Every write, when `record` is on. */
  readonly steps: Step[] = [];
  record = false;
  private minted = new Set<string>();

  constructor(
    seed = 1,
    readonly registry: Registry = MUTATORS,
  ) {
    this.random = rng(seed);
    this.serverRandom = rng(seed ^ 0x5eed);
  }

  /** A client-made ULID at the current time. */
  id(): string {
    const id = ulid(this.now, this.random);
    this.minted.add(id);
    return id;
  }

  advance(ms: number) {
    this.now += ms;
  }

  get(key: string): StoredRecord | undefined {
    return this.store.records.get(key);
  }

  rev(key: string): number {
    return this.get(key)?.rev ?? 0;
  }

  /** Apply one write as `u` and commit it when it applies. */
  run(
    u: string | null,
    name: string,
    input: unknown,
    mutationId = ulid(this.now, this.random),
  ): Outcome {
    const envelope = { mutationId, name, input, clientTime: this.now };
    const before = this.record ? this.store.clone() : this.store;
    const out = apply(this.registry, this.store, u === null ? null : { u }, envelope, {
      now: this.now,
      server: { random: this.serverRandom },
    });
    if (out.status === "ok") {
      this.store.commit(out.writes);
      this.effects.push(...out.effects);
    }
    if (this.record && u !== null)
      this.steps.push({ u, envelope, now: this.now, before, out, minted: this.minted });
    this.minted = new Set();
    return out;
  }

  /** A signed-in device of `u`'s, as the server's online-only
   * devices.approve writes its record to their user log. */
  device(u: string, id: string) {
    this.store.commit([
      [
        `device:${id}`,
        {
          kind: "device",
          id,
          u,
          name: `${u}'s Mac`,
          type: "mac",
          plat: "macOS",
          createdAt: "2026-11-01T00:00:00Z",
          seen: null,
        },
      ],
    ]);
  }

  /** An API key of `u`'s, as the server's online-only apiKeys.create writes
   * its record to their user log. */
  key(u: string, id: string, status: "checking" | "valid" | "invalid" = "valid") {
    this.store.commit([
      [`apikey:${id}`, { kind: "apikey", id, u, name: `Key ${id}`, provider: "Anthropic", status }],
    ]);
  }

  /** `base` of a decision on the join requests of `users` in `sp`. */
  requests(sp: string, users: string[]): Record<string, number> {
    return Object.fromEntries(users.map((u) => [u, this.rev(`request:${sp}:${u}`)]));
  }

  admission(sp: string, u: string): { adm: string } {
    const m = this.get(`member:${sp}:${u}`);
    return { adm: m?.kind === "member" ? m.adm : "" };
  }
}

export function ok(t: ExecutionContext, out: Outcome): unknown {
  if (out.status !== "ok") {
    t.fail(`expected ok, got ${JSON.stringify(out)}`);
    return undefined;
  }
  return out.result;
}

export function refused(
  t: ExecutionContext,
  out: Outcome,
  code: ErrorCode,
  what = "",
): ApiError | null {
  if (out.status !== "refused") {
    t.fail(`${what} expected ${code}, got ${JSON.stringify(out)}`);
    return null;
  }
  t.is(out.error.code, code, `${what} ${JSON.stringify(out.error)}`);
  return out.error;
}

/** The cast most tests start from (replica-proto's):
 * - `open` (#lounge): owner olga, moderator mona, members mel and otto.
 * - `closed` (#lab, listed, join by request, members may make invite links):
 *   owner olga, admin ada, moderator mona, member mel.
 * - `vault` (#vault, unlisted, invite only): owner olga.
 * Nobody else is a member of anything; `eve` is the outsider. */
export interface Cast {
  w: World;
  open: string;
  closed: string;
  vault: string;
}

export function cast(t: ExecutionContext, seed = 1, record = false): Cast {
  const w = new World(seed);
  w.record = record;
  const open = w.id();
  const closed = w.id();
  const vault = w.id();
  ok(t, w.run("olga", "spaces.create", { id: open, name: "lounge" }));
  ok(
    t,
    w.run("olga", "spaces.create", {
      id: closed,
      name: "lab",
      vis: "listed",
      policy: "request",
      invite: "members",
    }),
  );
  ok(
    t,
    w.run("olga", "spaces.create", { id: vault, name: "vault", vis: "unlisted", policy: "invite" }),
  );
  for (const u of ["mona", "mel", "otto"]) ok(t, w.run(u, "spaces.join", { space: open }));
  ok(
    t,
    w.run("olga", "members.setRole", {
      space: open,
      user: "mona",
      role: "mod",
      base: { rev: w.rev(`member:${open}:mona`) },
    }),
  );
  for (const u of ["ada", "mona", "mel"]) admit(t, w, closed, u);
  for (const [u, role] of [
    ["ada", "admin"],
    ["mona", "mod"],
  ] as const)
    ok(
      t,
      w.run("olga", "members.setRole", {
        space: closed,
        user: u,
        role,
        base: { rev: w.rev(`member:${closed}:${u}`) },
      }),
    );
  return { w, open, closed, vault };
}

/** Let `u` into a closed space: a request, approved by its owner olga. */
export function admit(t: ExecutionContext, w: World, space: string, u: string) {
  ok(t, w.run(u, "joinRequests.create", { space, rulesAccepted: true }));
  ok(
    t,
    w.run("olga", "joinRequests.decide", {
      space,
      users: [u],
      decision: "approve",
      base: w.requests(space, [u]),
    }),
  );
}

export function thread(
  t: ExecutionContext,
  w: World,
  u: string,
  space: string,
  kind: "ask" | "post" = "ask",
  q = "What changed?",
): string {
  const id = w.id();
  ok(t, w.run(u, "threads.create", { id, space, kind, q }));
  return id;
}
