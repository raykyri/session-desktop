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
  type Transport,
} from "@session/sync/client";

import { REQUESTED_WITH_HEADERS, currentFetch, getJson } from "../api/http.js";
import { createResource, type Resource } from "../api/resource.js";

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
 * attempt the frames are for, in `seq` order. */
export class RunTexts {
  private readonly runs = new Map<string, { attempt: number; seq: number; text: string }>();
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
  /** A frame: a newer attempt starts over; a frame out of order (a seq at
   * or below the last) is dropped. */
  add(f: Pick<RunFrame, "run" | "attempt" | "seq" | "text">) {
    const r = this.runs.get(f.run);
    if (r && (f.attempt < r.attempt || (f.attempt === r.attempt && f.seq <= r.seq))) return;
    const base = r && r.attempt === f.attempt ? r.text : "";
    this.runs.set(f.run, { attempt: f.attempt, seq: f.seq, text: base + f.text });
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

  constructor(
    me: string | null,
    o: {
      fetch?: typeof fetch;
      onUnauthorized?: () => void;
      /** False: no event stream (tests). */
      listen?: boolean;
      /** The sync transport (tests); by default `FetchTransport` over the
       * session cookie. */
      transport?: Transport;
    } = {},
  ) {
    this.me = me;
    this.listens = o.listen !== false;
    const transport =
      o.transport ??
      new FetchTransport({
        baseUrl: "",
        headers: REQUESTED_WITH_HEADERS,
        fetch: o.fetch ?? ((...a) => currentFetch()(...a)),
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
      this.client = new SyncClient({ user: me, transport, persist: false });
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
        this.setStatus({ ready: true, online: true });
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
