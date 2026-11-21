// An in-memory record store that is both the authority and the viewer's
// replica: the fixture replica of 02 §9.6, with no server. It keeps every
// record of the fixture world, answers the viewer's reads through the read
// rules of `@session/mutators` (`view`: scope and redaction), and applies a
// write the way the server half will: the mutator's input schema, the
// permission checks, `run` and `notify`, over a `StagedTx`, committed at
// once. `pre` (the registry and queue checks) is the server's and is not run.
//
// It is not the sync library's replica (no outbox, no rebase, no cursors);
// it implements the same `ReplicaSource` so the screens cannot tell.

import {
  MUTATORS,
  StagedTx,
  idOf,
  inIndex,
  indexOf,
  keyOf,
  msToIso,
  predict,
  uniqueOf,
  view,
  type Index,
  type Kind,
  type NotifyCtx,
  type Draft,
  type RecordOf,
  type Source,
  type StoredRecord,
  type UniqueIndex,
} from "@session/mutators";
import type { Spaces } from "@session/shared";

import { UNKNOWN, type ReplicaSource, type Unknown, type WriteOutcome } from "./source.js";
import { newUlid } from "./ulid.js";

type SpaceMutatorName = Spaces.SpaceMutatorName;

const indexName = (index: Index) =>
  "sp" in index ? `sp:${index.sp}` : "th" in index ? `th:${index.th}` : `u:${index.u}`;

export interface MemoryReplicaOptions {
  me: string | null;
  /** The server's clock, in milliseconds. */
  clock: () => number;
  /** Handles of Session accounts, for the mentions `notify` reports. */
  accounts?: ReadonlySet<string>;
}

export class MemoryReplica implements ReplicaSource, Source {
  readonly me: string | null;
  private readonly records = new Map<string, StoredRecord>();
  private readonly byKind = new Map<Kind, Map<string, StoredRecord>>();
  /** The last rev of every key ever written, deleted ones included. */
  private readonly revs = new Map<string, number>();
  private readonly ids = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly commitHooks = new Set<(keys: string[]) => void>();
  private counter = 0;
  private readonly clock: () => number;
  private readonly accounts: ReadonlySet<string>;

  constructor(options: MemoryReplicaOptions) {
    this.me = options.me;
    this.clock = options.clock;
    this.accounts = options.accounts ?? new Set();
  }

  // ---- loading and server-side writes ----

  /** Writes records as the server would (a snapshot, or a run's progress),
   * bypassing the mutators. */
  write(records: readonly Draft[], removed: readonly string[] = []): void {
    const keys: string[] = [];
    for (const r of records) keys.push(this.store(keyOf(r), r));
    for (const key of removed) if (this.drop(key)) keys.push(key);
    this.changed(keys);
  }

  /** Called after every commit with the keys it changed. */
  onCommit(hook: (keys: string[]) => void): () => void {
    this.commitHooks.add(hook);
    return () => this.commitHooks.delete(hook);
  }

  /** The record at `key` whatever the viewer may read (the authority's view). */
  raw(key: string): StoredRecord | undefined {
    return this.records.get(key);
  }

  rawAll<K extends Kind>(kind: K): RecordOf<K>[] {
    return [...(this.byKind.get(kind)?.values() ?? [])] as RecordOf<K>[];
  }

  private store(key: string, r: Draft): string {
    const rev = (this.revs.get(key) ?? 0) + 1;
    const rec = { ...r, rev };
    this.records.set(key, rec);
    this.revs.set(key, rev);
    let kind = this.byKind.get(rec.kind);
    if (!kind) this.byKind.set(rec.kind, (kind = new Map<string, StoredRecord>()));
    kind.set(key, rec);
    const id = idOf(rec);
    if (id !== null) this.ids.add(id);
    return key;
  }

  private drop(key: string): boolean {
    const rec = this.records.get(key);
    if (!rec) return false;
    this.records.delete(key);
    this.byKind.get(rec.kind)?.delete(key);
    return true;
  }

  private changed(keys: string[]): void {
    if (keys.length === 0) return;
    this.counter += 1;
    for (const hook of this.commitHooks) hook(keys);
    for (const listener of this.listeners) listener();
  }

  // ---- `Source`: the authority's reads for `StagedTx` ----

  byKey(key: string): StoredRecord | undefined {
    return this.records.get(key);
  }

  keysIn(kind: Kind, index: Index): Iterable<string> {
    const out: string[] = [];
    for (const [key, r] of this.byKind.get(kind) ?? []) if (inIndex(r, index)) out.push(key);
    return out;
  }

  uniqueKey(index: UniqueIndex, value: string): string | undefined {
    const kind: Kind = index === "space.name" ? "space" : "invite";
    for (const [key, r] of this.byKind.get(kind) ?? [])
      if (uniqueOf(r, index) === value) return key;
    return undefined;
  }

  idTaken(id: string): boolean {
    return this.ids.has(id);
  }

  // ---- `ReplicaSource`: the viewer's reads ----

  ready(): boolean {
    return true;
  }

  // A sync replica holds part of what its user may read. The fixture holds
  // everything, and tests mark indexes (a thread, a space) as not loaded to
  // see the screens wait for them (`source.ts`, "Known versus absent").
  private readonly unloaded = new Set<string>();

  /** Marks a thread or a space index as not loaded (`th:<id>`, `sp:<id>`). */
  unload(index: Index): void {
    this.unloaded.add(indexName(index));
    this.changed(["index"]);
  }

  /** Loads an index marked with `unload`. */
  load(index: Index): void {
    if (this.unloaded.delete(indexName(index))) this.changed(["index"]);
  }

  private hidden(r: StoredRecord): boolean {
    if (this.unloaded.size === 0) return false;
    const cols = indexOf(r);
    return (
      (cols.th !== null && this.unloaded.has(`th:${cols.th}`)) ||
      (cols.sp !== null && r.kind !== "space" && this.unloaded.has(`sp:${cols.sp}`))
    );
  }

  get(key: string): StoredRecord | undefined | Unknown {
    const r = this.records.get(key);
    if (!r) {
      const thread = /^(?:thread|counts|answer):([0-9A-Z]{26})$/.exec(key)?.[1];
      return thread && this.unloaded.has(`th:${thread}`) ? UNKNOWN : undefined;
    }
    if (this.hidden(r)) return UNKNOWN;
    return view(this, r, this.me) ?? undefined;
  }

  list<K extends Kind>(kind: K, index: Index): RecordOf<K>[] | Unknown {
    if (this.unloaded.has(indexName(index))) return UNKNOWN;
    const out: RecordOf<K>[] = [];
    for (const key of [...this.keysIn(kind, index)].sort()) {
      const r = this.get(key);
      if (r && r !== UNKNOWN) out.push(r as RecordOf<K>);
    }
    return out;
  }

  all<K extends Kind>(kind: K): RecordOf<K>[] {
    const out: RecordOf<K>[] = [];
    for (const r of this.byKind.get(kind)?.values() ?? []) {
      if (this.hidden(r)) continue;
      const v = view(this, r, this.me);
      if (v) out.push(v as RecordOf<K>);
    }
    return out;
  }

  complete(): boolean {
    return true;
  }

  version(): number {
    return this.counter;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  now(): number {
    return this.clock();
  }

  /** Applies a write as the server would, at once (there is nothing to wait
   * for in memory). A signed-out replica writes nothing. */
  mutate(name: SpaceMutatorName, input: unknown): Promise<WriteOutcome> {
    return Promise.resolve(this.apply(name, input));
  }

  apply(name: SpaceMutatorName, input: unknown): WriteOutcome {
    const me = this.me;
    if (me === null)
      return { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in to do this." } };
    const def = MUTATORS[name];
    if (!def) return { ok: false, error: { code: "BAD_REQUEST", message: `No mutator ${name}.` } };
    const tx = new StagedTx(this, me, msToIso(this.clock()), newUlid(this.clock()));
    const prediction = predict(tx, def, input);
    if ("unknown" in prediction)
      return { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "Not available." } };
    if (!prediction.ok) return prediction;
    let result = prediction.result;
    if (def.notify) {
      const ctx: NotifyCtx = { isAccount: (handle) => this.accounts.has(handle) };
      result = def.notify(tx, def.input.parse(input), result, ctx) ?? result;
    }
    const keys: string[] = [];
    for (const [key, r] of tx.staged) {
      if (r === null) {
        if (this.drop(key)) keys.push(key);
      } else keys.push(this.store(key, r));
    }
    this.changed(keys);
    return { ok: true, result };
  }
}
