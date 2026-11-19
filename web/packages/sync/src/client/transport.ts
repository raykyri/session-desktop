// How a client reaches the server half: `push`, `pull`, `snapshot`,
// `listen`, plus `register` and the online-only `call`. Two transports:
// - `InProcessTransport` (here): calls a server half in the same process,
//   through an optional `Network` that delays, loses, duplicates and reorders
//   (the tests and the simulation);
// - `FetchTransport` (`fetch.ts`): HTTP with a bearer token, the protocol
//   version header and fetch-based SSE.

import type { LogId } from "@session/mutators";

import type {
  Actor,
  Answer,
  CallAnswer,
  Cursor,
  Envelope,
  PullAnswer,
  ReadError,
  ReadOptions,
  RegisterAnswer,
  SnapshotAnswer,
  SseEvent,
} from "../protocol.js";

/** Cursor tokens by log (an SSE event id). */
export type CursorMap = Partial<Record<LogId, Cursor>>;

/** A push's result for an envelope that got no response at all: the
 * network is down, or the connection failed before a response arrived. The
 * write may have reached the server. Unlike `null` (a response that is not
 * an answer, such as a proxy's 502 page), it is not a try: the client pauses
 * with backoff and leaves the end to the 3-day drop. */
export const NO_RESPONSE = "no-response";
export type PushResult = Answer | null | typeof NO_RESPONSE;

export interface Transport {
  register(): Promise<RegisterAnswer>;
  /** Send writes, in order, one request each; stops after the first that got
   * no answer. Each answer, or null: a response that is not an answer
   * arrived, or NO_RESPONSE: none arrived (either way the write may or may
   * not have been applied). A transport that cannot tell them apart answers
   * null. */
  push(envelopes: readonly Envelope[]): Promise<PushResult[]>;
  /** A read: its answer or the server's `ReadError`; Offline is thrown when
   * no answer arrived. */
  pull(log: LogId, cursor: Cursor, options?: ReadOptions): Promise<PullAnswer>;
  snapshot(log: LogId, options?: ReadOptions): Promise<SnapshotAnswer>;
  /** Listen for pokes until `signal` aborts or the stream ends. `cursors`
   * gives the client's tokens at each (re)connection. It ends with a
   * `ReadError` when the server refused the stream (UNAUTHORIZED: the sign-in
   * was lost; UPDATE_REQUIRED). */
  listen(
    cursors: () => CursorMap,
    onEvent: (e: SseEvent, id?: string) => void,
    signal: AbortSignal,
  ): Promise<void | ReadError>;
  call(name: string, input: unknown): Promise<CallAnswer>;
}

/** Thrown by a transport when the server cannot be reached. */
export class Offline extends Error {}

/** The server half as a client sees it in process (`SyncServer` is one). */
export interface ServerLike {
  register(actor: Actor | null): RegisterAnswer;
  apply(actor: Actor | null, envelope: unknown): Answer;
  snapshot(actor: Actor | null, log: LogId, options?: ReadOptions): SnapshotAnswer;
  pull(actor: Actor | null, log: LogId, cursor: Cursor, options?: ReadOptions): PullAnswer;
  call(actor: Actor | null, name: string, input: unknown): CallAnswer;
}

/** What a network does to one request: deliver it after `delay` ms, lose
 * the request or the answer, deliver it twice. */
export interface Network {
  /** Called once per request; the in-process transport follows the plan. */
  plan(kind: "push" | "pull" | "snapshot" | "register" | "call"): {
    /** The request never reaches the server. */
    lost?: boolean;
    /** The server handles it, the answer never arrives (the connection
     * drops: no response at all). */
    answerLost?: boolean;
    /** The server handles it, and the response is not an answer (a proxy's
     * error page): a push answers null. */
    notAnswer?: boolean;
    /** The server handles it twice (a retransmission). */
    duplicate?: boolean;
    /** Wait before handling it. */
    delay?: number;
  };
  /** Wait `ms` (a fake scheduler in the simulation). */
  wait(ms: number): Promise<void>;
  /** The network is down: every request throws Offline. */
  down?(): boolean;
}

/** Split an SSE byte stream into events and hand each to `on`. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  on: (e: SseEvent, id?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const stop = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", stop);
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let k: number;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, k);
        buf = buf.slice(k + 2);
        let data = "";
        let id: string | undefined;
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) data += line.slice(5).trimStart();
          else if (line.startsWith("id:")) id = line.slice(3).trimStart();
        }
        if (!data) continue;
        try {
          on(JSON.parse(data) as SseEvent, id);
        } catch {
          // a frame that is not an event: skipped
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

export class InProcessTransport implements Transport {
  constructor(
    private readonly server: ServerLike,
    private readonly actor: Actor | null,
    private readonly o: {
      net?: Network;
      /** The server half's SSE stream (`openStream`), for `listen`. */
      stream?: (
        actor: Actor | null,
        cursors: CursorMap,
        signal: AbortSignal,
      ) => ReadableStream<Uint8Array>;
    } = {},
  ) {}

  /** Run `f` across the network: its plan decides what arrives (null: a
   * response that is not an answer). */
  private async across<T>(kind: Parameters<Network["plan"]>[0], f: () => T): Promise<T | null> {
    const net = this.o.net;
    if (!net) return f();
    if (net.down?.()) throw new Offline("offline");
    const p = net.plan(kind);
    if (p.delay) await net.wait(p.delay);
    if (p.lost) throw new Offline("the request was lost");
    const out = f();
    if (p.duplicate) f();
    if (p.answerLost) throw new Offline("the answer was lost");
    if (p.notAnswer) return null;
    return out;
  }

  /** `across` for a call that needs an answer: a response that is not one
   * is a lost answer. */
  private async answered<T>(kind: Parameters<Network["plan"]>[0], f: () => T): Promise<T> {
    const out = await this.across(kind, f);
    if (out === null) throw new Offline("the response was not an answer");
    return out;
  }

  register() {
    return this.answered("register", () => this.server.register(this.actor));
  }

  async push(envelopes: readonly Envelope[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (const e of envelopes) {
      let a: Answer | null;
      try {
        a = await this.across("push", () =>
          this.server.apply(this.actor, JSON.parse(JSON.stringify(e))),
        );
      } catch (x) {
        if (!(x instanceof Offline)) throw x;
        out.push(NO_RESPONSE);
        break;
      }
      out.push(a);
      if (a === null) break;
    }
    return out;
  }

  pull(log: LogId, cursor: Cursor, options?: ReadOptions) {
    return this.answered("pull", () => this.server.pull(this.actor, log, cursor, options));
  }

  snapshot(log: LogId, options?: ReadOptions) {
    return this.answered("snapshot", () => this.server.snapshot(this.actor, log, options));
  }

  call(name: string, input: unknown) {
    return this.answered("call", () => this.server.call(this.actor, name, input));
  }

  async listen(
    cursors: () => CursorMap,
    onEvent: (e: SseEvent, id?: string) => void,
    signal: AbortSignal,
  ) {
    if (!this.o.stream) return;
    await readSse(this.o.stream(this.actor, cursors(), signal), onEvent, signal);
  }
}
