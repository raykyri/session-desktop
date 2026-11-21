// The server half (`01` §4.2): `register`, `apply` (in order per client,
// idempotent by user and mutation id), `snapshot` and `pull` filtered by the
// reader's scope at the time of the read, `serverApply` for writes the
// server makes itself (Y13), and the retention jobs (Y8). It runs on a
// `ServerStore`; `replica-proto/src/server.ts` is the reference it was
// ported from, and that package's suite runs on this one.
//
// Apply, in order. "Unrecorded" answers use up nothing: the client may send
// the same `seq` again. An exception anywhere is INTERNAL_SERVER_ERROR,
// unrecorded, and the transaction it was in writes nothing.
//   the envelope nests at most 33 deep (its input at most 32; BAD_REQUEST)
//     and is at most 256 KB as JSON (TOO_LARGE): unrecorded, checked before
//     anything hashes or parses the input
//   protocol version (UPGRADE_REQUIRED) and envelope shape (BAD_REQUEST): unrecorded
//   signed in with a valid handle (UNAUTHORIZED): unrecorded
//   the client id is the caller's and was used in the past 7 days
//     (WRONG_CLIENT): unrecorded
//   then, in one transaction:
//   a stored answer for (user, mutation id) whose payload digest matches,
//     or that a reminted envelope stored under the id it replaced: returned
//     as it is, under any client id or seq; nothing runs and no seq is used
//   an answer stored for (client, seq) with the same mutation id and payload:
//     returned as it is
//   a reminted write whose replaced id has an answer: that answer, stored
//     under the new mutation id too, using no seq
//   `seq` is the client's next one (OUT_OF_ORDER, with `expectedSeq`): unrecorded
//   the mutation id is a ULID, and not one the user sent with another
//     payload (BAD_REQUEST): uses up the `seq`, stored for (client, seq)
//   `clientTime` within a minute of the server's time (CLOCK_SKEW): unrecorded
//   the mutation id's and `queuedAt`'s age on the device's clock at most 4
//     days and at least −1 minute (EXPIRED); the mutator name and strict
//     input (BAD_REQUEST); the input's new ids in the same window, and an
//     online-only write's mutation id at most a minute old (EXPIRED)
//   space, ban, frozen, who, can, pre (server values), run, notify
//   commit: records (notifications included), log rows, registry,
//     tombstones, the answer under the mutation id and each id in
//     `replaces`, and the client's last seq
//
// Change log: one row per (log, key), holding key, op and version only; a
// write replaces the key's row. Versions come from one sequence for the whole
// server and never leave it: a cursor is a sealed token (`tokens.ts`). A
// pull reads each changed record as it is now. A deleted record leaves a
// tombstone for 30 days: its key, kind and audience, no text, used only to
// decide who gets the `del`. The registry keeps every id and key ever
// written with its last rev.
//
// Resync: a pull answers `{ resync: true }` when the token was not sealed by
// this server (current or previous key) for this reader and log, or was
// served more than 30 days ago, or the log's history was replaced since, or
// the reader's scope changed since: their own membership in the space, and
// for their user log, their membership in any space or the history of a
// space log that a record in the log is about being replaced.

import {
  DAY,
  MINUTE,
  Refusal,
  StagedTx,
  ULID_RE,
  audience,
  authorize,
  createdOf,
  isHandle,
  isUlid,
  logsOf,
  memberKey,
  msToIso,
  readsAudience,
  refuse,
  registryKey,
  ulidTime,
  view,
  type AnyMutator,
  type Audience,
  type LogId,
  type PreCtx,
  type PreLimit,
  type RunRec,
  type StoredRecord,
  type Tx,
} from "@session/mutators";
import { z } from "zod";

import { ulid, ageOk, timeOk, CLOCK_MAX_SKEW, canonical, digest, webRandom } from "../ulid.js";
import {
  MAX_ENVELOPE_BYTES,
  MAX_INPUT_DEPTH,
  MAX_OPENED_THREADS,
  MIN_PROTOCOL_VERSION,
  UNRECORDED,
  envelopeSchema,
  type Actor,
  type ApplyResult,
  type Change,
  type Clock,
  type Cursor,
  type LastSeq,
  type Pull,
  type ReadOptions,
  type RegisterOptions,
  type RegisterResult,
  type ServerHalf,
  type Snapshot,
  type StoredAnswer,
} from "../wire.js";

import type { ClientRow, LogRow, ServerStore, Tombstone } from "./store.js";
import { Tokens, type CursorKeys } from "./tokens.js";
import { WEB_WINDOW, windowOf, type WindowSettings } from "./window.js";

/** Answers are kept 7 days (`01` D2). */
export const DEDUP_TTL = 7 * DAY;
/** Tombstones are kept 30 days, and a cursor served longer ago resyncs. */
export const TOMBSTONE_TTL = 30 * DAY;
/** Moderation log entries are kept 180 days (`01` C12; a replicated delete). */
export const MODLOG_TTL = 180 * DAY;
/** The most an online-only write's mutation id may be behind `clientTime`. */
export const ONLINE_MAX_AGE = MINUTE;
/** A web client id not used for this long expires (`01` Y3): it then answers
 * WRONG_CLIENT, and the client registers again. */
export const CLIENT_IDLE_TTL = 7 * DAY;
/** The most new client ids one person may register in a day; a re-attach is
 * not counted (`01` Y3). */
export const REGISTRATIONS_PER_DAY = 50;

const logS = z
  .string()
  .max(200)
  .regex(/^(space|user):[^:]+$/);
const threadsS = z.array(z.string().regex(ULID_RE)).max(MAX_OPENED_THREADS);
const TIERS: ReadonlySet<string> = new Set(["full", "summary", "window", "threads"]);

const fail = (e: Refusal): StoredAnswer => ({ ok: false, error: e.toError() });
const same = (a: StoredRecord, b: StoredRecord) =>
  JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });

/** Whether `v` nests deeper than `maxDepth` levels or holds more than
 * `maxNodes` values, or null when it does neither. Walked with a stack, so a
 * deep value cannot overflow the call stack. */
function outOfBounds(v: unknown, maxDepth: number, maxNodes: number): "deep" | "large" | null {
  const stack: [unknown, number][] = [[v, 0]];
  let nodes = 0;
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [x, level] = top;
    if (++nodes > maxNodes) return "large";
    if (x === null || typeof x !== "object") continue;
    if (level >= maxDepth) return "deep";
    for (const y of Object.values(x)) stack.push([y, level + 1]);
  }
  return null;
}

/** The digest an answer is stored with under a mutation id that a reminted
 * envelope replaced: a replay of that id with any payload gets the answer. */
const REPLACED = "*";

/** The kinds a summary leaves out: what is under a thread. */
const CONTENT_KINDS: ReadonlySet<string> = new Set([
  "node",
  "answer",
  "reply",
  "comment",
  "run",
  "turn",
]);

/** The logs a record with this audience is written to: its space's log
 * (none for saves and notifications, which live in user logs only) and its
 * person's user log. */
function logsOfAudience(a: Audience): LogId[] {
  const out: LogId[] = [];
  if (a.sp !== null && a.kind !== "save" && a.kind !== "notif") out.push(`space:${a.sp}`);
  if (a.person !== null) out.push(`user:${a.person}`);
  return out;
}

/** The thread a record belongs to, or null. */
const threadOf = (r: StoredRecord): string | null =>
  r.kind === "thread"
    ? r.id
    : r.kind === "counts" || CONTENT_KINDS.has(r.kind)
      ? (r as { th: string }).th
      : null;

/** What `execute` decided: the answer, whether it is recorded, and for an
 * applied write the staged changes, its notifications included. */
interface Outcome {
  result: StoredAnswer;
  recorded: boolean;
  staged?: Map<string, StoredRecord | null>;
}

export interface SyncServerOptions {
  store: ServerStore;
  clock: Clock;
  /** The server's random source for client ids, invite codes and server-made
   * ids: a number in [0, 1). Default: Web Crypto. */
  random?: () => number;
  /** The mutator definitions the server runs, by name. */
  mutators: Readonly<Record<string, AnyMutator>>;
  /** The cursor token keys (`SESSION_CURSOR_KEY`, `..._PREVIOUS`). Without
   * them, a random key of this process (tests). */
  cursorKeys?: CursorKeys;
  /** The web window of `window` snapshots (R1). */
  window?: WindowSettings;
  /** Expire answers, tombstones and clients at the start of every call, not
   * only when `retain` runs (the prototype's behaviour, which its suite
   * reads through `scanStorage`). */
  expireEveryCall?: boolean;
  /** How long a client id lives idle, and how many new ids a person may
   * register in a day (default: the web's 7 days and 50, `01` Y3). The
   * prototype's suite runs with its own figures, for clients that keep an
   * outbox for days (90 days and 20). */
  clients?: { idleTtl?: number; perDay?: number };
}

/** The result of `serverApply`: the function's result and the version of
 * the commit (null when it changed nothing), or the refusal; a refusal or a
 * fault commits nothing. */
/** The counter of the `pre`-stage limits (`SyncServer.setPreLimits`). */
export interface PreLimits {
  /** Whether `u` has a use of `limit` left; uses it when so. */
  take(u: string, limit: PreLimit): boolean;
}

export type ServerApplyResult<T> =
  | { ok: true; result: T; version: number | null }
  | { ok: false; error: ReturnType<Refusal["toError"]> };

export class SyncServer implements ServerHalf {
  readonly store: ServerStore;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly mutators: Readonly<Record<string, AnyMutator>>;
  private readonly tokens: Tokens;
  private readonly window: WindowSettings;
  private readonly expireEveryCall: boolean;
  private readonly clientIdleTtl: number;
  private readonly registrationsPerDay: number;
  /** The server's time: never decreasing, so every table's expiry order is
   * the order of its times. */
  private lastAt: number;
  /** Counts the `pre`-stage limits of `04` Z1 (`setPreLimits`). */
  private preLimits: PreLimits | null = null;

  /** Sets what counts the `pre`-stage limits (channels made, channel invite
   * links made and joins, per person; `04` Z1): `take` answers whether the
   * person has a use of the limit left, and uses it. Null (the default)
   * applies none: the prototype's suite and the tests of other rules. The
   * web server sets its in-memory buckets here at boot. */
  setPreLimits(limits: PreLimits | null): void {
    this.preLimits = limits;
  }

  constructor(options: SyncServerOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.random = options.random ?? webRandom;
    this.mutators = options.mutators;
    this.tokens = new Tokens(options.cursorKeys);
    this.window = options.window ?? WEB_WINDOW;
    this.expireEveryCall = options.expireEveryCall ?? false;
    this.clientIdleTtl = options.clients?.idleTtl ?? CLIENT_IDLE_TTL;
    this.registrationsPerDay = options.clients?.perDay ?? REGISTRATIONS_PER_DAY;
    this.lastAt = this.clock.now();
  }

  /** The server's time now: the clock, never earlier than a time used before. */
  now(): number {
    return (this.lastAt = Math.max(this.clock.now(), this.lastAt));
  }

  /** The caller's handle, or null for a signed-out caller and for a handle no
   * person may have. */
  private userOf(actor: Actor | null): string | null {
    return actor !== null && typeof actor.u === "string" && isHandle(actor.u) ? actor.u : null;
  }

  /** The server's time for this call, after expiring what is past its
   * lifetime when the server is set to at every call. */
  private begin(): number {
    const now = this.now();
    if (this.expireEveryCall) this.expire(now);
    return now;
  }

  // ---- retention (Y8) ----

  /** Expire the non-replicated tables: tombstones (and their `del` rows)
   * over 30 days, recorded answers over 7 days, clients idle 7 days and the
   * day's registration counts. A tombstone committed at the cutoff itself is
   * kept, so a cursor served then still gets its `del`. */
  expire(now = this.now()): void {
    const s = this.store;
    s.transaction(() => {
      s.pruneTombstones(now - TOMBSTONE_TTL);
      s.pruneAnswers(now - DEDUP_TTL);
      s.pruneClients(now - this.clientIdleTtl);
      s.pruneRegistrations(now - DAY);
    });
  }

  /** The hourly retention job (Y8): `expire`, and moderation log entries
   * over 180 days deleted as replicated deletes (tombstones and `del` rows,
   * so replicas drop them too). The registry is never pruned. */
  retain(now = this.now()): void {
    this.expire(now);
    const keys = this.store.keysCreatedBefore("modlog", now - MODLOG_TTL);
    if (keys.length)
      this.store.transaction(() => this.commit(new Map(keys.map((k) => [k, null])), now));
  }

  // ---- commit ----

  /** Write staged records under one new version: records, registry,
   * tombstones and log rows. Returns the version, or null when nothing
   * changed. Runs inside the caller's transaction. */
  private commit(staged: ReadonlyMap<string, StoredRecord | null>, now: number): number | null {
    const store = this.store;
    const writes: [string, StoredRecord | null, StoredRecord | undefined][] = [];
    for (const [key, next] of staged) {
      const prev = store.byKey(key);
      if (next === null ? !prev : prev && same(prev, next)) continue;
      writes.push([key, next, prev]);
    }
    if (!writes.length) return null;
    const version = store.nextVersion();
    const at = now;
    for (const [key, next, prev] of writes) {
      if (next === null) {
        const old = prev as StoredRecord;
        const tomb: Tombstone = { key, ...audience(store, old), at };
        store.deleteRecord(key);
        store.putTombstone(tomb);
        for (const log of logsOfAudience(tomb)) store.putLogRow(log, { key, op: "del", version });
        continue;
      }
      // the rev is the staged one (`StagedTx`)
      const rec = next;
      store.putRecord(key, rec, prev ? null : { version, at });
      store.setLastRev(registryKey(rec), rec.rev);
      store.deleteTombstone(key);
      for (const log of logsOf(rec)) store.putLogRow(log, { key, op: "put", version });
    }
    return version;
  }

  // ---- writes ----

  register(actor: Actor | null, options: RegisterOptions = {}): RegisterResult {
    try {
      const now = this.begin();
      const u = this.userOf(actor);
      if (u === null) return { ok: false, error: refuse("UNAUTHORIZED").toError() };
      if (this.store.accountStatus(u) === "waiting")
        return { ok: false, error: refuse("FORBIDDEN").toError() };
      const store = this.store;
      return store.transaction((): RegisterResult => {
        // a re-attach: the tab's stored id, if it is the caller's and not
        // idle 7 days; not counted against the limit
        if (options.clientId !== undefined) {
          const c = store.client(options.clientId);
          if (!c || c.u !== u || c.seen <= now - this.clientIdleTtl)
            return { ok: false, error: refuse("WRONG_CLIENT").toError() };
          store.putClient({ ...c, seen: now });
          return { ok: true, clientId: c.clientId, lastSeq: c.last, reattached: true };
        }
        if (store.registrationsSince(u, now - DAY + 1) >= this.registrationsPerDay)
          return { ok: false, error: refuse("TOO_MANY_REQUESTS").toError() };
        let id: string;
        do id = ulid(now, this.random);
        while (store.client(id));
        store.putClient({ clientId: id, u, last: 0, createdAt: now, seen: now });
        return { ok: true, clientId: id, lastSeq: 0, reattached: false };
      });
    } catch {
      // the random source or the store failed: nothing was registered
      return { ok: false, error: refuse("INTERNAL_SERVER_ERROR").toError() };
    }
  }

  apply(actor: Actor | null, envelope: unknown): ApplyResult {
    const a = this.answer(actor, envelope);
    // every answer carries the server's time (`01` Y2)
    const serverTime = this.now();
    return a.ok
      ? { ...a, serverTime }
      : {
          ok: false,
          error: { ...a.error, serverTime: a.error.serverTime ?? serverTime },
          ...(a.replay ? { replay: true as const } : {}),
        };
  }

  /** A batch of envelopes, answered in order (`POST /api/sync/apply`). */
  applyBatch(actor: Actor | null, envelopes: readonly unknown[]): ApplyResult[] {
    return envelopes.map((e) => this.apply(actor, e));
  }

  private answer(actor: Actor | null, envelope: unknown): StoredAnswer {
    try {
      return this.applyEnvelope(actor, envelope);
    } catch {
      // a fault outside the mutator stages: the transaction it was in
      // committed nothing
      return fail(refuse("INTERNAL_SERVER_ERROR"));
    }
  }

  private applyEnvelope(actor: Actor | null, envelope: unknown): StoredAnswer {
    // bounds first: nothing below may walk an input deeper or larger than this
    const bounds = outOfBounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);
    if (bounds === "deep")
      return fail(
        refuse("BAD_REQUEST", undefined, [
          `envelope: expected input nested at most ${MAX_INPUT_DEPTH} deep`,
        ]),
      );
    if (
      bounds === "large" ||
      Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES
    )
      return fail(
        refuse("TOO_LARGE", undefined, [
          `envelope: expected at most ${MAX_ENVELOPE_BYTES} bytes as JSON`,
        ]),
      );
    const version =
      envelope !== null && typeof envelope === "object"
        ? (envelope as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    if (typeof version === "number" && Number.isInteger(version) && version < MIN_PROTOCOL_VERSION)
      return fail(
        refuse("UPGRADE_REQUIRED", undefined, [
          `protocolVersion: expected at least ${MIN_PROTOCOL_VERSION}`,
        ]),
      );
    const env = envelopeSchema.safeParse(envelope);
    if (!env.success)
      return fail(
        refuse("BAD_REQUEST", undefined, [
          "envelope: expected { clientId, seq, mutationId, replaces?, name, input, protocolVersion, clientTime, queuedAt }",
        ]),
      );
    const m = env.data;
    const u = this.userOf(actor);
    if (u === null) return fail(refuse("UNAUTHORIZED"));
    const now = this.begin();
    const store = this.store;
    const client = store.client(m.clientId);
    if (!client || client.u !== u || client.seen <= now - this.clientIdleTtl)
      return fail(refuse("WRONG_CLIENT"));
    return store.transaction(() => this.applyIn(u, m, client, now));
  }

  /** The envelope's answer, in the apply transaction. */
  private applyIn(
    u: string,
    m: z.infer<typeof envelopeSchema>,
    client: ClientRow,
    now: number,
  ): StoredAnswer {
    const store = this.store;
    store.putClient({ ...client, seen: now });
    const wellFormed = isUlid(m.mutationId);
    const payload = digest(canonical([m.name, m.input]));
    const found = wellFormed ? store.answer(u, m.mutationId) : undefined;
    const hit = found && found.at > now - DEDUP_TTL ? found : undefined;
    // a write this user's devices sent before, under any client id or seq,
    // or one a reminted envelope replaced: its recorded answer, and the seq
    // is not used (R7c)
    if (hit && (hit.digest === payload || hit.digest === REPLACED))
      return { ...structuredClone(hit.result), replay: true };
    // an answer recorded under this client's seq: the same envelope again
    const sent = digest(canonical([m.mutationId, m.name, m.input]));
    const kept = store.seqAnswer(m.clientId, m.seq);
    if (kept && kept.at > now - DEDUP_TTL && kept.digest === sent)
      return structuredClone(kept.result);
    // a reminted write whose earlier mutation id has an answer (the delayed
    // original was applied, or answered, after all): that answer, stored
    // under this mutation id too, and no seq used
    if (wellFormed && !hit)
      for (const id of m.replaces ?? []) {
        const prior = store.answer(u, id);
        if (!prior || prior.at <= now - DEDUP_TTL) continue;
        store.putAnswer({
          u,
          mutationId: m.mutationId,
          result: prior.result,
          digest: payload,
          at: now,
        });
        return { ...structuredClone(prior.result), replay: true };
      }
    if (m.seq !== client.last + 1)
      return {
        ok: false,
        error: {
          ...refuse("OUT_OF_ORDER", undefined, [`seq: expected ${client.last + 1}`]).toError(),
          expectedSeq: client.last + 1,
        },
      };
    if (!wellFormed || hit) {
      // uses the seq, so it is recorded with it, under (client, seq): a
      // malformed id never enters the (user, mutation id) table, and a used
      // one keeps its first answer there (R7b)
      const result = fail(
        refuse("BAD_REQUEST", undefined, [
          wellFormed
            ? "mutationId: already used for a different change"
            : "mutationId: expected a ULID",
        ]),
      );
      store.putSeqAnswer({ clientId: m.clientId, seq: m.seq, digest: sent, result, at: now });
      store.putClient({ ...client, last: m.seq, seen: now });
      return structuredClone(result);
    }
    const out = this.execute(u, m, now);
    if (out.recorded) {
      // one transaction: the record changes and notifications, the stored
      // answer (under the mutation id and each id it replaces) and the
      // client's seq
      if (out.staged) this.commit(out.staged, now);
      store.putAnswer({
        u,
        mutationId: m.mutationId,
        result: out.result,
        digest: payload,
        at: now,
      });
      for (const id of new Set(m.replaces ?? [])) {
        const old = store.answer(u, id);
        if (id !== m.mutationId && !(old && old.at > now - DEDUP_TTL))
          store.putAnswer({ u, mutationId: id, result: out.result, digest: REPLACED, at: now });
      }
      store.putClient({ ...client, last: m.seq, seen: now });
    }
    return structuredClone(out.result);
  }

  private execute(u: string, m: z.infer<typeof envelopeSchema>, now: number): Outcome {
    const final = (e: Refusal): Outcome => ({ result: fail(e), recorded: !UNRECORDED.has(e.code) });
    // the device's clock against the server's: the client corrects it from
    // `serverTime` and sends the write again
    if (Math.abs(m.clientTime - now) > CLOCK_MAX_SKEW)
      return {
        result: {
          ok: false,
          error: {
            code: "CLOCK_SKEW",
            message: refuse("CLOCK_SKEW").message,
            issues: ["clientTime: expected the server's time to within a minute"],
            serverTime: now,
          },
        },
        recorded: false,
      };
    // the write's age, on the device's own clock: recorded, so a resend of
    // the same write gets it again
    const expired = (path: string) =>
      final(
        refuse("EXPIRED", undefined, [
          `${path}: expected a ULID from the 4 days before clientTime to 1 minute after`,
        ]),
      );
    if (!ageOk(m.mutationId, m.clientTime)) return expired("mutationId");
    if (!timeOk(m.queuedAt, m.clientTime)) return expired("queuedAt");
    const def = Object.hasOwn(this.mutators, m.name) ? this.mutators[m.name] : undefined;
    if (!def)
      return final(refuse("NOT_FOUND", "The server has no procedure with this name.", ["name"]));
    const parsed = def.input.safeParse(m.input);
    if (!parsed.success)
      return final(
        refuse(
          "BAD_REQUEST",
          undefined,
          parsed.error.issues.map(
            (x) => `input${x.path.map((p) => `.${String(p)}`).join("")}: ${x.code}`,
          ),
        ),
      );
    const input = parsed.data;
    try {
      for (const id of def.ids?.(input) ?? [])
        if (!ageOk(id, m.clientTime)) return expired("input.id");
      // an online-only write whose mutation id is over a minute old on the
      // device's clock waited in an outbox
      if (def.online && m.clientTime - ulidTime(m.mutationId) > ONLINE_MAX_AGE)
        return final(
          refuse("EXPIRED", undefined, [
            "mutationId: expected a ULID from the minute before clientTime (online only)",
          ]),
        );
      const tx = new StagedTx(this.store, u, msToIso(now), m.mutationId, "server");
      authorize(tx, def, input);
      const pre: PreCtx = {
        me: u,
        now,
        random: this.random,
        inviteCodeTaken: (code) => this.store.uniqueKey("invite.code", code) !== undefined,
        queuedRuns: () =>
          [...this.store.keysIn("run", { u })].filter(
            (k) => (this.store.byKey(k) as RunRec).status === "queued",
          ).length,
      };
      const limits = this.preLimits;
      if (limits) pre.allow = (limit) => limits.take(u, limit);
      const values = def.pre?.(pre, input) ?? {};
      const ran = def.run(tx, input, values);
      const told = def.notify?.(tx, input, ran, { isAccount: (h) => this.store.isAccount(h) });
      const result = told === undefined ? ran : told;
      return { result: { ok: true, result }, recorded: true, staged: tx.staged };
    } catch (e) {
      if (e instanceof Refusal) return final(e);
      // not a refusal: a fault of the server, not of the input. Nothing is
      // written or recorded; the client sends the write again later (R8).
      return final(refuse("INTERNAL_SERVER_ERROR"));
    }
  }

  // ---- server-originated writes (Y13) ----

  /** Run `fn` over a server transaction and commit what it staged (record
   * rows, log rows, registry and tombstones) in one transaction, with no
   * answer and no seq: a run's turns and finish, the account-invite
   * procedures. `me` is the person the writes are made for (ids derive from
   * it and `mutationId`, a new ULID by default). A refusal or any other
   * exception from `fn` commits nothing. Called inside a caller's own
   * `store.transaction`, its table writes and the records commit together. */
  serverApply<T>(
    spec: { me: string; mutationId?: string },
    fn: (tx: Tx) => T,
  ): ServerApplyResult<T> {
    const now = this.now();
    try {
      const mutationId = spec.mutationId ?? ulid(now, this.random);
      return this.store.transaction(() => {
        const tx = new StagedTx(this.store, spec.me, msToIso(now), mutationId, "server");
        const result = fn(tx);
        const version = this.commit(tx.staged, now);
        return { ok: true as const, result, version };
      });
    } catch (e) {
      return {
        ok: false,
        error: (e instanceof Refusal ? e : refuse("INTERNAL_SERVER_ERROR")).toError(),
      };
    }
  }

  // ---- reads ----
  //
  // A cursor is a sealed token naming the log, the reader, the log's history,
  // the version, the server's head and when it was served. Every read serves
  // a new token; a pull with no change the reader may read keeps the version
  // and renews the serve time, so a snapshot and pulls on a quiet server
  // never loop on resync.

  /** A user log is read by its user only; anyone else, and a signed-out
   * caller, gets nothing from it. */
  private closedTo(log: LogId, u: string | null) {
    return log.startsWith("user:") && (u === null || log !== `user:${u}`);
  }

  private lastSeq(u: string | null, clientId: string | undefined, now: number): LastSeq {
    if (u === null || clientId === undefined) return null;
    const c = this.store.client(clientId);
    if (!c || c.u !== u || c.seen <= now - this.clientIdleTtl) return null;
    this.store.putClient({ ...c, seen: now });
    return c.last;
  }

  /** A row as `u` may read it now: the record's view for a `put`, true for a
   * `del` whose tombstone `u` may read, or null. */
  private readRow(row: LogRow, u: string | null): StoredRecord | true | null {
    if (row.op === "put") {
      const rec = this.store.byKey(row.key);
      return rec ? view(this.store, rec, u) : null;
    }
    const t = this.store.tombstone(row.key);
    return t && readsAudience(this.store, t, u) ? true : null;
  }

  /** A token for `u` at `version` of `log`'s current history, served now. */
  private serve(log: LogId, u: string | null, version: number, now: number): Cursor {
    return this.tokens.seal({
      log,
      u,
      n: this.store.epoch(log).n,
      v: version,
      h: this.store.head(),
      at: now,
    });
  }

  /** Throws a `Refusal` (BAD_REQUEST, nothing recorded) for a tier or a
   * list of threads the protocol does not have: the route answers 400. */
  snapshot(actor: Actor | null, log: LogId, options: ReadOptions = {}): Snapshot {
    // a tier or a list of threads the protocol does not have is refused
    // (BAD_REQUEST, nothing recorded; the route answers 400)
    const tier = options.tier ?? "full";
    if (!TIERS.has(tier))
      throw refuse("BAD_REQUEST", undefined, ["tier: expected full, summary, window or threads"]);
    const opened = threadsS.safeParse(options.threads ?? []);
    if (!opened.success)
      throw refuse("BAD_REQUEST", undefined, [
        `threads: expected at most ${MAX_OPENED_THREADS} thread ids`,
      ]);
    if (tier === "threads" && opened.data.length === 0)
      throw refuse("BAD_REQUEST", undefined, ["threads: expected a thread id"]);
    const threads = opened.data;
    const now = this.begin();
    const u = this.userOf(actor);
    const lastSeq = this.lastSeq(u, options.clientId, now);
    // a log id that cannot name a log: no token, so a pull resyncs
    if (!logS.safeParse(log).success) return { records: [], cursor: "", lastSeq, serverTime: now };
    if (this.closedTo(log, u))
      return { records: [], cursor: this.serve(log, u, 0, now), lastSeq, serverTime: now };
    // which threads are served in full, and which as summaries; null: all
    let tiers: { full: Set<string>; summary: Set<string> | null } | null = null;
    if (tier === "window" && log.startsWith("space:"))
      tiers = windowOf(this.store, log.slice(6), u, threads, now, this.window);
    else if (tier === "threads") tiers = { full: new Set(threads), summary: new Set() };
    else if (tier === "summary") tiers = { full: new Set(), summary: null };
    const records: Snapshot["records"] = [];
    let version = 0;
    for (const row of this.store.logRows(log, 0)) {
      const v = this.readRow(row, u);
      if (v === null) continue;
      // the newest row the reader may read, a `del` or a row the tier leaves
      // out included
      version = Math.max(version, row.version);
      if (v === true) continue;
      if (tiers) {
        const th = threadOf(v);
        if (th !== null) {
          const isThread = v.kind === "thread" || v.kind === "counts";
          const full = tiers.full.has(th);
          const summary = tiers.summary === null || tiers.summary.has(th);
          if (!full && !(isThread && summary)) continue;
        } else if (tier === "threads") continue;
      }
      records.push({ key: row.key, record: structuredClone(v) });
    }
    // the server's creation time orders a list, then the version of the
    // commit that created the record; never the id a client chose (R13)
    const born = (key: string) => this.store.createdVersion(key) ?? 0;
    records.sort((a, b) => {
      const x = createdOf(a.record);
      const y = createdOf(b.record);
      return x < y ? -1 : x > y ? 1 : born(a.key) - born(b.key);
    });
    const out: Snapshot = {
      records,
      cursor: this.serve(log, u, version, now),
      lastSeq,
      serverTime: now,
    };
    if (tiers)
      out.full = records.flatMap((x) =>
        x.record.kind === "thread" && tiers.full.has(x.record.id) ? [x.record.id] : [],
      );
    return out;
  }

  pull(actor: Actor | null, log: LogId, cursor: Cursor, options: ReadOptions = {}): Pull {
    const now = this.begin();
    const u = this.userOf(actor);
    if (!logS.safeParse(log).success) return { resync: true };
    // The token's age is the time the server served it: a reader who was
    // served it within 30 days missed no `del`. A token the server did not
    // seal for this reader, this log and this history of the log resyncs.
    const c = this.tokens.open(cursor, now);
    if (
      c === null ||
      c.log !== log ||
      c.u !== u ||
      c.n !== this.store.epoch(log).n ||
      c.at < now - TOMBSTONE_TTL
    )
      return { resync: true };
    const lastSeq = this.lastSeq(u, options.clientId, now);
    // another person's user log: nothing
    if (this.closedTo(log, u))
      return { changes: [], cursor: this.serve(log, u, 0, now), lastSeq, serverTime: now };
    if (u !== null && this.scopeChanged(log, u, c.v, c.h)) return { resync: true };
    const changes: Change[] = [];
    let to = c.v;
    const fresh = this.store.logRows(log, c.v).sort((a, b) => a.version - b.version);
    for (const row of fresh) {
      const v = this.readRow(row, u);
      if (v === null) continue;
      to = row.version;
      changes.push(
        v === true
          ? { key: row.key, op: "del" }
          : { key: row.key, op: "put", record: structuredClone(v) },
      );
    }
    return { changes, cursor: this.serve(log, u, to, now), lastSeq, serverTime: now };
  }

  /** Whether what `u` may read of `log` changed, after the token at
   * `version` was served (when the server's head was `head`), in a way the
   * log's rows do not carry: `u`'s own membership in the space; for `u`'s
   * user log, `u`'s membership in any space, or the history of a space log
   * that a record in the log is about being replaced. */
  private scopeChanged(log: LogId, u: string, version: number, head: number): boolean {
    const store = this.store;
    if (log.startsWith("space:")) {
      const mine = store.logRow(log, memberKey(log.slice(6), u));
      return mine !== undefined && mine.version > version;
    }
    for (const row of store.logRows(log, 0)) {
      if (row.key.startsWith("member:") && row.version > version) return true;
      const rec = store.byKey(row.key);
      const a = rec ? audience(store, rec) : store.tombstone(row.key);
      if (a && a.sp !== null && store.epoch(`space:${a.sp}`).start > head) return true;
    }
    return false;
  }

  /** Replace a log's history, as a restore from a backup does (`01` D6): a
   * new history that begins at a new version, so every cursor of the log
   * resyncs. */
  replaceHistory(log: LogId): void {
    const now = this.begin();
    void now;
    this.store.transaction(() => {
      const version = this.store.nextVersion();
      this.store.setEpoch(log, { n: this.store.epoch(log).n + 1, start: version });
    });
  }
}
