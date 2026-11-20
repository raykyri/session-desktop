// The HTTP transport: `fetch` with a bearer token (the desktop's device token
// from the Keychain; the web's session cookie needs none), the protocol
// version header on every request, and SSE read with `fetch` (not
// EventSource, which cannot send headers). An answer of UPDATE_REQUIRED (or
// HTTP 426) calls `onUpdateRequired`, which a client shows as "Update
// Session". The endpoints are the mock's (`POST /api/sync/register`,
// `POST /api/sync/write`) and, for reads and live updates, `POST
// /api/sync/pull`, `POST /api/sync/snapshot` and `GET /api/sync/events`; an
// online-only call is `POST /api/rpc/<name>`.
//
// What a response that is not the protocol's means:
// - a write: a 5xx status, or a body that is not an answer (a proxy's error
//   page), is no answer (null): the server may have applied the write (the
//   client keeps its ids) and it counts as a try. No response at all (`fetch`
//   rejects: offline, or the connection failed) is NO_RESPONSE, which is not
//   a try. 426 is UPDATE_REQUIRED and 401 or 403 UNAUTHORIZED, both
//   unrecorded;
// - a read or a call: 426, 401 and 403 as for a write; any other response
//   that is not an answer is SERVICE_UNAVAILABLE. A read error changes no log.
//   A network failure throws Offline;
// - the event stream: 426 ends it with UPDATE_REQUIRED and 401 or 403 with
//   UNAUTHORIZED (`onUnauthorized`), instead of reconnecting. Any other
//   status that opens no stream (TOO_MANY_REQUESTS: the caller has too many
//   streams open; a 5xx) and a connection that fails before a response are
//   retried with backoff, doubling from `reconnectMs` to `maxReconnectMs`,
//   and never sooner than the refusal's `Retry-After` or `retryAt`; a stream
//   that opened starts the backoff over. One stream is open at a time.
// An answer the transport makes up carries `serverTime: NaN` (the server
// sent no time).

import type { ErrorCode, LogId } from "@session/mutators";

import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type Answer,
  type CallAnswer,
  type Cursor,
  type Envelope,
  type PullAnswer,
  type ReadError,
  type ReadOptions,
  type RegisterAnswer,
  type SnapshotAnswer,
  type SseEvent,
} from "../protocol.js";

import {
  NO_RESPONSE,
  Offline,
  readSse,
  type CursorMap,
  type PushResult,
  type Transport,
} from "./transport.js";

export interface FetchTransportOptions {
  /** The server's origin, e.g. "https://session.app" (no trailing "/"). */
  baseUrl: string;
  /** The bearer token, or null (a browser with a session cookie). */
  token?: () => string | null;
  /** Headers sent with every request: the web's CSRF header
   * (`X-Requested-With: session`), which a cookie POST needs. The content
   * type, the protocol header and a bearer token are set after them. */
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  /** The server answered that this client is too old. */
  onUpdateRequired?: () => void;
  /** The event stream was refused for want of a valid session or device
   * token (HTTP 401 or 403). */
  onUnauthorized?: () => void;
  /** Wait before reconnecting the event stream (ms). */
  reconnectMs?: number;
  /** The longest wait before reconnecting after refusals (ms). */
  maxReconnectMs?: number;
  /** Waits `ms` (tests); `setTimeout` by default. A wait ends early when
   * the stream is stopped. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The longest wait a refusal's `Retry-After` or `retryAt` can ask for. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** How long a refusal asks to wait (ms): its `Retry-After` header (seconds
 * or a date), or its body's `error.retryAt` (ISO); 0 when it names none. */
async function retryAfterMs(res: Response, now: number): Promise<number> {
  let at: number | null = null;
  const h = res.headers.get("Retry-After");
  if (h !== null && h.trim() !== "") {
    const secs = Number(h);
    at = Number.isFinite(secs) ? now + secs * 1000 : Date.parse(h);
  }
  if (at === null || Number.isNaN(at)) {
    const d: unknown = await res.json().catch(() => undefined);
    const retry = errorBody(d) ? (d.error as { retryAt?: unknown }).retryAt : undefined;
    at = typeof retry === "string" ? Date.parse(retry) : null;
  }
  if (at === null || Number.isNaN(at)) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

interface Response1 {
  status: number;
  /** The decoded JSON body, or undefined when it is not JSON. */
  data: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** An error answer the transport makes up (the server sent none). */
const madeUp = (code: ErrorCode, message: string): ReadError => ({
  ok: false,
  error: { code, message },
  serverTime: NaN,
});

/** The unrecorded error an HTTP status stands for, if any. */
function statusError(status: number): ReadError | null {
  if (status === 426) return madeUp("UPDATE_REQUIRED", "Update Session.");
  if (status === 401 || status === 403) return madeUp("UNAUTHORIZED", "Sign in again.");
  return null;
}

/** A body that is an error answer of the protocol's. */
const errorBody = (d: unknown): d is ReadError =>
  isObject(d) &&
  d["ok"] === false &&
  isObject(d["error"]) &&
  typeof d["error"]["code"] === "string";

export class FetchTransport implements Transport {
  private readonly f: typeof fetch;

  constructor(private readonly o: FetchTransportOptions) {
    this.f = o.fetch ?? ((...a) => fetch(...a));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      ...this.o.headers,
      "Content-Type": "application/json",
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      ...extra,
    };
    const t = this.o.token?.();
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  }

  /** POST JSON: the status and the JSON body. A network failure is Offline. */
  private async post(path: string, body: unknown): Promise<Response1> {
    let res: Response;
    try {
      res = await this.f(`${this.o.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Offline(e instanceof Error ? e.message : "offline");
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    const code = isObject(data) && isObject(data["error"]) ? data["error"]["code"] : undefined;
    if (res.status === 426 || code === "UPDATE_REQUIRED") this.o.onUpdateRequired?.();
    return { status: res.status, data };
  }

  /** A write's answer, or null: no answer (the write may have been applied). */
  private answer(r: Response1): Answer | null {
    if (r.status < 500 && isObject(r.data) && typeof r.data["ok"] === "boolean")
      return r.data as unknown as Answer;
    return statusError(r.status);
  }

  /** A read's or a call's answer; `shaped` checks a success body. */
  private read<T>(r: Response1, shaped: (d: Record<string, unknown>) => boolean): T | ReadError {
    const e = statusError(r.status);
    if (errorBody(r.data)) return r.data;
    if (e) return e;
    if (r.status >= 500 || !isObject(r.data) || !shaped(r.data))
      return madeUp("SERVICE_UNAVAILABLE", "The server is unavailable.");
    return r.data as T;
  }

  async register(): Promise<RegisterAnswer> {
    const a = this.answer(await this.post("/api/sync/register", {}));
    if (a === null) throw new Offline("no answer");
    return a as unknown as RegisterAnswer;
  }

  async push(envelopes: readonly Envelope[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (const e of envelopes) {
      let r: Response1;
      try {
        r = await this.post("/api/sync/write", e);
      } catch (x) {
        if (!(x instanceof Offline)) throw x;
        out.push(NO_RESPONSE);
        break;
      }
      const a = this.answer(r);
      out.push(a);
      if (a === null) break;
    }
    return out;
  }

  async pull(log: LogId, cursor: Cursor, options: ReadOptions = {}): Promise<PullAnswer> {
    return this.read(
      await this.post("/api/sync/pull", { log, cursor, ...options }),
      (d) =>
        d["resync"] === true || (Array.isArray(d["changes"]) && typeof d["cursor"] === "string"),
    );
  }

  async snapshot(log: LogId, options: ReadOptions = {}): Promise<SnapshotAnswer> {
    return this.read(
      await this.post("/api/sync/snapshot", { log, ...options }),
      (d) => Array.isArray(d["records"]) && typeof d["cursor"] === "string",
    );
  }

  async call(name: string, input: unknown): Promise<CallAnswer> {
    return this.read(
      await this.post(`/api/rpc/${encodeURIComponent(name)}`, input ?? {}),
      (d) => d["ok"] === true,
    );
  }

  /** The event stream, reconnecting with the last event id until `signal`
   * aborts, or until the server refuses it (426, 401, 403: the error). */
  async listen(
    cursors: () => CursorMap,
    onEvent: (e: SseEvent, id?: string) => void,
    signal: AbortSignal,
  ): Promise<void | ReadError> {
    const base = this.o.reconnectMs ?? 2000;
    const max = Math.max(base, this.o.maxReconnectMs ?? 30_000);
    const sleep = this.o.sleep ?? wait;
    // the wait before the next connection: `base` after a stream that
    // opened, doubled after each refusal or failed connection
    let backoff = base;
    while (!signal.aborted) {
      // each connection starts from the client's own tokens, so a poke the
      // client did not act on before a drop is sent again
      const last = JSON.stringify(cursors());
      let opened = false;
      let asked = 0;
      try {
        const res = await this.f(`${this.o.baseUrl}/api/sync/events`, {
          method: "GET",
          headers: this.headers({ Accept: "text/event-stream", "Last-Event-ID": last }),
          signal,
        });
        if (res.status === 426) {
          this.o.onUpdateRequired?.();
          return statusError(426) ?? undefined;
        }
        if (res.status === 401 || res.status === 403) {
          this.o.onUnauthorized?.();
          return statusError(res.status) ?? undefined;
        }
        if (res.ok && res.body) {
          opened = true;
          await readSse(res.body, onEvent, signal);
        } else asked = await retryAfterMs(res, Date.now());
      } catch {
        // the connection dropped, or never opened: reconnect
      }
      if (signal.aborted) break;
      let delay = base;
      if (opened) backoff = base;
      else {
        // refused (too many streams open) or failed: wait longer each time
        delay = Math.max(backoff, asked);
        backoff = Math.min(max, backoff * 2);
      }
      await sleep(delay, signal);
    }
  }
}
