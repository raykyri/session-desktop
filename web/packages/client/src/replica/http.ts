// The sync routes over HTTP (`01` §6, S1, Y3-Y7): a `SyncTransport` for the
// sync client, and the event stream read with `fetch` (an `EventSource`
// cannot send the protocol header).
//
//   POST /api/sync/register  { clientId? }                       Y3
//   POST /api/sync/apply     { envelopes: [envelope] }           Y4
//   POST /api/sync/snapshot  { log, tier?, threads?, clientId? } Y5
//   GET  /api/sync/pull      ?log&cursor&clientId                Y5
//   GET  /api/sync/events    ?clientId, Session-Cursors, Last-Event-ID  Y7
//
// Every request carries `Session-Protocol`; POSTs carry the CSRF header. A
// `426` on any route calls `onUpgrade` (`02` §9.2). A refusal of the
// transport itself (`{ code, message, serverTime }`: 400, 413, 426, 429,
// 503) answers `apply` as an unrecorded refusal, so the sync client marks
// the write "Not sent". A request that gets no answer throws, and the sync
// client treats it as no answer.

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

export interface HttpTransportOptions {
  /** Origin-relative or absolute base of the sync routes. */
  base?: string;
  fetch?: typeof globalThis.fetch;
  /** A `426 UPGRADE_REQUIRED` from any route. */
  onUpgrade?: () => void;
}

/** A read the server refused, or answered with something other than JSON. */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`sync request failed: ${status}${code ? ` ${code}` : ""}`);
  }
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

export class HttpSyncTransport implements SyncTransport {
  private readonly base: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly onUpgrade: () => void;

  constructor(options: HttpTransportOptions = {}) {
    this.base = options.base ?? SYNC_BASE;
    const f = options.fetch;
    this.doFetch = f ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.onUpgrade = options.onUpgrade ?? (() => {});
  }

  private async request(
    path: string,
    init: { body?: unknown; timeout: number; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown }> {
    const post = init.body !== undefined;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), init.timeout);
    (timer as { unref?: () => void }).unref?.();
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
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async register(options: RegisterOptions = {}): Promise<RegisterResult> {
    const { status, body } = await this.request("/register", {
      body: options.clientId === undefined ? {} : { clientId: options.clientId },
      timeout: READ_TIMEOUT_MS,
    });
    if (typeof body === "object" && body !== null && "ok" in body) return body as RegisterResult;
    if (isRefusal(body)) return { ok: false, error: { code: body.code, message: body.message } };
    throw new SyncHttpError(status, null);
  }

  async apply(envelope: Envelope): Promise<ApplyResult> {
    const { status, body } = await this.request("/apply", {
      body: { envelopes: [envelope] },
      timeout: APPLY_TIMEOUT_MS,
    });
    const answers = (body as { answers?: unknown } | null)?.answers;
    if (Array.isArray(answers) && answers[0] !== undefined) return answers[0] as ApplyResult;
    // a refusal of the request: unrecorded, the write was not applied
    if (isRefusal(body))
      return {
        ok: false,
        error: {
          code: body.code,
          message: body.message,
          serverTime: body.serverTime ?? Date.now(),
        },
      };
    throw new SyncHttpError(status, null);
  }

  private async read<T>(path: string, body?: unknown): Promise<T> {
    const r = await this.request(path, {
      ...(body === undefined ? {} : { body }),
      timeout: READ_TIMEOUT_MS,
    });
    if (r.status !== 200) throw new SyncHttpError(r.status, isRefusal(r.body) ? r.body.code : null);
    return r.body as T;
  }

  snapshot(log: LogId, options: ReadOptions = {}): Promise<Snapshot> {
    return this.read<Snapshot>("/snapshot", {
      log,
      ...(options.tier ? { tier: options.tier } : {}),
      ...(options.threads ? { threads: options.threads } : {}),
      ...(options.clientId ? { clientId: options.clientId } : {}),
    });
  }

  pull(log: LogId, cursor: Cursor, options: ReadOptions = {}): Promise<Pull> {
    const q = new URLSearchParams({ log, cursor });
    if (options.clientId) q.set("clientId", options.clientId);
    return this.read<Pull>(`/pull?${q.toString()}`);
  }

  /** Open the event stream of `clientId` for `cursors` (Y7). Resolves once
   * the response headers are in; the events arrive through `onEvent` until
   * the stream ends, which `done` reports. */
  async events(o: {
    clientId: string;
    cursors: ReadonlyMap<LogId, Cursor>;
    lastEventId?: string | null;
    signal: AbortSignal;
    onEvent: (e: SyncStreamEvent) => void;
  }): Promise<{ status: number; code: string | null; done: Promise<void> }> {
    const res = await this.doFetch(
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
        signal: o.signal,
      },
    );
    if (res.status === 426) this.onUpgrade();
    if (res.status !== 200 || !res.body) {
      const body = await json(res);
      return {
        status: res.status,
        code: isRefusal(body) ? body.code : null,
        done: Promise.resolve(),
      };
    }
    const reader = res.body.getReader();
    const done = readEvents(reader, (raw) => {
      const e = parseStreamEvent(raw);
      if (e) o.onEvent(e);
    }).catch(() => undefined);
    return { status: 200, code: null, done };
  }
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
  reader: ReadableStreamDefaultReader<Uint8Array>,
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
