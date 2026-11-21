// The acceptance suite's target over HTTP (`01` A1, M3): replica-proto's
// `TestServer` implemented against this package's server on a temp SQLite
// file. `register`, `apply`, `snapshot` and `pull` are requests to the sync
// routes on a listening socket, each with the session cookie of its person
// (an account row made on first use, so any handle the suite names signs
// in); the test access (`finishJob`, `freeze`, `replaceHistory`, `logRows`,
// `scanStorage`) is the `/api/sync/test/*` routes a test server mounts. The
// suite also reads the stored records synchronously (`dump`, `jobs`): those
// read the database file through a second, read-only connection.
//
// The server runs in this process so that the suite's clock and random
// source are the server's (clock control and random-source fault
// injection), and so does a set of mutators with a faulty one. One test
// replaces `Date`, `Math.random` and `Intl` to show that the mutators read
// none of them: the HTTP stack around them reads the real ones, so the
// target puts the real ones back for the length of each request and the
// suite's replacements in place again around each mutator stage it runs.
//
// The suite has no hook for the end of a test; a target idle for 30 s
// closes its socket and connections and opens them again if it is used
// after all. The temp directories go when the process exits.
//
// The batched target (`createBatchedHttpTestServer`,
// `convergence-batched.test.ts`) exercises the transport: it runs under the
// default body and batch limits (`SESSION_LIMIT_APPLY_BYTES`,
// `SESSION_LIMIT_APPLY_BATCH`; the rate limits stay raised, since the
// suite's oracles cannot predict them), and sends each envelope in a batch
// after the last few envelopes of the same client id and person that were
// applied in the past hour, which the server answers as replays from their
// stored answers (any other answer fails the test). The target returns the
// last answer of the batch.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { auth, closeDatabase, newId, openDatabase, type SessionDatabase } from "@session/db";
import type { AnyMutator, LogId, StoredRecord } from "@session/mutators";
import {
  PROTO_MUTATORS,
  type Actor,
  type ApplyResult,
  type Cursor,
  type Envelope,
  type LogRow,
  type Pull,
  type ReadOptions,
  type RegisterResult,
  type ServerOptions,
  type Snapshot,
  type StorageScan,
  type TestServer,
} from "@session/replica-proto";
import { PROTOCOL_VERSION } from "@session/sync/server";
import SqliteDatabase from "better-sqlite3";

import { createApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { RateLimiter } from "../../src/middleware/rateLimit.js";
import { createNoopRunsService } from "../../src/runs/service.js";
import { SyncService } from "../../src/sync/service.js";

const ORIGIN = "http://localhost:8787";
const DAY = 86_400_000;
const IDLE_CLOSE_MS = 30_000;
const UNLIMITED = String(1_000_000_000);

const dirs = new Set<string>();
process.once("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---- the real globals, and the suite's replacements ----

const REAL = { Date: globalThis.Date, random: Math.random, Intl: globalThis.Intl };
type Globals = typeof REAL;

function current(): Globals {
  return { Date: globalThis.Date, random: Math.random, Intl: globalThis.Intl };
}

function install(g: Globals) {
  globalThis.Date = g.Date;
  Math.random = g.random;
  Object.defineProperty(globalThis, "Intl", { value: g.Intl, configurable: true, writable: true });
}

const replaced = (g: Globals) =>
  g.Date !== REAL.Date || g.random !== REAL.random || g.Intl !== REAL.Intl;

/** The mutators with every stage run under `trapped()` when it is set. */
function guarded(
  mutators: Readonly<Record<string, AnyMutator>>,
  trapped: () => Globals | null,
): Record<string, AnyMutator> {
  const wrap = <A extends unknown[], R>(f: ((...a: A) => R) | undefined) =>
    f === undefined
      ? undefined
      : (...a: A): R => {
          const g = trapped();
          if (!g) return f(...a);
          install(g);
          try {
            return f(...a);
          } finally {
            install(REAL);
          }
        };
  const out: Record<string, AnyMutator> = {};
  for (const [name, def] of Object.entries(mutators)) {
    const d: AnyMutator = { ...def, run: wrap(def.run) ?? def.run };
    for (const k of ["ownLog", "space", "ids", "pre", "can", "notify"] as const) {
      const f = wrap(def[k] as ((...a: unknown[]) => unknown) | undefined);
      if (f) (d as unknown as Record<string, unknown>)[k] = f;
      else delete (d as unknown as Record<string, unknown>)[k];
    }
    out[name] = d;
  }
  return out;
}

/** `JSON.stringify` without recursion, for an envelope nested deeper than
 * the call stack (the suite sends one 20,000 deep, which the server must
 * refuse before anything walks it recursively). */
export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  const out: string[] = [];
  type Frame = { v: unknown; keys: string[] | null; i: number; array: boolean };
  const stack: Frame[] = [];
  const open = (v: unknown) => {
    if (v === null || typeof v !== "object") {
      out.push(JSON.stringify(v) ?? "null");
      return;
    }
    const array = Array.isArray(v);
    out.push(array ? "[" : "{");
    stack.push({ v, keys: array ? null : Object.keys(v), i: 0, array });
  };
  open(value);
  while (stack.length) {
    const f = stack[stack.length - 1] as Frame;
    const n = f.array ? (f.v as unknown[]).length : (f.keys as string[]).length;
    if (f.i >= n) {
      out.push(f.array ? "]" : "}");
      stack.pop();
      continue;
    }
    if (f.i > 0) out.push(",");
    const i = f.i++;
    if (f.array) open((f.v as unknown[])[i]);
    else {
      const k = (f.keys as string[])[i] as string;
      out.push(`${JSON.stringify(k)}:`);
      open((f.v as Record<string, unknown>)[k]);
    }
  }
  return out.join("");
}

// ---- the target ----

export interface HttpTargetOptions {
  /** Send each envelope after the client's recent applied ones, in one
   * batch, under the default body and batch limits. */
  batched?: boolean;
}

/** How many applied envelopes a batch resends before the new one, and how
 * long after their answer. */
const RESEND = 3;
const RESEND_WITHIN = 60 * 60_000;

interface Live {
  db: SessionDatabase;
  reader: SqliteDatabase.Database;
  sync: SyncService;
  http: ServerType;
  port: Promise<number>;
}

export class HttpTestServer implements TestServer {
  readonly directory: string;
  readonly path: string;
  readonly config: Config;
  readonly #options: ServerOptions;
  readonly #mutators: Record<string, AnyMutator>;
  #live: Live | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  /** The suite's replacements of the globals during the current request. */
  #trapped: Globals | null = null;
  readonly #tokens = new Map<string, string>();
  #dumpVersion = -1;
  #dump = new Map<string, StoredRecord>();

  readonly #batched: boolean;
  /** Each client id's applied envelopes, newest last, with the time of the
   * answer on the suite's clock. */
  readonly #applied = new Map<string, { envelope: Envelope; at: number; u: string | null }[]>();

  constructor(options: ServerOptions, target: HttpTargetOptions = {}) {
    this.#options = options;
    this.#batched = target.batched ?? false;
    this.directory = mkdtempSync(join(tmpdir(), "session-conformance-"));
    dirs.add(this.directory);
    this.path = join(this.directory, "session.db");
    this.config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "0",
      SESSION_PUBLIC_ORIGIN: ORIGIN,
      SESSION_DATA_DIR: this.directory,
      SESSION_LIMIT_WRITES_PER_MINUTE: UNLIMITED,
      SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: UNLIMITED,
      SESSION_LIMIT_REGISTER_PER_MINUTE: UNLIMITED,
      SESSION_LIMIT_THREAD_READS_PER_MINUTE: UNLIMITED,
      SESSION_LIMIT_THREAD_READS_PER_IP_PER_MINUTE: UNLIMITED,
      SESSION_LIMIT_STREAM_OPENS_PER_MINUTE: UNLIMITED,
      SESSION_TEST_ROUTES: "1",
      // the batched target keeps the default body and batch limits
      ...(this.#batched ? {} : { SESSION_LIMIT_APPLY_BYTES: String(64 * 1024 * 1024) }),
      // a key of this target's own, as the in-memory target has: another
      // target does not open its tokens
      SESSION_CURSOR_KEY: randomBytes(32).toString("base64"),
    });
    this.#mutators = guarded(options.mutators ?? PROTO_MUTATORS, () => this.#trapped);
  }

  #open(): Live {
    if (this.#live) return this.#live;
    const db = openDatabase(this.path);
    const clock = this.#options.clock;
    const sync = new SyncService({
      db,
      // the suite may give the web window of `window` snapshots
      config: this.#options.window
        ? { ...this.config, sync: { ...this.config.sync, window: this.#options.window } }
        : this.config,
      clock,
      ...(this.#options.random ? { random: this.#options.random } : {}),
      mutators: this.#mutators,
      // the prototype's figures, as the in-memory target (`sync-target.ts`)
      expireEveryCall: true,
      clients: { idleTtl: 90 * DAY, perDay: 20 },
    });
    const logger = createLogger({ level: "error", write: () => undefined });
    const app = createApp({
      config: this.config,
      db,
      sync,
      logger,
      runs: createNoopRunsService(),
      limiter: new RateLimiter(() => clock.now()),
      clientDistDirectory: join(this.directory, "no-client"),
    });
    let resolve: (port: number) => void = () => undefined;
    const port = new Promise<number>((r) => (resolve = r));
    const http = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
      resolve(info.port),
    );
    http.unref();
    const reader = new SqliteDatabase(this.path, { readonly: true });
    this.#live = { db, reader, sync, http, port };
    this.#dumpVersion = -1;
    return this.#live;
  }

  /** Release the socket and the connections; the file stays. */
  close(): void {
    const live = this.#live;
    if (!live) return;
    this.#live = null;
    live.http.close();
    live.sync.drain();
    live.reader.close();
    closeDatabase(live.db);
  }

  #touch() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    this.#idle.unref();
  }

  /** The session cookie of `u`, with an account row for the handle. */
  #cookie(u: string): string {
    const known = this.#tokens.get(u);
    if (known) return known;
    const { db } = this.#open();
    const at = Date.now();
    const id = newId();
    db.$client
      .prepare(
        `INSERT INTO users (id, provider, provider_user_id, login, status, handle, created_at, last_login_at)
         VALUES (?, 'github', ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, `conformance-${id}`, u, u, at, at);
    const token = auth.createSession(db, id).token;
    this.#tokens.set(u, token);
    return token;
  }

  /** One request, with the real globals in place while it is in flight. */
  async #request<T>(
    method: "GET" | "POST",
    path: string,
    actor: Actor | null,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const g = current();
    const trapped = replaced(g) ? g : null;
    if (trapped) install(REAL);
    this.#trapped = trapped;
    try {
      this.#touch();
      const live = this.#open();
      const port = await live.port;
      const headers: Record<string, string> = {
        Origin: ORIGIN,
        "X-Requested-With": "session",
        "Session-Protocol": String(PROTOCOL_VERSION),
      };
      if (actor !== null) headers["Cookie"] = `session=${this.#cookie(actor.u)}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, json: JSON.parse(text) as T };
    } finally {
      this.#trapped = null;
      if (trapped) install(trapped);
    }
  }

  // ---- the API ----

  async register(
    actor: Actor | null,
    options: { clientId?: string } = {},
  ): Promise<RegisterResult> {
    const { json } = await this.#request<RegisterResult | { code: string }>(
      "POST",
      "/api/sync/register",
      actor,
      options,
    );
    // a refusal of the request (signed out: 401 before the body is read; the
    // day's registrations: 429) is the registration's answer
    if ("code" in json) return { ok: false, error: json as never };
    // the handle the route adds for the web client: the suite's server half
    // answers without it
    if (json.ok && "user" in json) delete (json as { user?: unknown }).user;
    return json;
  }

  async apply(actor: Actor | null, envelope: Envelope): Promise<ApplyResult> {
    // a field that throws when read cannot travel over HTTP: the test route
    // gives the server an envelope whose same fields throw when read
    const unreadable = Object.keys(envelope).filter((k) => {
      try {
        void (envelope as unknown as Record<string, unknown>)[k];
        return false;
      } catch {
        return true;
      }
    });
    if (unreadable.length) {
      const readable = Object.fromEntries(
        Object.keys(envelope)
          .filter((k) => !unreadable.includes(k))
          .map((k) => [k, (envelope as unknown as Record<string, unknown>)[k]]),
      );
      return (
        await this.#request<ApplyResult>("POST", "/api/sync/test/apply-unreadable", actor, {
          envelope: readable,
          unreadable,
        })
      ).json;
    }
    const now = this.#options.clock.now();
    const sent = this.#batched
      ? [
          ...(this.#applied.get(envelope.clientId) ?? [])
            // the same person's (a client id sent by someone else is not)
            .filter(
              (x) =>
                x.u === (actor?.u ?? null) && x.at > now - RESEND_WITHIN && x.envelope !== envelope,
            )
            .slice(-RESEND)
            .map((x) => x.envelope),
          envelope,
        ]
      : [envelope];
    const { status, json } = await this.#request<{ answers?: ApplyResult[]; code?: string }>(
      "POST",
      "/api/sync/apply",
      actor,
      { envelopes: sent },
    );
    // a refusal of the request (signed out: 401 before the body is read)
    // is the envelope's unrecorded answer
    if (!json.answers && typeof json.code === "string") return { ok: false, error: json as never };
    const a = json.answers?.[sent.length - 1];
    if (!a) throw new Error(`apply answered ${status} ${JSON.stringify(json)}`);
    if (this.#batched) {
      for (const [i, replay] of (json.answers ?? []).slice(0, -1).entries())
        if (!replay.ok || !("replay" in replay))
          throw new Error(`a resent envelope was not answered from its stored answer: ${i}`);
      if (a.ok && !("replay" in a)) {
        const list = this.#applied.get(envelope.clientId) ?? [];
        list.push({ envelope, at: now, u: actor?.u ?? null });
        this.#applied.set(envelope.clientId, list.slice(-RESEND));
      }
    }
    return a;
  }

  async snapshot(actor: Actor | null, log: LogId, options: ReadOptions = {}): Promise<Snapshot> {
    const { status, json } = await this.#request<Snapshot>("POST", "/api/sync/snapshot", actor, {
      log,
      ...options,
    });
    // the server half throws a refusal for a tier or a thread list the
    // protocol does not have; over HTTP it is a 400
    if (status !== 200) throw new Error(`snapshot answered ${status}: ${JSON.stringify(json)}`);
    return json;
  }

  async pull(
    actor: Actor | null,
    log: LogId,
    cursor: Cursor,
    options: ReadOptions = {},
  ): Promise<Pull> {
    const q = new URLSearchParams({ log, cursor });
    if (options.clientId !== undefined) q.set("clientId", options.clientId);
    const { json } = await this.#request<Pull>("GET", `/api/sync/pull?${q.toString()}`, actor);
    return json;
  }

  // ---- test access ----

  dump(): ReadonlyMap<string, StoredRecord> {
    const { reader } = this.#open();
    const version = reader.pragma("data_version", { simple: true }) as number;
    if (version !== this.#dumpVersion) {
      this.#dumpVersion = version;
      this.#dump = new Map(
        reader
          .prepare<[], { key: string; body: string }>(
            "SELECT key, body FROM records ORDER BY created_v, rowid",
          )
          .all()
          .map((r) => [r.key, JSON.parse(r.body) as StoredRecord]),
      );
    }
    return this.#dump;
  }

  jobs() {
    const out: { kind: string; id: string }[] = [];
    for (const r of this.dump().values())
      if (r.kind === "run" && r.status === "queued") out.push({ kind: "run", id: r.id });
    return out;
  }

  async logRows(log: LogId): Promise<LogRow[]> {
    const q = new URLSearchParams({ log });
    return (await this.#request<LogRow[]>("GET", `/api/sync/test/log-rows?${q.toString()}`, null))
      .json;
  }

  async scanStorage(): Promise<StorageScan> {
    return (await this.#request<StorageScan>("GET", "/api/sync/test/scan", null)).json;
  }

  async finishJob(key: string, text: string): Promise<boolean> {
    return (
      await this.#request<{ ok: boolean }>("POST", "/api/sync/test/finish", null, { key, text })
    ).json.ok;
  }

  async replaceHistory(log: LogId): Promise<void> {
    await this.#request("POST", "/api/sync/test/replace-history", null, { log });
  }

  async freeze(space: string): Promise<boolean> {
    return (await this.#request<{ ok: boolean }>("POST", "/api/sync/test/freeze", null, { space }))
      .json.ok;
  }
}

export const createHttpTestServer = (options: ServerOptions): TestServer =>
  new HttpTestServer(options);

export const createBatchedHttpTestServer = (options: ServerOptions): TestServer =>
  new HttpTestServer(options, { batched: true });
