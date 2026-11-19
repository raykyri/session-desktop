// Roles and read scope: the mock's section 5a (`roleIn`, `readsSpace`,
// `readScope`) over multi-user records, with the owner's decisions of phase 0b
// and review round 1.
//
// Read rules:
// - Space records (the landing and the staff list `mods`) are public.
// - An open space's content (threads, follow-ups, replies, runs, its `stats`
//   record and its member list) is readable by anyone, signed out included;
//   a closed space's (`vis` listed or unlisted) by its members only. A
//   non-member gets none of a closed space's content, the threads they wrote
//   included: a device that lost membership keeps the copy it had, frozen
//   (`ReplicaClient.frozen`), and gets no further updates.
// - Join requests and reports: the person's own, and all of them in the
//   spaces they moderate. Bans: the spaces they moderate. Invite links: the
//   spaces they moderate, and the links they made while they are a member.
// - A person reads their own membership records (in their user log).
// - A person's likes, saves and notifications: that person only, and only
//   while they may read the space the record is about (a like's or save's
//   thread's space; a notification's space). A person removed from a closed
//   space is no longer served their likes, saves and notifications there,
//   nor their deletions (review round 1, R4a and R4c).
// - Text of a hidden thread, follow-up or reply: its author and the space's
//   moderators (and up). Every other reader gets the placeholder (`redact`).
//   A removed item's text is erased from storage, so nobody gets it. Hiding
//   a thread blanks that thread's own text only; its follow-ups and replies
//   are moderated one by one (kept as the mock has it; review round 1, R14).
//
// DESIGN (phase 0 finding): who may read a record depends only on its
// audience (`Audience`: kind, space, person and maker, which never change),
// the reader's role in that space, and whether the space is closed. Whether
// its text is redacted depends on its moderation state as well. A pull can
// then leave out every record the reader may not read without sending a
// `del` for it (which would expose its key: for a member record, who left a
// closed space), and a change of moderation state reaches readers as a `put`
// of the record as they may read it now. The scope changes only when the
// reader's own membership or role changes or a space opens or closes; the
// server answers both with a resync. A tombstone keeps the audience only, so
// who gets a `del` is decided by the same rule.

import type {
  FollowUpRec,
  Kind,
  ReplyRec,
  SpaceRec,
  SpaceRole,
  StoredRecord,
  ThreadRec,
} from "./records.js";
import { banKey, memberKey, personOf, spaceKey, spaceOf, threadKey } from "./records.js";

export interface Reader {
  get(key: string): StoredRecord | undefined;
}

export const RANK: Record<SpaceRole, number> = { member: 1, mod: 2, admin: 3, owner: 4 };

export const isClosed = (s: SpaceRec) => s.vis !== "open";

export function spaceRec(g: Reader, sp: string): SpaceRec | undefined {
  const s = g.get(spaceKey(sp));
  return s?.kind === "space" ? s : undefined;
}

/** A person's role in a space: their member record's role, or null. */
export function roleIn(g: Reader, sp: string, u: string | null): SpaceRole | null {
  if (u === null) return null;
  const m = g.get(memberKey(sp, u));
  return m?.kind === "member" ? m.role : null;
}

export const rankIn = (g: Reader, sp: string, u: string | null) => {
  const r = roleIn(g, sp, u);
  return r ? RANK[r] : 0;
};

export const isModOf = (g: Reader, sp: string, u: string | null) => rankIn(g, sp, u) >= RANK.mod;

export const bannedFrom = (g: Reader, sp: string, u: string) => g.get(banKey(sp, u)) !== undefined;

/** May `u` read a space's content (threads, follow-ups, replies, runs, stats,
 * member list). */
export function readsSpace(g: Reader, sp: string, u: string | null): boolean {
  const s = spaceRec(g, sp);
  if (!s) return false;
  return !isClosed(s) || roleIn(g, sp, u) !== null;
}

/** The fields that decide who reads a record: the part of it a tombstone
 * keeps. `sp` is the space whose rules apply: the record's own space, or
 * for a like or a save its thread's space, and for a notification the space
 * it is about. `person` is the person whose user log holds it; `by` its
 * author or maker. */
export interface Audience {
  kind: Kind;
  sp: string | null;
  person: string | null;
  by: string | null;
}

export function audience(g: Reader, r: StoredRecord): Audience {
  let sp = spaceOf(r);
  if (r.kind === "like" || r.kind === "save") {
    const p = g.get(threadKey(r.th));
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
    case "followup":
    case "reply":
    case "run":
      return sp !== null && readsSpace(g, sp, u);
    case "report":
    case "request":
      return own || (sp !== null && isModOf(g, sp, u));
    case "ban":
      return sp !== null && isModOf(g, sp, u);
    case "invite":
      return (
        sp !== null &&
        (isModOf(g, sp, u) || (u !== null && a.by === u && roleIn(g, sp, u) !== null))
      );
    case "like":
    case "save":
    case "notif":
      return own && (sp === null || readsSpace(g, sp, u));
  }
}

/** May `u` read the record at all (its audience; text is `redact`'s job). */
export function canRead(g: Reader, r: StoredRecord, u: string | null): boolean {
  return readsAudience(g, audience(g, r), u);
}

/** A moderated record as `u` may read it: a hidden one keeps its text for its
 * author and the space's moderators; everyone else, and every reader of a
 * removed one, gets the placeholder. */
export function redact(g: Reader, r: StoredRecord, u: string | null): StoredRecord {
  if (!("mod" in r) || r.mod === null) return r;
  if (r.mod === "hidden" && u !== null && (r.u === u || isModOf(g, r.s, u))) return r;
  switch (r.kind) {
    case "thread":
      return { ...r, q: "", t: null, sum: null } satisfies ThreadRec;
    case "followup":
      return { ...r, q: "", a: null } satisfies FollowUpRec;
    case "reply":
      return { ...r, t: "" } satisfies ReplyRec;
  }
  return r;
}

/** A record as `u` may read it now, or null when it is outside their scope. */
export function view(g: Reader, r: StoredRecord, u: string | null): StoredRecord | null {
  return canRead(g, r, u) ? redact(g, r, u) : null;
}
