// The sync routes of the server (`server/src/sync/routes.ts`, M3) over the
// sync package's in-memory server half, behind a fake `fetch`: register,
// apply, snapshot, pull and the event stream, with the protocol check, the
// signed-out answers and the `426`. The client's HTTP transport and replica
// run against it as against the real server. `offline` makes every request
// fail as a dropped connection does.

import { MUTATORS, type LogId, type SpaceRec, type StoredRecord } from "@session/mutators";
import {
  MemoryStore,
  PROTOCOL_VERSION,
  SyncServer,
  transportFor,
  ulid,
  type ApplyResult,
  type Clock,
  type Envelope,
  type WindowSettings,
} from "@session/sync/server";

export class TestClock implements Clock {
  offset = 0;
  now(): number {
    return Date.now() + this.offset;
  }
}

interface Stream {
  u: string;
  clientId: string;
  cursors: Map<LogId, string>;
  send: (event: string, data: unknown, id?: string) => void;
  close: () => void;
}

export interface SeenRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  status: number;
}

const encoder = new TextEncoder();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A stand-in for the event id: the cursor map in base64 (the server seals
 * it; the client only sends it back). */
const eventId = (cursors: Map<LogId, string>) =>
  Buffer.from(JSON.stringify(Object.fromEntries(cursors))).toString("base64url");

export class FakeSync {
  readonly clock = new TestClock();
  readonly store = new MemoryStore();
  readonly server: SyncServer;
  /** Every request fails as a dropped connection does. */
  offline = false;
  /** Every request answers 426. */
  upgrade = false;
  /** The apply route answers nothing until released (a request in flight). */
  holdApply: Promise<void> | null = null;
  readonly requests: SeenRequest[] = [];
  readonly streams = new Set<Stream>();
  private readonly clientIds = new Map<string, string>();
  private readonly seqs = new Map<string, number>();

  constructor(o: { window?: WindowSettings } = {}) {
    this.server = new SyncServer({
      store: this.store,
      clock: this.clock,
      mutators: MUTATORS,
      ...(o.window ? { window: o.window } : {}),
    });
  }

  id(): string {
    return ulid(this.clock.now(), Math.random);
  }

  /** A write as `u` straight to the server half (another person's client). */
  as(u: string, name: string, input: unknown): ApplyResult {
    let clientId = this.clientIds.get(u);
    const row = clientId === undefined ? undefined : this.store.client(clientId);
    // a client idle 7 days has expired: register again
    if (!row || row.seen <= this.clock.now() - 7 * 86_400_000) clientId = undefined;
    if (!clientId) {
      const r = this.server.register({ u });
      if (!r.ok) throw new Error(r.error.code);
      clientId = r.clientId;
      this.clientIds.set(u, clientId);
    }
    const seq = (this.seqs.get(clientId) ?? 0) + 1;
    this.seqs.set(clientId, seq);
    const now = this.clock.now();
    const e: Envelope = {
      clientId,
      seq,
      mutationId: this.id(),
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
    };
    const r = this.server.apply({ u }, e);
    this.wake();
    return r;
  }

  ok(u: string, name: string, input: unknown): unknown {
    const r = this.as(u, name, input);
    if (!r.ok) throw new Error(`${name}: ${r.error.code} ${r.error.message}`);
    return r.result;
  }

  get(key: string): StoredRecord | undefined {
    return this.store.records.get(key);
  }

  /** `spaces.directory`: the open channels. */
  directory = (): Promise<SpaceRec[]> => {
    if (this.offline) return Promise.reject(new TypeError("Failed to fetch"));
    const out: SpaceRec[] = [];
    for (const r of this.store.records.values())
      if (r.kind === "space" && r.vis === "open") out.push(r);
    return Promise.resolve(out);
  };

  /** `spaces.byName`: any channel's record (a private one's is its landing). */
  byName = (name: string): Promise<SpaceRec | null> => {
    for (const r of this.store.records.values())
      if (r.kind === "space" && r.name === name) return Promise.resolve(r);
    return Promise.resolve(null);
  };

  /** The in-process transport of `u`, for clients that skip HTTP. */
  transport(u: string | null) {
    return transportFor(this.server, u === null ? null : { u });
  }

  /** Push what changed to every open stream. */
  wake(): void {
    for (const s of this.streams) this.flush(s);
  }

  private flush(s: Stream): void {
    const batches: unknown[] = [];
    for (const [log, cursor] of [...s.cursors]) {
      const p = this.server.pull({ u: s.u }, log, cursor, { clientId: s.clientId });
      if ("resync" in p) {
        s.cursors.delete(log);
        s.send("resync", { log }, eventId(s.cursors));
        continue;
      }
      s.cursors.set(log, p.cursor);
      if (p.changes.length)
        batches.push({ log, changes: p.changes, cursor: p.cursor, lastSeq: p.lastSeq });
    }
    if (batches.length) s.send("changes", { batches }, eventId(s.cursors));
  }

  /** Close every stream (the server restarted). */
  closeStreams(): void {
    for (const s of [...this.streams]) s.close();
  }

  /** The fetch of a browser signed in as `u` (null: signed out). */
  fetchFor(u: string | null): typeof globalThis.fetch {
    return async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://localhost",
      );
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const seen: SeenRequest = { method, path: url.pathname, body, headers, status: 0 };
      this.requests.push(seen);
      if (this.offline) throw new TypeError("Failed to fetch");
      const res = await this.route(u, url, method, headers, body, init?.signal ?? null);
      seen.status = res.status;
      return res;
    };
  }

  private async route(
    u: string | null,
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal | null,
  ): Promise<Response> {
    const now = this.clock.now();
    if (this.upgrade || headers["session-protocol"] !== String(PROTOCOL_VERSION))
      return json(426, { code: "UPGRADE_REQUIRED", message: "Update Session.", serverTime: now });
    if (method === "POST" && headers["x-requested-with"] !== "session")
      return json(403, { error: "Missing required x-requested-with: session header" });
    const actor = u === null ? null : { u };
    switch (url.pathname) {
      case "/api/sync/register": {
        if (actor === null) return json(401, this.server.register(null));
        const r = this.server.register(
          actor,
          typeof body["clientId"] === "string" ? { clientId: body["clientId"] } : {},
        );
        return json(r.ok ? 200 : r.error.code === "WRONG_CLIENT" ? 409 : 400, r);
      }
      case "/api/sync/apply": {
        const envelopes = body["envelopes"];
        if (!Array.isArray(envelopes) || envelopes.length === 0)
          return json(400, {
            code: "BAD_REQUEST",
            message: "Expected { envelopes }.",
            serverTime: now,
          });
        if (this.holdApply) await this.holdApply;
        if (this.offline) throw new TypeError("Failed to fetch");
        const answers = envelopes.map((e) => this.server.apply(actor, e));
        this.wake();
        return json(actor === null ? 401 : 200, { answers });
      }
      case "/api/sync/snapshot": {
        const log = body["log"] as LogId;
        const snap = this.server.snapshot(actor, log, {
          ...(typeof body["tier"] === "string" ? { tier: body["tier"] as "window" } : {}),
          ...(Array.isArray(body["threads"]) ? { threads: body["threads"] as string[] } : {}),
          ...(typeof body["clientId"] === "string" ? { clientId: body["clientId"] } : {}),
        });
        return json(200, snap);
      }
      case "/api/sync/pull": {
        const log = (url.searchParams.get("log") ?? "") as LogId;
        const clientId = url.searchParams.get("clientId");
        const p = this.server.pull(actor, log, url.searchParams.get("cursor") ?? "", {
          ...(clientId ? { clientId } : {}),
        });
        return json(200, p);
      }
      case "/api/sync/events":
        return this.events(u, url, headers, signal);
      default:
        return json(404, { code: "NOT_FOUND", message: "No route.", serverTime: now });
    }
  }

  private events(
    u: string | null,
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal | null,
  ): Response {
    const now = this.clock.now();
    if (u === null) return json(401, { code: "UNAUTHORIZED", message: "", serverTime: now });
    const clientId = url.searchParams.get("clientId") ?? "";
    if (this.store.client(clientId)?.u !== u)
      return json(409, { code: "WRONG_CLIENT", message: "", serverTime: now });
    const cursors = new Map<LogId, string>();
    const last = headers["last-event-id"];
    if (last)
      for (const [log, c] of Object.entries(
        JSON.parse(Buffer.from(last, "base64url").toString()) as Record<string, string>,
      ))
        cursors.set(log as LogId, c);
    const named = headers["session-cursors"];
    if (named)
      for (const [log, c] of Object.entries(JSON.parse(named) as Record<string, string>))
        cursors.set(log as LogId, c);
    if (cursors.size === 0)
      return json(400, { code: "BAD_REQUEST", message: "Name the logs.", serverTime: now });
    // one stream per client id: a new one replaces it
    for (const s of [...this.streams]) if (s.clientId === clientId) s.close();
    let stream: Stream | null = null;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let open = true;
        const s: Stream = {
          u,
          clientId,
          cursors,
          send: (event, data, id) => {
            if (!open) return;
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n${id ? `id: ${id}\n` : ""}\n`,
              ),
            );
          },
          close: () => {
            if (!open) return;
            open = false;
            this.streams.delete(s);
            controller.close();
          },
        };
        stream = s;
        this.streams.add(s);
        signal?.addEventListener("abort", () => s.close());
        s.send("ready", { logs: [...cursors.keys()] });
        this.flush(s);
      },
      cancel: () => {
        if (stream) this.streams.delete(stream);
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
}

/** Exclusive Web Locks shared by the tabs of one browser. */
export class FakeLocks {
  readonly held = new Set<string>();
  async request(
    name: string,
    _o: { mode: "exclusive"; ifAvailable: true },
    cb: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try {
      return await cb({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

export class FakeStorage {
  constructor(readonly items = new Map<string, string>()) {}
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
  /** A duplicated tab inherits a copy. */
  copy() {
    return new FakeStorage(new Map(this.items));
  }
}

/** Waits until `check` holds, or fails after `ms`. */
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
