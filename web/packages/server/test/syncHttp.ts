// A person writing and reading through the sync routes of a test server
// (`helpers.ts` `createHarness`), and a reader of the event stream, for the
// route tests (`01` S1, Y3, Y4, Y7, A3).

import type { User } from "@session/shared";
import {
  PROTOCOL_VERSION,
  ulid,
  type ApplyResult,
  type Envelope,
  type RegisterResult,
  type Snapshot,
} from "@session/sync/server";

import type { Harness } from "./helpers.js";

export const MODEL = { model: "claude-fable", effort: "medium" } as const;

export const newId = (at = Date.now()) => ulid(at, Math.random);

export class Person {
  readonly cookie: string;
  clientId = "";
  seq = 0;

  constructor(
    readonly h: Harness,
    readonly user: User,
    /** The device's clock (the server's by default). */
    readonly now: () => number = Date.now,
  ) {
    this.cookie = h.signIn(user);
  }

  get handle(): string {
    return this.user.handle ?? "";
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.h.request(path, {
      method: "POST",
      cookie: this.cookie,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async register(clientId?: string): Promise<{ status: number; body: RegisterResult }> {
    const res = await this.post("/api/sync/register", clientId === undefined ? {} : { clientId });
    const body = (await res.json()) as RegisterResult;
    if (body.ok) {
      this.clientId = body.clientId;
      this.seq = body.lastSeq;
    }
    return { status: res.status, body };
  }

  envelope(name: string, input: unknown, mutationId = newId(this.now())): Envelope {
    const now = this.now();
    return {
      clientId: this.clientId,
      seq: ++this.seq,
      mutationId,
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
    };
  }

  async send(envelopes: Envelope[]): Promise<{ status: number; answers: ApplyResult[] }> {
    const res = await this.post("/api/sync/apply", { envelopes });
    const json = (await res.json()) as { answers: ApplyResult[] };
    return { status: res.status, answers: json.answers };
  }

  /** One write; registers first if needed. */
  async write(name: string, input: unknown): Promise<ApplyResult> {
    if (!this.clientId) await this.register();
    const { answers } = await this.send([this.envelope(name, input)]);
    const a = answers[0];
    if (!a) throw new Error("no answer");
    return a;
  }

  async ok(name: string, input: unknown): Promise<unknown> {
    const a = await this.write(name, input);
    if (!a.ok) throw new Error(`${name}: ${JSON.stringify(a.error)}`);
    return a.result;
  }

  async snapshot(log: string): Promise<Snapshot> {
    const res = await this.post("/api/sync/snapshot", {
      log,
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
    return (await res.json()) as Snapshot;
  }

  /** Open the event stream for `cursors`. */
  async events(cursors: Record<string, string>, lastEventId?: string): Promise<EventReader> {
    const res = await this.h.request(`/api/sync/events?clientId=${this.clientId}`, {
      cookie: this.cookie,
      headers: {
        "Session-Cursors": JSON.stringify(cursors),
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      },
    });
    return new EventReader(res);
  }
}

export interface SseEvent {
  event: string;
  data: string;
  id: string | undefined;
}

/** Reads `text/event-stream` from a fetch response. */
export class EventReader {
  readonly status: number;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array> | null;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  readonly #ready: SseEvent[] = [];
  #pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | null = null;
  ended = false;

  constructor(readonly response: Response) {
    this.status = response.status;
    this.#reader = response.body?.getReader() ?? null;
  }

  /** The next event that is not a ping, or null when the stream ended or
   * none came within `ms`. */
  async next(ms = 2000): Promise<SseEvent | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const e = this.#ready.shift();
      if (e) {
        if (e.event === "ping") continue;
        return e;
      }
      if (this.ended || !this.#reader) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // a read that loses the race is kept for the next call, so a chunk
      // that arrives after a timeout is not dropped
      this.#pending ??= this.#reader.read();
      const chunk = await Promise.race([
        this.#pending,
        new Promise<null>((r) => (timer = setTimeout(() => r(null), left))),
      ]);
      clearTimeout(timer);
      if (chunk === null) return null;
      this.#pending = null;
      if (chunk.done) {
        this.ended = true;
        continue;
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
      for (let at = this.#buffer.indexOf("\n\n"); at >= 0; at = this.#buffer.indexOf("\n\n")) {
        const block = this.#buffer.slice(0, at);
        this.#buffer = this.#buffer.slice(at + 2);
        const e: SseEvent = { event: "message", data: "", id: undefined };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) e.event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("id:")) e.id = line.slice(3).trim();
        }
        e.data = data.join("\n");
        if (block.trim() && !block.startsWith(":")) this.#ready.push(e);
      }
    }
  }

  /** The next event named `name`, skipping others. */
  async until(name: string, ms = 2000): Promise<SseEvent | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const e = await this.next(Math.max(1, deadline - Date.now()));
      if (e === null || e.event === name) return e;
    }
  }

  async close(): Promise<void> {
    await this.#reader?.cancel().catch(() => undefined);
  }
}

/** The keys a `changes` event carries for `log`. */
export function keysOf(e: SseEvent | null, log: string): string[] {
  if (!e || e.event !== "changes") return [];
  const { batches } = JSON.parse(e.data) as {
    batches: { log: string; changes: { key: string }[] }[];
  };
  return batches.filter((b) => b.log === log).flatMap((b) => b.changes.map((c) => c.key));
}

/** The records a `changes` event carries for `log`, by key. */
export function recordsOf(e: SseEvent | null, log: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!e || e.event !== "changes") return out;
  const { batches } = JSON.parse(e.data) as {
    batches: {
      log: string;
      changes: { key: string; op: string; record?: Record<string, unknown> }[];
    }[];
  };
  for (const b of batches)
    if (b.log === log) for (const c of b.changes) if (c.record) out.set(c.key, c.record);
  return out;
}

/** olga's open #lounge (mona, mel) and private #lab (mel, by an invite
 * link), over the sync routes. */
export async function channels(h: Harness) {
  const olga = new Person(h, h.addUser("olga"));
  const mona = new Person(h, h.addUser("mona"));
  const mel = new Person(h, h.addUser("mel"));
  const open = newId();
  const closed = newId();
  await olga.ok("spaces.create", { id: open, name: "lounge" });
  await olga.ok("spaces.create", { id: closed, name: "lab", vis: "private" });
  for (const p of [mona, mel]) await p.ok("spaces.join", { space: open });
  const link = (await olga.ok("invites.create", { id: newId(), space: closed, days: 7 })) as {
    code: string;
  };
  await mel.ok("spaces.join", { space: closed, invite: link.code });
  return { olga, mona, mel, open, closed };
}
