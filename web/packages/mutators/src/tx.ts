// The definition of a mutator and the transaction it runs in (`01` U1, U2).
//
// A mutator runs in three stages (AGENTS.md, "Packages"):
//
// 1. `pre(ctx, input)`: server only, synchronous. It checks what the client
//    cannot know and makes server values: an invite code, the limits (20
//    queued runs per person, `03` L1), the model registry (`03` K11, K13). It
//    may refuse. Its clock and random source come from `ctx`. It decides
//    who pays for a run the write queues (`03` K8).
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
import { bannedFrom, isClosed, isOwnerOf, roleIn, spaceRec, view } from "./access.js";
import { Refusal, refuse, type ApiError } from "./errors.js";
import type {
  Draft,
  Index,
  Kind,
  RecordOf,
  StoredRecord,
  UniqueIndex,
  UniqueKind,
} from "./records.js";

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
  /** True on the server. A client's prediction (false) skips the reads its
   * replica cannot answer by design, and the effects that need them: the
   * ban check (bans are the owner's records), other people's saves and
   * notifications in a cascade, a private channel's true save count. The
   * server's answer and records replace the prediction when the write is
   * confirmed. */
  readonly server: boolean;
  /** The server's time for this mutation (ISO, seconds). */
  readonly now: string;
  /** Write a new record. CONFLICT when its id was ever used, or its key exists. */
  create(r: Draft): void;
  /** Write a record, new or replacing the one at its key. Replacing never
   * changes the record's audience fields (`audienceOf`). */
  put(r: Draft): void;
  del(key: string): void;
  /** Write a record again as it is, with the next rev, so every reader is
   * served it again as they may read it now: a turn when the moderation
   * state of the ask it belongs to changes (`redact`). Nothing for a key
   * that holds no record. */
  touch(key: string): void;
  /** The mutation's id at `ordinal` (1, 2, …): see `deriveId`. */
  id(ordinal: number): string;
}

/** What `notify` may ask the server: whether a handle is a Session account
 * (a mention of anyone else is reported back, `notMembers`). */
export interface NotifyCtx {
  isAccount(handle: string): boolean;
}

/** Values the pre-check stage makes for `run` (server only). */
export type ServerValues = Readonly<Record<string, string>>;

/** What the payer of a run is decided from (`03` K8): server-only state a
 * client does not hold, read when the write applies. */
export interface PayerFacts {
  /** Whether the person has included tokens left this week, the ledger's
   * open rows counted (`03` K1, K3). */
  includedLeft: boolean;
  /** The Usage page's setting for when included tokens run out (`03` K7). */
  billing: "pause" | "key";
  /** The providers the person has a `valid` key for (`03` K4). */
  keys: readonly ("anthropic" | "openai")[];
}

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
  /** What the payer of a run the actor queues is decided from (`03` K8).
   * Absent where a server keeps no ledger (the prototype's suite): a run is
   * paid by its model's first payer. */
  payerFacts?(): PayerFacts;
  /** Whether the actor has a use of a `pre`-stage limit left (`04` Z1):
   * true, or the message of the TOO_MANY_REQUESTS refusal, which is not
   * recorded (it names the limit and when a use is free again). The server
   * takes the use only when the write commits a change, so a refused write
   * or one that changes nothing uses none. Absent where a server applies no
   * limits (the prototype's suite). */
  allow?(limit: PreLimit): true | string;
}

/** The limits of `04` Z1 that a mutator's `pre` stage applies, per person:
 * channels made (5 a day), channel invite links made (20 a day) and joins
 * (60 an hour). The server counts them; `pre` names the one a write uses. */
export type PreLimit = "spaces.create" | "invites.create" | "spaces.join";

export type Who = "user" | "member" | "author" | "owner";

/** How a write that acts on an existing record treats a change made after
 * the client saw it (stale intent, AGENTS.md):
 * - `base.rev`: it carries the target's rev and answers STALE when it
 *   differs (an author's edit);
 * - `base.rev when shown`: `moderation.decide`: "shown" compares the rev,
 *   "hidden" and "removed" act on the item as it is;
 * - `base.adm`: `members.remove` compares the member's admission id;
 * - `base.attempt`: `research.retryNode` compares the run's attempt;
 * - `as is`: it acts on the record as it is now (a restricting decision, a
 *   delete, a cancel, a retry fenced by the attempt number);
 * - `none`: it makes new records, or sets a value whatever it was. */
export type Intent =
  "base.rev" | "base.rev when shown" | "base.adm" | "base.attempt" | "as is" | "none";

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
  /** Whether this input writes only the actor's own user-log records
   * (marking a notification read, taking back a save): a ban does not stop
   * it (M1b review 11). */
  ownLog?: (i: I) => boolean;
  /** The space the write acts in, or null. Reads the target: NOT_FOUND when
   * the actor may not read it. */
  space?: (tx: Tx, i: I) => string | null;
  /** The client-made ids in the input, checked against the time window. */
  ids?: (i: I) => string[];
  pre?: (ctx: PreCtx, i: I) => ServerValues;
  can?: (tx: Tx, i: I) => void;
  run: (tx: Tx, i: I, values: ServerValues) => unknown;
  /** Server only, after `run` in the same transaction: the notifications
   * the write causes. It may return the write's result with server values
   * added (the mentions it notified, 02 N16); undefined keeps `run`'s. */
  notify?: (tx: Tx, i: I, result: unknown, ctx: NotifyCtx) => unknown;
}

export type AnyMutator = MutatorDef<unknown>;

export const define = <I>(def: MutatorDef<I>) => def as unknown as AnyMutator;

/** The message of a write refused in a frozen space (`04` B6). */
export const frozenMessage = (name: string) =>
  `#${name} is unavailable because its owner's account is deactivated.`;

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
    // Bans are the owner's records: a client's replica does not hold them,
    // so the check is server-only (`Tx.server`), and the server's FORBIDDEN
    // rolls a banned person's prediction back. A write of the person's own
    // user-log records only is not stopped by a ban.
    if (tx.server && !def.ownLog?.(input) && bannedFrom(tx, sp, tx.me))
      throw refuse("FORBIDDEN", `You are banned from #${s.name}.`);
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
 * never `pre` or `notify`, over a client transaction (`Tx.server` false), so
 * the server-only reads and effects are skipped. `run` gets no server
 * values. An exception other than a refusal or an unknown read is rethrown:
 * it is a bug.
 *
 * What the prediction stages is the stored shape; the replica shows it as
 * `predictedView` gives it (the actor's view, as the server would serve it).
 * Where `run` is engine-dependent (the `\p{L}`/`\p{N}` classes of a look-up
 * phrase, `validate.ts`), the server's stored record replaces the
 * prediction when the write is confirmed. */
export function predict(tx: Tx, def: AnyMutator, input: unknown): Prediction {
  if (tx.server) throw new Error("predict runs on a client transaction");
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

/** A prediction's staged records as the actor reads them (M1b review 6):
 * each through `view` over the transaction's reads, so the replica shows
 * what the server will serve the actor (a removed thread's author is null
 * for the owner who removed it). A record the actor may not read is null,
 * as a delete is. */
export function predictedView(tx: Tx & { staged: ReadonlyMap<string, StoredRecord | null> }) {
  const out = new Map<string, StoredRecord | null>();
  for (const [key, r] of tx.staged) out.set(key, r === null ? null : view(tx, r, tx.me));
  return out;
}
