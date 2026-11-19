// The HTTP transport: `fetch` with a bearer token (the desktop's device token
// from the Keychain; the web's session cookie needs none), the protocol
// version header on every request, and SSE read with `fetch` (not
// EventSource, which cannot send headers). An answer of UPDATE_REQUIRED (or
// HTTP 426) calls `onUpdateRequired`, which a client shows as "Update
// Session". The endpoints are the mock's (`POST /api/sync/register`,
// `POST /api/sync/write`) and, for reads and live updates, `POST
// /api/sync/pull`, `POST /api/sync/snapshot` and `GET /api/sync/events`; an
// online-only call is `POST /api/rpc/<name>`.

import type { LogId } from "@session/mutators";

import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type Answer,
  type CallAnswer,
  type Cursor,
  type Envelope,
  type Pull,
  type ReadOptions,
  type RegisterAnswer,
  type Snapshot,
  type SseEvent,
} from "../protocol.js";

import { Offline, readSse, type CursorMap, type Transport } from "./transport.js";

export interface FetchTransportOptions {
  /** The server's origin, e.g. "https://session.app" (no trailing "/"). */
  baseUrl: string;
  /** The bearer token, or null (a browser with a session cookie). */
  token?: () => string | null;
  fetch?: typeof fetch;
  /** The server answered that this client is too old. */
  onUpdateRequired?: () => void;
  /** Wait before reconnecting the event stream (ms). */
  reconnectMs?: number;
}

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

  /** POST JSON and read the JSON answer. A network failure is Offline; an
   * answer that is not JSON is SERVICE_UNAVAILABLE. */
  private async post<T>(path: string, body: unknown): Promise<T> {
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
      data = {
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "The server is unavailable." },
        serverTime: Date.now(),
      };
    }
    const code = (data as { error?: { code?: string } } | null)?.error?.code;
    if (res.status === 426 || code === "UPDATE_REQUIRED") this.o.onUpdateRequired?.();
    return data as T;
  }

  register() {
    return this.post<RegisterAnswer>("/api/sync/register", {});
  }

  async push(envelopes: readonly Envelope[]): Promise<(Answer | null)[]> {
    const out: (Answer | null)[] = [];
    for (const e of envelopes) {
      try {
        out.push(await this.post<Answer>("/api/sync/write", e));
      } catch (x) {
        if (!(x instanceof Offline)) throw x;
        out.push(null);
        break;
      }
    }
    return out;
  }

  pull(log: LogId, cursor: Cursor, options: ReadOptions = {}) {
    return this.post<Pull>("/api/sync/pull", { log, cursor, ...options });
  }

  snapshot(log: LogId, options: ReadOptions = {}) {
    return this.post<Snapshot>("/api/sync/snapshot", { log, ...options });
  }

  call(name: string, input: unknown) {
    return this.post<CallAnswer>(`/api/rpc/${encodeURIComponent(name)}`, input ?? {});
  }

  /** The event stream, reconnecting with the last event id until `signal`
   * aborts. */
  async listen(
    cursors: () => CursorMap,
    onEvent: (e: SseEvent, id?: string) => void,
    signal: AbortSignal,
  ) {
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
          return;
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
