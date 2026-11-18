// Roles and read scope: the mock's section 5a (`roleIn`, `readsSpace`,
// `readScope`) over multi-user records.
//
// Read rules (the mock's READ_RULES, all on):
// - Space records are public.
// - An open space's content and member list are readable by anyone, signed
//   out included; a closed space's (`vis` listed or unlisted) by its members.
// - In a closed space they are not a member of, a person reads the threads,
//   follow-ups and runs they wrote, and the staff list (the space record's
//   `mods`).
// - Join requests and reports: the person's own, and all of them in the
//   spaces they moderate. Bans: the spaces they moderate. Invite links: the
//   spaces they moderate, and the links they made while they are a member.
// - A person's likes, saves and notifications: that person only. A person
//   also reads their own membership records (in their user log).
//
// DESIGN (phase 0 finding): who may read a record is fixed for the record's
// lifetime, given the reader's role in its space and whether the space is
// closed. Hiding, removing or deleting content redacts the record (`view`) and
// never takes it out of its readers' scope; the staff list is the space
// record's `mods`, so a role change does not move a member record in or out of
// a non-member's scope. A pull can then leave out every record the reader may
// not read without sending a `del` for it (which would expose its key: for a
// member record, who left a closed space). A record leaves a reader's scope
// only when the reader's own role changes or the space opens or closes; the
// server answers both with a resync.

import type {
  FollowUpRec,
  ReplyRec,
  SpaceRec,
  SpaceRole,
  StoredRecord,
  ThreadRec,
} from "./records.js";
import { banKey, memberKey, spaceKey } from "./records.js";

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

/** May `u` read a space's content (threads, follow-ups, replies, member list). */
export function readsSpace(g: Reader, sp: string, u: string | null): boolean {
  const s = spaceRec(g, sp);
  if (!s) return false;
  return !isClosed(s) || roleIn(g, sp, u) !== null;
}

/** May `u` read the record at all (its audience; content is `view`'s job). */
export function canRead(g: Reader, r: StoredRecord, u: string | null): boolean {
  switch (r.kind) {
    case "space":
      return true;
    case "member":
      // a person reads their own membership in their user log
      return readsSpace(g, r.sp, u) || (u !== null && r.u === u);
    case "reply":
      return readsSpace(g, r.s, u);
    case "thread":
    case "followup":
    case "run":
      return readsSpace(g, r.s, u) || (u !== null && r.u === u);
    case "report":
      return (u !== null && r.by === u) || isModOf(g, r.sp, u);
    case "request":
      return (u !== null && r.u === u) || isModOf(g, r.sp, u);
    case "ban":
      return isModOf(g, r.sp, u);
    case "invite":
      return isModOf(g, r.sp, u) || (u !== null && r.by === u && roleIn(g, r.sp, u) !== null);
    case "like":
    case "save":
      return u !== null && r.u === u;
    case "notif":
      return u !== null && r.to === u;
  }
}

/** A moderated record with its content taken out. Hidden and removed content
 * is served to nobody, moderators and the author included.
 *
 * DESIGN (prototype choice): the mock shows hidden items as such to every
 * reader and leaves the decision of what to render to the page; here the
 * server never serves their content. A moderator who needs to review hidden
 * content would need a separate, audited read. */
export function redact(r: StoredRecord): StoredRecord {
  if (!("mod" in r) || r.mod === null) return r;
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
  return canRead(g, r, u) ? redact(r) : null;
}
