// The spaces session of one tab: the records the screens read and the writes
// they make, over `@session/sync`'s client half (AGENTS.md, phase 2b).
//
// Signed in, a `SyncClient` holds the person's replica with `persist: false`
// (the web keeps no outbox across time: a write is held only while its
// request is in flight, a transient failure shows Try again on its item, and
// nothing survives a reload). It opens the person's user log, the log of
// every space they belong to (from their member records), and the log of a
// space the screen shows. Signed out, a `GuestStore` reads the logs of the
// spaces the screen shows. Both listen on the sync stream: a poke pulls, and
// a run frame is in-flight answer text (`RunTexts`).
//
// The transport is `FetchTransport({ baseUrl: "" })` with the session cookie
// and the CSRF header a cookie POST needs. The space directory (`GET
// /api/spaces`) lists the spaces the person may find, which no log holds.
//
// In the Desktop app (phase 3) the platform (`../platform.ts`) gives the
// server's origin and the device's bearer token, and the client keeps its
// replica and outbox with `persist: true` in the platform's storage
// (SQLite): a write waits on the device until the server answers it, across
// a restart, and the sync-state UI (`../spaces/Outbox.tsx`) shows the
// writes that wait or need the person.

import * as pkg from "@session/mutators";
import {
  FetchTransport,
  SyncClient,
  makeQuery,
  type Answer,
  type LogId,
  type Query,
  type RunFrame,
  type StoredRecord,
  type StorageAdapter,
  type Transport,
} from "@session/sync/client";

import { currentFetch, getJson } from "../api/http.js";
import { createResource, type Resource } from "../api/resource.js";
import { platform } from "../platform.js";

import { GuestStore } from "./guest.js";
import { Reader, type RecordSource } from "./reader.js";

/** `GET /api/spaces`: the spaces the person may find, and the stats of those
 * they read. */
export interface Directory {
  spaces: pkg.SpaceRec[];
  stats: pkg.StatsRec[];
  serverTime: number;
}

export interface SessionStatus {
  /** Reads reach the server. */
  online: boolean;
  /** The server answered that this client is too old ("Update Session"). */
  updateRequired: boolean;
  /** The server no longer takes this tab's session. */
  signedOut: boolean;
  /** The first reads of the user log and the joined spaces are done. */
  ready: boolean;
}

/** In-flight text of the runs a reader watches, by run id: the text of the
 * attempt the frames are for. A frame carries only the text since the frame
 * before it, so the text is whole only when every frame of the attempt
 * arrived (ADR-22; review round 2 of phase 2, finding 6): a frame applies
 * only at the next seq (`seq === last + 1`), and an attempt's first frame
 * only at seq 1. A frame after a gap (the stream reconnected and missed
 * some), a first frame above seq 1 (the reader joined mid-run), or a jump
 * in seq (a server run resumed after a restart continues above every seq it
 * sent) leaves the attempt with no text: the screen shows the run's steps
 * until its answer arrives. A frame at or below the last seq is a replay
 * and is dropped. */
export class RunTexts {
  /** `text` null: the attempt's frames have a gap, so it shows none. */
  private readonly runs = new Map<string, { attempt: number; seq: number; text: string | null }>();
  private readonly listeners = new Set<() => void>();
  private ver = 0;

  version() {
    return this.ver;
  }
  onChange(l: () => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  get(run: string, attempt?: number): string | null {
    const r = this.runs.get(run);
    if (!r || (attempt !== undefined && r.attempt !== attempt)) return null;
    return r.text;
  }
  /** A frame: a newer attempt starts over, an older one is dropped, a
   * replay is dropped, and a frame that does not follow the last one ends
   * the attempt's text. */
  add(f: Pick<RunFrame, "run" | "attempt" | "seq" | "text">) {
    const r = this.runs.get(f.run);
    if (r && (f.attempt < r.attempt || (f.attempt === r.attempt && f.seq <= r.seq))) return;
    const same = r !== undefined && r.attempt === f.attempt;
    const follows = same ? f.seq === r.seq + 1 : f.seq === 1;
    const text = follows && (!same || r.text !== null) ? (same ? r.text : "") + f.text : null;
    this.runs.set(f.run, { attempt: f.attempt, seq: f.seq, text });
    // a frame of a broken attempt changes nothing shown
    if (same && r.text === null && text === null) return;
    this.ver++;
    for (const l of [...this.listeners]) l();
  }
  /** The run's answer arrived (or it ended): its in-flight text goes. */
  drop(run: string) {
    if (this.runs.delete(run)) {
      this.ver++;
      for (const l of [...this.listeners]) l();
    }
  }
}

type Listener = () => void;

export class SpacesSession {
  readonly me: string | null;
  readonly client: SyncClient | null;
  readonly guest: GuestStore | null;
  readonly source: RecordSource;
  readonly runs = new RunTexts();
  readonly directory: Resource<Directory>;
  private statusValue: SessionStatus;
  private readonly statusListeners = new Set<Listener>();
  private readonly abort = new AbortController();
  private readerAt: { ver: number; reader: Reader } | null = null;
  /** Space logs opened because a screen shows them. */
  private readonly shown = new Set<string>();
  private started = false;
  private readonly listens: boolean;
  /** The outbox is kept across time (the desktop): a write waits on the
   * device until the server answers it. */
  readonly persistent: boolean;

  constructor(
    me: string | null,
    o: {
      fetch?: typeof fetch;
      onUnauthorized?: () => void;
      /** False: no event stream (tests). */
      listen?: boolean;
      /** The sync transport (tests); by default `FetchTransport` over the
       * session cookie (the web) or the device token (the desktop). */
      transport?: Transport;
      /** Keep the outbox across time (default: the platform's). */
      persist?: boolean;
      /** Where the replica is kept (default: the platform's, else memory). */
      storage?: StorageAdapter;
      /** The sync client's clocks (tests). */
      clock?: { now(): number };
      monotonic?: () => number;
    } = {},
  ) {
    this.me = me;
    this.listens = o.listen !== false;
    const p = platform();
    this.persistent = o.persist ?? p.persist;
    const transport =
      o.transport ??
      new FetchTransport({
        baseUrl: p.origin,
        headers: p.headers(),
        token: () => p.token(),
        fetch: this.watch(o.fetch ?? ((...a) => currentFetch()(...a))),
        onUpdateRequired: () => this.setStatus({ updateRequired: true }),
        onUnauthorized: () => {
          this.setStatus({ signedOut: true });
          o.onUnauthorized?.();
        },
      });
    this.statusValue = {
      online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
      updateRequired: false,
      signedOut: false,
      ready: false,
    };
    if (me !== null) {
      const storage = o.storage ?? p.storage(me);
      this.client = new SyncClient({
        user: me,
        transport,
        persist: this.persistent,
        ...(storage ? { storage } : {}),
        ...(o.clock ? { clock: o.clock } : {}),
        ...(o.monotonic ? { monotonic: o.monotonic } : {}),
      });
      this.guest = null;
      this.source = this.client;
    } else {
      this.client = null;
      this.guest = new GuestStore(transport, (reached) => this.setStatus({ online: reached }));
      this.source = this.guest;
    }
    this.directory = createResource(async () => {
      const d = await getJson<Directory>("/api/spaces");
      this.directoryAt = Date.now();
      return d;
    });
  }

  /** The desktop's fetch, watched: a request that gets no response at all
   * (the network is down) shows the offline bar, and the first response
   * after it hides the bar and sends the outbox. A response, whatever its
   * status, means the server can be reached. The web's status follows its
   * reads and the browser's online events only. */
  private watch(f: typeof fetch): typeof fetch {
    if (!this.persistent) return f;
    return async (...a) => {
      try {
        const r = await f(...a);
        if (!this.statusValue.online) {
          this.setStatus({ online: true });
          void this.retry();
        }
        return r;
      } catch (e) {
        if (!(e instanceof Error && e.name === "AbortError")) this.setStatus({ online: false });
        throw e;
      }
    };
  }

  /** When the directory was read (the device's clock): a guest's "now". */
  private directoryAt: number | null = null;

  // ---- status ----

  status(): SessionStatus {
    return this.statusValue;
  }
  onStatus(l: Listener) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }
  private setStatus(patch: Partial<SessionStatus>) {
    const next = { ...this.statusValue, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.statusValue)) return;
    this.statusValue = next;
    for (const l of [...this.statusListeners]) l();
  }

  // ---- reads ----

  /** One reader per version of the records, shared by every query. */
  reader(): Reader {
    const ver = this.source.version();
    if (this.readerAt?.ver !== ver)
      this.readerAt = { ver, reader: new Reader(this.source, this.me) };
    return this.readerAt.reader;
  }

  query<T>(fn: (r: Reader) => T): Query<T> {
    return makeQuery(this.source, () => this.reader(), fn);
  }

  /** Open a space's log for a screen that shows it (a member's spaces are
   * open already). */
  async showSpace(space: string): Promise<void> {
    const log: LogId = `space:${space}`;
    if (this.shown.has(space)) return;
    this.shown.add(space);
    try {
      if (this.client) await this.client.open(log);
      else await this.guest?.open(log);
    } catch {
      this.shown.delete(space);
    }
  }

  /** A space the person just made (`spaces.create`'s answer carries it
   * under `space`, in the directory's shape: 2b design finding 6): it is in
   * the directory at once, before the next read of it. */
  addSpace(space: pkg.SpaceRec): void {
    const d = this.directory.get().data;
    const spaces = [...(d?.spaces ?? []).filter((x) => x.id !== space.id), space];
    this.directory.set({ spaces, stats: d?.stats ?? [], serverTime: d?.serverTime ?? this.now() });
    if (this.directoryAt === null) this.directoryAt = Date.now();
  }

  /** A thread held as a summary is fetched in full when it is opened. */
  async openThread(space: string, thread: string): Promise<void> {
    await this.showSpace(space);
    if (this.client?.summaries(`space:${space}`).has(thread))
      await this.client.hydrate(`space:${space}`, thread);
  }

  /** The spaces the person is a member of, from their member records. */
  private memberSpaces(): string[] {
    if (!this.me) return [];
    const me = this.me;
    return this.reader()
      .list("member", (m) => m.u === me)
      .map((m) => m.sp);
  }

  /** The joined spaces' logs being opened: a second call waits for the
   * reads the first one started, so `ready` follows them. */
  private readonly opening = new Map<string, Promise<void>>();

  private async openJoined() {
    if (!this.client) return;
    const c = this.client;
    const open = new Set(c.openLogs());
    const waits = this.memberSpaces().map((sp) => {
      const log: LogId = `space:${sp}`;
      const now = this.opening.get(log);
      if (now) return now;
      if (open.has(log)) return Promise.resolve();
      const p = c
        .open(log)
        .catch(() => undefined)
        .finally(() => this.opening.delete(log));
      this.opening.set(log, p);
      return p;
    });
    await Promise.all(waits);
  }

  /** Start reading: the user log and the joined spaces, then the stream. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const signal = this.abort.signal;
    void this.directory.load().catch(() => undefined);
    if (typeof window !== "undefined") {
      const on = () => {
        this.setStatus({ online: true });
        void this.retry();
      };
      const off = () => this.setStatus({ online: false });
      window.addEventListener("online", on, { signal });
      window.addEventListener("offline", off, { signal });
    }
    if (this.client) {
      const c = this.client;
      c.onRun((f) => this.runs.add(f));
      // a member record that appears (a join, an approval) opens its space;
      // a membership change also changes what the directory lists
      let members = "";
      c.onChange(() => {
        const now = this.memberSpaces().sort().join(",");
        if (now !== members) {
          const first = members === "";
          members = now;
          void this.openJoined();
          if (!first) void this.directory.load(true).catch(() => undefined);
        }
        for (const r of this.endedRuns()) this.runs.drop(r);
        if (c.signedOut) this.setStatus({ signedOut: true });
      });
      try {
        await c.init();
        await c.open(`user:${this.me}`);
        await this.openJoined();
        if (this.persistent) {
          // the logs came from storage: shown at once, then read from the
          // server (which also tells whether it can be reached), and the
          // writes an earlier run of the app left in the outbox are sent
          this.setStatus({ ready: true });
          void c
            .sync()
            .catch(() => false)
            .then(() => c.flush());
        } else this.setStatus({ ready: true, online: true });
      } catch {
        this.setStatus({ ready: true, online: false });
      }
      if (this.listens) void this.listenLoop(() => c.listen(signal));
    } else if (this.guest) {
      const g = this.guest;
      // a signed-out reader sees in-flight text too, and drops it as the
      // signed-in path does when the run's answer or end arrives
      g.onRun((f) => this.runs.add(f));
      g.onChange(() => {
        for (const r of this.endedRuns()) this.runs.drop(r);
      });
      this.setStatus({ ready: true });
      if (this.listens) void this.listenLoop(() => g.listen(signal));
    }
  }

  /** The stream, connected again after it ends, until the session stops. */
  private async listenLoop(listen: () => Promise<void>) {
    while (!this.abort.signal.aborted && !this.statusValue.signedOut) {
      await listen().catch(() => undefined);
      if (this.abort.signal.aborted || this.statusValue.updateRequired) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /** Runs whose answer has arrived or that ended: their in-flight text goes. */
  private endedRuns(): string[] {
    const r = this.reader();
    return r
      .list("run", (x) => x.status !== "queued" && x.status !== "running")
      .map((x) => x.id)
      .filter((id) => this.runs.get(id) !== null);
  }

  /** Try again after a failure to reach the server. */
  async retry(): Promise<void> {
    if (this.client) {
      const ok = await this.client.sync().catch(() => false);
      this.setStatus({ online: ok || this.statusValue.online });
      if (ok) this.setStatus({ online: true });
      void this.client.retryNow();
    } else await this.guest?.refresh();
    void this.directory.load(true).catch(() => undefined);
  }

  // ---- writes ----

  /** A write through the outbox (predicted, then confirmed); an online-only
   * call goes straight to the server. Signed out, nothing is written. */
  write(name: string, input: unknown): { local: string; answer: Promise<Answer | null> } | null {
    if (!this.client) return null;
    return this.client.write(name, input);
  }

  newId(): string {
    return this.client ? this.client.newId() : pkg.ulid(Date.now(), Math.random);
  }

  /** The server's time as this tab estimates it: the sync client's clock,
   * or (a guest) the device's clock moved to the directory's server time. */
  now(): number {
    if (this.client) return this.client.now();
    const d = this.directory.get().data;
    if (d && this.directoryAt !== null) return d.serverTime + (Date.now() - this.directoryAt);
    return Date.now();
  }

  stop() {
    this.abort.abort();
    this.client?.stop();
    this.guest?.stop();
  }
}

/** The records of one key, for a component that shows a single record. */
export const recordAt = (r: Reader, key: string): StoredRecord | undefined => r.byKey(key);
