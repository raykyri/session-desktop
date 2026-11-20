// Live updates over Server-Sent Events, independent of any HTTP framework: a
// function from a request (the reader and its cursor tokens) to a
// `ReadableStream` of SSE bytes. When a commit writes one of the stream's
// logs, the stream pulls it for its reader; when the reader gets a change
// (or must resync), it sends a poke naming the log, and the client pulls; a
// log that must resync leaves the stream.
// A commit the reader may not read sends nothing, so the stream tells a
// reader no more than its pulls do (review round 1, R3); and a stream pulls
// only when the commit wrote a row its reader may read (phase 2a, report-1b
// finding 1), so a commit costs a cheap check per stream, not a pull.
// The streams of one server hear a commit together (`Hub`): their reads
// are one `SyncServer.streamPulls`, one transaction in which the check is
// part of the pull and each row and record is read once for all of them
// (review round 1 of phase 2; phase 2a design findings 1 and 2).
//
// The event id of a poke is the stream's cursor tokens by log, as JSON: a
// client that reconnects with it as `Last-Event-ID` is poked at once for
// what changed since. In-flight run text (ADR-22) goes to the readers of the
// run's node (its thread or follow-up, unredacted) as `run` events, not
// stored and without an id. A device's stream closes when it is revoked.

import type { Actor, Cursor, LogId, SseEvent } from "../protocol.js";

import type { StreamPullAnswer, SyncServer } from "./server.js";

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

/** One open stream, as the hub serves it. */
interface Listener {
  actor: Actor | null;
  state: CursorMap;
  send: (text: string) => void;
}

/** The streams of one server: a commit is read for all of them at once. */
class Hub {
  private readonly streams = new Set<Listener>();
  private unsub: (() => void) | null = null;

  constructor(private readonly server: SyncServer) {}

  add(l: Listener): () => void {
    this.streams.add(l);
    this.unsub ??= this.server.subscribe((logs, keys) =>
      this.check([...this.streams], [...logs], keys),
    );
    return () => {
      this.streams.delete(l);
      if (this.streams.size === 0 && this.unsub) {
        this.unsub();
        this.unsub = null;
      }
    };
  }

  /** Pull `logs` for each stream that listens to them; poke a stream for
   * those with something new. A log whose token does not open for its
   * reader and log (made up, another reader's, too old, of another history)
   * is poked once and dropped from the stream: the client snapshots it and
   * reconnects with the new token. A stream never keeps a token it cannot
   * open, so it hears nothing more of a log its reader may not read (review
   * round 1 of phase 1, H3). */
  check(
    streams: readonly Listener[],
    logs: readonly LogId[],
    keys?: ReadonlyMap<LogId, ReadonlySet<string> | null>,
  ) {
    const asks: { l: Listener; log: LogId }[] = [];
    for (const l of streams)
      for (const log of logs) if (l.state[log] !== undefined) asks.push({ l, log });
    if (!asks.length) return;
    const answers: StreamPullAnswer[] = this.server.streamPulls(
      asks.map(({ l, log }) => ({
        actor: l.actor,
        log,
        cursor: l.state[log] as Cursor,
        keys: keys?.get(log) ?? null,
      })),
    );
    const pokes = new Map<Listener, LogId[]>();
    asks.forEach(({ l, log }, k) => {
      const a = answers[k];
      if (!a || "skip" in a) return;
      const poke = pokes.get(l) ?? [];
      if ("resync" in a) {
        poke.push(log);
        delete l.state[log];
      } else {
        l.state[log] = a.cursor;
        if (a.changed) poke.push(log);
      }
      pokes.set(l, poke);
    });
    for (const [l, poke] of pokes)
      if (poke.length)
        try {
          l.send(sseFrame({ type: "poke", logs: poke }, JSON.stringify(l.state)));
        } catch {
          // a stream that closed; the others still hear the commit
        }
  }
}

const hubs = new WeakMap<SyncServer, Hub>();
const hubOf = (server: SyncServer) => {
  let h = hubs.get(server);
  if (!h) hubs.set(server, (h = new Hub(server)));
  return h;
};

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
      const hub = hubOf(server);
      const me: Listener = { actor, state, send };
      const unsub = hub.add(me);
      const unrun = server.subscribeRuns((e, sp) => {
        const log: LogId = `space:${sp}`;
        if (state[log] === undefined) return;
        // only to a reader of the run's node as it is stored: a hidden
        // thread's or follow-up's text goes to its author and the space's
        // moderators only (review round 2 of phase 1, H1)
        if (server.readsRunText(e.run, actor?.u ?? null)) send(sseFrame(e));
      });
      // a stream of a device closes when the device is signed out (review
      // round 2 of phase 1)
      const device = actor?.device ?? null;
      const unrevoke = server.subscribeRevocations((d) => {
        if (device !== null && d === device) stop();
      });
      const ka = set(() => send(": keep-alive\n\n"), o.keepAliveMs ?? 25_000);
      stop = () => {
        if (!open) return;
        open = false;
        unsub();
        unrun();
        unrevoke();
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
      hub.check([me], Object.keys(state) as LogId[]);
    },
    cancel() {
      stop();
    },
  });
}

/** The request-shaped entry: the stream for a `Request`, with the reader the
 * caller authenticated. The cursors come from `Last-Event-ID`, else from the
 * `cursors` query parameter (JSON). */
export function sseResponse(
  server: SyncServer,
  req: Request,
  actor: Actor | null,
  o: SseOptions = {},
): Response {
  const url = new URL(req.url);
  const cursors = parseCursorMap(
    req.headers.get("Last-Event-ID") ?? url.searchParams.get("cursors"),
  );
  const body = openStream(server, actor, cursors, req.signal, o);
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
