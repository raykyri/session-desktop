// The sync event streams (`01` Y7): `GET /api/sync/events`, read by the web
// client with `fetch`. Each stream belongs to one registered client id of a
// signed-in person and reads a set of logs from a cursor each. After a commit
// the store names the logs it wrote (`SqliteStore` `onCommit`); every stream
// reading one of them runs a pull under its own reader's scope, coalesced to
// at most one batch per 100 ms per stream, and sends what changed as one
// `changes` event whose id is the sealed map of the stream's cursors. A log
// the pull answers `resync` for (a removal from a private space, a restore)
// is sent as a `resync` event and dropped from the stream: the client takes
// a snapshot and opens a new stream. Run deltas travel on the same stream as
// events without ids (`ephemeral`, ADR-22).
//
// A stream whose queue holds more than 2,048 events is closed, as is the
// older stream of a client id that opens another. Streams end on sign-out
// (`closeSession`), when the session expires (checked every 30 s), and at
// the drain.

import type { LogId } from "@session/mutators";
import type { SyncServer } from "@session/sync/server";

import type { Logger } from "../logger.js";

import type { CursorMap, EventIds } from "./eventIds.js";

/** At most one batch per stream in this many ms. */
export const COALESCE_MS = 100;
/** A stream whose unsent events exceed this is closed (`events/bus.ts`'s
 * bound). */
export const MAX_QUEUED_EVENTS = 2048;
/** A comment line this often keeps idle proxies from closing a stream. */
export const HEARTBEAT_MS = 25_000;
/** How often an open stream's session is checked. */
export const SESSION_CHECK_MS = 30_000;

/** One event as the route writes it. */
export interface StreamEvent {
  event: string;
  data: string;
  id?: string;
}

export interface StreamSink {
  /** Queue an event; the route writes them in order. */
  send(e: StreamEvent): void;
  /** How many events wait to be written. */
  queued(): number;
  /** End the stream. */
  close(reason: string): void;
}

export interface Stream {
  readonly id: number;
  readonly u: string;
  readonly clientId: string;
  readonly sessionToken: string | null;
  readonly cursors: CursorMap;
  readonly sink: StreamSink;
  dirty: Set<LogId>;
  timer: ReturnType<typeof setTimeout> | null;
  last: number;
  closed: boolean;
}

export interface HubOptions {
  server: SyncServer;
  ids: EventIds;
  logger?: Logger;
  /** Whether a session token still signs its person in. */
  sessionValid?: (token: string) => boolean;
}

export class SyncHub {
  readonly #server: SyncServer;
  readonly #ids: EventIds;
  readonly #logger: Logger | undefined;
  readonly #sessionValid: ((token: string) => boolean) | undefined;
  readonly #byClient = new Map<string, Stream>();
  readonly #byLog = new Map<LogId, Set<Stream>>();
  #next = 1;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #sessionCheck: ReturnType<typeof setInterval> | null = null;

  constructor(options: HubOptions) {
    this.#server = options.server;
    this.#ids = options.ids;
    this.#logger = options.logger;
    this.#sessionValid = options.sessionValid;
  }

  get ids(): EventIds {
    return this.#ids;
  }

  /** Open streams, for `/metrics` and the limits. */
  size(): number {
    return this.#byClient.size;
  }

  /** Whether a stream of this client id is open. */
  has(clientId: string): boolean {
    return this.#byClient.has(clientId);
  }

  streamsOf(u: string): number {
    let n = 0;
    for (const s of this.#byClient.values()) if (s.u === u) n += 1;
    return n;
  }

  /** Start reading `cursors` for `u`'s client `clientId`. The client id's
   * older stream, if any, is closed. Sends the changes since the cursors at
   * once. */
  open(spec: {
    u: string;
    clientId: string;
    sessionToken: string | null;
    cursors: CursorMap;
    sink: StreamSink;
  }): Stream {
    this.#byClient.get(spec.clientId)?.sink.close("replaced");
    const s: Stream = {
      id: this.#next++,
      u: spec.u,
      clientId: spec.clientId,
      sessionToken: spec.sessionToken,
      cursors: new Map(spec.cursors),
      sink: spec.sink,
      dirty: new Set(spec.cursors.keys()),
      timer: null,
      last: 0,
      closed: false,
    };
    this.#byClient.set(s.clientId, s);
    for (const log of s.cursors.keys()) this.#subscribe(s, log);
    s.sink.send({ event: "ready", data: JSON.stringify({ logs: [...s.cursors.keys()] }) });
    this.#flush(s);
    this.#startTimers();
    return s;
  }

  /** The stream ended (the client went away, or `sink.close`). */
  remove(s: Stream): void {
    if (s.closed) return;
    s.closed = true;
    if (s.timer) clearTimeout(s.timer);
    if (this.#byClient.get(s.clientId) === s) this.#byClient.delete(s.clientId);
    for (const log of s.cursors.keys()) this.#unsubscribe(s, log);
    if (this.#byClient.size === 0) this.#stopTimers();
  }

  #subscribe(s: Stream, log: LogId) {
    let set = this.#byLog.get(log);
    if (!set) this.#byLog.set(log, (set = new Set()));
    set.add(s);
  }

  #unsubscribe(s: Stream, log: LogId) {
    const set = this.#byLog.get(log);
    set?.delete(s);
    if (set?.size === 0) this.#byLog.delete(log);
  }

  /** A commit wrote these logs: wake the streams that read them. */
  wake(logs: ReadonlySet<LogId>): void {
    for (const log of logs)
      for (const s of this.#byLog.get(log) ?? []) {
        s.dirty.add(log);
        this.#schedule(s);
      }
  }

  #schedule(s: Stream) {
    if (s.timer || s.closed) return;
    const wait = Math.max(0, s.last + COALESCE_MS - Date.now());
    s.timer = setTimeout(() => {
      s.timer = null;
      this.#flush(s);
    }, wait);
    s.timer.unref?.();
  }

  /** Pull every dirty log of `s` under its reader's scope and send one
   * batch. */
  #flush(s: Stream) {
    if (s.closed) return;
    s.last = Date.now();
    const dirty = [...s.dirty];
    s.dirty = new Set();
    const batches: { log: LogId; changes: unknown[]; cursor: string; lastSeq: number | null }[] =
      [];
    const resync: LogId[] = [];
    for (const log of dirty) {
      const cursor = s.cursors.get(log);
      if (cursor === undefined) continue;
      let p;
      try {
        p = this.#server.pull({ u: s.u }, log, cursor, { clientId: s.clientId });
      } catch (error) {
        this.#logger?.error({ error, log }, "sync stream pull failed");
        s.dirty.add(log);
        this.#schedule(s);
        continue;
      }
      if ("resync" in p) {
        resync.push(log);
        s.cursors.delete(log);
        this.#unsubscribe(s, log);
        continue;
      }
      s.cursors.set(log, p.cursor);
      if (p.changes.length)
        batches.push({ log, changes: p.changes, cursor: p.cursor, lastSeq: p.lastSeq });
    }
    for (const log of resync)
      this.#send(s, {
        event: "resync",
        data: JSON.stringify({ log }),
        id: this.#ids.seal(s.cursors),
      });
    if (batches.length)
      this.#send(s, {
        event: "changes",
        data: JSON.stringify({ batches }),
        id: this.#ids.seal(s.cursors),
      });
  }

  #send(s: Stream, e: StreamEvent) {
    if (s.closed) return;
    if (s.sink.queued() >= MAX_QUEUED_EVENTS) {
      s.sink.close("too many queued events");
      this.remove(s);
      return;
    }
    s.sink.send(e);
  }

  /** An event without an id to every stream reading `log` whose reader may
   * read it now (a run's delta, `03` T2). `audience` is asked per stream at
   * send time, under the reader's current scope, as `pull` reads it: a
   * reader who may not read the record the event is about (a non-member
   * holding a cursor of a private space's log, a member removed within the
   * coalesce window, a hidden ask's reader other than its author and the
   * owner) gets nothing. Not stored, not replayed on a reconnect. */
  ephemeral(log: LogId, event: string, data: unknown, audience: (u: string) => boolean): void {
    let text: string | null = null;
    for (const s of this.#byLog.get(log) ?? []) {
      if (!audience(s.u)) continue;
      text ??= JSON.stringify(data);
      this.#send(s, { event, data: text });
    }
  }

  /** Sign-out: end the streams of this session. */
  closeSession(token: string): void {
    for (const s of [...this.#byClient.values()])
      if (s.sessionToken === token) {
        s.sink.close("signed out");
        this.remove(s);
      }
  }

  /** The drain: end every stream. */
  closeAll(reason: string): void {
    for (const s of [...this.#byClient.values()]) {
      s.sink.close(reason);
      this.remove(s);
    }
    this.#stopTimers();
  }

  #startTimers() {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => {
      for (const s of this.#byClient.values()) this.#send(s, { event: "ping", data: "" });
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
    this.#sessionCheck = setInterval(() => this.checkSessions(), SESSION_CHECK_MS);
    this.#sessionCheck.unref?.();
  }

  #stopTimers() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#sessionCheck) clearInterval(this.#sessionCheck);
    this.#heartbeat = null;
    this.#sessionCheck = null;
  }

  /** End the streams whose session no longer signs their person in. */
  checkSessions(): void {
    const valid = this.#sessionValid;
    if (!valid) return;
    for (const s of [...this.#byClient.values()])
      if (s.sessionToken === null || !valid(s.sessionToken)) {
        s.sink.close("session ended");
        this.remove(s);
      }
  }
}
