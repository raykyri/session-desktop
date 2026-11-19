// The mutator engine: `defineMutator`, a registry, and `apply`, the one path
// both the client (to predict a write's result) and the server (as the
// authority) run a write through.
//
// A mutator has these stages, in this order:
// 1. `can(tx, input)`: the permission check. It returns the write's `Scope`,
//    which only `inSpace`, `inSpaces` and `personal` make: `inSpace` refuses
//    a space that does not exist or that the actor is banned from, then
//    checks the role the write needs. So every write that acts in a space
//    passes the ban check (AGENTS.md: a ban stops every write in its space).
// 2. `pre(ctx, input)` (server only): checks and values the client cannot
//    have, such as an invite code made from the server's random source, or
//    the limit of device runs an hour. It may refuse, and reads
//    through `ctx.tx`. Its values reach `run` as data. `needsPre(input)`
//    says whether it runs for an input; a client that predicts a write whose
//    `pre` would run gets `unknown`.
// 3. `run(tx, input, values)`: deterministic over the synchronous `tx`. It
//    reads the time from `tx.now`, never the clock, uses no random source and
//    no `Intl`, and makes no ids: a new record's first id comes in the input,
//    later ones from `tx.id(ordinal)`. It writes the stored shape.
// 4. `effects(input, result)`: the post-commit work, as data (start a job,
//    notify a space's staff). Effects carry ids and keys, never text, so the
//    queue that holds them holds nothing a removal must erase.
//
// The server half checks the envelope (protocol version, client, seq,
// idempotency, the device's clock, the mutation id's age) before `apply`.
// `apply` checks the actor, the mutator's name, its input, the age of the new
// ids in the input and of an online-only write, then runs the stages.
//
// `RecordSource` is all a store has to provide: reads by kind and id, the
// indexed scans in `records.ts`, and the id registry. The engine stages the
// writes over it, so the same mutators run over the replica, over SQLite and
// over an in-memory map. A source that cannot answer a read (a replica that
// lacks the record or does not hold the whole of an index) returns
// `UNKNOWN`; the engine then stops and `apply` answers `unknown`: the client
// shows the write as pending and waits for the server.

import type { z } from "zod";

import type { Reader } from "./access.js";
import { RANK, isClosed, rankIn, roleIn } from "./access.js";
import { type ApiError, Refusal, notFound, refuse } from "./errors.js";
import { ONLINE_MAX_AGE, ageOk, deriveId, ulidTime } from "./ids.js";
import {
  type Draft,
  type IndexKind,
  type IndexName,
  type Kind,
  type RecordOf,
  type StoredRecord,
  audienceOf,
  idOf,
  idOfRecord,
  inIndex,
  keyFor,
  keyOf,
} from "./records.js";
import { isHandle } from "./schemas.js";
import { isoAt, msOf } from "./time.js";

// ---- the store's side ----

/** The answer to a read the source cannot give. */
export const UNKNOWN: unique symbol = Symbol("unknown");
export type Unknown = typeof UNKNOWN;

/** What the engine reads a mutation's state from. */
export interface RecordSource {
  /** The record of `kind` with `id`, undefined when there is none, or
   * UNKNOWN. */
  get(kind: Kind, id: string): StoredRecord | undefined | Unknown;
  /** The records an index lists under `value` (`INDEXES`), in any order, or
   * UNKNOWN when the source does not hold all of them. */
  scan(index: IndexName, value: string): readonly StoredRecord[] | Unknown;
  /** Whether an id was ever used by a record of an id kind (the id
   * registry), or UNKNOWN. */
  idUsed(id: string): boolean | Unknown;
}

// ---- the mutators' side ----

/** A mutation's view of the store: its reads see its own staged writes. */
export interface Tx extends Reader {
  /** The actor's handle. */
  readonly me: string;
  /** The time of this mutation (ISO, UTC, to the second). */
  readonly now: string;
  /** The same time in milliseconds since the epoch. */
  readonly nowMs: number;
  get<K extends Kind>(kind: K, id: string): RecordOf<K> | undefined;
  /** The records an index lists under `value`, in key order. */
  scan<N extends IndexName>(index: N, value: string): RecordOf<IndexKind<N>>[];
  /** Write a new record: CONFLICT when its key exists or its id was ever
   * used. */
  create(r: Draft): void;
  /** Write a record, new or replacing the one at its key. Replacing never
   * changes the record's audience fields (`audienceOf`). */
  put(r: Draft): void;
  del(kind: Kind, id: string): void;
  /** The mutation's id at `ordinal` (1, 2, …): see `deriveId`. */
  id(ordinal: number): string;
}

declare const scopeBrand: unique symbol;

/** The spaces a write acts in, as `can` decided them. Only `inSpace`,
 * `inSpaces` and `personal` make one. */
export interface Scope {
  readonly [scopeBrand]: true;
  readonly spaces: readonly string[];
}

const scope = (spaces: string[]) => ({ spaces }) as unknown as Scope;

/** The role a write needs in its space (the mock's `who`):
 * - `user`: anyone signed in who is not banned from the space;
 * - `member`: in a closed space, one of its members; an open space takes
 *   writes from anyone signed in;
 * - `moderator`, `admin`, `owner`: that role or a higher one. */
export type Who = "user" | "member" | "moderator" | "admin" | "owner";

/** A write in space `sp`: NOT_FOUND when the space does not exist (or was
 * deleted), FORBIDDEN when the actor is banned from it or lacks `who`. */
export function inSpace(tx: Tx, sp: string, who: Who): Scope {
  const s = tx.get("space", sp);
  if (!s || s.deleted) throw notFound();
  // a ban stops every write in its space, the author's own included
  if (tx.get("ban", `${sp}:${tx.me}`)) throw refuse("FORBIDDEN", "You are banned from this space.");
  if (who === "member") {
    if (isClosed(s) && roleIn(tx, sp, tx.me) === null) throw refuse("FORBIDDEN");
  } else if (who !== "user") {
    const need = who === "moderator" ? RANK.mod : RANK[who];
    if (rankIn(tx, sp, tx.me) < need) throw refuse("FORBIDDEN");
  }
  return scope([sp]);
}

/** A write in several spaces: `inSpace` for each. */
export function inSpaces(tx: Tx, sps: readonly string[], who: Who): Scope {
  for (const sp of sps) inSpace(tx, sp, who);
  return scope([...new Set(sps)]);
}

/** A write that touches no space: only the actor's own records. */
export const personal = (): Scope => scope([]);

/** Values the pre-check stage makes for `run` (server only). */
export type ServerValues = Readonly<Record<string, string>>;

/** What the server gives the pre-check stage. */
export interface ServerHooks {
  /** The server's random source: a number in [0, 1). */
  random(): number;
  /** The times (ms) at which `u` started device runs after `since`, as the
   * server counts them: a start stays counted when its run record is
   * deleted. A server records a start for each run record with an executor
   * that a committed write creates. */
  deviceRunStarts(u: string, since: number): readonly number[];
}

/** The device runs a write's staged changes start: the new run records with
 * an executor (what a server records for `deviceRunStarts`). */
export function deviceRunsStarted(
  writes: readonly Write[],
  existed: (key: string) => boolean,
): number {
  let n = 0;
  for (const [key, r] of writes) if (r?.kind === "run" && r.executor !== null && !existed(key)) n++;
  return n;
}

export interface PreCtx extends ServerHooks {
  readonly me: string;
  readonly nowMs: number;
  /** The mutation's reads, as `can` and `run` see them. */
  readonly tx: Tx;
}

/** Post-commit work, as data:
 * - `job`: start a server job: a run of an ask (`run`, the run's id) or a
 *   domain check (`domain`, the space's id), or (phase 2a, queued by the
 *   server's online `apiKeys.*` calls) an API key check (`key`, the key's id).
 * - `notifyStaff`: notify a space's staff (as they are when the effect runs)
 *   of a report.
 * - `reportResolved`: tell a report's author how it was resolved (`outcome`),
 *   replacing any earlier notice of it; `outcome` null takes the notice back
 *   (the report was opened again). */
export type JobKind = "run" | "domain" | "key";

export type Effect =
  | { type: "job"; kind: JobKind; id: string }
  | { type: "notifyStaff"; sp: string; report: string; item: string }
  | {
      type: "reportResolved";
      report: string;
      outcome: "dismissed" | "hidden" | "removed" | null;
    };

export interface MutatorDef<I, R> {
  name: string;
  input: z.ZodType<I>;
  /** Online only: the client sends it directly and never queues it. Refused
   * (EXPIRED) when its mutation id is more than a minute behind the
   * device's time. */
  online?: boolean;
  /** The client-made new ids in the input, checked against the id window. */
  ids?: (i: I) => string[];
  pre?: (ctx: PreCtx, i: I) => ServerValues;
  /** Whether `pre` runs for this input (default: always, when there is one). */
  needsPre?: (i: I) => boolean;
  can: (tx: Tx, i: I) => Scope;
  run: (tx: Tx, i: I, values: ServerValues) => R;
  effects?: (i: I, result: R) => Effect[];
}

/** A mutator with its types erased, as a registry holds it. */
export interface Mutator {
  readonly name: string;
  readonly input: z.ZodType<unknown>;
  readonly online: boolean;
  ids(input: unknown): string[];
  readonly pre: ((ctx: PreCtx, i: unknown) => ServerValues) | undefined;
  needsPre(input: unknown): boolean;
  can(tx: Tx, input: unknown): Scope;
  run(tx: Tx, input: unknown, values: ServerValues): unknown;
  effects(input: unknown, result: unknown): Effect[];
}

export function defineMutator<I, R>(def: MutatorDef<I, R>): Mutator {
  const d = def as unknown as MutatorDef<unknown, unknown>;
  return Object.freeze({
    name: d.name,
    input: d.input,
    online: d.online === true,
    ids: (i: unknown) => d.ids?.(i) ?? [],
    pre: d.pre,
    needsPre: (i: unknown) => d.pre !== undefined && (d.needsPre?.(i) ?? true),
    can: d.can,
    run: d.run,
    effects: (i: unknown, r: unknown) => d.effects?.(i, r) ?? [],
  });
}

/** The mutators by name. */
export interface Registry {
  get(name: string): Mutator | undefined;
  readonly names: readonly string[];
}

export function createRegistry(mutators: readonly Mutator[]): Registry {
  const byName = new Map<string, Mutator>();
  for (const m of mutators) {
    if (byName.has(m.name)) throw new Error(`two mutators named ${m.name}`);
    byName.set(m.name, m);
  }
  return Object.freeze({
    get: (name: string) => byName.get(name),
    names: Object.freeze([...byName.keys()]),
  });
}

// ---- apply ----

/** The signed-in person a write is made for. */
export interface Actor {
  readonly u: string;
}

/** The parts of an outbox entry `apply` reads. */
export interface MutationEnvelope {
  mutationId: string;
  name: string;
  input: unknown;
  /** The device's clock when it sent the write (ms): the new ids' age is
   * measured on it. */
  clientTime: number;
}

export interface ApplyOptions {
  /** The mutation's time in ms: the server's clock, or on the client its
   * estimate of the server's. */
  now: number;
  /** The server's hooks: given only on the server, where `pre` runs. */
  server?: ServerHooks;
}

/** A write in the order `run` staged it: a key and its new record (without
 * `rev`, which the store sets), or null for a delete. */
export type Write = readonly [key: string, record: Draft | null];

export type Outcome =
  | {
      status: "ok";
      result: unknown;
      scope: readonly string[];
      writes: readonly Write[];
      effects: readonly Effect[];
    }
  | { status: "refused"; error: ApiError }
  /** The source could not answer a read, or `pre` would run (a client). */
  | { status: "unknown"; reason: string };

/** Thrown by the staged tx when the source answers UNKNOWN. */
class UnknownRead extends Error {}

class StagedTx implements Tx {
  readonly staged = new Map<string, Draft | null>();
  private readonly newIds = new Set<string>();

  constructor(
    private readonly source: RecordSource,
    readonly me: string,
    readonly now: string,
    readonly nowMs: number,
    private readonly mutationId: string,
  ) {}

  get<K extends Kind>(kind: K, id: string): RecordOf<K> | undefined {
    const key = keyFor(kind, id);
    if (this.staged.has(key)) {
      const w = this.staged.get(key);
      return w ? ({ ...w, rev: 0 } as RecordOf<K>) : undefined;
    }
    const r = this.source.get(kind, id);
    if (r === UNKNOWN) throw new UnknownRead(key);
    if (r !== undefined && r.kind !== kind)
      throw new Error(`the source answered ${key} with a ${r.kind}`);
    return r as RecordOf<K> | undefined;
  }

  scan<N extends IndexName>(index: N, value: string): RecordOf<IndexKind<N>>[] {
    const found = this.source.scan(index, value);
    if (found === UNKNOWN) throw new UnknownRead(`${index}=${value}`);
    const out = new Map<string, StoredRecord>();
    for (const r of found) {
      const key = keyOf(r);
      if (!this.staged.has(key) && inIndex(r, index, value)) out.set(key, r);
    }
    for (const [key, w] of this.staged)
      if (w && inIndex(w, index, value)) out.set(key, { ...w, rev: 0 });
    return [...out.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, r]) => r as RecordOf<IndexKind<N>>);
  }

  create(r: Draft): void {
    const id = idOf(r);
    const exists = this.get(r.kind, idOfRecord(r)) !== undefined;
    if (exists || (id !== null && (this.newIds.has(id) || this.used(id))))
      throw refuse("CONFLICT", ID_TAKEN);
    this.write(r);
    if (id !== null) this.newIds.add(id);
  }

  put(r: Draft): void {
    const key = keyOf(r);
    const prev = this.get(r.kind, idOfRecord(r));
    if (!prev && idOf(r) !== null) return this.create(r);
    if (prev && audienceOf(prev) !== audienceOf(r))
      throw new Error(`a write changed the audience of ${key}`);
    this.write(r);
  }

  del(kind: Kind, id: string): void {
    if (this.get(kind, id)) this.staged.set(keyFor(kind, id), null);
  }

  id(ordinal: number): string {
    return deriveId(this.me, this.mutationId, ordinal);
  }

  private used(id: string): boolean {
    const u = this.source.idUsed(id);
    if (u === UNKNOWN) throw new UnknownRead(`id ${id}`);
    return u;
  }

  /** Stage a record without the `rev` a mutator may have spread into it
   * from the record it read: the store sets revs. */
  private write(r: Draft) {
    const draft: Record<string, unknown> = { ...r };
    delete draft["rev"];
    this.staged.set(keyOf(r), draft as Draft);
  }
}

/** The id-collision answer: one message, whether or not the caller may read
 * the record that holds the id. */
export const ID_TAKEN = "An item with this id exists.";

const refused = (e: Refusal): Outcome => ({ status: "refused", error: e.toError() });

/** Run one write. Both halves call it: the server with `options.server`
 * (then `unknown` never comes back from a source that answers every read),
 * the client without it, to predict the server's answer. An exception that
 * is not a refusal answers INTERNAL_SERVER_ERROR, with nothing written. */
export function apply(
  registry: Registry,
  source: RecordSource,
  actor: Actor | null,
  envelope: MutationEnvelope,
  options: ApplyOptions,
): Outcome {
  try {
    if (actor === null || !isHandle(actor.u)) return refused(refuse("UNAUTHORIZED"));
    const def = registry.get(envelope.name);
    if (!def)
      return refused(refuse("NOT_FOUND", "The server has no procedure with this name.", ["name"]));
    const parsed = def.input.safeParse(envelope.input);
    if (!parsed.success)
      return refused(
        refuse(
          "BAD_REQUEST",
          undefined,
          parsed.error.issues.map(
            (x) => `input${x.path.map((p) => `.${String(p)}`).join("")}: ${x.code}`,
          ),
        ),
      );
    const input = parsed.data;
    for (const id of def.ids(input))
      if (!ageOk(id, envelope.clientTime))
        return refused(
          refuse("EXPIRED", undefined, [
            "input.id: expected a ULID from the 4 days before clientTime to 1 minute after",
          ]),
        );
    // an online-only write whose mutation id is over a minute old on the
    // device's clock waited in an outbox
    if (def.online && envelope.clientTime - ulidTime(envelope.mutationId) > ONLINE_MAX_AGE)
      return refused(
        refuse("EXPIRED", undefined, [
          "mutationId: expected a ULID from the minute before clientTime (online only)",
        ]),
      );
    const now = isoAt(options.now);
    const tx = new StagedTx(source, actor.u, now, msOf(now), envelope.mutationId);
    const s = def.can(tx, input);
    if (!Array.isArray((s as { spaces?: unknown } | undefined)?.spaces))
      throw new Error(`${def.name}: can returned no scope`);
    let values: ServerValues = {};
    if (def.needsPre(input)) {
      const server = options.server;
      if (!server || !def.pre)
        return { status: "unknown", reason: "the write needs the server's pre-check" };
      const ctx: PreCtx = {
        me: actor.u,
        nowMs: tx.nowMs,
        tx,
        random: () => server.random(),
        deviceRunStarts: (u, since) => server.deviceRunStarts(u, since),
      };
      values = def.pre(ctx, input);
    }
    const result = def.run(tx, input, values);
    const effects = def.effects(input, result);
    return {
      status: "ok",
      result,
      scope: s.spaces,
      writes: [...tx.staged.entries()],
      effects,
    };
  } catch (e) {
    if (e instanceof UnknownRead) return { status: "unknown", reason: `read ${e.message}` };
    if (e instanceof Refusal) return refused(e);
    return refused(refuse("INTERNAL_SERVER_ERROR"));
  }
}
