// Roles and read scope: the mock's section 5a (`roleIn`, `readsSpace`,
// `readScope`) over multi-user records, with the owner's decisions of phase
// 0b, the reviews and the implementation plan (`01` C12, C18; `04` §6). The
// mutators read through these rules (a target the actor may not read is
// NOT_FOUND), and a server half filters every snapshot and pull with them.
//
// Roles: a space has one owner, for its lifetime, and members (`01` C18).
//
// Read rules:
// - Space records (the landing: name, About, owner, member count) are public.
// - An open space's content (threads and their counts, nodes, answers,
//   replies, comments, runs, its `stats` record and its member list) is
//   readable by anyone, signed out included; a private space's by its
//   members only. A non-member gets none of a private space's content, the
//   threads they wrote included, and no further updates of it.
// - Join requests (prototype only): the person's own, and all of them for
//   the space's owner. Bans: the banned person's own (in their user log, so
//   that their client learns of the ban), and all of them for the space's
//   owner. A ban holds the space, the person and its time, and no field
//   naming who banned them, so it is served unredacted. Invite links and
//   the moderation log: the space's owner only.
// - A person reads their own membership records (in their user log).
// - A person's saves, notifications and preferences: that person only;
//   saves and notifications only while they may read the space the record is
//   about (a save's thread's space; a notification's space). A person
//   removed from a private space is no longer served their saves and
//   notifications there, nor their deletions (review round 1, R4a and R4c).
// - Text of a hidden thread, node, reply or comment, and the answer of a
//   hidden thread or node: its author and the space's owner. Every other reader gets the placeholder (`redact`). A
//   removed item's text is erased from storage, so nobody gets it, and a
//   removed thread's author (`u`) is served to the author only (`04` §6.2).
//   Hiding a thread blanks that thread's own text only; what is under it is
//   moderated item by item (kept as the mock has it; review round 1, R14).
//
// DESIGN (phase 0 finding): who may read a record depends only on its
// audience (`Audience`: kind, space, person and maker, which never change),
// the reader's role in that space, and whether the space is private. Whether
// its text is redacted depends on its moderation state as well. A pull can
// then leave out every record the reader may not read without sending a
// `del` for it (which would expose its key: for a member record, who left a
// private space), and a change of moderation state reaches readers as a
// `put` of the record as they may read it now. The scope changes only when
// the reader's own membership changes or a log's history is replaced; the
// server answers both with a resync. A tombstone keeps the audience only, so
// who gets a `del` is decided by the same rule.

import type {
  AnswerRec,
  CommentRec,
  Kind,
  NodeRec,
  ReplyRec,
  SpaceRec,
  SpaceRole,
  StoredRecord,
  ThreadRec,
  TurnRec,
} from "./records.js";
import { banKey, memberKey, personOf, spaceKey, spaceOf, threadKey } from "./records.js";

export interface Reader {
  /** The record at `key`, or undefined. A replica throws `UnknownRead` for a
   * key outside its working set (`tx.ts`). */
  byKey(key: string): StoredRecord | undefined;
}

export const isClosed = (s: SpaceRec) => s.vis !== "open";

export function spaceRec(g: Reader, sp: string): SpaceRec | undefined {
  const s = g.byKey(spaceKey(sp));
  return s?.kind === "space" ? s : undefined;
}

/** A person's role in a space: their member record's role, or null. */
export function roleIn(g: Reader, sp: string, u: string | null): SpaceRole | null {
  if (u === null) return null;
  const m = g.byKey(memberKey(sp, u));
  return m?.kind === "member" ? m.role : null;
}

/** Whether `u` is the space's owner (by their member record). */
export const isOwnerOf = (g: Reader, sp: string, u: string | null) => roleIn(g, sp, u) === "owner";

export const bannedFrom = (g: Reader, sp: string, u: string) =>
  g.byKey(banKey(sp, u)) !== undefined;

/** May `u` read a space's content (threads and their counts, nodes, answers,
 * replies, comments, runs, stats, member list). */
export function readsSpace(g: Reader, sp: string, u: string | null): boolean {
  const s = spaceRec(g, sp);
  if (!s) return false;
  return !isClosed(s) || roleIn(g, sp, u) !== null;
}

/** The fields that decide who reads a record: the part of it a tombstone
 * keeps. `sp` is the space whose rules apply: the record's own space, for a
 * save its thread's space, and for a notification the space it is about.
 * `person` is the person whose user log holds it; `by` its author or maker. */
export interface Audience {
  kind: Kind;
  sp: string | null;
  person: string | null;
  by: string | null;
}

export function audience(g: Reader, r: StoredRecord): Audience {
  let sp = spaceOf(r);
  if (r.kind === "save") {
    const p = g.byKey(threadKey(r.th));
    sp = p?.kind === "thread" ? p.s : null;
  }
  if (r.kind === "notif") sp = r.sp;
  const by = "by" in r ? r.by : "u" in r ? r.u : null;
  return { kind: r.kind, sp, person: personOf(r), by };
}

/** May `u` read a record with this audience (its text is `redact`'s job). */
export function readsAudience(g: Reader, a: Audience, u: string | null): boolean {
  const sp = a.sp;
  const own = u !== null && a.person === u;
  switch (a.kind) {
    case "space":
      return true;
    case "member":
      // a person reads their own membership in their user log
      return own || (sp !== null && readsSpace(g, sp, u));
    case "stats":
    case "thread":
    case "counts":
    case "node":
    case "reply":
    case "comment":
    case "run":
    case "turn":
    case "answer":
      return sp !== null && readsSpace(g, sp, u);
    case "request":
    case "ban":
      return own || (sp !== null && isOwnerOf(g, sp, u));
    case "invite":
    case "modlog":
      return sp !== null && isOwnerOf(g, sp, u);
    case "save":
    case "notif":
      return own && (sp === null || readsSpace(g, sp, u));
    case "prefs":
      return own;
  }
}

/** May `u` read the record at all (its audience; text is `redact`'s job). */
export function canRead(g: Reader, r: StoredRecord, u: string | null): boolean {
  return readsAudience(g, audience(g, r), u);
}

/** A moderated record as `u` may read it: a hidden one keeps its text for its
 * author and the space's owner; everyone else, and every reader of a removed
 * one, gets the placeholder. A removed thread's author is served to the
 * author only. */
export function redact(g: Reader, r: StoredRecord, u: string | null): StoredRecord {
  if (r.kind === "turn") {
    // a turn has no moderation state of its own: it follows the ask it
    // belongs to, as its answer does (`turnItem`)
    const item = turnItem(g, r);
    if (item?.mod === null) return r;
    if (item === undefined) return { ...r, blocks: [] } satisfies TurnRec;
    if (item.mod === "hidden" && ((u !== null && item.u === u) || isOwnerOf(g, r.s, u))) return r;
    return { ...r, blocks: [] } satisfies TurnRec;
  }
  if (!("mod" in r) || r.mod === null) return r;
  const author = u !== null && r.u === u;
  if (r.mod === "hidden" && (author || isOwnerOf(g, r.s, u))) return r;
  switch (r.kind) {
    case "thread":
      return {
        ...r,
        q: "",
        t: null,
        sum: null,
        u: r.mod === "removed" && !author ? null : r.u,
      } satisfies ThreadRec;
    case "node":
      return { ...r, q: "", look: null, quote: null } satisfies NodeRec;
    case "reply":
      return { ...r, t: "" } satisfies ReplyRec;
    case "comment":
      return { ...r, t: "" } satisfies CommentRec;
    case "answer":
      return { ...r, md: "", pages: [] } satisfies AnswerRec;
  }
}

/** The ask a turn belongs to: its run's node, or the thread for the root
 * (`node: "r"`). Undefined when the run or the ask is gone (the turn is
 * erased with them). */
export function turnItem(g: Reader, r: TurnRec): ThreadRec | NodeRec | undefined {
  const run = g.byKey(`run:${r.run}`);
  if (run?.kind !== "run") return undefined;
  const item = g.byKey(run.node === "r" ? threadKey(run.th) : `node:${run.node}`);
  return item?.kind === "thread" || item?.kind === "node" ? item : undefined;
}

/** A record as `u` may read it now, or null when it is outside their scope. */
export function view(g: Reader, r: StoredRecord, u: string | null): StoredRecord | null {
  return canRead(g, r, u) ? redact(g, r, u) : null;
}
