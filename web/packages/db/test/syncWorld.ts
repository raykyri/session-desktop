// A sync server on `SqliteStore` over a temp-file database, a manual clock,
// and helpers to write as a person, for the store's tests (`01` D1-D7).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MUTATORS, type AnyMutator, type ErrorCode, type StoredRecord } from "@session/mutators";
import {
  MemoryStore,
  PROTOCOL_VERSION,
  SyncServer,
  ulid,
  type ApplyResult,
  type CursorKeys,
  type Envelope,
  type ServerStore,
} from "@session/sync/server";
import type { ExecutionContext } from "ava";

import {
  closeDatabase,
  newId,
  openDatabase,
  SqliteStore,
  type SessionDatabase,
} from "../src/index.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MODEL = { model: "claude-fable", effort: "medium" } as const;

export class ManualClock {
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

/** A cursor key fixed for the test, so a second server over the same file
 * opens the first one's tokens. */
export const KEYS: CursorKeys = { current: new Uint8Array(32).fill(7) };

export interface WorldOptions {
  mutators?: Readonly<Record<string, AnyMutator>>;
  /** Another store in place of `SqliteStore` (the memory store, for
   * comparison; a faulty one). */
  store?: (db: SessionDatabase) => ServerStore;
  /** An existing database file. */
  path?: string;
  clock?: ManualClock;
  seed?: number;
}

/** Make `handle` an active account in `users`. */
export function addAccount(
  db: SessionDatabase,
  handle: string,
  status: "active" | "waiting" = "active",
) {
  const at = Date.now();
  db.$client
    .prepare(
      `INSERT OR IGNORE INTO users (id, provider, provider_user_id, login, status, handle, created_at, last_login_at)
       VALUES (?, 'github', ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), `p-${handle}`, handle, status, status === "active" ? handle : null, at, at);
}

export class World {
  readonly clock: ManualClock;
  readonly random: () => number;
  readonly directory: string;
  readonly path: string;
  readonly db: SessionDatabase;
  readonly store: ServerStore;
  readonly server: SyncServer;
  private readonly clientIds = new Map<string, string>();

  constructor(t: ExecutionContext, o: WorldOptions = {}) {
    this.directory = mkdtempSync(join(tmpdir(), "session-sync-"));
    this.path = o.path ?? join(this.directory, "session.db");
    this.db = openDatabase(this.path);
    this.clock = o.clock ?? new ManualClock();
    this.random = rng(o.seed ?? 1);
    this.store = o.store?.(this.db) ?? new SqliteStore(this.db);
    this.server = new SyncServer({
      store: this.store,
      clock: this.clock,
      random: rng((o.seed ?? 1) + 1),
      mutators: o.mutators ?? MUTATORS,
      cursorKeys: KEYS,
    });
    t.teardown(() => this.close());
  }

  private closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    closeDatabase(this.db);
    rmSync(this.directory, { recursive: true, force: true });
  }

  id(offset = 0): string {
    return ulid(this.clock.now() + offset, this.random);
  }

  account(handle: string) {
    addAccount(this.db, handle);
    if (this.store instanceof MemoryStore) this.store.setAccount(handle, "active");
  }

  clientId(u: string): string {
    const known = this.clientIds.get(u);
    if (known) return known;
    this.account(u);
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
    return this.store.byKey(key);
  }

  /** Every row of the tables a commit writes, for "nothing changed". */
  tables(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const table of [
      "records",
      "change_log",
      "server_head",
      "log_epochs",
      "registry",
      "tombstones",
      "sync_clients",
      "sync_answers",
      "sync_seq_answers",
      "save_counts",
    ])
      out[table] = this.db.$client.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
    return out;
  }
}

export function ok(t: ExecutionContext, r: ApplyResult): unknown {
  if (!r.ok) t.fail(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.ok ? r.result : undefined;
}

export function refused(t: ExecutionContext, r: ApplyResult, code: ErrorCode) {
  if (r.ok) t.fail(`expected ${code}, got ok`);
  else t.is(r.error.code, code, JSON.stringify(r.error));
}

/** olga's open #lounge (members mona, mel, otto) and private #lab (ada and
 * mona, by invite links). */
export function cast(t: ExecutionContext, w: World) {
  const open = w.id();
  const closed = w.id();
  ok(t, w.as("olga", "spaces.create", { id: open, name: "lounge" }));
  ok(t, w.as("olga", "spaces.create", { id: closed, name: "lab", vis: "private" }));
  for (const u of ["mona", "mel", "otto"]) ok(t, w.as(u, "spaces.join", { space: open }));
  for (const u of ["ada", "mona", "mel"]) {
    const link = ok(t, w.as("olga", "invites.create", { id: w.id(), space: closed, days: 7 })) as {
      code: string;
    };
    ok(t, w.as(u, "spaces.join", { space: closed, invite: link.code }));
  }
  return { open, closed };
}

export function post(t: ExecutionContext, w: World, u: string, space: string, q = "A post") {
  const id = w.id();
  ok(t, w.as(u, "threads.create", { id, space, kind: "post", q }));
  return id;
}
