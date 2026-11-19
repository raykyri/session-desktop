// The prototype server half: a multi-user in-memory store with one change-log
// table, `register` and `apply` (in order per client, idempotent by user and
// mutation id), `snapshot` and `pull` filtered by the reader's scope at the
// time of the read, and a worker that runs post-commit effects.
//
// Apply, in order. "Unrecorded" answers use up nothing: the client may send
// the same `seq` again. Everything below runs inside one error handler: an
// exception anywhere is INTERNAL_SERVER_ERROR, unrecorded.
//   the envelope is at most 256 KB as JSON (TOO_LARGE), and nests at most
//     33 deep, its input at most 32 (BAD_REQUEST): unrecorded, checked before
//     anything hashes or parses the input
//   protocol version (UPDATE_REQUIRED) and envelope shape (BAD_REQUEST): unrecorded
//   signed in with a valid handle (UNAUTHORIZED): unrecorded
//   the client id is the caller's and has not expired (WRONG_CLIENT): unrecorded
//   a stored result for (user, mutation id) whose payload digest matches:
//     returned as it is, under any client id or seq; nothing runs and no seq
//     is used
//   a result stored for (client, seq) with the same mutation id and payload:
//     returned as it is
//   `seq` is the client's next one (OUT_OF_ORDER, with `expectedSeq`): unrecorded
//   the mutation id is a ULID, and not one the user sent with another
//     payload (BAD_REQUEST): uses up the `seq`, stored for (client, seq), so
//     a malformed or reused id never enters the (user, mutation id) table
//   `clientTime` is within a minute of the server's time (CLOCK_SKEW, with
//     the server's time): unrecorded
//   the mutation id's age on the device's clock (`clientTime`) is at most 4
//     days and at least −1 minute (EXPIRED)
//   the mutator name and its strict input schema
//   the input's new ids pass the same age check (EXPIRED)
//   an online-only mutator's mutation id is at most a minute old on the
//     device's clock (EXPIRED)
//   ban, who and can, pre (server values), run
// A refusal from these stages is recorded unless its code is in UNRECORDED;
// an exception that is not a refusal is INTERNAL_SERVER_ERROR, unrecorded,
// and nothing it staged is written. A recorded result is committed in one
// step with the write's changes and its post-commit effects (queued): stored
// for 7 days with a digest of the name and input, and the client's last
// processed `seq` becomes this one. The effect worker (`work`) runs the
// queued effects later, with backoff, and moves an effect that failed 10
// times to the dead letters. No request handler runs effects.
//
// Change log: one row per (log, key), holding key, op and version only; a
// write replaces the key's row. Versions come from one sequence for the whole
// server and never leave it: a cursor is a sealed token (see `Cursor`). A
// pull reads each changed record as it is now. A deleted record leaves a
// tombstone for 30 days: its key, kind and audience, no text, used only to
// decide who gets the `del`. The registry keeps every id and key ever
// written with its last rev, so an id is never used again and a record
// written again at a deleted key continues from its last rev.
//
// Resync: a pull answers `{ resync: true }` when the token was not sealed by
// this server for this reader and log, or was served more than 30 days ago,
// or the log's history was replaced since (a space's visibility changed), or
// the reader's scope changed since: their own membership or role in the
// space, and for their user log, their membership or role in any space or a
// space opening or closing that a record in the log is about.
//
// Expiry: every table that expires is a Map kept in expiry order (a value
// written again moves to the end), so each call drops only what expired from
// its front and stops at the first value that has not.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import * as pkg from "@session/mutators";
import { z } from "zod";

import {
  MIN_PROTOCOL_VERSION,
  UNRECORDED,
  type Actor,
  type ApplyResult,
  type Change,
  type Cursor,
  type LastSeq,
  type LogRow,
  type Pull,
  type ReadOptions,
  type RegisterResult,
  type ServerOptions,
  type Snapshot,
  type StorageScan,
  type TestServer,
} from "./contract.js";
import {
  Refusal,
  authorize,
  isHandle,
  refuse,
  type AnyMutator,
  type Effect,
  type NotifDraft,
  type PreCtx,
  type Tx,
} from "./mutators.js";
import {
  memberKey,
  type Draft,
  type LogId,
  type Kind,
  type RecordOf,
  type StoredRecord,
} from "./records.js";
import {
  ACTIVE_MUTATORS,
  USE_PACKAGE,
  applyPackage,
  audience,
  audienceOf,
  createdOf,
  idOf,
  inSpaceLog,
  isClosed,
  keyOf,
  logsOf,
  readsAudience,
  registryKey,
  spaceRec,
  view,
  viewDependents,
  type Audience,
} from "./switch.js";
import {
  CLOCK_MAX_SKEW,
  DAY,
  MINUTE,
  ageOk,
  cryptoRandom,
  deriveId,
  digest,
  isUlid,
  ulid,
  ulidTime,
} from "./ulid.js";

export const DEDUP_TTL = 7 * DAY;
export const TOMBSTONE_TTL = 30 * DAY;
/** The most an online-only write's mutation id may be behind `clientTime`:
 * older, it waited in an outbox. */
export const ONLINE_MAX_AGE = MINUTE;
/** A client record not used for this long expires; its client id then
 * answers WRONG_CLIENT, and the client registers again. */
export const CLIENT_IDLE_TTL = 90 * DAY;
/** The most clients one person may register in a day. */
export const REGISTRATIONS_PER_DAY = 20;
/** The deepest an envelope's input may nest, and the largest an envelope may
 * be as JSON. */
export const MAX_INPUT_DEPTH = 32;
export const MAX_ENVELOPE_BYTES = 256 * 1024;
/** The effect worker tries an effect this many times, then moves it to the
 * dead letters. Between attempts it waits 1 s, 2 s, 4 s, … up to 10 minutes. */
export const EFFECT_MAX_ATTEMPTS = 10;
export const EFFECT_BACKOFF_MIN = 1000;
export const EFFECT_BACKOFF_MAX = 10 * MINUTE;

const envelopeS = z.strictObject({
  clientId: z.string(),
  seq: z.number().int().positive(),
  mutationId: z.string(),
  name: z.string(),
  input: z.unknown(),
  protocolVersion: z.number().int(),
  clientTime: z.number().int().nonnegative(),
});
type Env = z.infer<typeof envelopeS>;
const logS = z
  .string()
  .max(200)
  .regex(/^(space|user):[^:]+$/);

const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const fail = (e: Refusal): ApplyResult => ({ ok: false, error: e.toError() });
const same = (a: StoredRecord, b: StoredRecord) =>
  JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });

/** JSON with object keys sorted, so equal values print equally. Called only
 * on a value `withinBounds` passed. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

/** Whether `v` nests at most `maxDepth` levels (a scalar is 0 deep, `[1]`
 * 1) and is at most `maxNodes` bytes as JSON, as far as a walk can tell
 * (a byte per value, and each string's length): "ok", or the bound it
 * passes, size first. Walked with a stack, not by recursion, so a deep value cannot
 * overflow the call stack. */
function withinBounds(v: unknown, maxDepth: number, maxNodes: number): "ok" | "deep" | "large" {
  const stack: [unknown, number][] = [[v, 0]];
  // a lower bound of the value's size as JSON: a byte per value, and each
  // string's length and quotes
  let bytes = 0;
  let deep = false;
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [x, level] = top;
    bytes += typeof x === "string" ? x.length + 2 : 1;
    if (bytes > maxNodes) return "large";
    if (x === null || typeof x !== "object") continue;
    // past the depth bound the walk goes on, for the size: size decides first
    if (level >= maxDepth) deep = true;
    for (const y of Object.values(x)) stack.push([y, level + 1]);
  }
  return deep ? "deep" : "ok";
}

/** The id-collision answer: one message, whether or not the caller may read
 * the record that holds the id. */
const ID_TAKEN = "An item with this id exists.";

/** What a deleted record leaves for 30 days: its key, kind and audience (the
 * fields that decide who gets the `del`). No text and no other field (review
 * round 1, R5); its last rev is in the registry. A record's moderation state
 * does not change who reads it, so it is not kept. */
export interface Tombstone extends Audience {
  key: string;
  /** The commit time of the delete. */
  at: number;
}

/** The logs a record with this audience is written to: its space's log
 * (none for likes, saves and notifications, which live in user logs only)
 * and its person's user log. */
function logsOfAudience(a: Audience): LogId[] {
  const out: LogId[] = [];
  if (a.sp !== null && inSpaceLog(a.kind)) out.push(`space:${a.sp}`);
  if (a.person !== null) out.push(`user:${a.person}`);
  return out;
}

/** Set `key` in an expiry-ordered map: as the newest value. */
function setLast<K, V>(m: Map<K, V>, key: K, value: V) {
  m.delete(key);
  m.set(key, value);
}

class Store {
  readonly records = new Map<string, StoredRecord>();
  readonly byKind = new Map<Kind, Set<string>>();
  /** In the order they were made, so oldest first. */
  readonly tombs = new Map<string, Tombstone>();
  /** The version of the commit that created each record now stored: lists
   * sort by `createdAt`, then by it. */
  readonly born = new Map<string, number>();
  /** Every id and key ever written (`registryKey`), with its last rev. An id
   * is never used again; a record written again at a deleted key continues
   * from its last rev (review round 2, R1). */
  readonly registry = new Map<string, number>();
  readonly logs = new Map<LogId, Map<string, LogRow>>();
  /** For a log whose history was replaced: how many times, and the version
   * its current history began at. Absent: never, from version 0. */
  readonly epochs = new Map<LogId, { n: number; start: number }>();
  head = 0;
  /** The server's time: never decreasing, so every table's expiry order is
   * the order of its times, and the tombstone cutoff and a cursor's age
   * compare the same order. */
  private lastAt: number;

  constructor(now: number) {
    this.lastAt = now;
  }

  /** The server's time now: the clock, never earlier than a time used before. */
  time(clock: number): number {
    return (this.lastAt = Math.max(clock, this.lastAt));
  }

  get(key: string) {
    return this.records.get(key);
  }

  keysOf(kind: Kind): Iterable<string> {
    return this.byKind.get(kind) ?? [];
  }

  /** A log's history: how many times it was replaced, and the version the
   * current one began at. */
  epoch(log: LogId): { n: number; start: number } {
    return this.epochs.get(log) ?? { n: 0, start: 0 };
  }

  private row(log: LogId, key: string, op: "put" | "del", version: number) {
    let rows = this.logs.get(log);
    if (!rows) this.logs.set(log, (rows = new Map<string, LogRow>()));
    rows.delete(key);
    rows.set(key, { key, op, version });
  }

  /** Write staged records under one new version. Returns the version, or null
   * when nothing changed. */
  commit(staged: Map<string, StoredRecord | null>, now: number): number | null {
    const writes: [string, StoredRecord | null, StoredRecord | undefined][] = [];
    for (const [key, next] of staged) {
      const prev = this.records.get(key);
      if (next === null ? !prev : prev && same(prev, next)) continue;
      writes.push([key, next, prev]);
    }
    if (!writes.length) return null;
    const version = ++this.head;
    const at = this.time(now);
    for (const [key, next, prev] of writes) {
      if (next === null) {
        const old = prev as StoredRecord;
        const tomb: Tombstone = { key, ...audience(this, old), at };
        this.records.delete(key);
        this.byKind.get(old.kind)?.delete(key);
        this.born.delete(key);
        setLast(this.tombs, key, tomb);
        for (const log of logsOfAudience(tomb)) this.row(log, key, "del", version);
        this.touchDependents(old, version);
        continue;
      }
      const reg = registryKey(next);
      const rev = (prev?.rev ?? this.registry.get(reg) ?? 0) + 1;
      const rec = { ...next, rev };
      this.records.set(key, rec);
      this.registry.set(reg, rev);
      if (!prev) this.born.set(key, version);
      let kind = this.byKind.get(rec.kind);
      if (!kind) this.byKind.set(rec.kind, (kind = new Set<string>()));
      kind.add(key);
      this.tombs.delete(key);
      for (const log of logsOf(rec)) this.row(log, key, "put", version);
      this.touchDependents(rec, version);
      // who may read a space's records depends on whether it is closed: a
      // change replaces the log's history (every cursor resyncs)
      if (rec.kind === "space" && prev?.kind === "space" && isClosed(prev) !== isClosed(rec)) {
        const log: LogId = `space:${rec.id}`;
        this.epochs.set(log, { n: (this.epochs.get(log)?.n ?? 0) + 1, start: version });
      }
    }
    return version;
  }

  /** A record whose view depends on `r` (a hide record's item) is served
   * again: a `put` row for it at this version in each of its logs. */
  private touchDependents(r: StoredRecord, version: number) {
    for (const key of viewDependents(r)) {
      const dep = this.records.get(key);
      if (dep) for (const log of logsOf(dep)) this.row(log, key, "put", version);
    }
  }

  /** Drop the tombstones (and their `del` rows) committed strictly before the
   * cutoff, oldest first. A cursor served at the cutoff itself is still
   * accepted (`pull`), so a delete committed in the same millisecond is kept. */
  prune(now: number) {
    const cutoff = now - TOMBSTONE_TTL;
    for (const [key, t] of this.tombs) {
      if (t.at >= cutoff) break;
      this.tombs.delete(key);
      for (const log of logsOfAudience(t)) {
        const rows = this.logs.get(log);
        if (rows?.get(key)?.op === "del") rows.delete(key);
      }
    }
  }
}

class StagedTx implements Tx {
  readonly staged = new Map<string, StoredRecord | null>();
  private readonly newIds = new Set<string>();

  constructor(
    private readonly store: Store,
    readonly me: string,
    readonly now: string,
    private readonly mutationId: string,
  ) {}

  get(key: string): StoredRecord | undefined {
    if (this.staged.has(key)) return this.staged.get(key) ?? undefined;
    return this.store.get(key);
  }

  find<K extends Kind>(kind: K, pred?: (r: RecordOf<K>) => boolean): RecordOf<K>[] {
    const keys = new Set(this.store.keysOf(kind));
    for (const [key, r] of this.staged) if (r?.kind === kind) keys.add(key);
    const out: RecordOf<K>[] = [];
    for (const key of [...keys].sort()) {
      const r = this.get(key);
      if (r?.kind === kind && (!pred || pred(r as RecordOf<K>))) out.push(r as RecordOf<K>);
    }
    return out;
  }

  create(r: Draft): void {
    const key = keyOf(r);
    const id = idOf(r);
    if (this.get(key) || (id !== null && (this.store.registry.has(id) || this.newIds.has(id))))
      throw refuse("CONFLICT", ID_TAKEN);
    this.write(key, r);
    if (id !== null) this.newIds.add(id);
  }

  put(r: Draft): void {
    const key = keyOf(r);
    const prev = this.get(key);
    if (!prev && idOf(r) !== null) return this.create(r);
    if (prev && audienceOf(prev) !== audienceOf(r))
      throw new Error(`a write changed the audience of ${key}`);
    this.write(key, r);
  }

  del(key: string): void {
    if (this.get(key)) this.staged.set(key, null);
  }

  id(ordinal: number): string {
    return deriveId(this.me, this.mutationId, ordinal);
  }

  private write(key: string, r: Draft) {
    this.staged.set(key, { ...r, rev: 0 });
  }
}

/** `@session/mutators`' reads over the store (with the switch on). */
class StoreSource implements pkg.RecordSource {
  constructor(private readonly store: Store) {}

  get(kind: pkg.Kind, id: string): pkg.StoredRecord | undefined {
    return this.store.get(`${kind}:${id}`) as pkg.StoredRecord | undefined;
  }

  scan(index: pkg.IndexName, value: string): pkg.StoredRecord[] {
    const [kind, field] = pkg.INDEXES[index];
    const out: pkg.StoredRecord[] = [];
    for (const key of this.store.keysOf(kind as Kind)) {
      const r = this.store.get(key) as unknown as Record<string, unknown> | undefined;
      if (r && r[field] === value) out.push(r as unknown as pkg.StoredRecord);
    }
    return out;
  }

  idUsed(id: string): boolean {
    return this.store.registry.has(id);
  }
}

/** The fields of a notification the prototype's records do not have, as the
 * package's notifications hold them. */
const NOTIF_REST = USE_PACKAGE
  ? { outcome: null, response: null, actor: null, thread: null, node: null }
  : {};

/** What `execute` decided: the answer, whether it is recorded, and for an
 * applied write the staged changes and the effects to queue. */
interface Outcome {
  result: ApplyResult;
  recorded: boolean;
  staged?: Map<string, StoredRecord | null>;
  effects?: AnyEffect[];
}

/** The prototype's effects, and with the switch on the package's. */
type AnyEffect = Effect | pkg.Effect;

/** A registered client: the user it is bound to, its last processed seq and
 * when it was last used (by a write or a read with its client id). */
interface ClientRec {
  u: string;
  last: number;
  seen: number;
}

/** An answer recorded under (client, seq): for a mutation id that is
 * malformed or already used for another change. */
interface SeqAnswer {
  clientId: string;
  seq: number;
  digest: string;
  result: ApplyResult;
  at: number;
}

/** One entry of the effect queue: kept until the effect has run or failed
 * `EFFECT_MAX_ATTEMPTS` times. */
interface QueuedEffect {
  effect: AnyEffect;
  /** The commit time of the write that queued it. */
  at: number;
  attempts: number;
  /** The time of the next attempt. */
  next: number;
}

/** What a cursor token holds. `v`: the version of the newest row of the log
 * the reader was given (a `put` or a `del` it may read), or 0. `h`: the
 * server's head when it was served. `n`: the log's history. `at`: when it
 * was served. */
interface CursorState {
  log: string;
  u: string | null;
  n: number;
  v: number;
  h: number;
  at: number;
}

const TOKEN_FORMAT = 1;
const TOKEN_HEAD = 29;
const TOKEN_IV = 12;
const TOKEN_TAG = 16;
const TOKEN_MAX_LENGTH = 1024;

/** Cursor tokens: AES-256-GCM under a key from `crypto.randomBytes`, a new
 * random IV for each. The plaintext is a fixed 29-byte head (format, history,
 * version, head, serve time) and the JSON of [log, reader], so a token's
 * length depends only on the lengths of the log id and the handle. The tag
 * authenticates every field; a token from another key, or with any byte
 * changed, does not open. */
class Tokens {
  private readonly key = randomBytes(32);

  seal(c: CursorState): Cursor {
    const head = Buffer.alloc(TOKEN_HEAD);
    head.writeUInt8(TOKEN_FORMAT, 0);
    head.writeUInt32BE(c.n, 1);
    head.writeDoubleBE(c.v, 5);
    head.writeDoubleBE(c.h, 13);
    head.writeDoubleBE(c.at, 21);
    const plain = Buffer.concat([head, Buffer.from(JSON.stringify([c.log, c.u]), "utf8")]);
    const iv = randomBytes(TOKEN_IV);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  }

  open(token: unknown): CursorState | null {
    if (typeof token !== "string" || token.length > TOKEN_MAX_LENGTH) return null;
    const raw = Buffer.from(token, "base64url");
    if (raw.length < TOKEN_IV + TOKEN_HEAD + TOKEN_TAG) return null;
    let plain: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, TOKEN_IV));
      decipher.setAuthTag(raw.subarray(raw.length - TOKEN_TAG));
      plain = Buffer.concat([
        decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG)),
        decipher.final(),
      ]);
    } catch {
      return null;
    }
    if (plain.readUInt8(0) !== TOKEN_FORMAT) return null;
    const [log, u] = JSON.parse(plain.subarray(TOKEN_HEAD).toString("utf8")) as [
      string,
      string | null,
    ];
    return {
      log,
      u,
      n: plain.readUInt32BE(1),
      v: plain.readDoubleBE(5),
      h: plain.readDoubleBE(13),
      at: plain.readDoubleBE(21),
    };
  }
}

export class ProtoServer implements TestServer {
  private readonly store: Store;
  /** Answers by (user, mutation id), oldest first. */
  private readonly dedup = new Map<string, { result: ApplyResult; digest: string; at: number }>();
  /** Answers by (client, seq), oldest first. */
  private readonly seqAnswers = new Map<string, SeqAnswer>();
  /** Registered clients, least recently used first. */
  private readonly clients = new Map<string, ClientRec>();
  /** Each person's registrations in the past day, by the time of their
   * latest, oldest first. */
  private readonly registrations = new Map<string, number[]>();
  /** The post-commit effects not yet run, in commit order: written in the
   * same step as the write that queued them (durable with it), and removed
   * once they ran or failed for good. */
  private readonly effectQueue: QueuedEffect[] = [];
  private readonly deadLetters: (QueuedEffect & { failedAt: number })[] = [];
  private readonly jobList: { kind: string; id: string }[] = [];
  private readonly clock: ServerOptions["clock"];
  private readonly random: () => number;
  private readonly mutators: Readonly<Record<string, AnyMutator>>;
  private readonly failEffect: ServerOptions["failEffect"];
  private readonly tokens = new Tokens();

  constructor(options: ServerOptions) {
    this.clock = options.clock;
    this.random = options.random ?? cryptoRandom;
    this.mutators = options.mutators ?? ACTIVE_MUTATORS;
    this.failEffect = options.failEffect;
    this.store = new Store(this.clock.now());
  }

  /** The caller's handle, or null for a signed-out caller and for a handle no
   * person may have. */
  private userOf(actor: Actor | null): string | null {
    return actor !== null && typeof actor.u === "string" && isHandle(actor.u) ? actor.u : null;
  }

  /** The server's time for this call, after expiring what is past its lifetime. */
  private begin(): number {
    const now = this.store.time(this.clock.now());
    this.housekeep(now);
    return now;
  }

  // ---- writes ----

  register(actor: Actor | null): RegisterResult {
    try {
      const now = this.begin();
      const u = this.userOf(actor);
      if (u === null) return { ok: false, error: refuse("UNAUTHORIZED").toError() };
      const times = (this.registrations.get(u) ?? []).filter((at) => at > now - DAY);
      if (times.length >= REGISTRATIONS_PER_DAY)
        return { ok: false, error: refuse("TOO_MANY_REQUESTS").toError() };
      let id: string;
      do id = ulid(now, this.random);
      while (this.clients.has(id));
      setLast(this.registrations, u, [...times, now]);
      this.clients.set(id, { u, last: 0, seen: now });
      return { ok: true, clientId: id };
    } catch {
      // the random source failed: nothing was registered
      return { ok: false, error: refuse("INTERNAL_SERVER_ERROR").toError() };
    }
  }

  apply(actor: Actor | null, envelope: unknown): ApplyResult {
    try {
      return this.applyEnvelope(actor, envelope);
    } catch {
      // a fault outside the mutator stages: nothing was committed before the
      // fault, or the commit and its stored answer were (and a resend gets
      // that answer)
      return fail(refuse("INTERNAL_SERVER_ERROR"));
    }
  }

  private applyEnvelope(actor: Actor | null, envelope: unknown): ApplyResult {
    // bounds first: nothing below may walk an input deeper or larger than
    // this. Size first (AGENTS.md: an oversized envelope answers TOO_LARGE,
    // unrecorded); a walk that stops past the value count is oversized too
    // (each value is at least a byte of JSON), and a deeper one malformed.
    const bounds = withinBounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);
    const tooLarge = () =>
      fail(
        refuse("TOO_LARGE", undefined, [
          `envelope: expected at most ${MAX_ENVELOPE_BYTES} bytes as JSON`,
        ]),
      );
    if (bounds === "large") return tooLarge();
    if (bounds === "deep")
      return fail(
        refuse("BAD_REQUEST", undefined, [
          `envelope: expected input nested at most ${MAX_INPUT_DEPTH} deep`,
        ]),
      );
    if (Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES) return tooLarge();
    const version =
      envelope !== null && typeof envelope === "object"
        ? (envelope as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    if (typeof version === "number" && Number.isInteger(version) && version < MIN_PROTOCOL_VERSION)
      return fail(
        refuse("UPDATE_REQUIRED", undefined, [
          `protocolVersion: expected at least ${MIN_PROTOCOL_VERSION}`,
        ]),
      );
    const env = envelopeS.safeParse(envelope);
    if (!env.success)
      return fail(
        refuse("BAD_REQUEST", undefined, [
          "envelope: expected { clientId, seq, mutationId, name, input, protocolVersion, clientTime }",
        ]),
      );
    const m = env.data;
    const u = this.userOf(actor);
    if (u === null) return fail(refuse("UNAUTHORIZED"));
    const now = this.begin();
    const client = this.clients.get(m.clientId);
    if (!client || client.u !== u) return fail(refuse("WRONG_CLIENT"));
    this.touch(m.clientId, client, now);
    const wellFormed = isUlid(m.mutationId);
    const dk = `${u}\u0000${m.mutationId}`;
    const payload = digest(canonical([m.name, m.input]));
    const hit = wellFormed ? this.dedup.get(dk) : undefined;
    // a write this user's devices sent before, under any client id or seq:
    // its recorded answer, and the seq is not used (R7c)
    if (hit && hit.digest === payload) return structuredClone(hit.result);
    // an answer recorded under this client's seq: the same envelope again
    const sk = `${m.clientId}\u0000${m.seq}`;
    const sent = digest(canonical([m.mutationId, m.name, m.input]));
    const kept = this.seqAnswers.get(sk);
    if (kept && kept.digest === sent) return structuredClone(kept.result);
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
      setLast(this.seqAnswers, sk, {
        clientId: m.clientId,
        seq: m.seq,
        digest: sent,
        result,
        at: now,
      });
      client.last = m.seq;
      return structuredClone(result);
    }
    const out = this.execute(u, m, now);
    if (out.recorded) {
      // one step, with nothing in it that can fail: the record changes, the
      // queued effects, the stored answer and the client's seq (R9). On the
      // real server, one transaction.
      if (out.staged) this.store.commit(out.staged, now);
      for (const effect of out.effects ?? [])
        this.effectQueue.push({ effect, at: now, attempts: 0, next: now });
      setLast(this.dedup, dk, { result: out.result, digest: payload, at: now });
      client.last = m.seq;
    }
    return structuredClone(out.result);
  }

  private execute(u: string, m: Env, now: number): Outcome {
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
    // the write's age, on the device's own clock: older than the outbox
    // keeps a write (with a margin), or made after `clientTime` (the device's
    // clock went back). Either way it is not applied, and the answer is
    // recorded, so a resend of the same write gets it again (review round 2,
    // finding 3).
    const expired = (path: string) =>
      final(
        refuse("EXPIRED", undefined, [
          `${path}: expected a ULID from the 4 days before clientTime to 1 minute after`,
        ]),
      );
    if (!ageOk(m.mutationId, m.clientTime)) return expired("mutationId");
    if (USE_PACKAGE) {
      // the name, the input, the new ids' age, the online-only age, then
      // can, pre, run and effects: `@session/mutators`' `apply`
      const out = applyPackage(this.mutators, new StoreSource(this.store), u, m, now, this.random);
      if (out.kind === "refused") return final(out.refusal);
      return { result: out.result, recorded: true, staged: out.staged, effects: out.effects };
    }
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
      const tx = new StagedTx(this.store, u, isoAt(now), m.mutationId);
      authorize(tx, def, input);
      const pre: PreCtx = {
        now,
        random: this.random,
        inviteCodeTaken: (code) =>
          [...this.store.keysOf("invite")].some(
            (k) => (this.store.get(k) as RecordOf<"invite">).code === code,
          ),
      };
      const values = def.pre?.(pre, input) ?? {};
      const result = def.run(tx, input, values);
      const effects = def.post?.(input, result) ?? [];
      return { result: { ok: true, result }, recorded: true, staged: tx.staged, effects };
    } catch (e) {
      if (e instanceof Refusal) return final(e);
      // not a refusal: a fault of the server, not of the input. Nothing is
      // written or recorded; the client sends the write again later (R8).
      return final(refuse("INTERNAL_SERVER_ERROR"));
    }
  }

  // ---- the effect worker ----

  work(): number {
    const now = this.begin();
    let ran = 0;
    for (let k = 0; k < this.effectQueue.length;) {
      const q = this.effectQueue[k] as QueuedEffect;
      if (q.next > now) {
        k++;
        continue;
      }
      q.attempts++;
      try {
        if (this.failEffect?.(q.effect as Effect, q.attempts))
          throw new Error("the effect's service failed");
        this.runEffect(q.effect, now);
        this.effectQueue.splice(k, 1);
        ran++;
      } catch {
        // its write's answer is recorded already and does not change
        if (q.attempts >= EFFECT_MAX_ATTEMPTS) {
          this.effectQueue.splice(k, 1);
          this.deadLetters.push({ ...q, failedAt: now });
        } else {
          q.next = now + Math.min(EFFECT_BACKOFF_MAX, EFFECT_BACKOFF_MIN * 2 ** (q.attempts - 1));
          k++;
        }
      }
    }
    return ran;
  }

  /** A report's author is told how it was resolved: their earlier notice of
   * it is replaced (or, for a report opened again, taken back). */
  private reportResolved(effect: Extract<AnyEffect, { type: "reportResolved" }>, now: number) {
    const r = this.store.get(`report:${effect.report}`);
    if (r?.kind !== "report") return;
    const staged = new Map<string, StoredRecord | null>();
    for (const key of this.store.keysOf("notif")) {
      const n = this.store.get(key) as unknown as { to: string; type: string; report: string };
      if (n.to === r.by && n.type === "report_resolved" && n.report === r.id) staged.set(key, null);
    }
    if (effect.outcome !== null) {
      let id: string;
      do id = ulid(now, this.random);
      while (this.store.registry.has(id));
      staged.set(`notif:${id}`, {
        kind: "notif",
        id,
        to: r.by,
        type: "report_resolved",
        sp: r.sp,
        report: r.id,
        item: r.key,
        ...NOTIF_REST,
        outcome: effect.outcome,
        read: false,
        createdAt: isoAt(now),
        rev: 0,
      } as unknown as StoredRecord);
    }
    this.store.commit(staged, now);
  }

  /** Run one effect. Its writes commit together, or not at all. */
  private runEffect(effect: AnyEffect, now: number) {
    if (effect.type === "job") {
      this.jobList.push({ kind: effect.kind, id: effect.id });
      return;
    }
    if (effect.type === "reportResolved") return this.reportResolved(effect, now);
    const staged = new Map<string, StoredRecord | null>();
    // the staff as they are when the effect runs
    const staff = spaceRec(this.store, effect.sp)?.mods ?? [];
    for (const [to, role] of staff) {
      if (role === "member") continue;
      let id: string;
      do id = ulid(now, this.random);
      while (this.store.registry.has(id) || staged.has(`notif:${id}`));
      const n: NotifDraft = {
        to,
        type: "report",
        sp: effect.sp,
        report: effect.report,
        item: effect.item,
      };
      staged.set(`notif:${id}`, {
        ...n,
        ...NOTIF_REST,
        kind: "notif",
        id,
        read: false,
        createdAt: isoAt(now),
        rev: 0,
      });
    }
    this.store.commit(staged, now);
  }

  /** Expire what is past its lifetime: each table from its oldest value,
   * stopping at the first that has not expired. */
  private housekeep(now: number) {
    this.store.prune(now);
    for (const [k, d] of this.dedup) {
      if (d.at > now - DEDUP_TTL) break;
      this.dedup.delete(k);
    }
    for (const [k, a] of this.seqAnswers) {
      if (a.at > now - DEDUP_TTL) break;
      this.seqAnswers.delete(k);
    }
    for (const [id, c] of this.clients) {
      if (c.seen > now - CLIENT_IDLE_TTL) break;
      this.clients.delete(id);
    }
    for (const [u, times] of this.registrations) {
      if ((times.at(-1) ?? 0) > now - DAY) break;
      this.registrations.delete(u);
    }
  }

  /** A client was used now: it moves to the end of the idle order. */
  private touch(clientId: string, c: ClientRec, now: number) {
    c.seen = now;
    setLast(this.clients, clientId, c);
  }

  // ---- reads ----
  //
  // A cursor is a sealed token (`Tokens`) naming the log, the reader, the
  // log's history, the version, the server's head and when it was served.
  // Two readers at the same version hold different tokens, so a reader whose
  // state missed a `del` that was pruned since cannot pass for one that did
  // not (review round 1, R12). Every read serves a new token; a pull with no
  // change the reader may read keeps the version and renews the serve time,
  // so a snapshot and pulls on a quiet server never loop on resync.

  private rows(log: LogId) {
    return this.store.logs.get(log) ?? new Map<string, LogRow>();
  }

  /** A user log is read by its user only; anyone else, and a signed-out
   * caller, gets nothing from it. */
  private closedTo(log: LogId, u: string | null) {
    return log.startsWith("user:") && (u === null || log !== `user:${u}`);
  }

  private lastSeq(u: string | null, clientId: string | undefined, now: number): LastSeq {
    if (u === null || clientId === undefined) return null;
    const c = this.clients.get(clientId);
    if (!c || c.u !== u) return null;
    this.touch(clientId, c, now);
    return c.last;
  }

  /** A row as `u` may read it now: the record's view for a `put`, true for a
   * `del` whose tombstone `u` may read, or null. */
  private readRow(row: LogRow, u: string | null): StoredRecord | true | null {
    if (row.op === "put") {
      const rec = this.store.get(row.key);
      return rec ? view(this.store, rec, u) : null;
    }
    const t = this.store.tombs.get(row.key);
    return t && readsAudience(this.store, t, u) ? true : null;
  }

  /** A token for `u` at `version` of `log`'s current history, served now. */
  private serve(log: LogId, u: string | null, version: number, now: number): Cursor {
    return this.tokens.seal({
      log,
      u,
      n: this.store.epoch(log).n,
      v: version,
      h: this.store.head,
      at: now,
    });
  }

  snapshot(actor: Actor | null, log: LogId, options: ReadOptions = {}): Snapshot {
    const now = this.begin();
    const u = this.userOf(actor);
    const lastSeq = this.lastSeq(u, options.clientId, now);
    // a log id that cannot name a log: no token, so a pull resyncs
    if (!logS.safeParse(log).success) return { records: [], cursor: "", lastSeq };
    if (this.closedTo(log, u)) return { records: [], cursor: this.serve(log, u, 0, now), lastSeq };
    const records: Snapshot["records"] = [];
    let version = 0;
    for (const row of this.rows(log).values()) {
      const v = this.readRow(row, u);
      if (v === null) continue;
      // the newest row the reader may read, a `del` or a row the summary
      // tier leaves out included
      version = Math.max(version, row.version);
      if (v === true) continue;
      if (
        options.tier === "summary" &&
        (v.kind === "followup" || v.kind === "reply" || v.kind === "run")
      )
        continue;
      records.push({ key: row.key, record: structuredClone(v) });
    }
    // the server's creation time orders a list, then the version of the
    // commit that created the record; never the id a client chose (R13)
    const born = (key: string) => this.store.born.get(key) ?? 0;
    records.sort((a, b) => {
      const x = createdOf(a.record);
      const y = createdOf(b.record);
      return x < y ? -1 : x > y ? 1 : born(a.key) - born(b.key);
    });
    return { records, cursor: this.serve(log, u, version, now), lastSeq };
  }

  pull(actor: Actor | null, log: LogId, cursor: Cursor, options: ReadOptions = {}): Pull {
    const now = this.begin();
    const u = this.userOf(actor);
    if (!logS.safeParse(log).success) return { resync: true };
    // The token's age is the time the server served it, not the time of the
    // commit at its version: a reader who was served it within 30 days
    // missed no `del` (one it may read and was not given is younger than
    // that token, so younger than 30 days). A token the server did not seal
    // for this reader, this log and this history of the log resyncs.
    const c = this.tokens.open(cursor);
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
    if (this.closedTo(log, u)) return { changes: [], cursor: this.serve(log, u, 0, now), lastSeq };
    if (u !== null && this.scopeChanged(log, u, c.v, c.h)) return { resync: true };
    const changes: Change[] = [];
    let to = c.v;
    const fresh = [...this.rows(log).values()]
      .filter((r) => r.version > c.v)
      .sort((a, b) => a.version - b.version);
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
    return { changes, cursor: this.serve(log, u, to, now), lastSeq };
  }

  /** Whether what `u` may read of `log` changed, after the token at
   * `version` was served (when the server's head was `head`), in a way the
   * log's rows do not carry: `u`'s own membership or role in the space; for
   * `u`'s user log, `u`'s membership or role in any space, or a space opening
   * or closing that a record in the log is about (likes, saves and
   * notifications follow the person's access to their space, notifications
   * their role too). Either way the reader resyncs. `u`'s member rows are
   * rows `u` may read, so their versions compare with the token's; a space's
   * history is not a row of the user log, so the version it began at
   * compares with the head. */
  private scopeChanged(log: LogId, u: string, version: number, head: number): boolean {
    const rows = this.rows(log);
    if (log.startsWith("space:")) {
      const mine = rows.get(memberKey(log.slice(6), u));
      return mine !== undefined && mine.version > version;
    }
    for (const row of rows.values()) {
      if (row.key.startsWith("member:") && row.version > version) return true;
      const rec = this.store.get(row.key);
      const a = rec ? audience(this.store, rec) : this.store.tombs.get(row.key);
      if (a && a.sp !== null && this.store.epoch(`space:${a.sp}`).start > head) return true;
    }
    return false;
  }

  // ---- test access ----

  dump(): ReadonlyMap<string, StoredRecord> {
    return this.store.records;
  }

  logRows(log: LogId): LogRow[] {
    this.begin();
    return [...this.rows(log).values()].map((r) => ({ ...r }));
  }

  jobs() {
    return this.jobList;
  }

  scanStorage(): StorageScan {
    this.begin();
    const answers: StorageScan["answers"] = [];
    for (const [k, d] of this.dedup) {
      const [u = "", mutationId = ""] = k.split("\u0000");
      answers.push({ u, mutationId, digest: d.digest, result: d.result, at: d.at });
    }
    for (const a of this.seqAnswers.values())
      answers.push({
        u: this.clients.get(a.clientId)?.u ?? "",
        clientId: a.clientId,
        seq: a.seq,
        digest: a.digest,
        result: a.result,
        at: a.at,
      });
    return structuredClone({
      records: [...this.store.records.values()],
      tombstones: [...this.store.tombs.values()],
      logRows: [...this.store.logs].flatMap(([log, rows]) =>
        [...rows.values()].map((r) => ({ log, ...r })),
      ),
      answers,
      clients: [...this.clients].map(([clientId, c]) => ({ clientId, ...c })),
      registrations: [...this.registrations].map(([u, at]) => ({ u, at })),
      registry: [...this.store.registry].map(([id, rev]) => ({ id, rev })),
      born: [...this.store.born].map(([key, version]) => ({ key, version })),
      epochs: [...this.store.epochs].map(([log, e]) => ({ log, ...e })),
      effects: this.effectQueue.map((q) => ({ ...q })),
      deadLetters: this.deadLetters.map((q) => ({ ...q })),
      jobs: [...this.jobList],
    });
  }

  finishJob(key: string, text: string): boolean {
    const now = this.begin();
    const r = this.store.get(key);
    if (!r || !("mod" in r) || r.mod === "removed") return false;
    if (r.kind === "thread" && !r.del)
      return this.store.commit(new Map([[key, { ...r, sum: text }]]), now) !== null;
    if (r.kind === "followup")
      return this.store.commit(new Map([[key, { ...r, a: text }]]), now) !== null;
    return false;
  }
}

export const createProtoServer = (options: ServerOptions): TestServer => new ProtoServer(options);
