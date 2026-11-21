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
//   outbox and no stream; every open channel of `spaces.directory`, read
//   with `summary` snapshots and pulled every 60 s.
// - a channel view of a channel the member has not joined (`watch`): its log
//   is read with a `summary` snapshot while the view is open, pulled on each
//   visit and every 60 s, and dropped when the view closes. Joining moves it
//   to the stream.
// A summary thread's own records are fetched when its row renders (`open`,
// 01 R3): the rows that render within 400 ms are fetched with one `threads`
// read per log (`openMany`), which the transport sends in requests of their
// own (`http.ts`). A fetch that fails is shown as "Available when online."
// and tried again after a backoff and when the stream reconnects. The
// transport sends the other reads of one turn as one request, so a reader of
// a few hundred channels stays under the server's snapshot limit.
//
// A read whose log the replica stopped reading meanwhile (a closed channel
// view, a left channel) is not applied, and a resync of such a log is
// ignored. A resync is read again after a backoff until it succeeds; the
// stream is reopened only then.
//
// Known versus absent (`source.ts`): a read the replica cannot answer is
// `UNKNOWN`. The sync client says what its logs cover (`loaded`,
// `loadedIndex`); a thread's own records are known once the thread is held
// in full; a thread that is not held is known absent only after `open`
// found no such thread on the server.
//
// Writes go through the sync client's outbox with the `in-flight` policy: a
// write whose request fails is "Not sent" (`unsent`), with Retry and
// Discard; its text is kept in `drafts` for a reload (`unsentDrafts`). The
// client id is checked against the session before a write is sent under a
// new one: a session signed in as another person stops the replica, and the
// tab reads the session again (`onSessionChanged`). Per-viewer fields are
// computed by the queries from these records (`queries.ts`).

import {
  MUTATORS,
  isOwnerOf,
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
  type OpenMany,
  type OpenOutcome,
  type RegisterOptions,
  type RegisterResult,
  type SyncOutcome,
  type SyncTransport,
} from "@session/sync/client";

import { retryAfterOf, type HttpSyncTransport } from "./http.js";
import { RunLiveTexts, type LiveText } from "./runLive.js";
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
export type SyncHttp = SyncTransport &
  Pick<HttpSyncTransport, "events"> &
  Partial<Pick<HttpSyncTransport, "live">>;

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
  /** Keep the text of a "Not sent" write for a reload (`drafts`), and drop
   * it once the write is applied, refused or discarded. */
  unsentDrafts?: {
    keep: (local: string, draft: DraftRef) => void;
    drop: (local: string) => void;
  };
  /** The handle the session is signed in as now (`auth.me`), null signed
   * out: asked when `register`'s answer names no user. */
  whoAmI?: () => Promise<string | null>;
  /** The session is signed in as another person than the replica's: read
   * the session again (the tab switches viewer). */
  onSessionChanged?: () => void;
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
  /** How long summary rows' opens are gathered into one request. */
  gatherMs?: number;
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
  "turn",
]);

/** How long the opens of summary rows rendering together are gathered. */
export const GATHER_MS = 400;

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
  /** Summary threads whose rows rendered, to open together. */
  private readonly gathered = new Set<string>();
  private gatherTimer: ReturnType<typeof setTimeout> | null = null;
  /** Opens waiting for their channel's log. */
  private readonly wantOpen = new Map<string, string | null>();
  /** The channel an address named for a thread it opened. */
  private readonly openSpaces = new Map<string, string | undefined>();
  private openRetry: ReturnType<typeof setTimeout> | null = null;
  private openWait = 1000;
  /** Channel names whose lookup failed, waiting to be asked again. */
  private readonly lookUpRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Space reads in progress (`syncSpace`), by log. */
  private readonly spaceReads = new Map<LogId, Promise<void>>();
  /** Logs being read again after a resync. */
  private readonly resyncing = new Set<LogId>();
  /** The poll waits until then: the server named a wait (`Retry-After`). */
  private pollPausedUntil = 0;

  /** Per write, by local id: the composer it came from, the error that left
   * it unsent, and who waits for its next outcome. */
  private readonly drafts = new Map<string, DraftRef>();
  private readonly errors = new Map<string, ApiError>();
  private readonly waiting = new Map<
    string,
    { promise: Promise<WriteOutcome>; resolve: (o: WriteOutcome) => void }
  >();
  /** Private channels this tab left with `spaces.leave`: their resync is no
   * news to the person. By space, with the write's local id. */
  private readonly leaving = new Map<string, string>();
  private unsentCache: { version: number; list: UnsentWrite[] } | null = null;

  private active = false;
  private generation = 0;
  private stream: AbortController | null = null;
  private restart = false;
  private lastEventId: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private recomputing: Promise<void> | null = null;
  private recomputeAgain = false;

  /** The text of runs still streaming (`03` T2, T3). */
  private readonly runTexts: RunLiveTexts;

  constructor(options: SyncReplicaOptions) {
    this.options = options;
    const live = options.transport.live?.bind(options.transport);
    this.runTexts = new RunLiveTexts({
      read: (run) => (live ? live(run) : Promise.resolve(null)),
      onChange: () => this.changed(),
    });
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
    if (this.gatherTimer !== null) clearTimeout(this.gatherTimer);
    this.gatherTimer = null;
    this.gathered.clear();
    if (this.openRetry !== null) clearTimeout(this.openRetry);
    this.openRetry = null;
    for (const [name, t] of this.lookUpRetries) {
      clearTimeout(t);
      this.names.delete(name);
    }
    this.lookUpRetries.clear();
    for (const f of this.unsubscribe) f();
    this.unsubscribe = [];
    this.runTexts.clear();
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
        const held = await claim(userId, (o) => this.registerAs(o));
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
      ...(this.options.whoAmI ? { whoAmI: this.options.whoAmI } : {}),
    });
  }

  /** `register` for the tab's claim, made just after the viewer was read:
   * an id the answer says is another person's (the session changed in
   * between) is not kept. An answer that names no user is taken as the
   * viewer's; the sync client checks again before it sends under an id it
   * registered itself (`whoAmI`). */
  private async registerAs(o?: RegisterOptions): Promise<RegisterResult> {
    const r = await this.options.transport.register(o);
    if (!r.ok) return r;
    if (r.user !== undefined && r.user !== this.me) {
      this.sessionChanged();
      return {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "This tab is now signed in as another person." },
      };
    }
    return r;
  }

  private sessionChangedValue = false;

  /** The session is another person's: stop reading, and have the tab read
   * the session again. */
  private sessionChanged(): void {
    if (this.sessionChangedValue) return;
    this.sessionChangedValue = true;
    this.stream?.abort();
    this.options.onSessionChanged?.();
  }

  private async run(gen: number): Promise<void> {
    this.making ??= this.makeClient();
    const client = (this.client = await this.making);
    if (!this.live(gen)) return;
    this.unsubscribe.push(
      client.subscribe(() => {
        this.pruneRunTexts();
        this.changed();
        this.scheduleRecompute();
      }),
      client.onEvent((e) => this.onClientEvent(e)),
    );
    // a reader's first snapshots wait for the directory; a member's do not
    if (this.writer) void this.loadDirectory(gen);
    await this.loadInitial(gen);
    if (!this.live(gen)) return;
    this.poll = setInterval(() => void this.pollOnce(gen), this.options.pollMs ?? 60_000);
    (this.poll as { unref?: () => void }).unref?.();
    if (this.writer) void this.streamLoop(gen);
  }

  /** Retries `f` with a growing wait, or the wait the server named
   * (`Retry-After`), until it succeeds or the replica stops. */
  private async persist<T>(gen: number, f: () => Promise<T>): Promise<T | null> {
    let wait = 1000;
    for (;;) {
      if (!this.live(gen)) return null;
      try {
        return await f();
      } catch (error) {
        await sleep(Math.max(wait, retryAfterOf(error) ?? 0));
        wait = Math.min(wait * 2, this.maxBackoff());
      }
    }
  }

  private maxBackoff(): number {
    return this.options.maxBackoffMs ?? 30_000;
  }

  /** Whether the replica still reads a log: the user log and joined
   * channels (streamed), an open channel view (watched), or, for a reader,
   * any open channel. */
  private wanted(log: LogId): boolean {
    if (this.streamed.has(log)) return true;
    if (!log.startsWith("space:")) return false;
    return this.watched.has(log.slice(6)) || !this.writer;
  }

  /** Read a log while the replica still wants it, retrying on failure. */
  private readWanted(gen: number, log: LogId): Promise<SyncOutcome | null> {
    const client = this.client;
    if (!client) return Promise.resolve(null);
    return this.persist(gen, () =>
      this.wanted(log) ? client.sync(log, this.tierOf(log)) : Promise.resolve("dropped" as const),
    );
  }

  private async loadInitial(gen: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.writer && this.me !== null) {
      const log = userLog(this.me);
      this.streamed.add(log);
      if (!this.loadedLogs.has(log)) {
        const r = await this.persist(gen, () => client.sync(log));
        if (!this.live(gen) || r === null || r === "dropped") return;
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

  /** The tier a space log is read with (01 R1, R5): a joined channel's with
   * the web window, an unjoined channel's and a reader's with summaries,
   * whose threads are fetched in full when their rows render (`open`). */
  private tierOf(log: LogId): "window" | "summary" | undefined {
    if (!log.startsWith("space:")) return undefined;
    return this.streamed.has(log) ? "window" : "summary";
  }

  /** Read a space log for the first time, or pull it. A log the replica
   * stopped reading while the read was in flight is not recorded as loaded
   * (the sync client did not apply the answer). */
  private syncSpace(gen: number, sp: string): Promise<void> {
    const log = spaceLog(sp);
    const running = this.spaceReads.get(log);
    if (running) return running;
    const run = (async () => {
      const r = await this.readWanted(gen, log);
      if (!this.live(gen) || r === null || r === "dropped" || !this.wanted(log)) return;
      if (!this.loadedLogs.has(log)) {
        this.loadedLogs.add(log);
        this.changed();
      }
      this.openWaiting(sp);
    })().finally(() => {
      if (this.spaceReads.get(log) === run) this.spaceReads.delete(log);
    });
    this.spaceReads.set(log, run);
    return run;
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
        this.spaceReads.delete(log);
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
    if (!this.live(gen) || this.clock.now() < this.pollPausedUntil) return;
    await this.loadDirectory(gen);
    if (!this.writer) await this.readOpenSpaces(gen);
    const client = this.client;
    if (!client) return;
    for (const log of client.logs())
      if (!this.streamed.has(log) && this.loadedLogs.has(log))
        void client.sync(log, this.tierOf(log)).catch((error: unknown) => {
          // the server named a wait: no poll before it
          const wait = retryAfterOf(error);
          if (wait !== undefined)
            this.pollPausedUntil = Math.max(this.pollPausedUntil, this.clock.now() + wait);
        });
  }

  // ---- the event stream (01 Y7) ----

  private restartStream(): void {
    if (!this.stream) return;
    this.restart = true;
    this.stream.abort();
  }

  private async streamLoop(gen: number): Promise<void> {
    let wait = 1000;
    const max = this.maxBackoff();
    while (this.live(gen)) {
      const client = this.client;
      const clientId = client?.clientId ?? null;
      if (!client || client.sessionChanged || this.sessionChangedValue) return;
      if (clientId === null) {
        // no client id yet (registration failed): the logs are pulled
        await sleep(wait);
        wait = Math.min(wait * 2, max);
        await client.register().catch(() => null);
        await this.pullStreamed(gen);
        continue;
      }
      // The stream starts from these cursors. A pull or snapshot of a log
      // after this point may read past a batch the stream pushes, so a
      // batch is applied only while the log's cursor is the one the stream
      // started from or moved by the stream (`receive`'s `base`).
      const cursors = new Map<LogId, string>();
      const bases = new Map<LogId, number>();
      for (const log of this.streamed) {
        const c = client.cursor(log);
        if (c === undefined) continue;
        cursors.set(log, c);
        bases.set(log, client.cursorReadsOf(log));
      }
      const abort = new AbortController();
      this.stream = abort;
      this.restart = false;
      let opened = false;
      let refused: { status: number; code: string | null; retryAfterMs?: number } | null = null;
      try {
        const r = await this.options.transport.events({
          clientId,
          cursors,
          lastEventId: this.lastEventId,
          signal: abort.signal,
          onEvent: (e) => {
            // an event of a stream that was replaced or closed
            if (this.stream !== abort || !this.live(gen)) return;
            if (e.type === "changes") {
              if (e.id) this.lastEventId = e.id;
              for (const b of e.batches) {
                const base = bases.get(b.log);
                if (!this.streamed.has(b.log) || base === undefined) continue;
                void client.receive(b.log, b, base).then((applied) => {
                  // a read moved the cursor past the stream's: reopen the
                  // stream from the newer cursor
                  if (!applied && this.stream === abort && client.cursor(b.log) !== undefined)
                    this.restartStream();
                });
              }
            } else if (e.type === "delta") {
              this.runTexts.apply(e.delta);
            } else if (e.type === "resync") {
              if (e.id) this.lastEventId = e.id;
              this.dropRunTexts(e.log);
              void this.resync(gen, e.log);
            }
          },
        });
        if (r.status === 200) {
          opened = true;
          wait = 1000;
          this.options.onConnection?.("open");
          // deltas sent while the stream was down are not replayed (`03` T3)
          this.runTexts.reconnected(this.runningRuns());
          this.retryOpens();
          await r.done;
        } else refused = r;
      } catch {
        // the request failed, was aborted, or timed out connecting
      }
      if (this.stream === abort) this.stream = null;
      if (!this.live(gen)) return;
      if (opened) this.options.onConnection?.("closed");
      if (this.restart) continue;
      if (refused?.code === "WRONG_CLIENT") {
        // the server no longer knows the id (expired, pruned) or it is
        // another person's: register again, then reconnect
        await client.reregister().catch(() => null);
        if (client.sessionChanged) return;
        if (client.clientId !== null) continue;
      }
      await sleep(Math.max(wait, refused?.retryAfterMs ?? 0));
      wait = Math.min(wait * 2, max);
      await this.pullStreamed(gen);
    }
  }

  /** A resync of a log on the stream: read it again, after a backoff while
   * the read fails, and reopen the stream once it succeeded. A log the
   * replica no longer reads is ignored. */
  private async resync(gen: number, log: LogId): Promise<void> {
    if (!this.wanted(log) || this.resyncing.has(log)) return;
    this.resyncing.add(log);
    try {
      const r = await this.readWanted(gen, log);
      if (!this.live(gen) || r === null || r === "dropped") return;
      if (this.streamed.has(log)) this.restartStream();
    } finally {
      this.resyncing.delete(log);
    }
  }

  /** Pull every streamed log (the stream is down). */
  private async pullStreamed(gen: number): Promise<void> {
    const client = this.client;
    if (!client || !this.live(gen)) return;
    await Promise.all(
      [...this.streamed].map((log) => client.sync(log, this.tierOf(log)).catch(() => undefined)),
    );
  }

  // ---- events of writes ----

  private onClientEvent(e: ClientEvent): void {
    switch (e.type) {
      case "applied":
        this.errors.delete(e.local);
        this.settle(e.local, { ok: true, result: e.result });
        this.drafts.delete(e.local);
        this.options.unsentDrafts?.drop(e.local);
        break;
      case "refused": {
        this.errors.delete(e.local);
        this.endLeave(e.local);
        const draft = this.drafts.get(e.local);
        this.drafts.delete(e.local);
        this.options.unsentDrafts?.drop(e.local);
        if (draft) this.options.restoreDraft?.(draft);
        this.settle(e.local, { ok: false, error: e.error });
        break;
      }
      case "unsent": {
        this.errors.set(e.local, withoutTime(e.error));
        // the text survives a reload, which drops the write (02 §9.2)
        const draft = this.drafts.get(e.local);
        if (draft) this.options.unsentDrafts?.keep(e.local, draft);
        this.settle(e.local, { ok: true, result: undefined, unsent: true });
        this.changed();
        break;
      }
      case "problem": {
        const local = e.problem.local;
        this.endLeave(local);
        const draft = this.drafts.get(local);
        this.drafts.delete(local);
        this.options.unsentDrafts?.drop(local);
        if (draft) this.options.restoreDraft?.(draft);
        this.settle(local, {
          ok: false,
          error: { code: "EXPIRED", message: "This change waited too long to be sent." },
        });
        break;
      }
      case "discarded":
        this.errors.delete(e.local);
        this.endLeave(e.local);
        this.options.unsentDrafts?.drop(e.local);
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
      case "user":
        this.sessionChanged();
        break;
      case "upgrade":
        // the transport reports every 426 (`http.ts`)
        break;
    }
  }

  /** A Leave that was refused or discarded: its resync, if one comes, is
   * news again. */
  private endLeave(local: string): void {
    for (const [space, l] of this.leaving) if (l === local) this.leaving.delete(space);
  }

  private settle(local: string, outcome: WriteOutcome): void {
    const w = this.waiting.get(local);
    this.waiting.delete(local);
    w?.resolve(outcome);
  }

  /** The next outcome of a write. Every caller waiting for it gets the
   * same one. */
  private outcomeOf(local: string): Promise<WriteOutcome> {
    const w = this.waiting.get(local);
    if (w) return w.promise;
    let resolve: (o: WriteOutcome) => void = () => {};
    const promise = new Promise<WriteOutcome>((r) => (resolve = r));
    this.waiting.set(local, { promise, resolve });
    return promise;
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

  /** The streaming text of a run's current attempt while it runs (`03`
   * T2, T3); null when none is held, and for an ask moderated since that
   * the viewer may not read (a hidden ask: its author and the space's owner
   * only). */
  liveText(run: string): LiveText | null {
    const r = this.client?.get(`run:${run}`);
    const text = this.runTexts.get(run);
    if (r?.kind !== "run" || r.status !== "running" || text?.attempt !== r.attempt) return null;
    return this.readsRunText(r) ? text : null;
  }

  /** Whether the viewer may read the text of `run`'s ask: it is not
   * moderated, or the viewer wrote it or owns the space. */
  private readsRunText(run: Spaces.RunRecord): boolean {
    const client = this.client;
    if (!client) return false;
    const ask = client.get(run.node === "r" ? `thread:${run.th}` : `node:${run.node}`);
    if (ask?.kind !== "thread" && ask?.kind !== "node") return false;
    if (ask.mod === null) return true;
    return (
      (this.me !== null && ask.u === this.me) ||
      isOwnerOf({ byKey: (key) => client.get(key) }, run.s, this.me)
    );
  }

  /** Drops the held text of every run that is no longer running on the
   * attempt the text belongs to, whose record is gone, or whose ask the
   * viewer may no longer read (`03` T2, T3). */
  private pruneRunTexts(): void {
    const client = this.client;
    if (!client) return;
    for (const id of this.runTexts.runs()) {
      const r = client.get(`run:${id}`);
      const text = this.runTexts.get(id);
      if (
        r?.kind !== "run" ||
        r.status !== "running" ||
        text?.attempt !== r.attempt ||
        !this.readsRunText(r)
      )
        this.runTexts.drop(id);
    }
  }

  /** A space log is read again (`resync`): the held texts of its runs, and
   * of runs the replica no longer holds, are dropped; a reconnect reads
   * `/live` for the runs still running. */
  private dropRunTexts(log: LogId): void {
    const client = this.client;
    for (const id of this.runTexts.runs()) {
      const r = client?.get(`run:${id}`);
      if (r?.kind !== "run" || spaceLog(r.s) === log) this.runTexts.drop(id);
    }
  }

  /** The runs the replica holds as running. */
  private runningRuns(): string[] {
    return this.all("run")
      .filter((r) => r.status === "running")
      .map((r) => r.id);
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
    if (!this.options.byName) return true;
    const state = this.names.get(name);
    if (state !== undefined) return state === "done";
    this.names.set(name, "pending");
    // asked from a query, which runs during a render: answer afterwards
    queueMicrotask(() => this.askName(name, this.generation, 1000));
    return false;
  }

  /** Ask the server for a channel by name. A lookup that fails says
   * nothing about the name: it stays unknown and is asked again after a
   * backoff while the replica runs. */
  private askName(name: string, gen: number, wait: number): void {
    const byName = this.options.byName;
    if (!byName) return;
    byName(name).then(
      (space) => {
        if (space) this.landings.set(space.id, space);
        this.names.set(name, "done");
        this.changed();
      },
      (error: unknown) => {
        if (!this.live(gen)) {
          this.names.delete(name);
          return;
        }
        const t = setTimeout(
          () => {
            this.lookUpRetries.delete(name);
            if (this.live(gen)) this.askName(name, gen, Math.min(wait * 2, this.maxBackoff()));
            else this.names.delete(name);
          },
          Math.max(wait, retryAfterOf(error) ?? 0),
        );
        (t as { unref?: () => void }).unref?.();
        this.lookUpRetries.set(name, t);
      },
    );
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
    const p = client.write(name, input);
    if (name === "spaces.leave") {
      const space = (input as { space?: unknown } | null)?.space;
      if (typeof space === "string") this.leaving.set(space, p.local);
    }
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
    // a Retry while the write is in flight waits for the same outcome
    const waiting = this.waiting.get(local);
    if (waiting) return waiting.promise;
    // not "Not sent" (sent meanwhile, or discarded): nothing to wait for
    if (!client.unsent().some((p) => p.local === local))
      return Promise.resolve({ ok: true, result: undefined });
    const outcome = this.outcomeOf(local);
    this.errors.delete(local);
    void client.retry(local);
    return outcome;
  }

  discard(local: string): void {
    const client = this.client;
    if (!client) return;
    // only a write that is "Not sent": one in flight keeps its text
    if (!client.discard(local)) return;
    const draft = this.drafts.get(local);
    this.drafts.delete(local);
    if (draft) this.options.restoreDraft?.(draft);
  }

  /** Whether a thread's records could not be fetched (offline, a refused
   * read): its row says "Available when online." until a retry fetches
   * them. */
  unavailable(thread: string): boolean {
    return this.opens.get(thread) === "unavailable";
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
    if (state === "pending" || this.gathered.has(thread)) return;
    this.openSpaces.set(thread, space);
    const client = this.client;
    // held in full (a resync may have taken an opened thread back to its
    // summary, so the earlier answer is not trusted)
    const held = client?.replica.logOfThread(thread);
    if (state === "full" && held && client?.replica.isFull(held, thread)) return;
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
    // A summary row asks for its records when it renders: the rows
    // rendered within `GATHER_MS` are fetched with one `threads` read per
    // log (`openMany`), which keeps a reader scrolling through summaries
    // under the server's limit. An address names its channel and is
    // fetched now; a thread the replica does not hold is asked of the logs
    // it holds (`SyncClient.open`).
    if (space === undefined && held) {
      this.gathered.add(thread);
      this.gatherTimer ??= setTimeout(() => {
        this.gatherTimer = null;
        this.openGathered(client);
      }, this.options.gatherMs ?? GATHER_MS);
      (this.gatherTimer as { unref?: () => void }).unref?.();
      return;
    }
    this.opens.set(thread, "pending");
    const gen = this.generation;
    void client.open(thread, space === undefined ? undefined : spaceLog(space)).then((r) => {
      if (this.live(gen)) this.opened(new Map([[thread, r]]), undefined, false);
    });
  }

  /** The gathered rows: one `openMany` per log. */
  private openGathered(client: SyncClient): void {
    const threads = [...this.gathered];
    this.gathered.clear();
    const byLog = new Map<LogId, string[]>();
    for (const th of threads) {
      const log = client.replica.logOfThread(th);
      if (!log) {
        // its log was dropped meanwhile: asked again when its row renders
        this.opens.delete(th);
        continue;
      }
      let list = byLog.get(log);
      if (!list) byLog.set(log, (list = []));
      list.push(th);
      this.opens.set(th, "pending");
    }
    const gen = this.generation;
    for (const [log, list] of byLog)
      void client.openMany(log, list).then((r: OpenMany) => {
        if (this.live(gen)) this.opened(r.outcomes, r.error, true);
      });
  }

  /** Record what opens came to. A fetch that failed is tried again after a
   * backoff (or the wait the server named) and when the stream
   * reconnects; a thread whose log the replica no longer holds is
   * forgotten, and asked again when its row renders. */
  private opened(
    outcomes: ReadonlyMap<string, OpenOutcome>,
    error: unknown,
    gathered: boolean,
  ): void {
    const client = this.client;
    let failed = false;
    for (const [th, outcome] of outcomes) {
      if (outcome !== "unavailable") {
        this.opens.set(th, outcome);
        continue;
      }
      const space = this.openSpaces.get(th);
      const held = client?.replica.logOfThread(th) !== undefined;
      // the log of a row, or of an address, was dropped meanwhile
      const dropped = gathered
        ? !held
        : !held && space !== undefined && !this.loadedLogs.has(spaceLog(space));
      if (dropped) {
        this.opens.delete(th);
        continue;
      }
      this.opens.set(th, "unavailable");
      failed = true;
    }
    if (failed) this.scheduleOpenRetry(retryAfterOf(error));
    else if ([...outcomes.values()].includes("full")) this.openWait = 1000;
    this.changed();
  }

  private scheduleOpenRetry(retryAfterMs: number | undefined): void {
    if (this.openRetry !== null || !this.active) return;
    const wait = Math.max(this.openWait, retryAfterMs ?? 0);
    this.openWait = Math.min(this.openWait * 2, this.maxBackoff());
    this.openRetry = setTimeout(() => {
      this.openRetry = null;
      this.retryOpens();
    }, wait);
    (this.openRetry as { unref?: () => void }).unref?.();
  }

  /** Fetch again every thread whose fetch failed. */
  private retryOpens(): void {
    if (this.openRetry !== null) {
      clearTimeout(this.openRetry);
      this.openRetry = null;
    }
    for (const [th, state] of [...this.opens])
      if (state === "unavailable") {
        this.opens.delete(th);
        this.open(th, this.openSpaces.get(th));
      }
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
      this.spaceReads.delete(log);
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
