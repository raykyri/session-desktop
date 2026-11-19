// Live updates over Server-Sent Events, independent of any HTTP framework: a
// function from a request (the reader and its cursor tokens) to a
// `ReadableStream` of SSE bytes. When a commit writes one of the stream's
// logs, the stream pulls it for its reader; when the reader gets a change
// (or must resync), it sends a poke naming the log, and the client pulls.
// A commit the reader may not read sends nothing, so the stream tells a
// reader no more than its pulls do (review round 1, R3).
//
// The event id of a poke is the stream's cursor tokens by log, as JSON: a
// client that reconnects with it as `Last-Event-ID` is poked at once for
// what changed since. In-flight run text (ADR-22) goes to the readers of the
// run's space as `run` events, not stored and without an id.

import type { Actor, Cursor, LogId, SseEvent } from "../protocol.js";

import type { SyncServer } from "./server.js";

/** Cursor tokens by log: the stream's state, and a poke's event id. */
export type CursorMap = Partial<Record<LogId, Cursor>>;

export interface SseOptions {
  /** Comment lines sent this often keep proxies from closing the stream. */
  keepAliveMs?: number;
  /** Timers (tests pass manual ones). */
  setInterval?: (f: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

const encoder = new TextEncoder();

/** One SSE event as text. */
export function sseFrame(e: SseEvent, id?: string): string {
  const lines = [`event: ${e.type}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(e)}`);
  return `${lines.join("\n")}\n\n`;
}

/** Parse a `Last-Event-ID` (or a `cursors` query value): JSON of cursor
 * tokens by log; anything else is no cursors. */
export function parseCursorMap(s: string | null | undefined): CursorMap {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: CursorMap = {};
    for (const [k, t] of Object.entries(v))
      if (typeof t === "string" && /^(space:[^:]+|user:[^:]+|catalog)$/.test(k))
        out[k as LogId] = t;
    return out;
  } catch {
    return {};
  }
}

/** The stream for one reader: `cursors` are the logs it listens to, each at
 * the token the client holds. `signal` ends it. */
export function openStream(
  server: SyncServer,
  actor: Actor | null,
  cursors: CursorMap,
  signal?: AbortSignal,
  o: SseOptions = {},
): ReadableStream<Uint8Array> {
  const state: CursorMap = { ...cursors };
  const set = o.setInterval ?? ((f, ms) => setInterval(f, ms));
  const clear = o.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (text: string) => {
        if (open) controller.enqueue(encoder.encode(text));
      };
      /** Pull the logs for the reader; poke for those with something new. */
      const check = (logs: Iterable<LogId>) => {
        const poke: LogId[] = [];
        for (const log of logs) {
          const at = state[log];
          if (at === undefined) continue;
          const p = server.pull(actor, log, at);
          if ("resync" in p) {
            poke.push(log);
            continue;
          }
          state[log] = p.cursor;
          if (p.changes.length) poke.push(log);
        }
        if (poke.length) send(sseFrame({ type: "poke", logs: poke }, JSON.stringify(state)));
      };
      const unsub = server.subscribe((logs) => check([...logs]));
      const unrun = server.subscribeRuns((e, sp) => {
        const log: LogId = `space:${sp}`;
        if (state[log] === undefined) return;
        if (server.viewOf(`run:${e.run}`, actor?.u ?? null) !== null) send(sseFrame(e));
      });
      const ka = set(() => send(": keep-alive\n\n"), o.keepAliveMs ?? 25_000);
      stop = () => {
        if (!open) return;
        open = false;
        unsub();
        unrun();
        clear(ka);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      signal?.addEventListener("abort", stop);
      send(": open\n\n");
      // what changed since the tokens the client reconnected with
      check(Object.keys(state) as LogId[]);
    },
    cancel() {
      stop();
    },
  });
}

/** The request-shaped entry: the stream for a `Request`, with the reader the
 * caller authenticated. The cursors come from `Last-Event-ID`, else from the
 * `cursors` query parameter (JSON). */
export function sseResponse(server: SyncServer, req: Request, actor: Actor | null, o: SseOptions = {}): Response {
  const url = new URL(req.url);
  const cursors = parseCursorMap(req.headers.get("Last-Event-ID") ?? url.searchParams.get("cursors"));
  const body = openStream(server, actor, cursors, req.signal, o);
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
