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
//   UNAUTHORIZED (`onUnauthorized`), instead of reconnecting.
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
  fetch?: typeof fetch;
  /** The server answered that this client is too old. */
  onUpdateRequired?: () => void;
  /** The event stream was refused for want of a valid session or device
   * token (HTTP 401 or 403). */
  onUnauthorized?: () => void;
  /** Wait before reconnecting the event stream (ms). */
  reconnectMs?: number;
}

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
    while (!signal.aborted) {
      // each connection starts from the client's own tokens, so a poke the
      // client did not act on before a drop is sent again
      const last = JSON.stringify(cursors());
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
        if (res.ok && res.body) await readSse(res.body, onEvent, signal);
      } catch {
        // the connection dropped: reconnect
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, this.o.reconnectMs ?? 2000));
    }
  }
}
