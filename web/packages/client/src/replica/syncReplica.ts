// The viewer's replica over `@session/sync` (02 §9.1, 01 Y9-Y12): a
// `SyncClient` on the sync routes (`http.ts`), behind the `ReplicaSource`
// the screens read. Nothing is persisted: a page load starts from snapshots.
//
// Which logs it reads:
// - a member: their user log and the log of every space they belong to,
//   read with `window` snapshots (01 R1) and kept current by the event
//   stream (Y7); a membership that appears or goes in the user log adds or
//   drops its space log. While the stream is down the logs are pulled on
//   each reconnect attempt.
// - signed out, and a `waiting` account (01 R5, 02 §9.5): no user log, no
//   outbox and no stream; every open channel of `spaces.directory`, read the
//   same way and pulled every 60 s.
// - a channel view of a channel the member has not joined (`watch`): its log
//   is read while the view is open, pulled on each visit and every 60 s, and
//   dropped when the view closes. Joining moves it to the stream.
//
// Known versus absent (`source.ts`): a read the replica cannot answer is
// `UNKNOWN`. The sync client says what its logs cover (`loaded`,
// `loadedIndex`); a thread's own records are known once the thread is held
// in full; a thread that is not held is known absent only after `open`
// found no such thread on the server.
//
// Writes go through the sync client's outbox with the `in-flight` policy: a
// write whose request fails is "Not sent" (`unsent`), with Retry and
// Discard. Per-viewer fields are computed by the queries from these records
// (`queries.ts`).

import {
  MUTATORS,
  isUlid,
  type ApiError,
  type Index,
  type Kind,
  type LogId,
  type RecordOf,
  type SpaceRec,
  type StoredRecord,
} from "@session/mutators";
import type { Spaces } from "@session/shared";
import {
  SyncClient,
  type ApplyResult,
  type ClientEvent,
  type Clock,
  type HeldClientId,
  type RegisterOptions,
  type RegisterResult,
  type SyncTransport,
} from "@session/sync/client";

import type { HttpSyncTransport } from "./http.js";
import {
  UNKNOWN,
  type DraftRef,
  type ReplicaSource,
  type Unknown,
  type UnsentWrite,
  type WriteOutcome,
} from "./source.js";

type SpaceMutatorName = Spaces.SpaceMutatorName;

/** The transport the replica reads and writes through: the sync routes and
 * their event stream. */
export type SyncHttp = SyncTransport & Pick<HttpSyncTransport, "events">;

export type ClaimResult = HeldClientId | { error: ApiError };

export interface SyncReplicaOptions {
  /** The handle the replica belongs to; null signed out. */
  me: string | null;
  /** A member: reads their user log, writes, and holds a client id. */
  writer: boolean;
  /** The account's id, which the tab's stored client id names. */
  userId: string | null;
  transport: SyncHttp;
  /** `spaces.directory`: the open channels (01 C7). */
  directory: () => Promise<readonly SpaceRec[]>;
  /** `spaces.byName`: a channel by name, a private one's landing included. */
  byName?: (name: string) => Promise<SpaceRec | null>;
  /** The tab's client id (`tabClient.ts`). */
  claim?: (
    userId: string,
    register: (options?: RegisterOptions) => Promise<RegisterResult>,
  ) => Promise<ClaimResult>;
  /** A client id the sync client registered after WRONG_CLIENT. */
  keepClientId?: (userId: string, clientId: string, lastSeq: number) => void;
  /** Put a write's text back in its composer (a discard or a refusal). */
  restoreDraft?: (draft: DraftRef) => void;
  /** Registers a function to run before an `UPGRADE_REQUIRED` reload
   * (`upgrade.ts`); the replica keeps its writes' text in their drafts. */
  beforeReload?: (keep: () => void) => () => void;
  /** The person lost access to a private channel (01 R4). */
  onLeft?: (name: string) => void;
  /** The event stream opened or closed. */
  onConnection?: (status: "open" | "closed") => void;
  clock?: Clock;
  /** How often logs without a stream are pulled (01 R5: 60 s). */
  pollMs?: number;
  /** The longest wait between attempts to reconnect the stream. */
  maxBackoffMs?: number;
}

/** The writes that create an item, by the input field holding its id. */
const ITEM_WRITES: ReadonlySet<string> = new Set([
  "threads.create",
  "research.forkNode",
  "research.createPostFollowUp",
  "comments.create",
]);

const USER_KINDS: ReadonlySet<Kind> = new Set<Kind>(["save", "notif", "prefs"]);
const CONTENT_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "node",
  "answer",
  "reply",
  "comment",
  "run",
]);

/** The same empty list on every read (a snapshot for `useSyncExternalStore`). */
const NO_WRITES: readonly UnsentWrite[] = [];

const spaceLog = (sp: string): LogId => `space:${sp}`;
const userLog = (u: string): LogId => `user:${u}`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });

/** An error as the screens read it: without the server's time. */
function withoutTime(e: ApiError & { serverTime?: number }): ApiError {
  const error: ApiError & { serverTime?: number } = { ...e };
  delete error.serverTime;
  return error;
}

function outcomeOf(r: ApplyResult): WriteOutcome {
  return r.ok ? { ok: true, result: r.result } : { ok: false, error: withoutTime(r.error) };
}

type OpenState = "pending" | "full" | "missing" | "unavailable";

export class SyncReplica implements ReplicaSource {
  readonly me: string | null;
  private readonly writer: boolean;
  private readonly options: SyncReplicaOptions;
  private readonly clock: Clock;
  private client: SyncClient | null = null;
  private making: Promise<SyncClient> | null = null;
  private readyValue = false;
  private counter = 0;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void)[] = [];

  /** `spaces.directory`'s answer, by id; null until it arrives. */
  private directoryRecords: Map<string, SpaceRec> | null = null;
  /** Channels looked up by name (`lookUp`), by id, and the names asked. */
  private readonly landings = new Map<string, SpaceRec>();
  private readonly names = new Map<string, "pending" | "done">();
  /** The logs the stream reads (a member's user log and joined spaces). */
  private readonly streamed = new Set<LogId>();
  /** Channel views open, by space id. */
  private readonly watched = new Map<string, number>();
  /** Logs whose first snapshot is in. */
  private readonly loadedLogs = new Set<LogId>();
  private readonly opens = new Map<string, OpenState>();
  /** Opens waiting for their channel's log. */
  private readonly wantOpen = new Map<string, string | null>();

  /** Per write, by local id: the composer it came from, the error that left
   * it unsent, and who waits for its next outcome. */
  private readonly drafts = new Map<string, DraftRef>();
  private readonly errors = new Map<string, ApiError>();
  private readonly waiting = new Map<string, (o: WriteOutcome) => void>();
  /** Private channels this tab left with `spaces.leave`: their resync is no
   * news to the person. */
  private readonly leaving = new Set<string>();
  private unsentCache: { version: number; list: UnsentWrite[] } | null = null;

  private active = false;
  private generation = 0;
  private stream: AbortController | null = null;
  private restart = false;
  private lastEventId: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private recomputing: Promise<void> | null = null;
  private recomputeAgain = false;

  constructor(options: SyncReplicaOptions) {
    this.options = options;
    this.me = options.me;
    this.writer = options.writer && options.me !== null;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  // ---- lifecycle ----

  /** Starts reading: the client id, the first snapshots, the stream and the
   * polls. May run again after `dispose`. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    const keep = this.options.beforeReload?.(() => this.keepDrafts());
    if (keep) this.unsubscribe.push(keep);
    const gen = ++this.generation;
    void this.run(gen);
  }

  /** Stops the stream and the polls; what was read stays. */
  dispose(): void {
    this.active = false;
    this.generation += 1;
    this.stream?.abort();
    this.stream = null;
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    for (const f of this.unsubscribe) f();
    this.unsubscribe = [];
    this.options.onConnection?.("closed");
  }

  private live(gen: number): boolean {
    return this.active && gen === this.generation;
  }

  private async makeClient(): Promise<SyncClient> {
    let clientId: string | null = null;
    let lastSeq = 0;
    const { claim, userId } = this.options;
    if (this.writer && claim && userId !== null) {
      try {
        const held = await claim(userId, (o) =>
          Promise.resolve(this.options.transport.register(o)),
        );
        if (!("error" in held)) {
          clientId = held.clientId;
          lastSeq = held.lastSeq;
        }
      } catch {
        // no answer: the client registers when it first writes
      }
    }
    return new SyncClient(this.options.transport, {
      user: this.writer ? this.me : null,
      clock: this.clock,
      mutators: MUTATORS,
      policy: "in-flight",
      clientId,
      lastSeq,
    });
  }

  private async run(gen: number): Promise<void> {
    this.making ??= this.makeClient();
    const client = (this.client = await this.making);
    if (!this.live(gen)) return;
    this.unsubscribe.push(
      client.subscribe(() => {
        this.changed();
        this.scheduleRecompute();
      }),
      client.onEvent((e) => this.onClientEvent(e)),
    );
    void this.loadDirectory(gen);
    await this.loadInitial(gen);
    if (!this.live(gen)) return;
    this.poll = setInterval(() => void this.pollOnce(gen), this.options.pollMs ?? 60_000);
    (this.poll as { unref?: () => void }).unref?.();
    if (this.writer) void this.streamLoop(gen);
  }

  /** Retries `f` with a growing wait until it succeeds or the replica stops. */
  private async persist<T>(gen: number, f: () => Promise<T>): Promise<T | null> {
    let wait = 1000;
    for (;;) {
      if (!this.live(gen)) return null;
      try {
        return await f();
      } catch {
        await sleep(wait);
        wait = Math.min(wait * 2, this.options.maxBackoffMs ?? 30_000);
      }
    }
  }

  private async loadInitial(gen: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.writer && this.me !== null) {
      const log = userLog(this.me);
      this.streamed.add(log);
      if (!this.loadedLogs.has(log)) {
        await this.persist(gen, () => client.sync(log));
        this.loadedLogs.add(log);
      }
      await this.recompute(gen);
    } else {
      await this.persist(gen, () => this.loadDirectory(gen, true));
      await this.readOpenSpaces(gen);
    }
    if (!this.live(gen)) return;
    this.readyValue = true;
    this.changed();
    await this.readWatched(gen);
    this.openWaiting(null);
  }

  // ---- logs ----

  /** Read a space log for the first time, or pull it. */
  private async syncSpace(gen: number, sp: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    const log = spaceLog(sp);
    await this.persist(gen, () => client.sync(log, "window"));
    if (!this.live(gen)) return;
    if (!this.loadedLogs.has(log)) {
      this.loadedLogs.add(log);
      this.changed();
    }
    this.openWaiting(sp);
  }

  /** The spaces of the member's confirmed memberships. */
  private joinedSpaces(): Set<string> {
    const client = this.client;
    const me = this.me;
    const out = new Set<string>();
    if (!client || me === null) return out;
    for (const key of client.replica.keysIn("member", { u: me })) {
      const r = client.replica.get(key);
      if (r?.kind === "member" && r.u === me) out.add(r.sp);
    }
    return out;
  }

  private scheduleRecompute(): void {
    if (!this.writer || !this.active) return;
    if (this.recomputing) {
      this.recomputeAgain = true;
      return;
    }
    const gen = this.generation;
    this.recomputing = Promise.resolve()
      .then(() => this.recompute(gen))
      .finally(() => {
        this.recomputing = null;
        if (this.recomputeAgain) {
          this.recomputeAgain = false;
          this.scheduleRecompute();
        }
      });
  }

  /** Make the streamed logs the user log and the joined spaces' logs. */
  private async recompute(gen: number): Promise<void> {
    const client = this.client;
    const me = this.me;
    if (!client || me === null || !this.live(gen)) return;
    if (!this.loadedLogs.has(userLog(me))) return;
    const joined = this.joinedSpaces();
    const want = new Set<LogId>([userLog(me), ...[...joined].map(spaceLog)]);
    const added = [...want].filter((log) => !this.streamed.has(log));
    const gone = [...this.streamed].filter((log) => !want.has(log));
    if (added.length === 0 && gone.length === 0) return;
    for (const log of gone) {
      this.streamed.delete(log);
      const sp = log.slice("space:".length);
      if (!this.watched.has(sp)) {
        client.dropLog(log);
        this.loadedLogs.delete(log);
      }
    }
    for (const log of added) this.streamed.add(log);
    await Promise.all(
      added.map((log) =>
        this.loadedLogs.has(log) ? Promise.resolve() : this.syncSpace(gen, log.slice(6)),
      ),
    );
    this.restartStream();
  }

  private async loadDirectory(gen: number, required = false): Promise<void> {
    let list: readonly SpaceRec[];
    try {
      list = await this.options.directory();
    } catch (error) {
      if (required) throw error;
      return;
    }
    if (!this.live(gen)) return;
    this.directoryRecords = new Map(list.map((s) => [s.id, s]));
    this.changed();
  }

  /** Signed out and waiting: read every open channel. */
  private async readOpenSpaces(gen: number): Promise<void> {
    const spaces = [...(this.directoryRecords?.values() ?? [])].filter((s) => s.vis === "open");
    await Promise.all(
      spaces
        .filter((s) => !this.loadedLogs.has(spaceLog(s.id)))
        .map((s) => this.syncSpace(gen, s.id)),
    );
  }

  private async pollOnce(gen: number): Promise<void> {
    if (!this.live(gen)) return;
    await this.loadDirectory(gen);
    if (!this.writer) await this.readOpenSpaces(gen);
    const client = this.client;
    if (!client) return;
    for (const log of client.logs())
      if (!this.streamed.has(log) && this.loadedLogs.has(log))
        void client.sync(log, "window").catch(() => undefined);
  }

  // ---- the event stream (01 Y7) ----

  private restartStream(): void {
    if (!this.stream) return;
    this.restart = true;
    this.stream.abort();
  }

  private async streamLoop(gen: number): Promise<void> {
    let wait = 1000;
    const max = this.options.maxBackoffMs ?? 30_000;
    while (this.live(gen)) {
      const client = this.client;
      const clientId = client?.clientId ?? null;
      if (!client) return;
      if (clientId === null) {
        // no client id yet (registration failed): the logs are pulled
        await sleep(wait);
        wait = Math.min(wait * 2, max);
        await client.register().catch(() => null);
        await this.pullStreamed(gen);
        continue;
      }
      const cursors = new Map<LogId, string>();
      for (const log of this.streamed) {
        const c = client.cursor(log);
        if (c !== undefined) cursors.set(log, c);
      }
      const abort = new AbortController();
      this.stream = abort;
      this.restart = false;
      let opened = false;
      try {
        const r = await this.options.transport.events({
          clientId,
          cursors,
          lastEventId: this.lastEventId,
          signal: abort.signal,
          onEvent: (e) => {
            if (e.type === "changes") {
              if (e.id) this.lastEventId = e.id;
              for (const b of e.batches)
                if (this.streamed.has(b.log)) void client.receive(b.log, b);
            } else if (e.type === "resync") {
              if (e.id) this.lastEventId = e.id;
              void client
                .sync(e.log, e.log.startsWith("space:") ? "window" : undefined)
                .catch(() => undefined)
                .then(() => this.restartStream());
            }
          },
        });
        if (r.status === 200) {
          opened = true;
          wait = 1000;
          this.options.onConnection?.("open");
          await r.done;
        }
      } catch {
        // the request failed or was aborted
      }
      if (this.stream === abort) this.stream = null;
      if (!this.live(gen)) return;
      if (opened) this.options.onConnection?.("closed");
      if (this.restart) continue;
      await sleep(wait);
      wait = Math.min(wait * 2, max);
      await this.pullStreamed(gen);
    }
  }

  /** Pull every streamed log (the stream is down). */
  private async pullStreamed(gen: number): Promise<void> {
    const client = this.client;
    if (!client || !this.live(gen)) return;
    await Promise.all(
      [...this.streamed].map((log) =>
        client.sync(log, log.startsWith("space:") ? "window" : undefined).catch(() => undefined),
      ),
    );
  }

  // ---- events of writes ----

  private onClientEvent(e: ClientEvent): void {
    switch (e.type) {
      case "applied":
        this.errors.delete(e.local);
        this.settle(e.local, { ok: true, result: e.result });
        this.drafts.delete(e.local);
        break;
      case "refused": {
        this.errors.delete(e.local);
        const draft = this.drafts.get(e.local);
        this.drafts.delete(e.local);
        if (draft) this.options.restoreDraft?.(draft);
        this.settle(e.local, { ok: false, error: e.error });
        break;
      }
      case "unsent": {
        this.errors.set(e.local, withoutTime(e.error));
        this.settle(e.local, { ok: true, result: undefined, unsent: true });
        this.changed();
        break;
      }
      case "problem": {
        const draft = this.drafts.get(e.problem.local);
        this.drafts.delete(e.problem.local);
        if (draft) this.options.restoreDraft?.(draft);
        this.settle(e.problem.local, {
          ok: false,
          error: { code: "EXPIRED", message: "This change waited too long to be sent." },
        });
        break;
      }
      case "discarded":
        this.errors.delete(e.local);
        break;
      case "left":
        // a Leave made in this tab has its own toast ("Left #name.")
        if (!this.leaving.delete(e.space)) this.options.onLeft?.(e.name);
        break;
      case "client":
        if (this.options.userId !== null)
          this.options.keepClientId?.(this.options.userId, e.clientId, e.lastSeq);
        this.restartStream();
        break;
      case "upgrade":
        // the transport reports every 426 (`http.ts`)
        break;
    }
  }

  private settle(local: string, outcome: WriteOutcome): void {
    const f = this.waiting.get(local);
    this.waiting.delete(local);
    f?.(outcome);
  }

  private outcomeOf(local: string): Promise<WriteOutcome> {
    return new Promise((resolve) => this.waiting.set(local, resolve));
  }

  /** Puts the text of every write not confirmed back in its draft (before
   * an `UPGRADE_REQUIRED` reload, 02 §9.2). */
  keepDrafts(): void {
    for (const draft of this.drafts.values()) this.options.restoreDraft?.(draft);
  }

  // ---- ReplicaSource ----

  private changed(): void {
    this.counter += 1;
    for (const f of [...this.listeners]) f();
  }

  ready(): boolean {
    return this.readyValue;
  }

  version(): number {
    return this.counter;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  now(): number {
    return this.client?.serverNow() ?? this.clock.now();
  }

  private userLogLoaded(): boolean {
    return this.me !== null && this.loadedLogs.has(userLog(this.me));
  }

  /** Whether a thread's records other than its own are all held: the thread
   * is held in full, or only predicted (a write of this tab made it). */
  private threadFull(client: SyncClient, th: string): boolean | Unknown {
    if (!client.get(`thread:${th}`)) return UNKNOWN;
    const log = client.replica.logOfThread(th);
    return log === undefined || client.replica.isFull(log, th);
  }

  get(key: string): StoredRecord | undefined | Unknown {
    const client = this.client;
    if (!client) return UNKNOWN;
    const r = client.get(key);
    if (r) return r;
    const [kind, a] = key.split(":");
    switch (kind) {
      case "space": {
        const d = a ? (this.directoryRecords?.get(a) ?? this.landings.get(a)) : undefined;
        if (d) return d;
        return this.complete("space") ? undefined : UNKNOWN;
      }
      case "thread": {
        if (!a) return undefined;
        const state = this.opens.get(a);
        return state === "missing" ? undefined : UNKNOWN;
      }
      case "counts":
        return a && client.get(`thread:${a}`) ? undefined : UNKNOWN;
      case "answer": {
        if (!a) return undefined;
        if (client.get(`thread:${a}`)) {
          const full = this.threadFull(client, a);
          return full === true ? undefined : UNKNOWN;
        }
        const node = client.get(`node:${a}`);
        if (node?.kind === "node")
          return this.threadFull(client, node.th) === true ? undefined : UNKNOWN;
        return UNKNOWN;
      }
      case "save":
      case "prefs":
      case "notif":
        if (!this.writer) return undefined;
        return client.loaded(key) ? undefined : UNKNOWN;
      case "member":
      case "request":
      case "ban": {
        const u = key.split(":")[2];
        if (!this.writer && u === this.me) return undefined;
        if (this.writer && u === this.me && this.userLogLoaded()) return undefined;
        return client.loaded(key) ? undefined : UNKNOWN;
      }
      default:
        return client.loaded(key) ? undefined : UNKNOWN;
    }
  }

  private records<K extends Kind>(client: SyncClient, kind: K, index: Index): RecordOf<K>[] {
    const out: RecordOf<K>[] = [];
    for (const key of client.keysIn(kind, index).sort()) {
      const r = client.get(key);
      if (r && r.kind === kind) out.push(r as RecordOf<K>);
    }
    return out;
  }

  list<K extends Kind>(kind: K, index: Index): RecordOf<K>[] | Unknown {
    const client = this.client;
    if (!client) return UNKNOWN;
    if ("u" in index) {
      if (!this.writer) return [];
      if (index.u !== this.me || !client.loadedIndex(kind, index)) return UNKNOWN;
      return this.records(client, kind, index);
    }
    if (USER_KINDS.has(kind)) {
      if (!this.writer) return [];
      return client.loadedIndex(kind, index) ? this.records(client, kind, index) : UNKNOWN;
    }
    if ("sp" in index) {
      // the threads of a space are what its log holds: a window snapshot
      // leaves out threads older than 2 years, which `open` fetches
      const held = client.replica.state(spaceLog(index.sp)) !== undefined;
      if (kind === "thread" || kind === "counts")
        return held ? this.records(client, kind, index) : UNKNOWN;
      return client.loadedIndex(kind, index) ? this.records(client, kind, index) : UNKNOWN;
    }
    if (CONTENT_KINDS.has(kind) || kind === "counts") {
      if (this.threadFull(client, index.th) !== true) return UNKNOWN;
      return this.records(client, kind, index);
    }
    return client.loadedIndex(kind, index) ? this.records(client, kind, index) : UNKNOWN;
  }

  all<K extends Kind>(kind: K): RecordOf<K>[] {
    const client = this.client;
    if (!client) return [];
    const out: RecordOf<K>[] = [];
    const seen = new Set<string>();
    for (const key of client.keysOfKind(kind)) {
      const r = client.get(key);
      if (r && r.kind === kind) {
        out.push(r as RecordOf<K>);
        seen.add(key);
      }
    }
    if (kind === "space")
      for (const s of [...(this.directoryRecords?.values() ?? []), ...this.landings.values()])
        if (!seen.has(`space:${s.id}`)) {
          seen.add(`space:${s.id}`);
          out.push(s as RecordOf<K>);
        }
    return out;
  }

  lookUp(name: string): boolean {
    const byName = this.options.byName;
    if (!byName) return true;
    const state = this.names.get(name);
    if (state !== undefined) return state === "done";
    this.names.set(name, "pending");
    // asked from a query, which runs during a render: answer afterwards
    queueMicrotask(() => {
      void byName(name)
        .then((space) => {
          if (space) this.landings.set(space.id, space);
        })
        .catch(() => undefined)
        .finally(() => {
          this.names.set(name, "done");
          this.changed();
        });
    });
    return false;
  }

  complete(kind: Kind): boolean {
    if (kind !== "space") return false;
    return this.directoryRecords !== null && (!this.writer || this.userLogLoaded());
  }

  async mutate(
    name: SpaceMutatorName,
    input: unknown,
    options: { draft?: DraftRef } = {},
  ): Promise<WriteOutcome> {
    const client = this.client;
    if (!this.writer)
      return { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in to do this." } };
    if (!client)
      return { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "Not connected yet." } };
    const def = Object.hasOwn(MUTATORS, name) ? MUTATORS[name] : undefined;
    if (!def) return { ok: false, error: { code: "BAD_REQUEST", message: `No mutator ${name}.` } };
    if (def.online) return outcomeOf(await client.send(name, input));
    if (name === "spaces.leave") {
      const space = (input as { space?: unknown } | null)?.space;
      if (typeof space === "string") this.leaving.add(space);
    }
    const p = client.write(name, input);
    if (options.draft) this.drafts.set(p.local, options.draft);
    return this.outcomeOf(p.local);
  }

  unsent(): readonly UnsentWrite[] {
    const client = this.client;
    if (!client) return NO_WRITES;
    if (this.unsentCache?.version === this.counter) return this.unsentCache.list;
    const list = client.unsent().map((p): UnsentWrite => ({
      local: p.local,
      name: p.name as SpaceMutatorName,
      input: p.input,
      item: ITEM_WRITES.has(p.name) ? ((p.input as { id?: string } | null)?.id ?? null) : null,
      error: this.errors.get(p.local) ?? null,
    }));
    const previous = this.unsentCache?.list;
    const same =
      previous !== undefined &&
      previous.length === list.length &&
      previous.every((x, i) => x.local === list[i]?.local && x.error === list[i]?.error);
    this.unsentCache = { version: this.counter, list: same ? previous : list };
    return this.unsentCache.list;
  }

  retry(local: string): Promise<WriteOutcome> {
    const client = this.client;
    if (!client) return Promise.resolve({ ok: true, result: undefined, unsent: true });
    const outcome = this.outcomeOf(local);
    this.errors.delete(local);
    void client.retry(local);
    return outcome;
  }

  discard(local: string): void {
    const client = this.client;
    if (!client) return;
    const draft = this.drafts.get(local);
    this.drafts.delete(local);
    if (client.discard(local) && draft) this.options.restoreDraft?.(draft);
  }

  open(thread: string, space?: string): void {
    if (!isUlid(thread)) {
      if (this.opens.get(thread) !== "missing") {
        this.opens.set(thread, "missing");
        this.changed();
      }
      return;
    }
    const state = this.opens.get(thread);
    if (state === "pending" || state === "full") return;
    const client = this.client;
    // before the first snapshots, or before the channel's log is read: once
    // it is (`syncSpace`, `run`)
    if (
      !client ||
      !this.readyValue ||
      (space !== undefined &&
        !client.replica.logOfThread(thread) &&
        !this.loadedLogs.has(spaceLog(space)))
    ) {
      this.wantOpen.set(thread, space ?? null);
      return;
    }
    this.opens.set(thread, "pending");
    void client.open(thread, space === undefined ? undefined : spaceLog(space)).then((r) => {
      this.opens.set(thread, r);
      this.changed();
    });
  }

  /** Run the opens that waited for `space`'s log (null: for the first
   * snapshots). */
  private openWaiting(space: string | null): void {
    for (const [thread, sp] of [...this.wantOpen])
      if (space === null || sp === space) {
        this.wantOpen.delete(thread);
        this.open(thread, sp ?? undefined);
      }
  }

  watch(space: string): () => void {
    this.watched.set(space, (this.watched.get(space) ?? 0) + 1);
    const log = spaceLog(space);
    // a visit pulls the log, or reads it the first time
    if (this.client && this.readyValue && !this.streamed.has(log))
      void this.syncSpace(this.generation, space);
    return () => {
      const n = (this.watched.get(space) ?? 1) - 1;
      if (n > 0) {
        this.watched.set(space, n);
        return;
      }
      this.watched.delete(space);
      // a reader keeps every open channel: Home reads them all
      if (!this.writer || this.streamed.has(log)) return;
      this.client?.dropLog(log);
      this.loadedLogs.delete(log);
      for (const [thread, sp] of [...this.wantOpen]) if (sp === space) this.wantOpen.delete(thread);
    };
  }

  /** The channel views opened before the first snapshots were in. */
  private async readWatched(gen: number): Promise<void> {
    await Promise.all(
      [...this.watched.keys()]
        .filter((sp) => !this.streamed.has(spaceLog(sp)))
        .map((sp) => this.syncSpace(gen, sp)),
    );
  }
}
