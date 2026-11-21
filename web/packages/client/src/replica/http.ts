// The sync routes over HTTP (`01` §6, S1, Y3-Y7): a `SyncTransport` for the
// sync client, and the event stream read with `fetch` (an `EventSource`
// cannot send the protocol header).
//
//   POST /api/sync/register  { clientId? }                       Y3
//   POST /api/sync/apply     { envelopes: [envelope] }           Y4
//   POST /api/sync/read      { reads: [{ log, cursor? | tier?, threads? }], clientId? }
//                            snapshots and pulls, several logs per request  Y5, R5
//   GET  /api/sync/events    ?clientId, Session-Cursors, Last-Event-ID  Y7
//
// Every request carries `Session-Protocol`; POSTs carry the CSRF header. A
// `426` on any route calls `onUpgrade` (`02` §9.2). A refusal of the
// transport itself (`{ code, message, serverTime }`: 400, 413, 426, 429,
// 503) answers `apply` as an unrecorded refusal, so the sync client marks
// the write "Not sent". A request that gets no answer throws, and the sync
// client treats it as no answer. A `Retry-After` header (429, 503) is read
// into `retryAfterMs` of the refusal, or of the `SyncHttpError` a read
// rejects with.

import type { ApiError, LogId } from "@session/mutators";
import {
  PROTOCOL_VERSION,
  type ApplyResult,
  type Change,
  type Cursor,
  type Envelope,
  type LastSeq,
  type Pull,
  type ReadOptions,
  type RegisterOptions,
  type RegisterResult,
  type Snapshot,
  type SyncTransport,
} from "@session/sync/client";

export const SYNC_BASE = "/api/sync";
export const PROTOCOL_HEADER = "Session-Protocol";
export const CURSORS_HEADER = "Session-Cursors";

/** How long a write's request may take before the client gives up on it
 * and shows it as "Not sent". */
export const APPLY_TIMEOUT_MS = 30_000;
/** How long a read may take. */
export const READ_TIMEOUT_MS = 60_000;
/** How long the event stream may take to answer with its headers. */
export const STREAM_CONNECT_TIMEOUT_MS = 30_000;
/** The server writes a heartbeat every 25 s: a stream with nothing for two
 * of them is taken as stalled, and closed. */
export const STREAM_HEARTBEAT_MS = 25_000;
export const STREAM_STALL_MS = 2 * STREAM_HEARTBEAT_MS;

export interface HttpTransportOptions {
  /** Origin-relative or absolute base of the sync routes. */
  base?: string;
  fetch?: typeof globalThis.fetch;
  /** A `426 UPGRADE_REQUIRED` from any route. */
  onUpgrade?: () => void;
  /** The first wait before a read the server answered with a transient
   * error in its place is asked again (doubled each time). */
  readRetryMs?: number;
  /** See `STREAM_CONNECT_TIMEOUT_MS` and `STREAM_STALL_MS`. */
  streamConnectTimeoutMs?: number;
  streamStallMs?: number;
}

/** The most reads in one `POST /read` (the server's `MAX_READS`). */
export const MAX_READS = 100;
/** A request whose reads are all `threads` reads is counted against its own
 * limit, and names at most this many logs and thread ids in all. */
export const MAX_THREAD_READ_LOGS = 20;
export const MAX_THREAD_READ_IDS = 100;
/** How many times a read answered with a transient error in its place is
 * asked again before it fails. */
export const READ_RETRIES = 3;

/** The per-read errors after which the read is asked again. */
const TRANSIENT_READ: ReadonlySet<string> = new Set([
  "TOO_MANY_REQUESTS",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
]);

/** One read of `POST /read`: a pull with `cursor`, else a snapshot. */
type ReadSpec =
  { log: LogId; cursor: Cursor } | { log: LogId; tier?: ReadOptions["tier"]; threads?: string[] };

interface ReadEntry {
  read: ReadSpec;
  resolve: (answer: unknown) => void;
  reject: (error: unknown) => void;
  /** How many times the server answered it with a transient error. */
  attempts: number;
}

/** A read the server refused, or answered with something other than JSON.
 * `retryAfterMs`: the wait the server named (`Retry-After`). */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterMs?: number,
  ) {
    super(`sync request failed: ${status}${code ? ` ${code}` : ""}`);
  }
}

/** The wait the server named for an error, if any. */
export function retryAfterOf(error: unknown): number | undefined {
  if (error instanceof SyncHttpError) return error.retryAfterMs;
  const v = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === "number" ? v : undefined;
}

/** `Retry-After` in milliseconds: delay-seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The headers of every sync request. */
export function syncHeaders(post: boolean): Record<string, string> {
  return {
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    ...(post ? { "X-Requested-With": "session", "Content-Type": "application/json" } : {}),
  };
}

interface Refusal {
  code: ApiError["code"];
  message: string;
  serverTime?: number;
}

const isRefusal = (v: unknown): v is Refusal =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Refusal).code === "string" &&
  typeof (v as Refusal).message === "string";

async function json(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

const withWait = (retryAfterMs: number | undefined) =>
  retryAfterMs === undefined ? {} : { retryAfterMs };

const timer = (ms: number, f: () => void) => {
  const t = setTimeout(f, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
};

export class HttpSyncTransport implements SyncTransport {
  private readonly base: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly onUpgrade: () => void;
  private readonly readRetryMs: number;
  private readonly connectTimeoutMs: number;
  private readonly stallMs: number;

  constructor(options: HttpTransportOptions = {}) {
    this.base = options.base ?? SYNC_BASE;
    const f = options.fetch;
    this.doFetch = f ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.onUpgrade = options.onUpgrade ?? (() => {});
    this.readRetryMs = options.readRetryMs ?? 1000;
    this.connectTimeoutMs = options.streamConnectTimeoutMs ?? STREAM_CONNECT_TIMEOUT_MS;
    this.stallMs = options.streamStallMs ?? STREAM_STALL_MS;
  }

  private async request(
    path: string,
    init: { body?: unknown; timeout: number; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown; retryAfterMs: number | undefined }> {
    const post = init.body !== undefined;
    const abort = new AbortController();
    const t = timer(init.timeout, () => abort.abort());
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method: post ? "POST" : "GET",
        headers: { ...syncHeaders(post), ...init.headers },
        credentials: "same-origin",
        cache: "no-store",
        ...(post ? { body: JSON.stringify(init.body) } : {}),
        signal: abort.signal,
      });
      const body = await json(res);
      if (res.status === 426) this.onUpgrade();
      return {
        status: res.status,
        body,
        retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")),
      };
    } finally {
      clearTimeout(t);
    }
  }

  async register(options: RegisterOptions = {}): Promise<RegisterResult> {
    const { status, body, retryAfterMs } = await this.request("/register", {
      body: options.clientId === undefined ? {} : { clientId: options.clientId },
      timeout: READ_TIMEOUT_MS,
    });
    if (typeof body === "object" && body !== null && "ok" in body) {
      const r = body as RegisterResult;
      return r.ok ? r : { ok: false, error: { ...r.error, ...withWait(retryAfterMs) } };
    }
    if (isRefusal(body))
      return {
        ok: false,
        error: { code: body.code, message: body.message, ...withWait(retryAfterMs) },
      };
    throw new SyncHttpError(status, null, retryAfterMs);
  }

  async apply(envelope: Envelope): Promise<ApplyResult> {
    const { status, body, retryAfterMs } = await this.request("/apply", {
      body: { envelopes: [envelope] },
      timeout: APPLY_TIMEOUT_MS,
    });
    const answers = (body as { answers?: unknown } | null)?.answers;
    if (Array.isArray(answers) && answers[0] !== undefined) {
      const answer = answers[0] as ApplyResult;
      return answer.ok || retryAfterMs === undefined
        ? answer
        : { ...answer, error: { ...answer.error, retryAfterMs } };
    }
    // a refusal of the request: unrecorded, the write was not applied
    if (isRefusal(body))
      return {
        ok: false,
        error: {
          code: body.code,
          message: body.message,
          serverTime: body.serverTime ?? Date.now(),
          ...withWait(retryAfterMs),
        },
      };
    throw new SyncHttpError(status, null, retryAfterMs);
  }

  snapshot(log: LogId, options: ReadOptions = {}): Promise<Snapshot> {
    return this.enqueue<Snapshot>(
      {
        log,
        ...(options.tier ? { tier: options.tier } : {}),
        ...(options.threads ? { threads: options.threads } : {}),
      },
      options.clientId ?? null,
    );
  }

  pull(log: LogId, cursor: Cursor, options: ReadOptions = {}): Promise<Pull> {
    return this.enqueue<Pull>({ log, cursor }, options.clientId ?? null);
  }

  // ---- reads, several per request ----
  //
  // The snapshots and pulls asked for in one turn of the event loop go out
  // together, which the server counts once against its snapshot limit: a
  // signed-out Home reads every open channel in a request or a few, not one
  // request per channel. A request names each log once and holds at most
  // `MAX_READS` reads. The `threads` reads (rows asking for their records,
  // 01 R3) go in requests of their own, counted against their own limit, of
  // at most `MAX_THREAD_READ_LOGS` logs and `MAX_THREAD_READ_IDS` ids. Each
  // read keeps its own answer, so the sync client's reads of a log stay in
  // order. A read the server answers with a transient error in its place
  // (`{ error: { code } }`) is asked again after a wait.

  private batches = new Map<string, ReadEntry[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private enqueue<T>(read: ReadSpec, clientId: string | null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.add(clientId, {
        read,
        resolve: resolve as (v: unknown) => void,
        reject,
        attempts: 0,
      });
    });
  }

  private add(clientId: string | null, entry: ReadEntry): void {
    const key = clientId ?? "";
    let batch = this.batches.get(key);
    if (!batch) this.batches.set(key, (batch = []));
    batch.push(entry);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      const batches = this.batches;
      this.batches = new Map();
      for (const [id, entries] of batches)
        for (const group of packReads(entries)) void this.sendReads(id === "" ? null : id, group);
    }, 0);
  }

  private async sendReads(clientId: string | null, entries: ReadEntry[]): Promise<void> {
    try {
      const r = await this.request("/read", {
        body: { reads: entries.map((e) => e.read), ...(clientId ? { clientId } : {}) },
        timeout: READ_TIMEOUT_MS,
      });
      const answers = (r.body as { answers?: unknown } | null)?.answers;
      if (r.status !== 200 || !Array.isArray(answers))
        throw new SyncHttpError(r.status, isRefusal(r.body) ? r.body.code : null, r.retryAfterMs);
      entries.forEach((e, i) => {
        const answer = answers[i] as { error?: { code?: string } } | undefined;
        if (answer !== undefined && !answer.error) {
          e.resolve(answer);
          return;
        }
        const code = answer?.error?.code ?? null;
        if (code !== null && TRANSIENT_READ.has(code) && e.attempts < READ_RETRIES) {
          e.attempts += 1;
          const wait = Math.max(this.readRetryMs * 2 ** (e.attempts - 1), r.retryAfterMs ?? 0);
          timer(wait, () => this.add(clientId, e));
          return;
        }
        e.reject(new SyncHttpError(r.status, code, r.retryAfterMs));
      });
    } catch (error) {
      for (const e of entries) e.reject(error);
    }
  }

  /** Open the event stream of `clientId` for `cursors` (Y7). Resolves once
   * the response headers are in (or fails after the connect timeout); the
   * events arrive through `onEvent` until the stream ends, which `done`
   * reports. A stream with nothing, not even a heartbeat, for
   * `STREAM_STALL_MS` is closed. */
  async events(o: {
    clientId: string;
    cursors: ReadonlyMap<LogId, Cursor>;
    lastEventId?: string | null;
    signal: AbortSignal;
    onEvent: (e: SyncStreamEvent) => void;
  }): Promise<{
    status: number;
    code: string | null;
    retryAfterMs?: number;
    done: Promise<void>;
  }> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    if (o.signal.aborted) stop();
    else o.signal.addEventListener("abort", stop, { once: true });
    const connect = timer(this.connectTimeoutMs, stop);
    let res: Response;
    try {
      res = await this.doFetch(
        `${this.base}/events?${new URLSearchParams({ clientId: o.clientId }).toString()}`,
        {
          headers: {
            ...syncHeaders(false),
            Accept: "text/event-stream",
            [CURSORS_HEADER]: JSON.stringify(Object.fromEntries(o.cursors)),
            ...(o.lastEventId ? { "Last-Event-ID": o.lastEventId } : {}),
          },
          credentials: "same-origin",
          cache: "no-store",
          signal: abort.signal,
        },
      );
    } finally {
      clearTimeout(connect);
    }
    if (res.status === 426) this.onUpgrade();
    if (res.status !== 200 || !res.body) {
      const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
      const body = await json(res);
      return {
        status: res.status,
        code: isRefusal(body) ? body.code : null,
        ...withWait(retryAfterMs),
        done: Promise.resolve(),
      };
    }
    const reader = res.body.getReader();
    let stall = timer(this.stallMs, stop);
    const watched = {
      read: async () => {
        const chunk = await reader.read();
        clearTimeout(stall);
        if (!chunk.done) stall = timer(this.stallMs, stop);
        return chunk;
      },
    };
    const done = readEvents(watched, (raw) => {
      const e = parseStreamEvent(raw);
      if (e) o.onEvent(e);
    })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(stall);
        o.signal.removeEventListener("abort", stop);
      });
    return { status: 200, code: null, done };
  }
}

/** Splits one turn's reads into requests: each names a log once and holds
 * at most `MAX_READS` reads; `threads` reads go in requests of their own of
 * at most `MAX_THREAD_READ_LOGS` logs and `MAX_THREAD_READ_IDS` ids. */
export function packReads<T extends { read: ReadSpec }>(entries: readonly T[]): T[][] {
  const plain: { entries: T[]; logs: Set<LogId> }[] = [];
  const threads: { entries: T[]; logs: Set<LogId>; ids: number }[] = [];
  for (const e of entries) {
    const ids =
      "threads" in e.read && e.read.tier === "threads" ? (e.read.threads?.length ?? 0) : -1;
    if (ids >= 0) {
      let group = threads.find(
        (g) =>
          !g.logs.has(e.read.log) &&
          g.entries.length < MAX_THREAD_READ_LOGS &&
          g.ids + ids <= MAX_THREAD_READ_IDS,
      );
      if (!group) threads.push((group = { entries: [], logs: new Set(), ids: 0 }));
      group.entries.push(e);
      group.logs.add(e.read.log);
      group.ids += ids;
    } else {
      let group = plain.find((g) => !g.logs.has(e.read.log) && g.entries.length < MAX_READS);
      if (!group) plain.push((group = { entries: [], logs: new Set() }));
      group.entries.push(e);
      group.logs.add(e.read.log);
    }
  }
  return [...plain, ...threads].map((g) => g.entries);
}

/** One event of `text/event-stream`. */
export interface RawEvent {
  event: string;
  data: string;
  id: string | undefined;
}

/** Read `text/event-stream` blocks from a body until it ends. Comment lines
 * (heartbeats) are skipped. */
export async function readEvents(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  onEvent: (e: RawEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, "\n");
    for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const e: RawEvent = { event: "message", data: "", id: undefined };
      const data: string[] = [];
      let fields = 0;
      for (const line of block.split("\n")) {
        if (line === "" || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        fields += 1;
        if (name === "event") e.event = value;
        else if (name === "data") data.push(value);
        else if (name === "id") e.id = value;
      }
      if (fields === 0) continue;
      e.data = data.join("\n");
      onEvent(e);
    }
  }
}

/** A pull batch of one log, as a `changes` event carries it. */
export interface StreamBatch {
  log: LogId;
  changes: Change[];
  cursor: Cursor;
  lastSeq: LastSeq;
}

/** The events of the sync stream the client reads. `id` is the sealed map
 * of the stream's cursors (Y7), sent back as `Last-Event-ID`. */
export type SyncStreamEvent =
  | { type: "ready"; logs: LogId[] }
  | { type: "changes"; batches: StreamBatch[]; id: string | undefined }
  | { type: "resync"; log: LogId; id: string | undefined }
  | { type: "ping" };

export function parseStreamEvent(raw: RawEvent): SyncStreamEvent | null {
  let data: unknown = null;
  try {
    data = raw.data ? (JSON.parse(raw.data) as unknown) : null;
  } catch {
    return null;
  }
  const d = (data ?? {}) as Record<string, unknown>;
  switch (raw.event) {
    case "ready":
      return { type: "ready", logs: Array.isArray(d["logs"]) ? (d["logs"] as LogId[]) : [] };
    case "changes":
      return Array.isArray(d["batches"])
        ? { type: "changes", batches: d["batches"] as StreamBatch[], id: raw.id }
        : null;
    case "resync":
      return typeof d["log"] === "string"
        ? { type: "resync", log: d["log"] as LogId, id: raw.id }
        : null;
    case "ping":
      return { type: "ping" };
    default:
      // run deltas (M5a) and events this build does not read
      return null;
  }
}
