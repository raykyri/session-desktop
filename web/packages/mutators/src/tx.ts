// The definition of a mutator and the transaction it runs in (`01` U1, U2).
//
// A mutator runs in three stages (AGENTS.md, "Packages"):
//
// 1. `pre(ctx, input)`: server only, synchronous. It checks what the client
//    cannot know and makes server values: an invite code, the limits (20
//    queued runs per person, `03` L1), the model registry (`03` K11, K13). It
//    may refuse. Its clock and random source come from `ctx`.
// 2. `can` and `run(tx, input, values)`: deterministic over a synchronous
//    `tx`, run by the client (prediction) and the server (authority). They
//    read the time from `tx.now`, never a clock, use no random source, `Intl`
//    or `Date` formatting, and make no ids: the first id comes in the input,
//    later ones from `tx.id(ordinal)`. `run` writes the stored shape, counts
//    included.
// 3. `notify(tx, input, result)`: server only, inside the same transaction,
//    after `run`. It writes the notification records the write causes (`01`
//    C16), so they commit with the write, exactly once. There is no effect
//    queue: an ask's run is a `run` record with status `queued`.
//
// On the server the order is: `space` (the target; NOT_FOUND when the actor
// may not read it), the ban check, the frozen-channel check, `who`, `can`,
// `pre`, `run`, `notify`, all in one transaction, so `pre` never runs for a
// caller the permission checks refuse. No stage does network work.
//
// Reads are declared lookups (`01` U2), each one an index of the records
// table (`01` D1): `byKey`, `list` and `count` by space, thread or person,
// and `unique` by a space's name or an invite link's code. A client replica
// implements the same reads over its working set, and throws `UnknownRead`
// for one it cannot answer; prediction stops there (`predict`) and the write
// is sent unpredicted.

import type { z } from "zod";

import type { Reader } from "./access.js";
import { bannedFrom, isClosed, isOwnerOf, roleIn, spaceRec } from "./access.js";
import { Refusal, refuse, type ApiError } from "./errors.js";
import type { Draft, Index, Kind, RecordOf, UniqueIndex, UniqueKind } from "./records.js";

/** A read the replica cannot answer: the record or index is outside its
 * working set. A replica's `tx` throws it; it stops prediction. On the server
 * every read is answered, so it never reaches an answer as a refusal (an
 * uncaught one is a server fault). */
export class UnknownRead extends Error {
  constructor(what: string) {
    super(`unknown on this replica: ${what}`);
  }
}

/** The reads of a transaction. */
export interface Reads extends Reader {
  /** The records of `kind` in one space, thread or person's index, in key
   * order. */
  list<K extends Kind>(kind: K, index: Index): RecordOf<K>[];
  /** How many records of `kind` are in the index. */
  count(kind: Kind, index: Index): number;
  /** The record a unique lookup names: a space by its name, a channel invite
   * link by its code. */
  unique<I extends UniqueIndex>(index: I, value: string): RecordOf<UniqueKind<I>> | undefined;
}

export interface Tx extends Reads {
  /** The actor's handle. */
  readonly me: string;
  /** The server's time for this mutation (ISO, seconds). */
  readonly now: string;
  /** Write a new record. CONFLICT when its id was ever used, or its key exists. */
  create(r: Draft): void;
  /** Write a record, new or replacing the one at its key. Replacing never
   * changes the record's audience fields (`audienceOf`). */
  put(r: Draft): void;
  del(key: string): void;
  /** The mutation's id at `ordinal` (1, 2, …): see `deriveId`. */
  id(ordinal: number): string;
}

/** Values the pre-check stage makes for `run` (server only). */
export type ServerValues = Readonly<Record<string, string>>;

/** What `pre` may read: the server's clock and random source, and the
 * server-only state the limits need. */
export interface PreCtx {
  /** The actor's handle. */
  readonly me: string;
  /** The server's time, in milliseconds. */
  readonly now: number;
  random(): number;
  inviteCodeTaken(code: string): boolean;
  /** How many runs the actor has with status `queued` (`03` L1). */
  queuedRuns(): number;
}

export type Who = "user" | "member" | "author" | "owner";

/** How a write that acts on an existing record treats a change made after
 * the client saw it (stale intent, AGENTS.md):
 * - `base.rev`: it carries the target's rev and answers STALE when it
 *   differs (an author's edit);
 * - `base.rev when shown`: `moderation.decide`: "shown" compares the rev,
 *   "hidden" and "removed" act on the item as it is;
 * - `base.adm`: `members.remove` compares the member's admission id;
 * - `as is`: it acts on the record as it is now (a restricting decision, a
 *   delete, a cancel, a retry fenced by the attempt number);
 * - `none`: it makes new records, or sets a value whatever it was. */
export type Intent = "base.rev" | "base.rev when shown" | "base.adm" | "as is" | "none";

export interface MutatorDef<I> {
  input: z.ZodType<I>;
  /** Online only: the client sends it directly and never queues it. The
   * server refuses one whose mutation id is older than a minute. */
  online?: boolean;
  who: Who;
  intent: Intent;
  /** Allowed in a frozen space (`04` B6): deleting one's own items, leaving,
   * and the person's own user-log records. Every other write there is
   * FORBIDDEN. */
  frozen?: "allowed";
  /** The space the write acts in, or null. Reads the target: NOT_FOUND when
   * the actor may not read it. */
  space?: (tx: Tx, i: I) => string | null;
  /** The client-made ids in the input, checked against the time window. */
  ids?: (i: I) => string[];
  pre?: (ctx: PreCtx, i: I) => ServerValues;
  can?: (tx: Tx, i: I) => void;
  run: (tx: Tx, i: I, values: ServerValues) => unknown;
  /** Server only, after `run` in the same transaction: the notifications
   * the write causes. */
  notify?: (tx: Tx, i: I, result: unknown) => void;
}

export type AnyMutator = MutatorDef<unknown>;

export const define = <I>(def: MutatorDef<I>) => def as unknown as AnyMutator;

/** The message of a write refused in a frozen space (`04` B6). */
export const frozenMessage = (name: string) =>
  `#${name} is frozen because its owner’s account is not active.`;

/** The ban check, the frozen-space check, the `who` check and `can` (the
 * mock's `authorize`). */
export function authorize(tx: Tx, def: AnyMutator, input: unknown): void {
  const sp = def.space?.(tx, input) ?? null;
  if (sp !== null) {
    const s = spaceRec(tx, sp);
    if (!s) throw refuse("NOT_FOUND");
    // DESIGN (phase 0 finding): the mock lets anyone signed in write in an
    // open space, a banned person included (its bans only stop joining a
    // closed space). A ban stops every write in its space here, the author's
    // edits and deletes and a person's own saves included.
    if (bannedFrom(tx, sp, tx.me)) throw refuse("FORBIDDEN", "You are banned from this space.");
    if (s.frozen && def.frozen !== "allowed") throw refuse("FORBIDDEN", frozenMessage(s.name));
    const who = def.who;
    if (who === "member") {
      if (isClosed(s) && roleIn(tx, sp, tx.me) === null) throw refuse("FORBIDDEN");
    } else if (who === "owner") {
      if (!isOwnerOf(tx, sp, tx.me)) throw refuse("FORBIDDEN");
    }
  } else if (def.who !== "user" && def.who !== "author") {
    throw refuse("INTERNAL_SERVER_ERROR");
  }
  def.can?.(tx, input);
}

/** What a client's prediction of a write came to: applied (its writes are
 * staged in `tx`), refused (the server would refuse it the same way, unless
 * its state differs), or unknown (a read outside the replica's working set,
 * or a value only `pre` makes: the write is sent unpredicted). */
export type Prediction =
  { ok: true; result: unknown } | { ok: false; error: ApiError } | { unknown: true };

/** Predict a write on a client: the input schema, `authorize` and `run`,
 * never `pre` or `notify`. `run` gets no server values. An exception other
 * than a refusal or an unknown read is rethrown: it is a bug. */
export function predict(tx: Tx, def: AnyMutator, input: unknown): Prediction {
  const parsed = def.input.safeParse(input);
  if (!parsed.success) return { ok: false, error: refuse("BAD_REQUEST").toError() };
  try {
    authorize(tx, def, parsed.data);
    return { ok: true, result: def.run(tx, parsed.data, {}) };
  } catch (e) {
    if (e instanceof UnknownRead) return { unknown: true };
    if (e instanceof Refusal) return { ok: false, error: e.toError() };
    throw e;
  }
}
