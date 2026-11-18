// A minimal client for the suite: one replica per log, built from a snapshot
// and kept current with pulls, and an outbox sent in order. It does not
// predict or rebase (phase 0).
//
// A client belongs to one actor for its lifetime: it has no way to change the
// person it reads for, so a replica never holds what another person read.

import type { Actor, ApplyResult, Clock, Cursor, Envelope, ServerHalf, Tier } from "./contract.js";
import { PROTOCOL_VERSION } from "./contract.js";
import { MUTATORS } from "./mutators.js";
import type { LogId, StoredRecord } from "./records.js";
import { ulid } from "./ulid.js";

interface Replica {
  cursor: Cursor;
  records: Map<string, StoredRecord>;
}

export type SyncOutcome = "snapshot" | "pull" | "resync";

export class ReplicaClient {
  private readonly replicas = new Map<LogId, Replica>();
  private readonly outbox: Envelope[] = [];
  /** The last mutation id the server reported for this actor. */
  lastMutationId: string | null = null;

  constructor(
    private readonly server: ServerHalf,
    readonly actor: Actor | null,
    private readonly env: { clock: Clock; random: () => number },
  ) {}

  /** A new ULID at the client's time. */
  newId(): string {
    return ulid(this.env.clock.now(), this.env.random);
  }

  /** Bring one log's replica up to date: a snapshot the first time and after
   * a resync, a pull otherwise. */
  async sync(log: LogId, tier?: Tier): Promise<SyncOutcome> {
    const r = this.replicas.get(log);
    if (r) {
      const res = await this.server.pull(this.actor, log, r.cursor);
      if (!("resync" in res)) {
        for (const c of res.changes) {
          if (c.op === "put") r.records.set(c.key, c.record);
          else r.records.delete(c.key);
        }
        r.cursor = { epoch: res.epoch, version: res.version };
        this.lastMutationId = res.lastMutationId;
        return "pull";
      }
    }
    const snap = await this.server.snapshot(this.actor, log, tier);
    this.replicas.set(log, {
      cursor: { epoch: snap.epoch, version: snap.version },
      records: new Map(snap.records.map((x) => [x.key, x.record])),
    });
    this.lastMutationId = snap.lastMutationId;
    return r ? "resync" : "snapshot";
  }

  records(log: LogId): ReadonlyMap<string, StoredRecord> {
    return this.replicas.get(log)?.records ?? new Map<string, StoredRecord>();
  }

  cursor(log: LogId): Cursor | undefined {
    const c = this.replicas.get(log)?.cursor;
    return c && { ...c };
  }

  logs(): LogId[] {
    return [...this.replicas.keys()];
  }

  /** Every record this client holds, across its logs. */
  allRecords(): Map<string, StoredRecord> {
    const out = new Map<string, StoredRecord>();
    for (const r of this.replicas.values()) for (const [k, v] of r.records) out.set(k, v);
    return out;
  }

  /** Queue a write. Online-only mutators (`spaces.create`) are never queued. */
  queue(name: string, input: unknown, mutationId = this.newId()): Envelope {
    if (Object.hasOwn(MUTATORS, name) && MUTATORS[name]?.online)
      throw new Error(`${name} is online only`);
    const e: Envelope = { mutationId, name, input, protocolVersion: PROTOCOL_VERSION };
    this.outbox.push(e);
    return e;
  }

  pending(): readonly Envelope[] {
    return this.outbox;
  }

  /** Send the outbox in order. Every answer is final here (the prototype has
   * no transient errors besides UNAUTHORIZED, which the suite does not send). */
  async flush(): Promise<ApplyResult[]> {
    const out: ApplyResult[] = [];
    while (this.outbox.length)
      out.push(await this.server.apply(this.actor, this.outbox.shift() as Envelope));
    return out;
  }

  /** Send one write now, outside the outbox (online-only writes). */
  async send(name: string, input: unknown, mutationId = this.newId()): Promise<ApplyResult> {
    return this.server.apply(this.actor, {
      mutationId,
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
    });
  }
}
