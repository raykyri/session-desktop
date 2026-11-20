// The records a signed-out reader sees: snapshots of the space logs they
// open (open spaces, and a closed space's public records), kept current by
// the event stream's pokes. The sync client is a person's replica and never
// reads as nobody (a read made as nobody signs it out), so a guest reads
// through the transport directly. Nothing is written as a guest.

import {
  isReadError,
  type Changing,
  type CursorMap,
  type LogId,
  type StoredRecord,
  type Transport,
} from "@session/sync/client";

import type { RecordSource } from "./reader.js";

interface GuestLog {
  cursor: string | null;
  records: Map<string, StoredRecord>;
  chain: Promise<void>;
}

export class GuestStore implements RecordSource, Changing {
  private readonly logs = new Map<LogId, GuestLog>();
  private readonly listeners = new Set<() => void>();
  private ver = 0;
  private stream: AbortController | null = null;
  private stopped = false;

  constructor(
    private readonly transport: Transport,
    /** A read failed for want of a connection (true) or came back (false). */
    private readonly onReach: (reached: boolean) => void = () => undefined,
  ) {}

  version() {
    return this.ver;
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed() {
    this.ver++;
    for (const l of [...this.listeners]) l();
  }

  get(key: string): StoredRecord | undefined {
    for (const l of this.logs.values()) {
      const r = l.records.get(key);
      if (r) return r;
    }
    return undefined;
  }

  keys(): Set<string> {
    const out = new Set<string>();
    for (const l of this.logs.values()) for (const k of l.records.keys()) out.add(k);
    return out;
  }

  pendingAt(): boolean {
    return false;
  }

  isOpen(log: LogId) {
    return this.logs.has(log);
  }

  /** Read a log's snapshot (once); later pokes pull it. */
  async open(log: LogId): Promise<void> {
    if (this.logs.has(log)) return this.logs.get(log)?.chain;
    const l: GuestLog = { cursor: null, records: new Map(), chain: Promise.resolve() };
    this.logs.set(log, l);
    l.chain = this.read(log, l);
    await l.chain;
    this.restream();
  }

  private async read(log: LogId, l: GuestLog): Promise<void> {
    try {
      if (l.cursor === null) {
        const s = await this.transport.snapshot(log);
        if (isReadError(s)) return;
        l.records = new Map(s.records.map((x) => [x.key, x.record]));
        l.cursor = s.cursor;
      } else {
        const p = await this.transport.pull(log, l.cursor);
        if (isReadError(p)) return;
        if ("resync" in p) {
          l.cursor = null;
          return this.read(log, l);
        }
        for (const c of p.changes) {
          if (c.op === "del") l.records.delete(c.key);
          else l.records.set(c.key, c.record);
        }
        l.cursor = p.cursor;
      }
      this.onReach(true);
      this.changed();
    } catch {
      this.onReach(false);
    }
  }

  /** Bring every open log up to date. */
  async refresh(): Promise<void> {
    await Promise.all(
      [...this.logs].map(([log, l]) => (l.chain = l.chain.then(() => this.read(log, l)))),
    );
  }

  private cursors(): CursorMap {
    const out: CursorMap = {};
    for (const [log, l] of this.logs) if (l.cursor !== null) out[log] = l.cursor;
    return out;
  }

  private restream() {
    this.stream?.abort();
  }

  /** Listen for pokes until `signal` aborts; reconnects when the set of
   * open logs changes. */
  async listen(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopped) {
      const conn = new AbortController();
      const stop = () => conn.abort();
      signal.addEventListener("abort", stop);
      this.stream = conn;
      try {
        await this.transport.listen(
          () => this.cursors(),
          (e) => {
            if (e.type !== "poke") return;
            for (const log of e.logs) {
              const l = this.logs.get(log);
              if (l) l.chain = l.chain.then(() => this.read(log, l));
            }
          },
          conn.signal,
        );
      } finally {
        signal.removeEventListener("abort", stop);
        if (this.stream === conn) this.stream = null;
      }
      if (!conn.signal.aborted) return;
    }
  }

  stop() {
    this.stopped = true;
    this.restream();
  }
}
