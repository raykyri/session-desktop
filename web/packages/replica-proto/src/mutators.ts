// Mutator definitions: the mock's PROCS (section 5b) ported to multi-user
// records, in the three stages AGENTS.md sets:
//
// 1. `pre` (server only): checks and values the client cannot have, such as
//    an invite code. It may refuse. It is the only stage with a random source.
// 2. `can` and `run`: deterministic over a synchronous `tx`. They read the
//    time from `tx.now`, never the clock, use no random source and no `Intl`,
//    and make no ids: the first id comes in the input and later ones from
//    `tx.id(ordinal)`. `run` writes the stored shape, counts included.
// 3. `post` (server only): the effects to run after the commit
//    (notifications and jobs), as data. The server queues them in the same
//    commit as the write and runs them after it, retrying until they
//    succeed; an effect's failure never changes the write's answer.
//
// `space(tx, input)` names the space the write acts in, reading the target
// (NOT_FOUND when it does not exist or the actor may not read it, with one
// answer for both), or null when the write touches no space. In that space,
// `authorize` refuses a banned person every write, then checks `who`, the
// role the actor needs (the mock's `who`).
//
// A write that acts on another record carries `base.rev`, the rev of that
// record as the client saw it, and is refused with STALE when the rev differs:
// a join request (`joinRequests.decide`, one rev per person), a moderated
// item (`moderation.decide`), a member record (`members.setRole`,
// `members.remove`, `members.ban`; 0 for a person with no member record) and
// a thread (`threads.update`). A state check alone is not enough: a request
// that was approved, then reopened by its person asking again, is open again,
// and an approval made for the first request would admit them (review round
// 1, R1). With the rev matching, a decision the record's state does not allow
// is PRECONDITION_FAILED.
//
// Input schemas are strict: a field the schema does not list (`likes`, `u`,
// `createdAt`, `code`) is BAD_REQUEST, never stored.

import { spaces } from "@session/shared";
import { z } from "zod";

import {
  RANK,
  bannedFrom,
  canRead,
  isClosed,
  isModOf,
  rankIn,
  roleIn,
  spaceRec,
  type Reader,
} from "./access.js";
import type { ApiError, ErrorCode } from "./contract.js";
import {
  banKey,
  likeKey,
  memberKey,
  requestKey,
  saveKey,
  statsKey,
  threadKey,
  type Draft,
  type FollowUpRec,
  type Kind,
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
  OUT_OF_ORDER: "This change arrived out of order.",
  WRONG_CLIENT: "This device isn’t signed in to your account.",
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
/** A record's rev, or 0 when there is none. */
const revOf = (tx: Tx, key: string) => tx.get(key)?.rev ?? 0;
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

/** A post-commit effect, as the server's effect queue holds it. It carries
 * ids and keys only, no text, so the queue keeps nothing a removal must
 * erase.
 * - `job`: start a server job (here: a run of an ask).
 * - `notifyStaff`: notify the space's staff (owner, admins, moderators, as
 *   they are when the effect runs) of a report. */
export type Effect =
  | { type: "job"; kind: string; id: string }
  | { type: "notifyStaff"; sp: string; report: string; item: string };

/** The notification a `notifyStaff` effect writes for one person. */
export type NotifDraft = Omit<NotifRec, "kind" | "id" | "rev" | "createdAt" | "read">;

export type Who = "user" | "member" | "moderator" | "admin" | "owner" | "author";

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
  post?: (i: I, result: unknown) => Effect[];
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
    // edits and deletes and a person's own likes and saves included.
    if (bannedFrom(tx, sp, tx.me)) throw refuse("FORBIDDEN", "You are banned from this space.");
    const who = def.who;
    if (who === "member") {
      if (isClosed(s) && roleIn(tx, sp, tx.me) === null) throw refuse("FORBIDDEN");
    } else if (who !== "user" && who !== "author") {
      const need = who === "moderator" ? RANK.mod : RANK[who];
      if (rankIn(tx, sp, tx.me) < need) throw refuse("FORBIDDEN");
    }
  } else if (def.who !== "user" && def.who !== "author") {
    throw refuse("INTERNAL_SERVER_ERROR");
  }
  def.can?.(tx, input);
}

// ---- shared rules ----

/** The shared id schema, narrowed to ULIDs whose time fits 48 bits. */
const ulidS = spaces.spaceUlidSchema.regex(ULID_RE);
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
/** The rev of the record a write acts on, as the client saw it. */
const baseS = z.strictObject({ rev: count });
/** The longest an invite link lasts, in days. */
export const INVITE_MAX_DAYS = 30;

const text = (v: string, path: string) => {
  const s = v.trim();
  if (!s) throw bad(path, "some text");
  return s;
};

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

/** The staff list (the space's `mods`) from its member records: by rank, then handle. */
function staffOf(tx: Tx, sp: string): [string, SpaceRole][] {
  return tx
    .find("member", (m) => m.sp === sp && m.role !== "member")
    .sort((a, b) => RANK[b.role] - RANK[a.role] || (a.u < b.u ? -1 : a.u > b.u ? 1 : 0))
    .map((m) => [m.u, m.role]);
}

/** Write a space's stored member count and staff list after its member records changed. */
function refreshSpace(tx: Tx, sp: string): void {
  const s = needSpace(tx, sp);
  const members = tx.find("member", (m) => m.sp === sp).length;
  tx.put({ ...s, members, mods: staffOf(tx, sp) });
}

function addMember(tx: Tx, sp: string, u: string, role: SpaceRole): void {
  if (tx.get(memberKey(sp, u))) return;
  tx.put({ kind: "member", sp, u, role, joinedAt: tx.now });
}

/** The mock's cxCanAct (`actsOn`): you act on members ranked below you; owners
 * and admins also act on admins; nobody acts on the owner or on themselves. */
function actsOn(tx: Tx, sp: string, u: string): void {
  const m = tx.get(memberKey(sp, u));
  const role: SpaceRole = m?.kind === "member" ? m.role : "member";
  const mine = rankIn(tx, sp, tx.me);
  if (u === tx.me) throw refuse("FORBIDDEN", "You can’t change your own membership here.");
  if (role === "owner") throw refuse("FORBIDDEN");
  const ok = role === "admin" ? mine >= RANK.admin : mine > RANK[role];
  if (!ok) throw refuse("FORBIDDEN");
}

/** Who makes invite links: moderators; in a closed space whose invite setting
 * is "members", its members (the mock's `invites`). */
function mayInvite(g: Reader, s: SpaceRec, u: string): boolean {
  return (
    isModOf(g, s.id, u) || (isClosed(s) && s.invite === "members" && roleIn(g, s.id, u) !== null)
  );
}

/** The record a moderation key names (`a:<thread>`, `p:<thread>`,
 * `f:<thread>:<follow-up>`, `r:<thread>:<reply>`), if the actor may read it.
 * The mock's reply keys use reply paths; here they use reply ids. */
function itemOf(tx: Tx, key: string): ThreadRec | FollowUpRec | ReplyRec {
  const [k, th, sub, ...rest] = key.split(":");
  if (!th || rest.length) throw notFound();
  if (k === "a" || k === "p") {
    if (sub !== undefined) throw notFound();
    const p = readableThread(tx, th);
    if ((k === "a") !== (p.k === "ask")) throw notFound();
    return p;
  }
  if ((k === "f" || k === "r") && sub) {
    const r = readable(
      tx,
      `${k === "f" ? "followup" : "reply"}:${sub}`,
      k === "f" ? "followup" : "reply",
    );
    if (r.th !== th) throw notFound();
    return r;
  }
  throw notFound();
}

/** Remove a moderated item for good: its text is erased from storage, and so
 * is everything under it (a thread's follow-ups, answers, runs and replies; a
 * top-level reply's replies). The item stays as a placeholder. */
function erase(tx: Tx, r: ThreadRec | FollowUpRec | ReplyRec): void {
  switch (r.kind) {
    case "thread":
      for (const x of tx.find("followup", (y) => y.th === r.id)) tx.del(`followup:${x.id}`);
      for (const x of tx.find("reply", (y) => y.th === r.id)) tx.del(`reply:${x.id}`);
      for (const x of tx.find("run", (y) => y.th === r.id)) tx.del(`run:${x.id}`);
      tx.put({
        ...r,
        q: "",
        t: null,
        sum: null,
        r: 0,
        running: false,
        mod: "removed",
        updatedAt: tx.now,
      });
      return;
    case "followup":
      tx.put({ ...r, q: "", a: null, mod: "removed" });
      return;
    case "reply":
      if (r.parent === null)
        for (const x of tx.find("reply", (y) => y.parent === r.id)) tx.del(`reply:${x.id}`);
      tx.put({ ...r, t: "", mod: "removed" });
      return;
  }
}

// ---- input schemas: the shared schemas, with the first id and strict ----

const settingsS = spaces.spaceSettingsSchema
  .pick({
    name: true,
    title: true,
    desc: true,
    rules: true,
    vis: true,
    policy: true,
    qs: true,
    invite: true,
    postsOff: true,
  })
  .strict();

const normQs = (qs: { q: string; req?: boolean | undefined }[]) =>
  qs.filter((q) => q.q.trim()).map((q) => ({ q: q.q.trim(), req: q.req === true }));
const normRules = (rules: string[]) => rules.map((r) => r.trim()).filter(Boolean);

/** The space of the thread a like or save names, for taking one back: null
 * when the person has none (nothing is written), so taking back a like or a
 * save needs no read access and answers the same whether or not the thread
 * exists. */
function ownMarkSpace(tx: Tx, key: string, thread: string): string | null {
  if (!tx.get(key)) return null;
  const p = tx.get(threadKey(thread));
  return p?.kind === "thread" ? p.s : null;
}

// ---- the mutators ----

export const MUTATORS: Readonly<Record<string, AnyMutator>> = Object.freeze({
  // -- spaces
  // Space names are unique across all spaces, unlisted ones included (kept
  // as decided; review round 1, R10): the CONFLICT on create tells anyone
  // that a name is taken, so an unlisted space's name can be probed. It
  // names only the name sent.
  "spaces.create": define({
    input: spaces.createSpaceInputSchema.omit({ faq: true }).extend({ id: ulidS }).strict(),
    online: true,
    who: "user",
    ids: (i) => [i.id],
    run: (tx, i) => {
      const name = slug(i.name);
      if (!name) throw bad("name", "a name");
      if (tx.find("space", (s) => s.name === name).length)
        throw refuse("CONFLICT", `#${name} already exists.`);
      const vis = i.vis ?? "open";
      const closed = vis !== "open";
      const rules = normRules(i.rules ?? []);
      tx.create({
        kind: "space",
        id: i.id,
        name,
        title: name,
        desc: (i.desc ?? "").trim() || "No description yet.",
        rules: rules.length ? rules : ["Be specific in asks."],
        rulesRev: 0,
        vis,
        policy: closed ? (i.policy ?? "request") : null,
        invite: closed ? (i.invite ?? "mods") : null,
        qs: closed ? normQs(i.qs ?? []) : [],
        postsOff: false,
        members: 1,
        mods: [[tx.me, "owner"]],
        createdAt: tx.now,
      });
      tx.put({ kind: "stats", sp: i.id, posts: 0, updatedAt: tx.now });
      addMember(tx, i.id, tx.me, "owner");
      return { id: i.id };
    },
  }),

  "spaces.update": define({
    input: z.strictObject({
      id: ulidS,
      set: settingsS.optional(),
      base: z.strictObject({ rulesRev: count }).optional(),
      force: z.boolean().optional(),
    }),
    who: "admin",
    space: (_tx, i) => i.id,
    run: (tx, i) => {
      const s0 = needSpace(tx, i.id);
      const set = i.set ?? {};
      let name = s0.name;
      if (set.name !== undefined) {
        name = slug(set.name);
        if (!name) throw bad("set.name", "a name");
        if (name !== s0.name && tx.find("space", (s) => s.name === name).length)
          throw refuse("CONFLICT", `#${name} already exists.`);
      }
      const rules = set.rules ? normRules(set.rules) : s0.rules;
      const rulesChange = rules.join("\n") !== s0.rules.join("\n");
      if (rulesChange && i.base && !i.force && i.base.rulesRev !== s0.rulesRev)
        throw refuse("CONFLICT", "Someone else changed the rules first.");
      const vis = set.vis ?? s0.vis;
      const closed = vis !== "open";
      tx.put({
        ...s0,
        name,
        title: set.title ?? s0.title,
        desc: set.desc ?? s0.desc,
        rules,
        rulesRev: s0.rulesRev + (rulesChange ? 1 : 0),
        vis,
        policy: closed ? (set.policy ?? s0.policy ?? "request") : null,
        invite: closed ? (set.invite ?? s0.invite ?? "mods") : null,
        qs: closed ? (set.qs ? normQs(set.qs) : s0.qs) : [],
        postsOff: set.postsOff ?? s0.postsOff,
      });
      // a closed space that becomes open: the open requests are approved
      if (isClosed(s0) && !closed) {
        for (const r of tx.find("request", (x) => x.sp === s0.id && x.st === "open")) {
          tx.put({ ...r, st: "approved", updatedAt: tx.now });
          if (!bannedFrom(tx, s0.id, r.u)) addMember(tx, s0.id, r.u, "member");
        }
        refreshSpace(tx, s0.id);
      }
      return null;
    },
  }),

  "spaces.join": define({
    input: z.strictObject({ space: ulidS, invite: z.string().optional() }),
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
        throw refuse(
          "FORBIDDEN",
          `#${s.name} is closed: joining it needs an invite or a request a moderator approved.`,
        );
      const link = tx.find("invite", (l) => l.code === i.invite)[0];
      // DESIGN (phase 0 finding): a link carries its maker's authority, so it
      // works only while the maker may make links (checked now, at apply
      // time). A link that stopped working because its maker lost that right
      // works again once the maker has it again. The mock keeps a removed
      // member's links working.
      const live =
        link !== undefined &&
        link.sp === s.id &&
        link.dead === null &&
        (link.expiresAt === null || Date.parse(link.expiresAt) > Date.parse(tx.now)) &&
        mayInvite(tx, s, link.by);
      if (!live) throw refuse("FORBIDDEN", "This invite link has expired or was already used.");
    },
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (roleIn(tx, s.id, tx.me)) return null;
      if (isClosed(s) && i.invite !== undefined) {
        const link = tx.find("invite", (l) => l.code === i.invite)[0];
        if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });
      }
      addMember(tx, s.id, tx.me, "member");
      refreshSpace(tx, s.id);
      return null;
    },
  }),

  "spaces.leave": define({
    input: z.strictObject({ space: ulidS }),
    who: "member",
    space: (_tx, i) => i.space,
    can: (tx, i) => {
      const sole =
        roleIn(tx, i.space, tx.me) === "owner" &&
        !tx.find("member", (m) => m.sp === i.space && m.role === "owner" && m.u !== tx.me).length;
      if (sole)
        throw refuse(
          "PRECONDITION_FAILED",
          "You are the only owner of this space. Transfer ownership before you leave.",
        );
    },
    run: (tx, i) => {
      if (!tx.get(memberKey(i.space, tx.me))) return null;
      tx.del(memberKey(i.space, tx.me));
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // -- threads, follow-ups and replies
  "threads.create": define({
    input: spaces.createThreadInputSchema
      .pick({ kind: true, q: true, title: true })
      .extend({ id: ulidS, space: ulidS })
      .strict(),
    who: "member",
    space: (_tx, i) => i.space,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (i.kind === "post" && s.postsOff)
        throw refuse("PRECONDITION_FAILED", "Posts are turned off in this space.");
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
        likes: 0,
        r: 0,
        running: ask,
        edited: false,
        del: false,
        gone: false,
        mod: null,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      const stats = tx.get(statsKey(s.id));
      if (stats?.kind === "stats") tx.put({ ...stats, posts: stats.posts + 1, updatedAt: tx.now });
      if (!ask) return { id: i.id, run: null };
      const run = tx.id(1);
      tx.create({
        kind: "run",
        id: run,
        th: i.id,
        s: s.id,
        u: tx.me,
        node: "r",
        status: "queued",
        attempt: 1,
        createdAt: tx.now,
      });
      return { id: i.id, run };
    },
    post: (_i, result) => {
      const run = (result as { run: string | null }).run;
      return run ? [{ type: "job", kind: "run", id: run }] : [];
    },
  }),

  "threads.update": define({
    input: spaces.updateThreadInputSchema
      .pick({ id: true, q: true })
      .extend({ id: ulidS, base: z.strictObject({ rev: count }) })
      .strict(),
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
    input: z.strictObject({ id: ulidS }),
    who: "author",
    // the author may delete their thread without read access: a person
    // removed from a closed space can still delete what they wrote there
    space: (tx, i) => {
      const p = tx.get(threadKey(i.id));
      if (p?.kind !== "thread") throw notFound();
      return p.u === tx.me ? p.s : readableThread(tx, i.id).s;
    },
    can: (tx, i) => {
      if ((tx.get(threadKey(i.id)) as ThreadRec).u !== tx.me)
        throw refuse("FORBIDDEN", "Only the person who wrote this can change it.");
    },
    // Kept as the mock has it (review round 1, R11): a thread deleted while
    // it has follow-ups or replies stays as a shell (`del`), and follow-ups,
    // replies and likes on it are taken as on any thread. A thread with none
    // is `gone`; it leaves every Saved and every like. The author may delete
    // a thread a moderator removed: its count `r` is 0 then, so it is gone,
    // and other people's saves of it are deleted too.
    run: (tx, i) => {
      const p = tx.get(threadKey(i.id)) as ThreadRec;
      const kept = p.r > 0;
      // an author who may no longer read the thread (removed from its closed
      // space) learns nothing about it: whether it got follow-ups or replies
      // after they left is not in the answer (R4b)
      const reads = canRead(tx, p, tx.me);
      // a thread without follow-ups or replies is gone: it leaves Saved and likes
      if (!kept) {
        for (const l of tx.find("like", (x) => x.th === p.id)) tx.del(likeKey(l.u, l.th));
        for (const x of tx.find("save", (y) => y.th === p.id)) tx.del(saveKey(x.u, x.th));
      }
      for (const r of tx.find("run", (x) => x.th === p.id)) tx.del(`run:${r.id}`);
      tx.put({
        ...p,
        q: "",
        t: null,
        edited: false,
        running: false,
        del: true,
        gone: !kept,
        sum: kept ? p.sum : null,
        likes: kept ? p.likes : 0,
        updatedAt: tx.now,
      });
      return reads ? { kept } : null;
    },
  }),

  "likes.set": define({
    input: z.strictObject({ thread: ulidS, on: z.boolean() }),
    who: "user",
    space: (tx, i) =>
      i.on ? readableThread(tx, i.thread).s : ownMarkSpace(tx, likeKey(tx.me, i.thread), i.thread),
    can: (tx, i) => {
      if (!i.on || tx.get(likeKey(tx.me, i.thread))) return;
      if (readableThread(tx, i.thread).mod === "removed") throw removed();
    },
    run: (tx, i) => {
      const key = likeKey(tx.me, i.thread);
      const had = tx.get(key) !== undefined;
      if (i.on === had) return { on: i.on };
      const p = tx.get(threadKey(i.thread));
      if (i.on) tx.put({ kind: "like", u: tx.me, th: i.thread, createdAt: tx.now });
      else tx.del(key);
      if (p?.kind === "thread") tx.put({ ...p, likes: Math.max(0, p.likes + (i.on ? 1 : -1)) });
      return { on: i.on };
    },
  }),

  // The mock's saved.toggle, with a required `on`: the result depends on what
  // the client saw, not on the server's state, so two devices that save the
  // same thread do not cancel out.
  "saved.set": define({
    input: z.strictObject({ kind: z.literal("thread"), id: ulidS, on: z.boolean() }),
    who: "user",
    space: (tx, i) =>
      i.on ? readableThread(tx, i.id).s : ownMarkSpace(tx, saveKey(tx.me, i.id), i.id),
    run: (tx, i) => {
      const key = saveKey(tx.me, i.id);
      const had = tx.get(key) !== undefined;
      if (i.on && !had) tx.put({ kind: "save", u: tx.me, th: i.id, createdAt: tx.now });
      if (!i.on && had) tx.del(key);
      return { on: i.on };
    },
  }),

  "followups.ask": define({
    input: z.strictObject({ id: ulidS, thread: ulidS, q: z.string() }),
    who: "member",
    space: (tx, i) => readableThread(tx, i.thread).s,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.k !== "ask") throw bad("thread", "an ask thread");
      if (p.mod === "removed") throw removed();
      const q = text(i.q, "q");
      tx.create({
        kind: "followup",
        id: i.id,
        th: p.id,
        s: p.s,
        u: tx.me,
        q,
        a: null,
        mod: null,
        createdAt: tx.now,
      });
      tx.put({ ...p, r: p.r + 1 });
      return null;
    },
  }),

  /** A reply to a post (the mock's name for replies.create). */
  "research.createPostFollowUp": define({
    input: z.strictObject({ id: ulidS, thread: ulidS, t: z.string(), parent: ulidS.optional() }),
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
      if (i.parent === undefined) tx.put({ ...p, r: p.r + 1 });
      return null;
    },
  }),

  // -- join requests and members
  "joinRequests.create": define({
    input: spaces.spaceProcedures["joinRequests.create"].input.extend({ space: ulidS }).strict(),
    who: "user",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (!isClosed(s)) throw refuse("PRECONDITION_FAILED", "This space is open: join it instead.");
      if (s.policy === "invite")
        throw refuse(
          "PRECONDITION_FAILED",
          "This space is invite only: ask for an invite instead.",
        );
      if (roleIn(tx, s.id, tx.me))
        throw refuse("PRECONDITION_FAILED", "You are a member of this space.");
      const a = i.answers ?? [];
      const issues = s.qs.flatMap((q, k) =>
        q.req && !(a[k] ?? "").trim() ? [`input.answers[${k}]: expected an answer (required)`] : [],
      );
      if (s.rules.length && i.rulesAccepted !== true)
        issues.push("input.rulesAccepted: expected true");
      if (issues.length) throw refuse("BAD_REQUEST", undefined, issues);
      const old = tx.get(requestKey(s.id, tx.me));
      tx.put({
        kind: "request",
        sp: s.id,
        u: tx.me,
        st: "open",
        a,
        why: null,
        createdAt: old?.kind === "request" ? old.createdAt : tx.now,
        updatedAt: tx.now,
      });
      return null;
    },
  }),

  "joinRequests.decide": define({
    input: spaces.decideRequestsInputSchema
      .extend({
        space: ulidS,
        users: z.array(handleS).min(1),
        /** Each request's rev as the moderator saw it, by person: one entry
         * for every person in `users` and no other. */
        base: z.record(handleS, count),
      })
      .strict()
      .refine(
        (i) =>
          Object.keys(i.base).length === new Set(i.users).size &&
          i.users.every((u) => Object.hasOwn(i.base, u)),
        { path: ["base"], message: "expected one rev for each person in users" },
      ),
    who: "moderator",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      for (const u of [...new Set(i.users)]) {
        const r = tx.get(requestKey(i.space, u));
        if (r?.kind !== "request") throw notFound();
        // a decision acts on the request as the moderator saw it: its rev,
        // which every write of the request bumps (a person who asks again
        // reopens it, and so bumps it). With the rev matching, approving or
        // declining needs the request open, reopening needs it declined.
        if (r.rev !== i.base[u]) throw stale();
        if (r.st !== (i.decision === "reopen" ? "declined" : "open"))
          throw refuse("PRECONDITION_FAILED", "This request was already decided.");
        if (i.decision === "approve") {
          if (bannedFrom(tx, i.space, u))
            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");
          tx.put({ ...r, st: "approved", updatedAt: tx.now });
          addMember(tx, i.space, u, "member");
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

  "members.setRole": define({
    input: z.strictObject({
      space: ulidS,
      user: handleS,
      role: spaces.spaceMemberRoleSchema,
      /** The member record's rev as the actor saw it. */
      base: baseS,
    }),
    who: "admin",
    space: (_tx, i) => i.space,
    can: (tx, i) => {
      if (i.role === "owner" && roleIn(tx, i.space, tx.me) !== "owner")
        throw refuse("FORBIDDEN", "Only the owner can transfer ownership.");
      actsOn(tx, i.space, i.user);
      if (i.role !== "owner" && RANK[i.role] > rankIn(tx, i.space, tx.me))
        throw refuse("FORBIDDEN", "You can’t give a role higher than your own.");
    },
    run: (tx, i) => {
      const m = tx.get(memberKey(i.space, i.user));
      if (revOf(tx, memberKey(i.space, i.user)) !== i.base.rev) throw stale();
      if (m?.kind !== "member")
        throw refuse("NOT_FOUND", "This person is not a member of the space.");
      tx.put({ ...m, role: i.role });
      if (i.role === "owner") {
        const me = tx.get(memberKey(i.space, tx.me));
        if (me?.kind === "member") tx.put({ ...me, role: "admin" });
      }
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // `base.rev`: the member record's rev as the moderator saw it (0: no member
  // record). A removal queued before the person was removed and let in again
  // is STALE (review round 1, R1b).
  "members.remove": define({
    input: z.strictObject({ space: ulidS, user: handleS, base: baseS }),
    who: "moderator",
    space: (_tx, i) => i.space,
    can: (tx, i) => actsOn(tx, i.space, i.user),
    run: (tx, i) => {
      if (revOf(tx, memberKey(i.space, i.user)) !== i.base.rev) throw stale();
      if (!tx.get(memberKey(i.space, i.user))) return null;
      tx.del(memberKey(i.space, i.user));
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  "members.ban": define({
    input: z.strictObject({ space: ulidS, user: handleS, base: baseS }),
    who: "moderator",
    space: (_tx, i) => i.space,
    can: (tx, i) => actsOn(tx, i.space, i.user),
    run: (tx, i) => {
      if (revOf(tx, memberKey(i.space, i.user)) !== i.base.rev) throw stale();
      // the ban's id is the mock's (`<space>:<user>`): one ban per person and
      // space, outside the ULID id registry
      if (tx.get(memberKey(i.space, i.user))) tx.del(memberKey(i.space, i.user));
      if (!tx.get(banKey(i.space, i.user)))
        tx.put({
          kind: "ban",
          id: `${i.space}:${i.user}`,
          sp: i.space,
          u: i.user,
          createdAt: tx.now,
        });
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // -- invite links
  // `days` is bounded in the schema: an input that passes the schema never
  // makes `run` throw (review round 1, R8, where 1e15 days made an invalid
  // date). A mutator turns an input it cannot apply into a refusal; any other
  // exception is a server fault (INTERNAL_SERVER_ERROR, not recorded).
  "invites.create": define({
    input: z.strictObject({
      id: ulidS,
      space: ulidS,
      days: count.max(INVITE_MAX_DAYS).nullable().optional(),
    }),
    who: "member",
    space: (_tx, i) => i.space,
    ids: (i) => [i.id],
    can: (tx, i) => {
      if (!mayInvite(tx, needSpace(tx, i.space), tx.me)) throw refuse("FORBIDDEN");
    },
    // The code is made here, on the server, from its random source. The mock
    // takes it from the id (`id.slice(-5)`), which the client now chooses, so
    // the client would choose the code. 10 characters: 50 bits.
    pre: (ctx) => {
      const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
      for (;;) {
        let code = "";
        for (let k = 0; k < 10; k++) code += B32.charAt(Math.floor(ctx.random() * 32) % 32);
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
        expiresAt: i.days ? isoAt(Date.parse(tx.now) + i.days * DAY) : null,
        dead: null,
        usedBy: null,
        createdAt: tx.now,
      });
      return { id: i.id, code };
    },
  }),

  // -- reports and moderation
  "reports.create": define({
    input: z.strictObject({
      id: ulidS,
      item: spaces.moderationKeySchema,
      why: z.string(),
      note: z.string().optional(),
    }),
    who: "member",
    space: (tx, i) => itemOf(tx, i.item).s,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const item = itemOf(tx, i.item);
      const why = text(i.why, "why");
      tx.create({
        kind: "report",
        id: i.id,
        sp: item.s,
        key: i.item,
        by: tx.me,
        st: "open",
        why,
        note: (i.note ?? "").trim(),
        createdAt: tx.now,
      });
      return { id: i.id, sp: item.s };
    },
    // the space's staff get a notification (server-made ids)
    post: (i, result) => {
      const { id, sp } = result as { id: string; sp: string };
      return [{ type: "notifyStaff", sp, report: id, item: i.item }];
    },
  }),

  "moderation.decide": define({
    input: spaces.spaceProcedures["moderation.decide"].input.extend({ base: baseS }).strict(),
    who: "moderator",
    space: (tx, i) => itemOf(tx, i.item).s,
    run: (tx, i) => {
      const r = itemOf(tx, i.item);
      // a decision acts on the item as the moderator read it: its rev. The
      // author may still edit a hidden item, which bumps the rev, so a
      // "shown" made after reading one text never publishes another (review
      // round 1, R2). With the rev matching: hiding needs the item shown,
      // showing needs it hidden, and a removed item stays removed (the mock's
      // reports.resolve "open" restores both).
      if (r.rev !== i.base.rev) throw stale();
      if (r.mod === "removed") throw removed();
      if (i.decision === "hidden" && r.mod !== null)
        throw refuse("PRECONDITION_FAILED", "This item is already hidden.");
      if (i.decision === "shown" && r.mod !== "hidden")
        throw refuse("PRECONDITION_FAILED", "This item is not hidden.");
      if (i.decision === "removed") erase(tx, r);
      else tx.put({ ...r, mod: i.decision === "hidden" ? "hidden" : null });
      return null;
    },
  }),
});

export const mutatorNames = Object.keys(MUTATORS);
