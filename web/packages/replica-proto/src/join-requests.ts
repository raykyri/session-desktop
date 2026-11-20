// Mutator definitions: the mock's PROCS (section 5b) ported to multi-user
// records and revised to the build's contract (`01` C1-C18, U1), in the
// stages AGENTS.md sets:
//
// 1. `pre` (server only): checks and values the client cannot have, such as
//    an invite code. It may refuse. It is the only stage with a random source.
// 2. `can` and `run`: deterministic over a synchronous `tx`. They read the
//    time from `tx.now`, never the clock, use no random source and no `Intl`,
//    and make no ids: the first id comes in the input and later ones from
//    `tx.id(ordinal)`. `run` writes the stored shape, counts included.
// 3. `notify` (server only): inside the same transaction, after `run`, it
//    writes the notification records the write causes (`01` C16), so they
//    commit with the write, exactly once. It never runs on a client. There is
//    no effect queue: an ask's run is a `run` record with status `queued`,
//    which is the run queue.
//
// `space(tx, input)` names the space the write acts in, reading the target
// (NOT_FOUND when it does not exist or the actor may not read it, with one
// answer for both), or null when the write touches no space. In that space,
// `authorize` refuses a banned person every write, then checks `who`, the
// role the actor needs: anyone signed in (`user`), a member of a private
// space (`member`; in an open space anyone signed in), the item's author
// (`author`, checked by `can`), or the space's owner (`owner`). A space has
// one owner and members; there are no admins or moderators (`01` C18).
//
// Stale intent (review round 2, finding 2). A decision that could expose
// content or admit someone carries `base.rev`, the rev of the record it acts
// on as the client saw it, and is refused with STALE when the rev differs:
// showing a moderated item (`moderation.decide` "shown"), and approving or
// reopening a join request (`joinRequests.decide`, one rev per person; join
// requests are prototype only, `01` C10). An author's edit (`threads.update`)
// carries the thread's rev too. A state check alone is not enough: a request
// that was approved, then reopened by its person asking again, is open
// again, and an approval made for the first request would admit them (review
// round 1, R1).
//
// A decision that restricts applies to the record as it is now, whatever its
// rev: hiding or removing an item, declining a request, banning a person. The
// person it is about could otherwise make it STALE every time by editing,
// saving or leaving and joining again; hiding or erasing a newer text is
// always safe. `base` is optional on these decisions and not compared. A
// removal (`members.remove`) names the member's admission id
// (`MemberRec.adm`), which only the owner's decision or an invite gives, so a
// removal decided before the person was let in again is STALE; joining an
// open space again gives a new admission id.
//
// With the rev matching, a decision the record's state does not allow is
// PRECONDITION_FAILED.
//
// Input schemas are the shared contract's (`spaces.spaceMutators`), strict:
// a field the schema does not list (`saves`, `u`, `createdAt`, `code`) is
// BAD_REQUEST, never stored. Ids are narrowed to ULIDs whose time fits 48
// bits.

import { spaces } from "@session/shared";
import { z } from "zod";

import {
  bannedFrom,
  canRead,
  isClosed,
  isOwnerOf,
  roleIn,
  spaceRec,
  type Reader,
} from "./access.js";
import type { ApiError, ErrorCode } from "./contract.js";
import {
  answerKey,
  banKey,
  countsKey,
  memberKey,
  nodeKey,
  prefsKey,
  requestKey,
  saveKey,
  statsKey,
  threadKey,
  type CommentRec,
  type CountsRec,
  type Draft,
  type Kind,
  type NodeRec,
  type NotifRec,
  type RecordOf,
  type ReplyRec,
  type SpaceRec,
  type SpaceRole,
  type ThreadRec,
} from "./records.js";
import { DAY, ULID_RE } from "./ulid.js";

// ---- errors ----

/** The mock's default messages (section 2), and the sync protocol's. */
export const MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: "The server didn’t accept this change: some of its data is missing or not valid.",
  UNAUTHORIZED: "Your sign-in expired. Sign in again.",
  FORBIDDEN: "You don’t have permission to do this.",
  NOT_FOUND: "The server has no record of this item. Someone may have deleted it.",
  METHOD_NOT_SUPPORTED: "The server doesn’t support this request.",
  CONFLICT: "Someone else changed this item first.",
  PRECONDITION_FAILED: "This change isn’t possible in the item’s current state.",
  TOO_MANY_REQUESTS: "Too many requests from your account. Try again in a minute.",
  INTERNAL_SERVER_ERROR: "The server had an error and didn’t save the change.",
  SERVICE_UNAVAILABLE: "The server is unavailable.",
  UPGRADE_REQUIRED: "Update Session.",
  STALE: "This item changed after you saw it. Look at it again.",
  CLOCK_SKEW: "Your device’s clock is off.",
  EXPIRED: "This change waited too long to be sent, and wasn’t saved.",
  OUT_OF_ORDER: "This change arrived out of order.",
  WRONG_CLIENT: "This device isn’t signed in to your account.",
  TOO_LARGE: "This change is too large to send.",
};

/** A refusal: a mutator stage throws it, and nothing the mutation wrote is kept. */
export class Refusal extends Error {
  readonly code: ErrorCode;
  readonly issues: string[] | undefined;
  constructor(code: ErrorCode, message?: string, issues?: string[]) {
    super(message ?? MESSAGES[code]);
    this.code = code;
    this.issues = issues;
  }
  toError(): ApiError {
    return this.issues
      ? { code: this.code, message: this.message, issues: this.issues }
      : { code: this.code, message: this.message };
  }
}

export const refuse = (code: ErrorCode, message?: string, issues?: string[]) =>
  new Refusal(code, message, issues);
const bad = (path: string, expected: string) =>
  refuse("BAD_REQUEST", undefined, [`input.${path}: expected ${expected}`]);
/** The one answer for a missing target and for a target the actor may not read. */
const notFound = () => refuse("NOT_FOUND");
const stale = () => refuse("STALE");
const removed = () => refuse("PRECONDITION_FAILED", "This item was removed.");

// ---- the transaction and the stage contexts ----

export interface Tx extends Reader {
  /** The actor's handle. */
  readonly me: string;
  /** The server's time for this mutation (ISO, seconds). */
  readonly now: string;
  /** Records of a kind, in key order. */
  find<K extends Kind>(kind: K, pred?: (r: RecordOf<K>) => boolean): RecordOf<K>[];
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

export interface PreCtx {
  readonly now: number;
  random(): number;
  inviteCodeTaken(code: string): boolean;
}

export type Who = "user" | "member" | "author" | "owner";

export interface MutatorDef<I> {
  input: z.ZodType<I>;
  /** Online only: the client sends it directly and never queues it. The
   * server refuses one whose mutation id is older than `ONLINE_MAX_AGE`. */
  online?: boolean;
  who: Who;
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

const define = <I>(def: MutatorDef<I>) => def as unknown as AnyMutator;

/** The ban check, the `who` check and `can` (the mock's `authorize`). */
export function authorize(tx: Tx, def: AnyMutator, input: unknown): void {
  const sp = def.space?.(tx, input) ?? null;
  if (sp !== null) {
    const s = spaceRec(tx, sp);
    if (!s) throw notFound();
    // DESIGN (phase 0 finding): the mock lets anyone signed in write in an
    // open space, a banned person included (its bans only stop joining a
    // closed space). A ban stops every write in its space here, the author's
    // edits and deletes and a person's own saves included.
    if (bannedFrom(tx, sp, tx.me)) throw refuse("FORBIDDEN", "You are banned from this space.");
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

// ---- shared rules ----

/** The shared id schema, narrowed to ULIDs whose time fits 48 bits. */
const ulidS = spaces.spaceUlidSchema.regex(ULID_RE);
const isUlidS = (v: string) => ULID_RE.test(v);
/** Handles no person may have: a signed-out caller's absent handle prints as
 * one of them, so a key or log id built from it never names a person. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["null", "undefined"]);
/** A handle as used in keys (`member:<space>:<handle>`): no ":". */
export const handleS = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .refine((h) => !RESERVED_HANDLES.has(h), "reserved");
export const isHandle = (u: string) => handleS.safeParse(u).success;
const count = z.number().int().nonnegative();
/** The longest an invite link lasts, in days. */
export const INVITE_MAX_DAYS = spaces.INVITE_DAYS_MAX;
/** A private space serves a save count only from this many saves (`01` C1,
 * decision S6). */
export const PRIVATE_SAVES_MIN = 3;
/** The look-up prompt, version 1 (`03` G2): the mutator stores it in `q`; the
 * client shows the phrase. `@session/mutators` owns it from M1b. */
export const LOOKUP_PROMPT_V1 = (phrase: string) =>
  `Look up "${phrase}" as it is used in this answer. Describe what it refers to in two or three sentences, with a source.`;

const text = (v: string, path: string) => {
  const s = v.trim();
  if (!s) throw bad(path, "some text");
  return s;
};

/** A look-up phrase: 1 to 4 words once the characters that are not letters
 * or digits are trimmed from both ends. */
export function lookPhrase(v: string): string | null {
  const s = v.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const words = s.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 ? words.join(" ") : null;
}

/** The mock's space name rule: lower case, `[a-z0-9-]`, at most 32 characters. */
export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);

const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A record the actor may read, or NOT_FOUND. */
function readable<K extends Kind>(tx: Tx, key: string, kind: K): RecordOf<K> {
  const r = tx.get(key);
  if (!r || r.kind !== kind || !canRead(tx, r, tx.me)) throw notFound();
  return r as RecordOf<K>;
}

const readableThread = (tx: Tx, id: string) => readable(tx, threadKey(id), "thread");

function needSpace(tx: Tx, sp: string): SpaceRec {
  const s = spaceRec(tx, sp);
  if (!s) throw notFound();
  return s;
}

/** Write a space's stored member count after its member records changed. */
function refreshSpace(tx: Tx, sp: string): void {
  const s = needSpace(tx, sp);
  const members = tx.find("member", (m) => m.sp === sp).length;
  tx.put({ ...s, members });
}

/** Add `u` to a space, with `adm` as the admission id (a derived id of the
 * write that admits them). */
function addMember(tx: Tx, sp: string, u: string, role: SpaceRole, adm: string): void {
  if (tx.get(memberKey(sp, u))) return;
  tx.put({ kind: "member", sp, u, role, adm, joinedAt: tx.now });
}

/** A thread's counts record (written with the thread). */
function countsOf(tx: Tx, th: ThreadRec): CountsRec {
  const c = tx.get(countsKey(th.id));
  if (c?.kind !== "counts") throw refuse("INTERNAL_SERVER_ERROR");
  return c;
}

/** Write a thread's `r` (`01` C5): every ask node under an ask's root, every
 * reply of a post, placeholders included. */
function recount(tx: Tx, th: ThreadRec): void {
  const c = countsOf(tx, th);
  const r =
    th.k === "ask"
      ? tx.find("node", (x) => x.th === th.id).length
      : tx.find("reply", (x) => x.th === th.id).length;
  tx.put({ ...c, r });
}

/** Write a thread's served save count (`01` C1): the number of save records;
 * in a private space 0 below `PRIVATE_SAVES_MIN`. The true count is the save
 * records, which only the server reads (a client's read of them is
 * unknown), so a save that leaves a private count below 3 writes no counts
 * record. */
function countSaves(tx: Tx, th: string): void {
  const c = tx.get(countsKey(th));
  if (c?.kind !== "counts") return;
  const n = tx.find("save", (x) => x.th === th).length;
  const s = spaceRec(tx, c.s);
  const saves = s && isClosed(s) && n < PRIVATE_SAVES_MIN ? 0 : n;
  tx.put({ ...c, saves });
}

/** The owner acts on anyone but themselves (`01` C18): the target of a
 * removal or a ban is never the owner. */
function actsOn(tx: Tx, u: string): void {
  if (u === tx.me) throw refuse("FORBIDDEN", "You can’t change your own membership here.");
}

/** The node a reference names in a thread: `r` (the root: the thread) or a
 * node of the thread the actor may read. */
function nodeOf(tx: Tx, th: ThreadRec, ref: string): ThreadRec | NodeRec {
  if (ref === "r") return th;
  const n = readable(tx, nodeKey(ref), "node");
  if (n.th !== th.id) throw notFound();
  return n;
}

/** The record a moderation key names (`a:<thread>`, `p:<thread>`,
 * `f:<thread>:<node>`, `r:<thread>:<reply>`, `c:<thread>:<comment>`), if the
 * actor may read it. The mock's reply keys use reply paths; here they use
 * reply ids. */
function itemOf(tx: Tx, key: string): ThreadRec | NodeRec | ReplyRec | CommentRec {
  const [k, th, sub, ...rest] = key.split(":");
  if (!th || rest.length) throw notFound();
  if (k === "a" || k === "p") {
    if (sub !== undefined) throw notFound();
    const p = readableThread(tx, th);
    if ((k === "a") !== (p.k === "ask")) throw notFound();
    return p;
  }
  const kinds = { f: "node", r: "reply", c: "comment" } as const;
  if ((k === "f" || k === "r" || k === "c") && sub) {
    const r = readable(tx, `${kinds[k]}:${sub}`, kinds[k]);
    if (r.th !== th) throw notFound();
    return r;
  }
  throw notFound();
}

/** Remove a moderated item for good: its text is erased from storage, and so
 * is everything under it (a thread's nodes, answers, runs, replies,
 * comments, saves and the mention notifications about it; a node's answer
 * and comments; a top-level reply's or comment's replies). The item stays
 * as a placeholder; a thread's keeps who removed it and the reason. */
function erase(tx: Tx, r: ThreadRec | NodeRec | ReplyRec | CommentRec, note: string | null): void {
  /** The keys erased; mention notifications about them go too. */
  const gone = new Set<string>();
  const drop = (key: string) => {
    gone.add(key);
    tx.del(key);
  };
  switch (r.kind) {
    case "thread":
      for (const x of tx.find("node", (y) => y.th === r.id)) drop(`node:${x.id}`);
      for (const x of tx.find("answer", (y) => y.th === r.id)) drop(answerKey(x.node));
      for (const x of tx.find("reply", (y) => y.th === r.id)) drop(`reply:${x.id}`);
      for (const x of tx.find("comment", (y) => y.th === r.id)) drop(`comment:${x.id}`);
      for (const x of tx.find("run", (y) => y.th === r.id)) drop(`run:${x.id}`);
      for (const x of tx.find("save", (y) => y.th === r.id)) drop(saveKey(x.u, x.th));
      for (const x of tx.find("notif", (y) => y.type === "mention" && y.th === r.id))
        drop(`notif:${x.id}`);
      tx.put({ ...countsOf(tx, r), r: 0, saves: 0 });
      tx.put({
        ...r,
        q: "",
        t: null,
        sum: null,
        running: false,
        mod: "removed",
        modBy: tx.me,
        modNote: note,
        updatedAt: tx.now,
      });
      return;
    case "node":
      drop(answerKey(r.id));
      for (const x of tx.find("comment", (y) => y.node === r.id)) drop(`comment:${x.id}`);
      tx.put({ ...r, q: "", look: null, quote: null, mod: "removed" });
      break;
    case "reply":
      if (r.parent === null)
        for (const x of tx.find("reply", (y) => y.parent === r.id)) drop(`reply:${x.id}`);
      tx.put({ ...r, t: "", mod: "removed" });
      recount(tx, tx.get(threadKey(r.th)) as ThreadRec);
      break;
    case "comment":
      if (r.parent === null)
        for (const x of tx.find("comment", (y) => y.parent === r.id)) drop(`comment:${x.id}`);
      tx.put({ ...r, t: "", mod: "removed" });
      break;
  }
  gone.add(`${r.kind}:${r.id}`);
  for (const x of tx.find("notif", (y) => y.type === "mention" && gone.has(y.item ?? "")))
    tx.del(`notif:${x.id}`);
}

// ---- notifications (`01` C16) ----

/** The ordinal of the first id a notify stage derives: above any `run`'s. */
const NOTIFY_ORDINAL = 1000;
/** Notification types that coalesce: one unread per (recipient, type, thread). */
const COALESCED: ReadonlySet<NotifRec["type"]> = new Set(["reply", "branch", "comment"]);

/** The handles a text mentions (`@handle`), once each, in order. */
export function mentionsIn(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/(?:^|[^a-z0-9._@-])@([a-z0-9][a-z0-9._-]{0,63})/g)) {
    const h = (m[1] ?? "").replace(/[.]+$/, "");
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

/** Writes a mutation's notifications, with ids derived from its mutation id. */
class Notifier {
  private k = 0;
  constructor(private readonly tx: Tx) {}

  /** Notify `to` of the actor's write, unless `to` is the actor. Coalesced
   * types update the recipient's unread notification of that type and thread. */
  send(
    to: string,
    type: NotifRec["type"],
    sp: string,
    th: string,
    item: string,
    note: string | null = null,
  ): void {
    const tx = this.tx;
    if (to === tx.me) return;
    const actor = type === "removed" ? null : tx.me;
    if (COALESCED.has(type)) {
      const old = tx.find(
        "notif",
        (n) => n.to === to && n.type === type && n.th === th && !n.read,
      )[0];
      if (old) {
        tx.put({ ...old, item, actor, n: old.n + 1, createdAt: tx.now });
        return;
      }
    }
    tx.create({
      kind: "notif",
      id: tx.id(NOTIFY_ORDINAL + ++this.k),
      to,
      type,
      sp,
      th,
      item,
      actor,
      n: 1,
      note,
      read: false,
      createdAt: tx.now,
    });
  }

  /** Notify the members of `sp` that `t` mentions. A person who is not a
   * member, or is the actor, is not notified. */
  mentions(t: string, sp: string, th: string, item: string): void {
    for (const h of mentionsIn(t))
      if (isHandle(h) && roleIn(this.tx, sp, h) !== null) this.send(h, "mention", sp, th, item);
  }
}

// ---- input schemas: the shared contract's, with ULIDs of 48-bit time ----

const M = spaces.spaceMutators;
/** Every id and space field of an input, narrowed to `ULID_RE`. */
const ulidFields = <I>(schema: z.ZodType<I>, fields: string[]) =>
  schema.refine(
    (i) =>
      fields.every((f) => {
        const v = (i as Record<string, unknown>)[f];
        return v === undefined || v === "r" || (typeof v === "string" && isUlidS(v));
      }),
    { message: "expected a ULID" },
  );

/** The space of the thread a save names, for taking it back: null when the
 * person has none (nothing is written), so taking back a save needs no read
 * access and answers the same whether or not the thread exists. */
function ownMarkSpace(tx: Tx, key: string, thread: string): string | null {
  if (!tx.get(key)) return null;
  const p = tx.get(threadKey(thread));
  return p?.kind === "thread" ? p.s : null;
}

/** The author of the node a reference names: the thread's for `r`. */
const authorOf = (n: ThreadRec | NodeRec) => n.u ?? "";

// ---- the mutators ----

export const MUTATORS: Readonly<Record<string, AnyMutator>> = Object.freeze({
  // -- spaces
  // Space names are unique across all spaces, private ones included (kept
  // as decided; review round 1, R10): the CONFLICT on create tells anyone
  // that a name is taken, so a private space's name can be probed. It names
  // only the name sent.
  "spaces.create": define({
    input: M["spaces.create"].input.extend({ id: ulidS }).strict(),
    online: true,
    who: "user",
    ids: (i) => [i.id],
    run: (tx, i) => {
      const name = slug(i.name);
      if (!name) throw bad("name", "a name");
      if (tx.find("space", (s) => s.name === name).length)
        throw refuse("CONFLICT", `#${name} already exists.`);
      tx.create({
        kind: "space",
        id: i.id,
        name,
        desc: (i.desc ?? "").trim(),
        vis: i.vis ?? "open",
        members: 1,
        owner: tx.me,
        frozen: false,
        createdAt: tx.now,
      });
      tx.put({ kind: "stats", sp: i.id, posts: 0, updatedAt: tx.now });
      addMember(tx, i.id, tx.me, "owner", tx.id(1));
      return { id: i.id };
    },
  }),

  // About only (`01` C11); name and visibility are set at creation
  "spaces.update": define({
    input: M["spaces.update"].input.extend({ id: ulidS }).strict(),
    who: "owner",
    space: (_tx, i) => i.id,
    run: (tx, i) => {
      const s = needSpace(tx, i.id);
      tx.put({ ...s, desc: i.desc.trim() });
      return null;
    },
  }),

  "spaces.join": define({
    input: M["spaces.join"].input.extend({ space: ulidS }).strict(),
    who: "user",
    space: (_tx, i) => i.space,
    can: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (roleIn(tx, s.id, tx.me)) return;
      if (!isClosed(s)) return;
      // DESIGN (phase 0 finding): the mock also admits a person whose join
      // request was approved. Here approval makes the member record directly
      // (joinRequests.decide), and an approved request admits nobody: kept as
      // a standing pass, it would let a removed member join again.
      if (i.invite === undefined)
        throw refuse("FORBIDDEN", `#${s.name} is private: joining it needs an invite link.`);
      const link = tx.find("invite", (l) => l.code === i.invite)[0];
      // a link is made by the owner, who keeps the right to make links; it
      // works once, until it expires (checked now, at apply time)
      const live =
        link !== undefined &&
        link.sp === s.id &&
        link.dead === null &&
        Date.parse(link.expiresAt) > Date.parse(tx.now);
      if (!live) throw refuse("FORBIDDEN", "This invite link has expired or was already used.");
    },
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (roleIn(tx, s.id, tx.me)) return null;
      if (isClosed(s) && i.invite !== undefined) {
        const link = tx.find("invite", (l) => l.code === i.invite)[0];
        if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });
      }
      addMember(tx, s.id, tx.me, "member", tx.id(1));
      refreshSpace(tx, s.id);
      return null;
    },
  }),

  "spaces.leave": define({
    input: M["spaces.leave"].input.extend({ space: ulidS }).strict(),
    who: "member",
    space: (_tx, i) => i.space,
    can: (tx, i) => {
      if (isOwnerOf(tx, i.space, tx.me))
        throw refuse("PRECONDITION_FAILED", "You own this channel: the owner can’t leave it.");
    },
    run: (tx, i) => {
      if (!tx.get(memberKey(i.space, tx.me))) return null;
      tx.del(memberKey(i.space, tx.me));
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // -- threads, nodes, replies and comments
  "threads.create": define({
    input: ulidFields(M["threads.create"].input, ["id", "space"]),
    who: "member",
    space: (_tx, i) => i.space,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      const q = text(i.q, "q");
      const ask = i.kind === "ask";
      tx.create({
        kind: "thread",
        id: i.id,
        s: s.id,
        u: tx.me,
        k: i.kind,
        q,
        t: i.title ?? null,
        sum: null,
        tok: 0,
        src: 0,
        model: ask ? i.model : null,
        effort: ask ? i.effort : null,
        running: ask,
        edited: false,
        del: false,
        gone: false,
        mod: null,
        modBy: null,
        modNote: null,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      tx.put({ kind: "counts", th: i.id, s: s.id, saves: 0, r: 0 });
      const stats = tx.get(statsKey(s.id));
      if (stats?.kind === "stats") tx.put({ ...stats, posts: stats.posts + 1, updatedAt: tx.now });
      if (!ask) return { id: i.id, run: null };
      // the run record with status `queued` is the run queue (`03` E2)
      const run = tx.id(1);
      tx.create({
        kind: "run",
        id: run,
        th: i.id,
        s: s.id,
        node: "r",
        u: tx.me,
        model: i.model,
        effort: i.effort,
        status: "queued",
        attempt: 1,
        step: 0,
        fail: null,
        tok: null,
        bill: null,
        note: null,
        createdAt: tx.now,
        startedAt: null,
        finishedAt: null,
      });
      return { id: i.id, run };
    },
    // a post notifies the members it mentions
    notify: (tx, i) => {
      if (i.kind === "post") new Notifier(tx).mentions(i.q, i.space, i.id, threadKey(i.id));
    },
  }),

  "threads.update": define({
    input: M["threads.update"].input.extend({ id: ulidS }).strict(),
    who: "author",
    space: (tx, i) => readableThread(tx, i.id).s,
    can: (tx, i) => {
      if (readableThread(tx, i.id).u !== tx.me)
        throw refuse("FORBIDDEN", "Only the person who wrote this can change it.");
    },
    run: (tx, i) => {
      const p = readableThread(tx, i.id);
      if (p.mod === "removed") throw removed();
      if (p.del || p.gone) throw refuse("PRECONDITION_FAILED", "This thread was deleted.");
      if (p.rev !== i.base.rev) throw stale();
      const q = text(i.q, "q");
      const changed = q !== p.q;
      tx.put({ ...p, q, t: changed ? null : p.t, edited: p.edited || changed, updatedAt: tx.now });
      return null;
    },
  }),

  "threads.delete": define({
    input: M["threads.delete"].input.extend({ id: ulidS }).strict(),
    who: "author",
    // the author may delete their thread without read access: a person
    // removed from a private space can still delete what they wrote there
    space: (tx, i) => {
      const p = tx.get(threadKey(i.id));
      if (p?.kind !== "thread") throw notFound();
      return p.u === tx.me ? p.s : readableThread(tx, i.id).s;
    },
    can: (tx, i) => {
      if ((tx.get(threadKey(i.id)) as ThreadRec).u !== tx.me)
        throw refuse("FORBIDDEN", "Only the person who wrote this can change it.");
    },
    // Kept as the mock has it (review round 1, R11; `01` C15): a thread
    // deleted while it has nodes or replies stays as a shell (`del`), and
    // nodes, replies and saves on it are taken as on any thread. A thread
    // with none is `gone`; it leaves every Saved. The author may delete a
    // thread the owner removed: its count `r` is 0 then, so it is gone.
    run: (tx, i) => {
      const p = tx.get(threadKey(i.id)) as ThreadRec;
      const counts = countsOf(tx, p);
      const kept = counts.r > 0;
      // an author who may no longer read the thread (removed from its private
      // space) learns nothing about it: whether it got nodes or replies after
      // they left is not in the answer (R4b)
      const reads = canRead(tx, p, tx.me);
      // a thread without nodes or replies is gone: it leaves Saved, and its
      // root answer goes
      if (!kept) {
        for (const x of tx.find("save", (y) => y.th === p.id)) tx.del(saveKey(x.u, x.th));
        tx.del(answerKey(p.id));
      }
      for (const r of tx.find("run", (x) => x.th === p.id && x.node === "r")) tx.del(`run:${r.id}`);
      if (!kept) tx.put({ ...counts, saves: 0 });
      tx.put({
        ...p,
        q: "",
        t: null,
        edited: false,
        running: false,
        del: true,
        gone: !kept,
        sum: kept ? p.sum : null,
        updatedAt: tx.now,
      });
      return reads ? { kept } : null;
    },
  }),

  // The mock's saved.toggle, with a required `on`: the result depends on what
  // the client saw, not on the server's state, so two devices that save the
  // same thread do not cancel out. A save is counted (`01` C1).
  "saved.set": define({
    input: M["saved.set"].input.extend({ id: ulidS }).strict(),
    who: "user",
    space: (tx, i) =>
      i.on ? readableThread(tx, i.id).s : ownMarkSpace(tx, saveKey(tx.me, i.id), i.id),
    can: (tx, i) => {
      if (!i.on || tx.get(saveKey(tx.me, i.id))) return;
      if (readableThread(tx, i.id).mod === "removed") throw removed();
    },
    run: (tx, i) => {
      const key = saveKey(tx.me, i.id);
      const had = tx.get(key) !== undefined;
      if (i.on === had) return { on: i.on };
      if (i.on) tx.put({ kind: "save", u: tx.me, th: i.id, createdAt: tx.now });
      else tx.del(key);
      countSaves(tx, i.id);
      return { on: i.on };
    },
  }),

  // Continue, Branch, Branch here and Look up (`03` §2.1): a node and its
  // run, in one write. The node id is in the input, the run's is `tx.id(1)`.
  "research.forkNode": define({
    input: ulidFields(M["research.forkNode"].input, ["id", "thread", "parent"]),
    who: "member",
    space: (tx, i) => readableThread(tx, i.thread).s,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.k !== "ask") throw bad("thread", "an ask thread");
      if (p.mod === "removed") throw removed();
      const parent = nodeOf(tx, p, i.parent);
      if (parent.mod === "removed") throw removed();
      let q: string;
      let look: string | null = null;
      if (i.kind === "ask") q = text(i.q, "q");
      else {
        look = lookPhrase(i.look);
        if (look === null) throw bad("look", "1 to 4 words");
        q = LOOKUP_PROMPT_V1(look);
      }
      const run = tx.id(1);
      tx.create({
        kind: "node",
        id: i.id,
        th: p.id,
        s: p.s,
        par: i.parent,
        k: i.kind,
        u: tx.me,
        q,
        look,
        quote: i.quote ?? null,
        b: i.b ?? null,
        tpl: i.kind === "lookup" ? 1 : null,
        model: i.model,
        effort: i.effort,
        run,
        promoted: null,
        mod: null,
        del: false,
        createdAt: tx.now,
      });
      tx.create({
        kind: "run",
        id: run,
        th: p.id,
        s: p.s,
        node: i.id,
        u: tx.me,
        model: i.model,
        effort: i.effort,
        status: "queued",
        attempt: 1,
        step: 0,
        fail: null,
        tok: null,
        bill: null,
        note: null,
        createdAt: tx.now,
        startedAt: null,
        finishedAt: null,
      });
      recount(tx, p);
      return { id: i.id, run };
    },
    // the parent's author gets a `branch` notification
    notify: (tx, i) => {
      const p = tx.get(threadKey(i.thread)) as ThreadRec;
      const parent = i.parent === "r" ? p : (tx.get(nodeKey(i.parent)) as NodeRec);
      new Notifier(tx).send(authorOf(parent), "branch", p.s, p.id, nodeKey(i.id));
    },
  }),

  /** A reply to a post (the mock's name for replies.create). */
  "research.createPostFollowUp": define({
    input: ulidFields(M["research.createPostFollowUp"].input, ["id", "thread", "parent"]),
    who: "member",
    space: (tx, i) => readableThread(tx, i.thread).s,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.k !== "post") throw bad("thread", "a post");
      if (p.mod === "removed") throw removed();
      if (i.parent !== undefined) {
        const top = readable(tx, `reply:${i.parent}`, "reply");
        if (top.th !== p.id || top.parent !== null) throw notFound();
        if (top.mod === "removed") throw removed();
      }
      const t = text(i.t, "t");
      tx.create({
        kind: "reply",
        id: i.id,
        th: p.id,
        s: p.s,
        u: tx.me,
        t,
        parent: i.parent ?? null,
        mod: null,
        createdAt: tx.now,
      });
      recount(tx, p);
      return null;
    },
    // the post's author gets a `reply` notification; mentioned members a `mention`
    notify: (tx, i) => {
      const p = tx.get(threadKey(i.thread)) as ThreadRec;
      const n = new Notifier(tx);
      n.send(p.u ?? "", "reply", p.s, p.id, `reply:${i.id}`);
      n.mentions(i.t, p.s, p.id, `reply:${i.id}`);
    },
  }),

  // A discussion under a node, without a run (`01` C4; `03` G4), nested
  // like replies: a parent is a top-level comment on the same node.
  "comments.create": define({
    input: ulidFields(M["comments.create"].input, ["id", "thread", "node", "parent"]),
    who: "member",
    space: (tx, i) => readableThread(tx, i.thread).s,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.k !== "ask") throw bad("thread", "an ask thread");
      if (p.mod === "removed") throw removed();
      const node = nodeOf(tx, p, i.node);
      if (node.mod === "removed") throw removed();
      if (i.parent !== undefined) {
        const top = readable(tx, `comment:${i.parent}`, "comment");
        if (top.th !== p.id || top.node !== i.node || top.parent !== null) throw notFound();
        if (top.mod === "removed") throw removed();
      }
      const t = text(i.t, "t");
      tx.create({
        kind: "comment",
        id: i.id,
        th: p.id,
        s: p.s,
        node: i.node,
        parent: i.parent ?? null,
        u: tx.me,
        t,
        mod: null,
        createdAt: tx.now,
      });
      return null;
    },
    // the node's author gets a `comment` notification; mentioned members a `mention`
    notify: (tx, i) => {
      const p = tx.get(threadKey(i.thread)) as ThreadRec;
      const node = i.node === "r" ? p : (tx.get(nodeKey(i.node)) as NodeRec);
      const n = new Notifier(tx);
      n.send(authorOf(node), "comment", p.s, p.id, `comment:${i.id}`);
      n.mentions(i.t, p.s, p.id, `comment:${i.id}`);
    },
  }),

  // -- join requests (prototype only, `01` C10) and members
  "joinRequests.create": define({
    input: z.strictObject({ space: ulidS }),
    who: "user",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (!isClosed(s)) throw refuse("PRECONDITION_FAILED", "This space is open: join it instead.");
      if (roleIn(tx, s.id, tx.me))
        throw refuse("PRECONDITION_FAILED", "You are a member of this space.");
      const old = tx.get(requestKey(s.id, tx.me));
      tx.put({
        kind: "request",
        sp: s.id,
        u: tx.me,
        st: "open",
        why: null,
        createdAt: old?.kind === "request" ? old.createdAt : tx.now,
        updatedAt: tx.now,
      });
      return null;
    },
  }),

  "joinRequests.decide": define({
    input: z
      .strictObject({
        space: ulidS,
        users: z.array(handleS).min(1),
        decision: z.enum(["approve", "decline", "reopen"]),
        why: z.string().max(spaces.MODERATION_NOTE_MAX).optional(),
        /** Each request's rev as the owner saw it, by person: one entry for
         * every person in `users` and no other. Compared for "approve" and
         * "reopen", not for "decline". */
        base: z.record(handleS, count),
      })
      .refine(
        (i) =>
          Object.keys(i.base).length === new Set(i.users).size &&
          i.users.every((u) => Object.hasOwn(i.base, u)),
        { path: ["base"], message: "expected one rev for each person in users" },
      ),
    who: "owner",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      let k = 0;
      for (const u of [...new Set(i.users)]) {
        const r = tx.get(requestKey(i.space, u));
        if (r?.kind !== "request") throw notFound();
        k++;
        // an approval or a reopening acts on the request as the owner saw
        // it: its rev, which every write of the request bumps (a person who
        // asks again reopens it, and so bumps it). A decline applies to the
        // request as it is now. Approving or declining needs the request
        // open, reopening needs it declined.
        if (i.decision !== "decline" && r.rev !== i.base[u]) throw stale();
        if (r.st !== (i.decision === "reopen" ? "declined" : "open"))
          throw refuse("PRECONDITION_FAILED", "This request was already decided.");
        if (i.decision === "approve") {
          if (bannedFrom(tx, i.space, u))
            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");
          tx.put({ ...r, st: "approved", updatedAt: tx.now });
          addMember(tx, i.space, u, "member", tx.id(k));
        } else if (i.decision === "decline") {
          tx.put({ ...r, st: "declined", why: (i.why ?? "").trim(), updatedAt: tx.now });
        } else {
          tx.put({ ...r, st: "open", updatedAt: tx.now });
        }
      }
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // `base.adm`: the member's admission id as the owner saw it. A removal
  // queued before the person was removed and let in again is STALE (review
  // round 1, R1b); the person cannot change the id alone, except by joining
  // an open space again (review round 2, finding 2). A person who is no
  // longer a member: nothing to remove.
  "members.remove": define({
    input: M["members.remove"].input.extend({ space: ulidS, user: handleS }).strict(),
    who: "owner",
    space: (_tx, i) => i.space,
    can: (tx, i) => actsOn(tx, i.user),
    run: (tx, i) => {
      const m = tx.get(memberKey(i.space, i.user));
      if (m?.kind !== "member") return null;
      if (m.adm !== i.base.adm) throw stale();
      tx.del(memberKey(i.space, i.user));
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // A ban applies to the person as they are now, a member or not: it carries
  // no base (review round 2, finding 2). A new ban writes a moderation log
  // entry (`01` C12).
  "members.ban": define({
    input: M["members.ban"].input.extend({ space: ulidS, user: handleS }).strict(),
    who: "owner",
    space: (_tx, i) => i.space,
    can: (tx, i) => actsOn(tx, i.user),
    run: (tx, i) => {
      // the ban's id is the mock's (`<space>:<user>`): one ban per person and
      // space, outside the ULID id registry
      if (tx.get(memberKey(i.space, i.user))) tx.del(memberKey(i.space, i.user));
      if (!tx.get(banKey(i.space, i.user))) {
        tx.put({
          kind: "ban",
          id: `${i.space}:${i.user}`,
          sp: i.space,
          u: i.user,
          createdAt: tx.now,
        });
        tx.create({
          kind: "modlog",
          id: tx.id(1),
          sp: i.space,
          act: "ban",
          item: null,
          by: tx.me,
          author: i.user,
          note: null,
          createdAt: tx.now,
        });
      }
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  "members.unban": define({
    input: M["members.unban"].input.extend({ space: ulidS, user: handleS }).strict(),
    who: "owner",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      if (!tx.get(banKey(i.space, i.user))) return null;
      tx.del(banKey(i.space, i.user));
      tx.create({
        kind: "modlog",
        id: tx.id(1),
        sp: i.space,
        act: "unban",
        item: null,
        by: tx.me,
        author: i.user,
        note: null,
        createdAt: tx.now,
      });
      return null;
    },
  }),

  // -- invite links
  // `days` is bounded in the schema: an input that passes the schema never
  // makes `run` throw (review round 1, R8, where 1e15 days made an invalid
  // date). A mutator turns an input it cannot apply into a refusal; any other
  // exception is a server fault (INTERNAL_SERVER_ERROR, not recorded).
  "invites.create": define({
    input: M["invites.create"].input.extend({ id: ulidS, space: ulidS }).strict(),
    who: "owner",
    space: (_tx, i) => i.space,
    ids: (i) => [i.id],
    // The code is made here, on the server, from its random source. The mock
    // takes it from the id (`id.slice(-5)`), which the client now chooses, so
    // the client would choose the code. 26 characters: 130 bits (`04` B4).
    pre: (ctx) => {
      const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
      for (;;) {
        let code = "";
        for (let k = 0; k < 26; k++) code += B32.charAt(Math.floor(ctx.random() * 32) % 32);
        if (!ctx.inviteCodeTaken(code)) return { code };
      }
    },
    run: (tx, i, v) => {
      const code = v["code"];
      // a client predicting this mutation has no code: its read is unknown
      if (code === undefined) throw refuse("INTERNAL_SERVER_ERROR");
      tx.create({
        kind: "invite",
        id: i.id,
        code,
        by: tx.me,
        sp: i.space,
        expiresAt: isoAt(Date.parse(tx.now) + i.days * DAY),
        dead: null,
        usedBy: null,
        createdAt: tx.now,
      });
      return { id: i.id, code };
    },
  }),

  // -- moderation (no reporting, `01` C12)
  "moderation.decide": define({
    input: M["moderation.decide"].input,
    who: "owner",
    space: (tx, i) => itemOf(tx, i.item).s,
    can: (_tx, i) => {
      if (i.decision === "shown" && i.base === undefined) throw bad("base", "the item's rev");
    },
    run: (tx, i) => {
      const r = itemOf(tx, i.item);
      // "shown" acts on the item as the owner read it: its rev. The author
      // may still edit a hidden item, which bumps the rev, so a "shown" made
      // after reading one text never publishes another (review round 1,
      // R2). Saves and branches change the counts record, not the item.
      // "hidden" and "removed" apply to the item as it is now, whatever its
      // rev (review round 2, finding 2). Hiding needs the item shown, showing
      // needs it hidden, and a removed item stays removed.
      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();
      if (r.mod === "removed") throw removed();
      if (i.decision === "hidden" && r.mod !== null)
        throw refuse("PRECONDITION_FAILED", "This item is already hidden.");
      if (i.decision === "shown" && r.mod !== "hidden")
        throw refuse("PRECONDITION_FAILED", "This item is not hidden.");
      if (i.decision !== "removed") {
        const mod = i.decision === "hidden" ? "hidden" : null;
        tx.put({ ...r, mod });
        // a hidden ask's answer is hidden with it
        const a = r.kind === "thread" || r.kind === "node" ? tx.get(answerKey(r.id)) : undefined;
        if (a?.kind === "answer") tx.put({ ...a, mod });
        return null;
      }
      const note = (i.note ?? "").trim() || null;
      erase(tx, r, note);
      // the moderation log names the item's kind, author and space, and
      // keeps no text of it
      tx.create({
        kind: "modlog",
        id: tx.id(1),
        sp: r.s,
        act: "remove",
        item: i.item,
        by: tx.me,
        author: r.u ?? "",
        note,
        createdAt: tx.now,
      });
      return null;
    },
    // a thread's removal notifies its author, with the reason and no text
    notify: (tx, i) => {
      if (i.decision !== "removed") return;
      const [k, th] = i.item.split(":");
      if ((k !== "a" && k !== "p") || !th) return;
      const p = tx.get(threadKey(th));
      if (p?.kind !== "thread" || p.u === null) return;
      new Notifier(tx).send(p.u, "removed", p.s, p.id, threadKey(p.id), p.modNote);
    },
  }),

  // -- notifications and preferences
  "notifications.markRead": define({
    input: M["notifications.markRead"].input.extend({ id: ulidS }).strict(),
    who: "user",
    // the person's own notification, while they may read its space
    space: (tx, i) => {
      const n = tx.get(`notif:${i.id}`);
      if (n?.kind !== "notif" || n.to !== tx.me || !canRead(tx, n, tx.me)) throw notFound();
      return n.sp;
    },
    run: (tx, i) => {
      const n = tx.get(`notif:${i.id}`) as NotifRec;
      if (!n.read) tx.put({ ...n, read: true });
      return null;
    },
  }),

  // the layout toggle, kept in the person's user log (`01` C13)
  "prefs.set": define({
    input: M["prefs.set"].input,
    who: "user",
    run: (tx, i) => {
      const old = tx.get(prefsKey(tx.me));
      if (old?.kind !== "prefs" || old.layout !== i.layout)
        tx.put({ kind: "prefs", u: tx.me, layout: i.layout });
      return null;
    },
  }),
});

export const mutatorNames = Object.keys(MUTATORS);
